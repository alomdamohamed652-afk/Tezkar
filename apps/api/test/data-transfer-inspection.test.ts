import test from "node:test";
import assert from "node:assert/strict";
import {
  databaseIdentity,
  inspectDatabaseTransfer,
  roleMembershipQueryForVersion
} from "../src/modules/data-transfer/data-transfer-inspection.service.js";
import { parseRequestedTables } from "../src/modules/data-transfer/data-transfer-counts.service.js";
import { assertDistinctConnectedDatabases } from "../src/modules/data-transfer/data-transfer-connection.service.js";

test("database identity normalizes hostname case and PostgreSQL default port", () => {
  assert.equal(
    databaseIdentity("postgres://user:secret@DB.EXAMPLE/tezkar?sslmode=require"),
    "db.example:5432/tezkar"
  );
  assert.equal(
    databaseIdentity("postgres://other:password@db.example:5432/tezkar"),
    "db.example:5432/tezkar"
  );
});

test("role membership inspection uses PostgreSQL 16 membership options when available", () => {
  const query = roleMembershipQueryForVersion(160000);
  assert.match(query, /m\.inherit_option/);
  assert.match(query, /m\.set_option/);
  assert.doesNotMatch(query, /member\.rolinherit AS inherit_option/);
});

test("role membership inspection remains compatible with PostgreSQL 15 and older", () => {
  const query = roleMembershipQueryForVersion(150000);
  assert.match(query, /member\.rolinherit AS inherit_option/);
  assert.match(query, /TRUE AS set_option/);
  assert.doesNotMatch(query, /m\.inherit_option/);
  assert.doesNotMatch(query, /m\.set_option/);
});

test("database identity returns null for malformed connection strings", () => {
  assert.equal(databaseIdentity("not-a-database-url"), null);
});

test("inspection refuses identical database endpoints before opening connections", async () => {
  await assert.rejects(
    () => inspectDatabaseTransfer(
      "postgres://user:secret@DB.EXAMPLE/tezkar",
      "postgres://other:password@db.example:5432/tezkar"
    ),
    /نفس قاعدة البيانات/
  );
});


test("database identity distinguishes projects on the shared Supabase pooler hostname", () => {
  assert.notEqual(
    databaseIdentity("postgres://postgres.project_old:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres"),
    databaseIdentity("postgres://postgres.project_new:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres")
  );
});

test("database identity still treats different users on the same direct PostgreSQL endpoint as the same database", () => {
  assert.equal(
    databaseIdentity("postgres://user_a:secret@db.example/tezkar"),
    databaseIdentity("postgres://user_b:secret@db.example:5432/tezkar")
  );
});


test("selected table parser accepts unique schema-qualified public table names", () => {
  assert.deepEqual(parseRequestedTables("public.users, public.employees"), [
    { schema: "public", table: "users", key: "public.users" },
    { schema: "public", table: "employees", key: "public.employees" }
  ]);
});

test("selected table parser rejects duplicates, empty entries, unsupported schemas, and SQL fragments", () => {
  assert.throws(() => parseRequestedTables("public.users,public.users"));
  assert.throws(() => parseRequestedTables("public.users,,public.employees"));
  assert.throws(() => parseRequestedTables("auth.users"));
  assert.throws(() => parseRequestedTables("public.users; DROP TABLE users"));
});


test("database identity detects the same Supabase project across direct and pooled endpoints", () => {
  assert.equal(
    databaseIdentity("postgres://postgres:secret@db.projectref123.supabase.co:5432/postgres"),
    databaseIdentity("postgres://postgres.projectref123:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres")
  );
});

test("database identity distinguishes different Supabase project refs on a shared pooler", () => {
  assert.notEqual(
    databaseIdentity("postgres://postgres.projectone:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres"),
    databaseIdentity("postgres://postgres.projecttwo:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres")
  );
});


test("connected database identity rejects two URLs resolving to the same PostgreSQL database", async () => {
  const same = {
    query: async () => ({
      rows: [{ database_name: "postgres", database_oid: "16384", server_address: "10.0.0.5", server_port: 5432 }]
    })
  };
  await assert.rejects(
    () => assertDistinctConnectedDatabases(same, same),
    /نفس|تعذر إثبات اختلاف/
  );
});

test("connected database identity rejects matching database OIDs even across different backend addresses", async () => {
  const source = {
    query: async () => ({
      rows: [{ database_name: "postgres", database_oid: "16384", server_address: "10.0.0.5", server_port: 5432 }]
    })
  };
  const target = {
    query: async () => ({
      rows: [{ database_name: "postgres", database_oid: "16384", server_address: "10.0.0.9", server_port: 6543 }]
    })
  };
  await assert.rejects(
    () => assertDistinctConnectedDatabases(source, target),
    /تعذر إثبات اختلاف/
  );
});

test("connected database identity still rejects matching OIDs when Supabase project identities are the same", async () => {
  const sameBackend = {
    query: async () => ({
      rows: [{ database_name: "postgres", database_oid: "16384", server_address: "10.0.0.5", server_port: 5432 }]
    })
  };
  await assert.rejects(
    () => assertDistinctConnectedDatabases(
      sameBackend,
      sameBackend,
      "supabase:projectref123/postgres",
      "supabase:projectref123/postgres"
    ),
    /تعذر إثبات اختلاف/
  );
});

test("connected database identity accepts different Supabase projects with matching database OIDs", async () => {
  const source = {
    query: async () => ({
      rows: [{ database_name: "postgres", database_oid: "16384", server_address: "10.0.0.5", server_port: 5432 }]
    })
  };
  const target = {
    query: async () => ({
      rows: [{ database_name: "postgres", database_oid: "16384", server_address: "10.0.0.9", server_port: 6543 }]
    })
  };
  await assert.doesNotReject(() => assertDistinctConnectedDatabases(
    source,
    target,
    "supabase:sourceproject/postgres",
    "supabase:targetproject/postgres"
  ));
});

test("connected database identity accepts distinct PostgreSQL databases", async () => {
  const source = {
    query: async () => ({
      rows: [{ database_name: "postgres", database_oid: "16384", server_address: "10.0.0.5", server_port: 5432 }]
    })
  };
  const target = {
    query: async () => ({
      rows: [{ database_name: "postgres", database_oid: "32768", server_address: "10.0.0.6", server_port: 5432 }]
    })
  };
  await assert.doesNotReject(() => assertDistinctConnectedDatabases(source, target));
});

test("connected database identity fails closed when server identity is unavailable", async () => {
  const unknown = { query: async () => ({ rows: [{ database_name: "postgres", database_oid: null, server_address: null, server_port: null }] }) };
  await assert.rejects(
    () => assertDistinctConnectedDatabases(unknown, unknown),
    /تعذر إثبات اختلاف/
  );
});


test("connected database identity accepts distinct Supabase projects sharing the same pooler backend identity", async () => {
  const sharedPoolerBackend = {
    query: async () => ({
      rows: [{ database_name: "postgres", database_oid: "16384", server_address: "10.0.0.5", server_port: 5432 }]
    })
  };
  await assert.doesNotReject(() => assertDistinctConnectedDatabases(
    sharedPoolerBackend,
    sharedPoolerBackend,
    "supabase:sourceproject/postgres",
    "supabase:targetproject/postgres"
  ));
});
