import Fastify from "fastify";
import type { SessionUser } from "./modules/auth/auth.types.js";
import { pool } from "./db/pool.js";
import { writeAudit } from "./modules/audit/audit.service.js";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { env } from "./config.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { employeeRoutes } from "./modules/employees/employees.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { registrationRoutes } from "./modules/auth/registration.routes.js";
import { passwordResetRoutes } from "./modules/auth/password-reset.routes.js";
import { accountRoutes } from "./modules/auth/account.routes.js";
import { masterDataRoutes } from "./modules/master-data/master-data.routes.js";
import { userRoutes } from "./modules/users/users.routes.js";
import { operationsMasterRoutes } from "./modules/operations-master/operations-master.routes.js";
import { productionRoutes } from "./modules/production/production.routes.js";
import { machineProductionCancellationRoutes } from "./modules/production/machine-production.routes.js";
import { laserDesignRoutes } from "./modules/production/laser-design.routes.js";
import { laserMachineOperationsRoutes } from "./modules/production/laser-machine-operations.routes.js";
import { laserScrapReasonRoutes } from "./modules/production/laser-scrap-reasons.routes.js";
import { productionScrapRoutes } from "./modules/production/production-scrap.routes.js";
import { paymentsRoutes } from "./modules/payments/payments.routes.js";
import { earningsRoutes } from "./modules/earnings/earnings.routes.js";
import { warehouseRoutes } from "./modules/warehouse/warehouse.routes.js";
import { shiftWithdrawalRoutes } from "./modules/warehouse/shift-withdrawals.routes.js";
import { advanceRoutes } from "./modules/advances/advances.routes.js";
import { dashboardRoutes } from "./modules/dashboard/dashboard.routes.js";
import { cartonDeliveryRoutes } from "./modules/warehouse/cartons-deliveries.routes.js";
import { reportsRoutes } from "./modules/reports/reports.routes.js";
import { orderRoutes } from "./modules/orders/orders.routes.js";
import { custodyRoutes } from "./modules/custody/custody.routes.js";
import { receiptRoutes } from "./modules/warehouse/receipts.routes.js";
import { codingRoutes } from "./modules/coding/coding.routes.js";
import { reverseCodingRoutes } from "./modules/reverse-coding/reverse-coding.routes.js";
import { accountingRoutes } from "./modules/accounting/accounting.routes.js";
import { taskRoutes } from "./modules/tasks/tasks.routes.js";
import { payrollRoutes } from "./modules/payroll/payroll.routes.js";
import { globalSearchRoutes } from "./modules/search/global-search.routes.js";
import { notificationRoutes } from "./modules/notifications/notifications.routes.js";
import { systemResetRoutes } from "./modules/system-reset/system-reset.routes.js";
import { attendanceRoutes } from "./modules/attendance/attendance.routes.js";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: env.WEB_ORIGIN,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
});
await app.register(cookie, { secret: env.SESSION_SECRET });


app.addHook("onResponse", async (request, reply) => {
  const route = request.routeOptions.url ?? request.url.split("?")[0] ?? request.url;
  const isRead = ["GET", "HEAD", "OPTIONS"].includes(request.method);
  const sensitiveRead = request.method === "GET" && (/^\/api\/admin\/security/.test(route) || route === "/api/account/profile" || route === "/api/auth/sessions");
  if (isRead && (!sensitiveRead || reply.statusCode >= 400)) return;
  const actor = (request as typeof request & { user?: SessionUser | null }).user ?? null;
  const moduleName = route.split("/").filter(Boolean)[1] ?? "api";
  const client = await pool.connect().catch(() => null);
  if (!client) {
    app.log.error({ route, method: request.method }, "Unable to open audit connection");
    return;
  }
  try {
    await writeAudit(client, {
      actorUserId: actor?.userId ?? null,
      actorEmployeeId: actor?.employeeId ?? null,
      action: request.method.toLowerCase() + " " + route,
      module: moduleName,
      entityType: "api_request",
      requestId: request.id,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
      metadata: { statusCode: reply.statusCode, failed: reply.statusCode >= 400 }
    });
  } catch (error) {
    app.log.error({ err: error, route, method: request.method }, "Failed to write mutation audit log");
  } finally {
    client.release();
  }
});

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
await app.register(registrationRoutes);
await app.register(passwordResetRoutes);
await app.register(accountRoutes);
await app.register(employeeRoutes);
await app.register(attendanceRoutes);
await app.register(masterDataRoutes);
await app.register(userRoutes);
await app.register(operationsMasterRoutes);
await app.register(productionRoutes);
await app.register(machineProductionCancellationRoutes);
await app.register(laserDesignRoutes);
await app.register(laserMachineOperationsRoutes);
await app.register(laserScrapReasonRoutes);
await app.register(productionScrapRoutes);
await app.register(paymentsRoutes);
await app.register(earningsRoutes);
await app.register(warehouseRoutes);
  await app.register(shiftWithdrawalRoutes);
await app.register(advanceRoutes);
await app.register(dashboardRoutes);
await app.register(cartonDeliveryRoutes);
await app.register(reportsRoutes);
await app.register(orderRoutes);
await app.register(custodyRoutes);
await app.register(receiptRoutes);
await app.register(codingRoutes);
await app.register(reverseCodingRoutes);
await app.register(accountingRoutes);
await app.register(taskRoutes);
await app.register(payrollRoutes);
await app.register(globalSearchRoutes);
await app.register(notificationRoutes);
await app.register(systemResetRoutes);

await app.listen({ host: "0.0.0.0", port: env.API_PORT });
