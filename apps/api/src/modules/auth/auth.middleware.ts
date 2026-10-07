import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../../db/pool.js";
import type { SessionUser } from "./auth.types.js";
import { getSessionUser } from "./session.service.js";

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const token = request.cookies.tezkar_session;

  if (!token) {
    reply.code(401).send({
      error: { code: "UNAUTHENTICATED", message: "يجب تسجيل الدخول أولاً" }
    });
    return;
  }

  const client = await pool.connect();
  try {
    request.user = await getSessionUser(client, token);
  } finally {
    client.release();
  }

  if (!request.user) {
    reply.code(401).send({
      error: { code: "SESSION_INVALID", message: "جلسة الدخول غير صالحة أو منتهية" }
    });
  }
}
