import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticate } from "./auth.service.js";
import { authenticateRequest } from "./auth.middleware.js";
import { createSession, revokeSession } from "./session.service.js";

const loginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200)
});

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_ERROR", "بيانات تسجيل الدخول غير صحيحة", 422);
    }

    const result = await withTransaction(async (client) => {
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

      return { user, session };
    });

    reply.setCookie("tezkar_session", result.session.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: result.session.expiresAt
    });

    return { data: result.user };
  });

  app.post("/api/auth/logout", { preHandler: authenticateRequest }, async (request, reply) => {
    const token = request.cookies.tezkar_session;
    if (token) {
      await withTransaction(async (client) => {
        await revokeSession(client, token);
        await writeAudit(client, {
          actorUserId: request.user!.userId,
          actorEmployeeId: request.user!.employeeId,
          action: "logout",
          module: "auth",
          entityType: "user",
          entityId: request.user!.userId,
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"] ?? null
        });
      });
    }

    reply.clearCookie("tezkar_session", { path: "/" });
    return { data: { success: true } };
  });

  app.get("/api/auth/me", { preHandler: authenticateRequest }, async (request) => ({
    data: request.user
  }));
}
