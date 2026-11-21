import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const reportsRoutes = readFileSync(
  new URL("../src/modules/reports/reports.routes.ts", import.meta.url),
  "utf8",
);

test("production report count skips payment allocation joins unless payment status is filtered", () => {
  assert.match(
    reportsRoutes,
    /const countQueryJoins = q\.paymentStatus\s*\?\s*countJoins\s*:\s*"LEFT JOIN order_stages os ON os\.id=p\.order_stage_id"/,
  );
  assert.match(
    reportsRoutes,
    /SELECT COUNT\(\*\)::int AS total FROM production_entries p \$\{countQueryJoins\} \$\{whereSql\}/,
  );
});

test("production report summary skips payment allocation joins unless payment status is filtered", () => {
  assert.match(
    reportsRoutes,
    /const summaryJoins = [\s\S]*?\+ \(q\.paymentStatus \? [\s\S]*? : ""\);/,
  );
  assert.match(
    reportsRoutes,
    /FROM production_entries p \$\{summaryJoins\}[\s\S]*?\$\{whereSql\}/,
  );
});


test("production report group query skips payment allocation joins unless payment status is filtered", () => {
  assert.match(
    reportsRoutes,
    /const groupPaymentJoins = q\.paymentStatus\s*\?\s*countJoins\.replace\(/,
  );
  assert.match(
    reportsRoutes,
    /LEFT JOIN production_types pt ON pt\.id=p\.production_type_id\s*\$\{groupPaymentJoins\}/,
  );
});
