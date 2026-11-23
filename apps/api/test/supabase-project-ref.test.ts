import assert from "node:assert/strict";
import test from "node:test";
import { getSupabaseProjectRef } from "../src/db/supabase-project-ref.js";

const projectRef = "abcdefghijklmnopqrst";

test("extracts project reference from Supabase direct connection URL", () => {
  assert.equal(
    getSupabaseProjectRef(`postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/postgres`),
    projectRef
  );
});

test("extracts the same project reference from Supavisor pooler username", () => {
  assert.equal(
    getSupabaseProjectRef(`postgresql://postgres.${projectRef}:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres`),
    projectRef
  );
});

test("normalizes pooler project references to lowercase", () => {
  assert.equal(
    getSupabaseProjectRef("postgresql://postgres.ABCDEFGHIJKLMNOPQRST:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres"),
    projectRef
  );
});

test("returns null for non-Supabase hosts", () => {
  assert.equal(getSupabaseProjectRef("postgresql://user:secret@db.example.com:5432/app"), null);
});

test("fails closed for malformed connection URLs", () => {
  assert.throws(() => getSupabaseProjectRef("not-a-database-url"), /Invalid database URL/);
});
