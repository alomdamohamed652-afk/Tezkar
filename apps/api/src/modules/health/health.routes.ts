import type { FastifyInstance } from "fastify";
import { pool } from "../../db/pool.js";

export async function healthRoutes(app: FastifyInstance) {
  const handler = async () => {
    try {
      const result = await pool.query("SELECT 1 AS ok");
      return {
        status: "ok",
        database: result.rows[0]?.ok === 1 ? "ok" : "unknown"
      };
    } catch {
      return {
        status: "degraded",
        database: "down"
      };
    }
  };

  app.get("/health", handler);
  app.get("/api/health", handler);
}
