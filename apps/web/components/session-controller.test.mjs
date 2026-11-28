import test from "node:test";
import assert from "node:assert/strict";
import { createSessionController } from "./session-controller.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const userA = { username: "worker-a", permissions: ["tasks.read"] };
const userB = { username: "manager-b", permissions: ["payroll.read"] };

test("parallel initial consumers share one session request", async () => {
  const pending = deferred();
  let calls = 0;
  const controller = createSessionController(() => {
    calls += 1;
    return pending.promise;
  }, () => {});
  const first = controller.ensureSession();
  const second = controller.ensureSession();
  assert.equal(calls, 1);
  pending.resolve(userA);
  await Promise.all([first, second]);
  assert.deepEqual(controller.getSnapshot(), { session: userA, ready: true });
});

test("account switch ignores a response from the previous account", async () => {
  const oldRequest = deferred();
  const newRequest = deferred();
  let calls = 0;
  const snapshots = [];
  const controller = createSessionController(
    () => (++calls === 1 ? oldRequest.promise : newRequest.promise),
    snapshot => snapshots.push(snapshot),
  );

  const oldLoad = controller.ensureSession();
  const switchLoad = controller.sessionChanged("login");
  newRequest.resolve(userB);
  await switchLoad;
  oldRequest.resolve(userA);
  await oldLoad;

  assert.deepEqual(controller.getSnapshot(), { session: userB, ready: true });
  assert.equal(snapshots.some(x => x.session?.username === userA.username), false);
});

test("logout while auth/me is in flight prevents late session resurrection", async () => {
  const pending = deferred();
  const controller = createSessionController(() => pending.promise, () => {});
  const loading = controller.ensureSession();
  controller.sessionChanged("logout");
  pending.resolve(userA);
  await loading;
  assert.deepEqual(controller.getSnapshot(), { session: null, ready: true });
});

test("401/session expiry invalidates an in-flight auth/me response", async () => {
  const pending = deferred();
  const controller = createSessionController(() => pending.promise, () => {});
  const loading = controller.ensureSession();
  controller.sessionExpired();
  pending.resolve(userA);
  await loading;
  assert.deepEqual(controller.getSnapshot(), { session: null, ready: true });
});

test("a forced refresh supersedes an earlier request and stale failures are ignored", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const controller = createSessionController(
    () => (++calls === 1 ? first.promise : second.promise),
    () => {},
  );
  const initial = controller.ensureSession();
  const forced = controller.refresh(true);
  second.resolve(userB);
  await forced;
  first.reject(new Error("stale request failed"));
  await initial;
  assert.deepEqual(controller.getSnapshot(), { session: userB, ready: true });
});

test("a fresh session avoids another request; stale session revalidates after two minutes", async () => {
  let now = 10_000;
  let calls = 0;
  const controller = createSessionController(
    async () => { calls += 1; return userA; },
    () => {},
    () => now,
  );
  await controller.ensureSession();
  await controller.ensureSession();
  assert.equal(calls, 1);
  now += 120_000;
  await controller.ensureSession();
  assert.equal(calls, 2);
});
