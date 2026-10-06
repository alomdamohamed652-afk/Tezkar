import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../../db/pool.js";
import { hasPermission } from "./rbac.service.js";

export function requirePermission(permissionCode: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      reply.code(401).send({
        error: { code: "UNAUTHENTICATED", message: "يجب تسجيل الدخول أولاً" }
      });
      return;
    }

    const client = await pool.connect();
    try {
      const allowed = await hasPermission(client, request.user.userId, permissionCode);
      if (!allowed) {
        reply.code(403).send({
          error: { code: "FORBIDDEN", message: "ليس لديك صلاحية لتنفيذ هذا الإجراء" }
        });
      }
    } finally {
      client.release();
    }
  };
}
