import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { env } from "./config.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { employeeRoutes } from "./modules/employees/employees.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { masterDataRoutes } from "./modules/master-data/master-data.routes.js";
import { userRoutes } from "./modules/users/users.routes.js";
import { operationsMasterRoutes } from "./modules/operations-master/operations-master.routes.js";
import { productionRoutes } from "./modules/production/production.routes.js";
import { paymentsRoutes } from "./modules/payments/payments.routes.js";
import { earningsRoutes } from "./modules/earnings/earnings.routes.js";
import { warehouseRoutes } from "./modules/warehouse/warehouse.routes.js";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: env.WEB_ORIGIN,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
});
await app.register(cookie, { secret: env.SESSION_SECRET });

app.setErrorHandler((error, _request, reply) => {
  if ("statusCode" in error && typeof error.statusCode === "number" && error.statusCode < 500) {
    return reply.code(error.statusCode).send({
      error: {
        code: "code" in error ? String(error.code) : "REQUEST_ERROR",
        message: error.message
      }
    });
  }

  app.log.error(error);
  return reply.code(500).send({
    error: { code: "INTERNAL_ERROR", message: "حدث خطأ داخلي غير متوقع" }
  });
});

await app.register(healthRoutes);
await app.register(authRoutes);
await app.register(employeeRoutes);
await app.register(masterDataRoutes);
await app.register(userRoutes);
await app.register(operationsMasterRoutes);
await app.register(productionRoutes);
await app.register(paymentsRoutes);
await app.register(earningsRoutes);
await app.register(warehouseRoutes);

await app.listen({ host: "0.0.0.0", port: env.API_PORT });
