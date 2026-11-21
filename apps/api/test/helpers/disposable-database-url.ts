import assert from "node:assert/strict";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\\[|\\]$/g, "");
}

/**
 * Restrict integration-test connections to the disposable local postgres
 * service. PostgreSQL connection URIs can override the authority hostname
 * with ?host=/path, which selects a Unix-domain socket.
 */
export function assertDisposableDatabaseUrl(value: string): void {
  const url = new URL(value);
  assert.ok(url.protocol === "postgres:" || url.protocol === "postgresql:");
  assert.ok(LOCAL_HOSTS.has(normalizeHost(url.hostname)),
    "integration tests require a TCP loopback PostgreSQL host");
  assert.equal(url.pathname.slice(1), "postgres",
    "TEST_DATABASE_URL must connect to the postgres admin database, never an application database");

  const hostOverrides = url.searchParams.getAll("host");
  assert.ok(hostOverrides.every(host => LOCAL_HOSTS.has(normalizeHost(host))),
    "TEST_DATABASE_URL must not override the TCP host with a Unix socket path or remote host");

  const hostAddressOverrides = url.searchParams.getAll("hostaddr");
  assert.ok(hostAddressOverrides.every(host => LOCAL_HOSTS.has(normalizeHost(host))),
    "TEST_DATABASE_URL hostaddr must be a TCP loopback address, not a Unix socket path or remote host");
}
