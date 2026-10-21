import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticate, hashPassword } from "./auth.service.js";
import { authenticateRequest } from "./auth.middleware.js";
import { isFirstRunSetupRequired } from "./auth.repository.js";
import { createSession, revokeSession } from "./session.service.js";
import { env } from "../../config.js";

const loginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200)
});

const loginAttempts = new Map<string, { count: number; firstAt: number; blockedUntil: number }>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const LOGIN_MAX_TRACKED_KEYS = 10_000;

function loginKey(request: { ip: string }, username: string) {
  return request.ip + ":" + username.toLowerCase();
}

function pruneLoginAttempts(now: number) {
  for (const [key, entry] of loginAttempts) {
    if (now - entry.firstAt >= LOGIN_WINDOW_MS && entry.blockedUntil <= now) {
      loginAttempts.delete(key);
    }
  }

}

function assertLoginAllowed(request: { ip: string }, username: string) {
  const now = Date.now();
  pruneLoginAttempts(now);
  const key = loginKey(request, username);
  const current = loginAttempts.get(key);
  if (current && current.blockedUntil > now) {
    throw new AppError("LOGIN_RATE_LIMITED", "محاولات تسجيل الدخول كثيرة. حاول مرة أخرى بعد قليل.", 429);
  }
  // Fail closed when the bounded in-memory tracker is saturated. Otherwise
  // attackers could bypass throttling by continuously submitting new usernames.
  if (!current && loginAttempts.size >= LOGIN_MAX_TRACKED_KEYS) {
    throw new AppError("LOGIN_RATE_LIMITED", "تعذر بدء تسجيل الدخول حاليًا. حاول مرة أخرى بعد قليل.", 429);
  }
  if (current && now - current.firstAt >= LOGIN_WINDOW_MS) loginAttempts.delete(key);
}

function recordLoginFailure(request: { ip: string }, username: string) {
  const key = loginKey(request, username);
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || now - current.firstAt >= LOGIN_WINDOW_MS) {
    pruneLoginAttempts(now);
    // Never evict a still-active key just to make room: doing so could erase
    // another user's active lockout during a burst of unique login attempts.
    if (loginAttempts.size >= LOGIN_MAX_TRACKED_KEYS) return;
    loginAttempts.set(key, { count: 1, firstAt: now, blockedUntil: 0 });
    return;
  }
  const count = current.count + 1;
  loginAttempts.set(key, {
    count,
    firstAt: current.firstAt,
    blockedUntil: count >= LOGIN_MAX_FAILURES ? now + LOGIN_WINDOW_MS : 0
  });
}

function clearLoginFailures(request: { ip: string }, username: string) {
  loginAttempts.delete(loginKey(request, username));
}

const setupSchema = z.object({
  username: z.string().trim().min(3).max(100).regex(/^[a-zA-Z0-9._-]+$/, "اسم المستخدم يجب أن يحتوي على حروف إنجليزية وأرقام فقط"),
  password: z.string().min(12).max(200),
  confirmPassword: z.string().min(12).max(200)
}).refine((data) => data.password === data.confirmPassword, {
  message: "كلمتا المرور غير متطابقتين",
  path: ["confirmPassword"]
});

