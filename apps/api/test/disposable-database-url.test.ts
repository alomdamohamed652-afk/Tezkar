import test from "node:test";
import assert from "node:assert/strict";
import { assertDisposableDatabaseUrl } from "./helpers/disposable-database-url.js";

test("disposable PostgreSQL URL guard accepts TCP loopback connections only", () => {
  assert.doesNotThrow(() => assertDisposableDatabaseUrl("postgresql://postgres:postgres@localhost:5432/postgres"));
  assert.doesNotThrow(() => assertDisposableDatabaseUrl("postgresql://postgres:postgres@127.0.0.1:5432/postgres"));
  assert.doesNotThrow(() => assertDisposableDatabaseUrl("postgresql://postgres:postgres@[::1]:5432/postgres"));
  assert.doesNotThrow(() => assertDisposableDatabaseUrl("postgresql://postgres:postgres@localhost:5432/postgres?host=127.0.0.1"));
});

test("disposable PostgreSQL URL guard rejects Unix socket path overrides", () => {
  const urls = [
    "postgresql://postgres:postgres@localhost:5432/postgres?host=%2Fvar%2Frun%2Fpostgresql",
    "postgresql://postgres:postgres@localhost:5432/postgres?host=%2Ftmp",
    "postgresql://postgres:postgres@localhost:5432/postgres?hostaddr=%2Fvar%2Frun%2Fpostgresql",
    "postgresql://postgres:postgres@localhost:5432/postgres?host=localhost&host=%2Fvar%2Frun%2Fpostgresql"
  ];

  for (const url of urls) {
    assert.throws(
      () => assertDisposableDatabaseUrl(url),
      /Unix socket path|hostaddr must be a TCP loopback/,
      "a Unix socket override must never pass the disposable database guard"
    );
  }
});

test("disposable PostgreSQL URL guard rejects remote host overrides", () => {
  assert.throws(
    () => assertDisposableDatabaseUrl("postgresql://postgres:postgres@localhost:5432/postgres?host=example.com"),
    /Unix socket path or remote host/
  );
  assert.throws(
    () => assertDisposableDatabaseUrl("postgresql://postgres:postgres@localhost:5432/postgres?hostaddr=203.0.113.10"),
    /TCP loopback address/
  );
});
