import type { FastifyInstance } from "fastify";
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
  while (loginAttempts.size >= LOGIN_MAX_TRACKED_KEYS) {
    const oldestKey = loginAttempts.keys().next().value;
    if (oldestKey === undefined) break;
    loginAttempts.delete(oldestKey);
  }
}

function assertLoginAllowed(request: { ip: string }, username: string) {
  const key = loginKey(request, username);
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current) return;
  if (current.blockedUntil > now) {
    throw new AppError("LOGIN_RATE_LIMITED", "محاولات تسجيل الدخول كثيرة. حاول مرة أخرى بعد قليل.", 429);
  }
  if (now - current.firstAt >= LOGIN_WINDOW_MS) loginAttempts.delete(key);
}

function recordLoginFailure(request: { ip: string }, username: string) {
  const key = loginKey(request, username);
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || now - current.firstAt >= LOGIN_WINDOW_MS) {
    pruneLoginAttempts(now);
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
        const session = await createSession(client, user);
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
      recordLoginFailure(request, parsed.data.username);
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
}