export async function authRoutes(app: FastifyInstance) {
  app.get("/api/auth/setup-status", async () => {
    const client = await pool.connect();
    try {
      return { data: { required: await isFirstRunSetupRequired(client) } };
    } finally {
      client.release();
    }
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "بيانات تسجيل الدخول غير صحيحة", 422);

    assertLoginAllowed(request, parsed.data.username);

    let result;
    try {
      result = await withTransaction(async (client) => {
        const user = await authenticate(client, parsed.data.username, parsed.data.password);
        const rawAgent = request.headers["user-agent"];
        const userAgent = Array.isArray(rawAgent) ? rawAgent[0] : rawAgent ?? null;
        const rawDeviceId = request.headers["x-tezkar-device-id"];
        const deviceId = (Array.isArray(rawDeviceId) ? rawDeviceId[0] : rawDeviceId)?.slice(0, 128) ?? null;
        const session = await createSession(client, user, { deviceId, ipAddress: request.ip, userAgent });
        await writeAudit(client, {
          actorUserId: user.userId,
          actorEmployeeId: user.employeeId,
          action: "login",
          module: "auth",
          entityType: "user",
          entityId: user.userId,
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"] ?? null
        });
        await client.query("DELETE FROM user_sessions WHERE expires_at <= now() OR revoked_at IS NOT NULL");
        return { user, session };
      });
      clearLoginFailures(request, parsed.data.username);
    } catch (error) {
      // Only invalid credentials should count toward the login lockout.
      // Database, session, and audit failures must not lock out a legitimate user.
      if (error instanceof AppError && error.code === "INVALID_CREDENTIALS") {
        recordLoginFailure(request, parsed.data.username);
      }
      throw error;
    }

    reply.setCookie("tezkar_session", result.session.token, {
      httpOnly: true,
      secure: env.NODE_ENV === "production" || env.SESSION_COOKIE_SAMESITE === "none",
      sameSite: env.SESSION_COOKIE_SAMESITE,
      path: "/",
      expires: result.session.expiresAt
    });

    return {
      data: result.user,
      requiresSetup: result.user.mustCompleteSetup
    };
  });

  app.post("/api/auth/complete-first-run", { preHandler: authenticateRequest }, async (request, reply) => {
    const parsed = setupSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "بيانات إنشاء حساب المدير الجديد غير صحيحة", 422);
    if (!request.user?.isBootstrap || !request.user.mustCompleteSetup) {
      throw new AppError("SETUP_NOT_REQUIRED", "إعداد النظام الأولي غير مطلوب لهذا الحساب", 409);
    }

    await withTransaction(async (client) => {
      const exists = await client.query("SELECT id FROM users WHERE username = $1", [parsed.data.username]);
      if (exists.rows[0]) {
        throw new AppError("USERNAME_EXISTS", "اسم المستخدم مستخدم بالفعل", 409);
      }

      const created = await client.query(
        `INSERT INTO users (username, password_hash, is_bootstrap, must_complete_setup)
         VALUES ($1, $2, FALSE, FALSE)
         RETURNING id, username`,
        [parsed.data.username, hashPassword(parsed.data.password)]
      );

      await client.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT $1, id FROM roles WHERE code = 'manager'
         ON CONFLICT DO NOTHING`,
        [created.rows[0].id]
      );

      await client.query(
        `UPDATE users
         SET is_active = FALSE, must_complete_setup = FALSE, updated_at = now()
         WHERE id = $1`,
        [request.user!.userId]
      );

      await client.query(
        `UPDATE user_sessions SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [request.user!.userId]
      );

      await writeAudit(client, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId,
        action: "complete_first_run",
        module: "auth",
        entityType: "user",
        entityId: created.rows[0].id,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
        metadata: { bootstrapUserId: request.user!.userId }
      });
    });

    reply.clearCookie("tezkar_session", { path: "/" });
    return { data: { success: true, message: "تم إنشاء حساب المدير الجديد. سجل الدخول بالحساب الجديد." } };
  });

  app.post("/api/auth/logout", { preHandler: authenticateRequest }, async (request, reply) => {
    const token = request.cookies.tezkar_session;
    if (token) {
      await withTransaction(async (client) => {
        await revokeSession(client, token);
        await writeAudit(client, {
          actorUserId: request.user!.userId, actorEmployeeId: request.user!.employeeId,
          action: "logout", module: "auth", entityType: "user", entityId: request.user!.userId,
          ipAddress: request.ip, userAgent: request.headers["user-agent"] ?? null
        });
      });
    }
    reply.clearCookie("tezkar_session", { path: "/" });
    return { data: { success: true } };
  });

  app.get("/api/auth/me", { preHandler: authenticateRequest }, async (request) => {
    const client = await pool.connect();
    try {
      const permissions = await client.query(
        `SELECT DISTINCT p.code
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = $1
           AND r.is_active = TRUE
         ORDER BY p.code`,
        [request.user!.userId]
      );
      const employeeId=request.user!.employeeId;
      const activeCustody=employeeId?await client.query("SELECT 1 FROM employee_custodies WHERE employee_id=$1 AND status IN ('ACTIVE','PARTIAL_RETURNED') LIMIT 1",[employeeId]):{rowCount:0};
      const openAdvance=employeeId?await client.query("SELECT 1 FROM advance_requests WHERE employee_id=$1 AND status='PAID' AND repayment_status='OPEN' LIMIT 1",[employeeId]):{rowCount:0};
      return {
        data: {
          ...request.user,
          permissions: permissions.rows.map((row) => row.code as string),
          activeRecords: {
            custody: Boolean(activeCustody.rowCount),
            advance: Boolean(openAdvance.rowCount)
          }
        }
      };
    } finally {
      client.release();
    }
  });
  app.get("/api/auth/sessions", { preHandler: authenticateRequest }, async (request) => {
    const token = request.cookies.tezkar_session;
    const tokenHash = token ? createHash("sha256").update(token).digest("hex") : "";
    const result = await pool.query(
      "SELECT id, device_id, device_name, device_type, browser_name, os_name, host(ip_address) AS ip_address, last_seen_at, expires_at, (token_hash = $2) AS is_current FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC NULLS LAST",
      [request.user!.userId, tokenHash]
    );
    return { data: result.rows };
  });

  app.post("/api/auth/logout-all", { preHandler: authenticateRequest }, async (request, reply) => {
    const revoked = await withTransaction(async (client) => {
      const result = await client.query("UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()", [request.user!.userId]);
      await writeAudit(client, { actorUserId: request.user!.userId, actorEmployeeId: request.user!.employeeId, action: "logout_all_devices", module: "auth", entityType: "user", entityId: request.user!.userId, ipAddress: request.ip, userAgent: request.headers["user-agent"] ?? null, metadata: { revokedSessions: result.rowCount ?? 0 } });
      return result.rowCount ?? 0;
    });
    reply.clearCookie("tezkar_session", { path: "/" });
    return { data: { success: true, revokedSessions: revoked, message: "تم تسجيل الخروج من جميع الأجهزة" } };
  });

  app.get("/api/admin/security/accounts", { preHandler: authenticateRequest }, async (request) => {
    const roles = request.user?.roleCodes ?? [];
    if (!roles.some((role) => ["admin", "manager", "owner"].includes(role.toLowerCase()))) {
      throw new AppError("FORBIDDEN", "هذه الصفحة متاحة للإدارة فقط", 403);
    }
    const result = await pool.query(
      "SELECT u.id, u.username, e.full_name, u.is_active, u.last_login_at, COUNT(DISTINCT s.id) FILTER (WHERE s.revoked_at IS NULL AND s.expires_at > now())::int AS active_devices, COALESCE((SELECT COUNT(*)::int FROM audit_log al WHERE al.actor_user_id = u.id AND al.created_at >= now() - interval '30 days'), 0) AS actions_30d, COALESCE(json_agg(DISTINCT jsonb_build_object('deviceName',s.device_name,'deviceType',s.device_type,'browser',s.browser_name,'os',s.os_name,'ip',host(s.ip_address),'lastSeenAt',s.last_seen_at)) FILTER (WHERE s.id IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at > now()), '[]'::json) AS devices FROM users u LEFT JOIN employees e ON e.id = u.employee_id LEFT JOIN user_sessions s ON s.user_id = u.id GROUP BY u.id, e.full_name ORDER BY actions_30d DESC, active_devices DESC, u.username ASC LIMIT 500"
    );
    return { data: result.rows };
  });

  app.get("/api/admin/security/audit", { preHandler: authenticateRequest }, async (request) => {
    const roles = request.user?.roleCodes ?? [];
    if (!roles.some((role) => ["admin", "manager", "owner"].includes(role.toLowerCase()))) {
      throw new AppError("FORBIDDEN", "هذه الصفحة متاحة للإدارة فقط", 403);
    }
    const query = z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      username: z.string().trim().max(100).optional()
    }).parse(request.query);
    const result = await pool.query(
      "SELECT al.id, al.created_at, al.action, al.module, al.entity_type, al.entity_id, al.ip_address, al.user_agent, al.metadata, u.username, e.full_name FROM audit_log al LEFT JOIN users u ON u.id = al.actor_user_id LEFT JOIN employees e ON e.id = al.actor_employee_id WHERE ($1::text IS NULL OR u.username ILIKE '%' || $1 || '%') ORDER BY al.created_at DESC LIMIT $2 OFFSET $3",
      [query.username ?? null, query.limit, (query.page - 1) * query.limit]
    );
    return { data: result.rows, page: query.page, limit: query.limit };
  });

}
