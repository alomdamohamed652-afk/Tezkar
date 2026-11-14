import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const reportsRoutes = readFileSync(
  new URL("../src/modules/reports/reports.routes.ts", import.meta.url),
  "utf8",
);
const reportsPage = readFileSync(
  new URL("../../web/app/reports/page.tsx", import.meta.url),
  "utf8",
);

test("production report options are queried independently of the first data page", () => {
  const start = reportsRoutes.indexOf('app.get("/api/reports/production/options"');
  assert.notEqual(start, -1, "production options endpoint must exist");
  const end = reportsRoutes.indexOf('app.get("/api/reports/production"', start);
  assert.notEqual(end, -1, "production data endpoint must follow options endpoint");
  const endpoint = reportsRoutes.slice(start, end);

  assert.match(endpoint, /SELECT DISTINCT po\.id/);
  assert.match(endpoint, /SELECT DISTINCT st\.id/);
  assert.match(endpoint, /SELECT DISTINCT sh\.id/);
  assert.match(endpoint, /Promise\.all/);
});

test("production export uses lightweight page-only requests and fetches every page", () => {
  assert.match(reportsRoutes, /countResult = q\.pageOnly \? null/);
  assert.match(reportsRoutes, /summaryResult = q\.pageOnly \? null/);
  assert.match(reportsRoutes, /q\.pageOnly \|\| q\.groupBy === "none" \? \[\]/);
  assert.match(reportsRoutes, /q\.pageOnly \? q\.limit \+ 1 : q\.limit/);
  assert.match(reportsRoutes, /hasMore:q\.pageOnly \? hasExtraPageRow/);
  assert.match(reportsPage, /productionQueryParams\(offset,\s*true\)/);
  assert.match(reportsPage, /while\s*\(hasMore\)/);
});
