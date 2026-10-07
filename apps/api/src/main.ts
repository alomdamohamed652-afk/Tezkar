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
import { advanceRoutes } from "./modules/advances/advances.routes.js";
import { dashboardRoutes } from "./modules/dashboard/dashboard.routes.js";
import { cartonDeliveryRoutes } from "./modules/warehouse/cartons-deliveries.routes.js";
import { reportsRoutes } from "./modules/reports/reports.routes.js";
import { orderRoutes } from "./modules/orders/orders.routes.js";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: env.WEB_ORIGIN,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
});
await app.register(cookie, { secret: env.SESSION_SECRET });

app.setErrorHandler((error, _request, reply) => {
  const statusCode = typeof error === "object" && error !== null && "statusCode" in error
    ? (error as { statusCode?: unknown }).statusCode
    : undefined;

  if (typeof statusCode === "number" && statusCode < 500) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "REQUEST_ERROR";
    const message = error instanceof Error ? error.message : "حدث خطأ في الطلب";
    return reply.code(statusCode).send({ error: { code, message } });
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
await app.register(advanceRoutes);
await app.register(dashboardRoutes);
await app.register(cartonDeliveryRoutes);
await app.register(reportsRoutes);
await app.register(orderRoutes);

await app.listen({ host: "0.0.0.0", port: env.API_PORT });
