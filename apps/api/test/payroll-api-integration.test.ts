import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const adminUrl = process.env.TEST_DATABASE_URL;
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertDisposableDatabaseUrl(connectionString: string) {
  const url = new URL(connectionString);
  assert.ok(
    url.protocol === "postgres:" || url.protocol === "postgresql:",
    "TEST_DATABASE_URL must use PostgreSQL"
  );
  assert.ok(
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase()),
    "TEST_DATABASE_URL must point to a local disposable PostgreSQL test server"
  );
  assert.equal(
    url.pathname.slice(1),
    "postgres",
    "TEST_DATABASE_URL must use the disposable admin database named postgres"
  );
}

test("payroll HTTP routes enforce approval, partial/full payment, overpayment and concurrent payment safety", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl, "TEST_DATABASE_URL must point to a disposable PostgreSQL test server");
  assertDisposableDatabaseUrl(adminUrl);
  const name = "tezkar_payroll_api_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const target = new URL(adminUrl);
  target.pathname = "/" + name;
  let apiPool: typeof import("../src/db/pool.js").pool | undefined;

  try {
    const migration = spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate.ts"], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: target.toString() },
      encoding: "utf8"
    });
    assert.equal(migration.status, 0, migration.stderr || migration.stdout);

    // Configure the API's singleton DB pool before importing route modules.
    process.env.DATABASE_URL = target.toString();
    process.env.WEB_ORIGIN = "http://localhost:3000";
    process.env.SESSION_SECRET = "test-only-session-secret-that-is-long-enough";
    process.env.NODE_ENV = "test";

    const [{ default: Fastify }, { default: cookie }, { authRoutes }, { payrollRoutes }, { attendanceRoutes }, { operationsMasterRoutes }, { advanceRoutes }, { accountingRoutes }, { employeeRoutes }, { userRoutes }, { accountRoutes }, { hashPassword }, { authenticateRequest }, poolModule] =
      await Promise.all([
        import("fastify"),
        import("@fastify/cookie"),
        import("../src/modules/auth/auth.routes.js"),
        import("../src/modules/payroll/payroll.routes.js"),
        import("../src/modules/attendance/attendance.routes.js"),
        import("../src/modules/operations-master/operations-master.routes.js"),
        import("../src/modules/advances/advances.routes.js"),
        import("../src/modules/accounting/accounting.routes.js"),
        import("../src/modules/employees/employees.routes.js"),
        import("../src/modules/users/users.routes.js"),
        import("../src/modules/auth/account.routes.js"),
        import("../src/modules/auth/auth.service.js"),
        import("../src/modules/auth/auth.middleware.js"),
        import("../src/db/pool.js")
      ]);
    apiPool = poolModule.pool;

    const app = Fastify();
    await app.register(cookie, { secret: process.env.SESSION_SECRET });
    app.setErrorHandler((error, _request, reply) => {
      const status = typeof error.statusCode === "number" && error.statusCode < 500 ? error.statusCode : 500;
      reply.code(status).send({ error: { code: error.code ?? "ERROR", message: error.message } });
    });
    await app.register(authRoutes);
    await app.register(payrollRoutes);
    await app.register(attendanceRoutes);
    await app.register(operationsMasterRoutes);
    await app.register(advanceRoutes);
    await app.register(accountingRoutes);
    await app.register(employeeRoutes);
    await app.register(userRoutes);
    await app.register(accountRoutes);

    let invalidSessionHandlerExecuted = false;
    app.get("/test/auth-only", { preHandler: [authenticateRequest] }, async () => {
      invalidSessionHandlerExecuted = true;
      return { ok: true };
    });

    try {
      const employeeA = await apiPool.query(
        "INSERT INTO employees(full_name) VALUES ('Payroll API Employee A') RETURNING id"
      );
      const employeeB = await apiPool.query(
        "INSERT INTO employees(full_name) VALUES ('Payroll API Employee B') RETURNING id"
      );
      const password = "Test-Only-Password-2026!";
      const userResult = await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES ($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
        ["payroll-api-" + randomBytes(5).toString("hex"), hashPassword(password), employeeA.rows[0].id]
      );
      const userId = userResult.rows[0].id;
      for (const employeeId of [employeeA.rows[0].id, employeeB.rows[0].id]) {
        for (let weekday = 0; weekday < 7; weekday++) {
          await apiPool.query(
            "INSERT INTO attendance_weekly_schedule_versions(employee_id,weekday,starts_at,ends_at,is_day_off,effective_from,created_by) VALUES($1,$2,'08:00','16:00',FALSE,'2099-01-01',$3)",
            [employeeId, weekday, userId]
          );
        }
      }
      const secondUserResult = await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES ($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
        ["payroll-api-reviewer-" + randomBytes(5).toString("hex"), hashPassword(password), employeeB.rows[0].id]
      );
      const secondUserId = secondUserResult.rows[0].id;
      await apiPool.query(
        "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='manager' ON CONFLICT DO NOTHING",
        [userId]
      );
      // Ensure this synthetic manager has every permission, including payroll routes.
      await apiPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='manager' ON CONFLICT DO NOTHING"
      );
      await apiPool.query(
        "INSERT INTO cash_custody_transactions(employee_id,direction,amount,description,created_by) VALUES($1,'IN',10000,'test opening custody for payroll payments',$2)",
        [employeeA.rows[0].id,userId]
      );

      await apiPool.query(
        "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2 ON CONFLICT DO NOTHING",
        [secondUserId, "manager"]
      );
      const secondLogin = await app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { username: (await apiPool.query("SELECT username FROM users WHERE id=$1", [secondUserId])).rows[0].username, password }
      });
      assert.equal(secondLogin.statusCode, 200, secondLogin.body);
      const secondSetCookie = secondLogin.headers["set-cookie"];
      assert.ok(secondSetCookie, "reviewer login must issue a session cookie");
      const secondCookieHeader = (Array.isArray(secondSetCookie) ? secondSetCookie[0] : secondSetCookie).split(";")[0];




      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: (await apiPool.query("SELECT username FROM users WHERE id=$1", [userId])).rows[0].username, password }
      });
      assert.equal(login.statusCode, 200, login.body);
      const setCookie = login.headers["set-cookie"];
      assert.ok(setCookie, "login must issue a session cookie");
      const cookieHeader = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];


      // Employee permission requests: identity and financial classification are server-controlled.
      const permissionEmployee=await apiPool.query("INSERT INTO employees(full_name) VALUES($1) RETURNING id",["Attendance Permission Integration Employee"]);
      const permissionUser=await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id,username",
        ["attendance-permission-"+randomBytes(5).toString("hex"),hashPassword(password),permissionEmployee.rows[0].id]
      );
      await apiPool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='worker'",[permissionUser.rows[0].id]);
      // Give the permission employee a historical scheduled day so the report/payroll path
      // can verify that approved PAID and UNPAID requests are reflected in attendance minutes.
      for(let weekday=0;weekday<7;weekday++)await apiPool.query(
        "INSERT INTO attendance_weekly_schedule_versions(employee_id,weekday,starts_at,ends_at,is_day_off,effective_from,created_by) VALUES($1,$2,'08:00','16:00',FALSE,'2026-01-01',$3)",
        [permissionEmployee.rows[0].id,weekday,permissionUser.rows[0].id]
      );
      const permissionLogin=await app.inject({method:"POST",url:"/api/auth/login",payload:{username:permissionUser.rows[0].username,password}});
      assert.equal(permissionLogin.statusCode,200,permissionLogin.body);
      const permissionSetCookie=permissionLogin.headers["set-cookie"];
      assert.ok(permissionSetCookie,"employee permission login must issue a session cookie");
      const permissionCookie=(Array.isArray(permissionSetCookie)?permissionSetCookie[0]:permissionSetCookie).split(";")[0];
      const permissionDate="2026-11-04";
      const permissionRequest=async(startsAt:string,endsAt:string)=>app.inject({
        method:"POST",url:"/api/attendance/permissions",headers:{cookie:permissionCookie},
        payload:{date:permissionDate,startsAt,endsAt,reason:"Personal appointment"}
      });

      const forgedPermission=await app.inject({
        method:"POST",url:"/api/attendance/permissions",headers:{cookie:permissionCookie},
        payload:{date:permissionDate,startsAt:"08:00",endsAt:"09:00",reason:"Personal appointment",employeeId:employeeB.rows[0].id,type:"PAID",status:"APPROVED"}
      });
      assert.equal(forgedPermission.statusCode,422,"employees must not choose identity, approval status or paid/unpaid classification");
      const ownPermissionList=await app.inject({method:"GET",url:"/api/attendance/permissions/my",headers:{cookie:permissionCookie}});
      assert.equal(ownPermissionList.statusCode,200,ownPermissionList.body);
      assert.equal(ownPermissionList.json().data.length,0);
      const deniedGlobalPermissionList=await app.inject({method:"GET",url:"/api/attendance/permissions",headers:{cookie:permissionCookie}});
      assert.equal(deniedGlobalPermissionList.statusCode,403,"employees may only view their own permission requests");

      const paidPermission=await permissionRequest("08:00","09:00");
      assert.equal(paidPermission.statusCode,201,paidPermission.body);
      const paidPermissionRow=paidPermission.json().data;
      assert.equal(paidPermissionRow.employee_id,permissionEmployee.rows[0].id);
      assert.equal(paidPermissionRow.requested_by,permissionUser.rows[0].id);
      assert.equal(paidPermissionRow.permission_type,null);
      assert.equal(paidPermissionRow.status,"PENDING");
      const paidReview=await app.inject({
        method:"POST",url:`/api/attendance/permissions/${paidPermissionRow.id}/review`,headers:{cookie:cookieHeader},
        payload:{decision:"APPROVED",permissionType:"PAID"}
      });
      assert.equal(paidReview.statusCode,200,paidReview.body);
      assert.equal(paidReview.json().data.status,"APPROVED");
      assert.equal(paidReview.json().data.permission_type,"PAID");

      const unpaidPermission=await permissionRequest("09:00","10:00");
      assert.equal(unpaidPermission.statusCode,201,unpaidPermission.body);
      const unpaidPermissionRow=unpaidPermission.json().data;
      const unpaidReview=await app.inject({
        method:"POST",url:`/api/attendance/permissions/${unpaidPermissionRow.id}/review`,headers:{cookie:cookieHeader},
        payload:{decision:"APPROVED",permissionType:"UNPAID"}
      });
      assert.equal(unpaidReview.statusCode,200,unpaidReview.body);
      assert.equal(unpaidReview.json().data.permission_type,"UNPAID");

      const rejectedPermission=await permissionRequest("10:00","11:00");
      assert.equal(rejectedPermission.statusCode,201,rejectedPermission.body);
      const rejectedPermissionRow=rejectedPermission.json().data;
      const invalidRejectedReview=await app.inject({
        method:"POST",url:`/api/attendance/permissions/${rejectedPermissionRow.id}/review`,headers:{cookie:cookieHeader},
        payload:{decision:"REJECTED",permissionType:"PAID"}
      });
      assert.equal(invalidRejectedReview.statusCode,422,"rejected requests cannot carry a financial classification");
      const rejectedReview=await app.inject({
        method:"POST",url:`/api/attendance/permissions/${rejectedPermissionRow.id}/review`,headers:{cookie:cookieHeader},
        payload:{decision:"REJECTED"}
      });
      assert.equal(rejectedReview.statusCode,200,rejectedReview.body);
      assert.equal(rejectedReview.json().data.status,"REJECTED");
      assert.equal(rejectedReview.json().data.permission_type,null);

      const cancelledPermission=await permissionRequest("11:00","12:00");
      assert.equal(cancelledPermission.statusCode,201,cancelledPermission.body);
      const cancelledPermissionRow=cancelledPermission.json().data;
      const cancelled=await app.inject({
        method:"POST",url:`/api/attendance/permissions/${cancelledPermissionRow.id}/cancel`,headers:{cookie:permissionCookie}
      });
      assert.equal(cancelled.statusCode,200,cancelled.body);
      assert.equal(cancelled.json().data.status,"CANCELLED");
      assert.equal(cancelled.json().data.permission_type,null);

      const overlapPermission=await permissionRequest("08:30","09:30");
      assert.equal(overlapPermission.statusCode,409,"a new request cannot overlap an already approved permission");
      assert.equal(overlapPermission.json().error.code,"PERMISSION_OVERLAP");
      const refreshedOwnPermissions=await app.inject({method:"GET",url:"/api/attendance/permissions/my",headers:{cookie:permissionCookie}});
      assert.equal(refreshedOwnPermissions.statusCode,200,refreshedOwnPermissions.body);
      assert.equal(refreshedOwnPermissions.json().data.length,4,"employees should see only their own requests across all statuses");

      const permissionAttendanceReport=await app.inject({
        method:"GET",url:`/api/attendance/report?from=${permissionDate}&to=${permissionDate}`,headers:{cookie:cookieHeader}
      });
      assert.equal(permissionAttendanceReport.statusCode,200,permissionAttendanceReport.body);
      const permissionAttendanceDay=permissionAttendanceReport.json().data.find((day:{employeeId:string})=>day.employeeId===permissionEmployee.rows[0].id);
      assert.ok(permissionAttendanceDay,"approved permission employee must appear in the attendance report");
      assert.equal(permissionAttendanceDay.status,"ABSENT");
      assert.equal(permissionAttendanceDay.paidPermissionMinutes,60,"approved paid permission minutes must be included in attendance reporting");
      assert.equal(permissionAttendanceDay.unpaidPermissionMinutes,60,"approved unpaid permission minutes must be included in attendance reporting");
      assert.equal(permissionAttendanceDay.permissionMinutes,120,"rejected and cancelled requests must not affect attendance reporting");

      const passwordResetEmployee=await apiPool.query("INSERT INTO employees(full_name) VALUES('Password Reset Integration Employee') RETURNING id");
      const passwordResetUser=await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
        ["password-reset-"+randomBytes(5).toString("hex"),hashPassword(password),passwordResetEmployee.rows[0].id]
      );
      await apiPool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='worker'",[passwordResetUser.rows[0].id]);
      const oldSession=await apiPool.query(
        "INSERT INTO user_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day') RETURNING id",
        [passwordResetUser.rows[0].id,randomBytes(32).toString("hex")]
      );
      const nonAdminUser=await apiPool.query(
        "INSERT INTO users(username,password_hash,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,TRUE,FALSE,FALSE) RETURNING id,username",
        ["password-reset-denied-"+randomBytes(5).toString("hex"),hashPassword(password)]
      );
      await apiPool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='worker'",[nonAdminUser.rows[0].id]);
      // Give this non-admin role the route permission so the request reaches the explicit system-manager guard.
      await apiPool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code='users.edit' WHERE r.code='worker' ON CONFLICT DO NOTHING");
      const nonAdminLogin=await app.inject({method:"POST",url:"/api/auth/login",payload:{username:nonAdminUser.rows[0].username,password}});
      assert.equal(nonAdminLogin.statusCode,200,nonAdminLogin.body);
      const nonAdminSetCookie=nonAdminLogin.headers["set-cookie"];
      assert.ok(nonAdminSetCookie,"non-admin login must issue a session cookie");
      const nonAdminCookie=(Array.isArray(nonAdminSetCookie)?nonAdminSetCookie[0]:nonAdminSetCookie).split(";")[0];
      await apiPool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code IN ('users.create','employees.create','employees.edit') WHERE r.code='worker' ON CONFLICT DO NOTHING");
      const deniedEmployeeRoleChange=await app.inject({
        method:"PATCH",url:`/api/employees/${passwordResetEmployee.rows[0].id}`,headers:{cookie:nonAdminCookie},
        payload:{roleCode:"manager"}
      });
      assert.equal(deniedEmployeeRoleChange.statusCode,403,deniedEmployeeRoleChange.body);
      assert.equal(deniedEmployeeRoleChange.json().error.code,"RBAC_ADMIN_REQUIRED");
      assert.equal((await apiPool.query(
        "SELECT r.code FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1",
        [passwordResetUser.rows[0].id]
      )).rows[0].code,"worker","employee editing must not bypass privileged role assignment protection");

      const attemptedManagerUsername="privilege-escalation-"+randomBytes(5).toString("hex");
      const deniedManagerCreation=await app.inject({
        method:"POST",url:"/api/users",headers:{cookie:nonAdminCookie},
        payload:{username:attemptedManagerUsername,password:"Test-Only-Password-2026!",roleCode:"manager"}
      });
      assert.equal(deniedManagerCreation.statusCode,403,deniedManagerCreation.body);
      assert.equal(deniedManagerCreation.json().error.code,"RBAC_ADMIN_REQUIRED");
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM users WHERE username=$1",[attemptedManagerUsername])).rows[0].count),0,
        "non-admin account creators must not be able to assign the system manager role through the API");
      const attemptedShiftLeaderUsername="privileged-role-escalation-"+randomBytes(5).toString("hex");
      const deniedShiftLeaderCreation=await app.inject({
        method:"POST",url:"/api/users",headers:{cookie:nonAdminCookie},
        payload:{username:attemptedShiftLeaderUsername,password:"Test-Only-Password-2026!",roleCode:"shift_leader"}
      });
      assert.equal(deniedShiftLeaderCreation.statusCode,403,deniedShiftLeaderCreation.body);
      assert.equal(deniedShiftLeaderCreation.json().error.code,"RBAC_ADMIN_REQUIRED");
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM users WHERE username=$1",[attemptedShiftLeaderUsername])).rows[0].count),0,
        "non-admin account creators must not assign privileged system operational roles either");
      await apiPool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code='employees.create' WHERE r.code='worker' ON CONFLICT DO NOTHING");
      const attemptedPrivilegedEmployeeName="Privilege escalation employee "+randomBytes(5).toString("hex");
      const deniedPrivilegedEmployee=await app.inject({
        method:"POST",url:"/api/employees",headers:{cookie:nonAdminCookie},
        payload:{fullName:attemptedPrivilegedEmployeeName,roleCode:"manager"}
      });
      assert.equal(deniedPrivilegedEmployee.statusCode,403,deniedPrivilegedEmployee.body);
      assert.equal(deniedPrivilegedEmployee.json().error.code,"RBAC_ADMIN_REQUIRED");
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM employees WHERE full_name=$1",[attemptedPrivilegedEmployeeName])).rows[0].count),0,
        "employee creation must not bypass privileged role assignment protection");

      const deactivationEmployee=await apiPool.query("INSERT INTO employees(full_name) VALUES('Session Revocation On Employee Deactivation') RETURNING id");
      const deactivationUser=await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id,username",
        ["deactivate-session-"+randomBytes(5).toString("hex"),hashPassword(password),deactivationEmployee.rows[0].id]
      );
      await apiPool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='worker'",[deactivationUser.rows[0].id]);
      const deactivationLogin=await app.inject({method:"POST",url:"/api/auth/login",payload:{username:deactivationUser.rows[0].username,password}});
      assert.equal(deactivationLogin.statusCode,200,deactivationLogin.body);
      const deactivationSetCookie=deactivationLogin.headers["set-cookie"];
      assert.ok(deactivationSetCookie,"employee login must issue a session cookie");
      const deactivationCookie=(Array.isArray(deactivationSetCookie)?deactivationSetCookie[0]:deactivationSetCookie).split(";")[0];
      const deactivationSession=await apiPool.query("SELECT id FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL",[deactivationUser.rows[0].id]);
      assert.equal(deactivationSession.rowCount,1);
      const employeeDeactivated=await app.inject({method:"DELETE",url:"/api/employees/"+deactivationEmployee.rows[0].id,headers:{cookie:cookieHeader}});
      assert.equal(employeeDeactivated.statusCode,200,employeeDeactivated.body);
      assert.ok((await apiPool.query("SELECT revoked_at FROM user_sessions WHERE id=$1",[deactivationSession.rows[0].id])).rows[0].revoked_at,
        "deactivating an employee must revoke every existing login session");
      // Simulate legacy inconsistent data from before session revocation existed.
      await apiPool.query("UPDATE users SET is_active=TRUE WHERE id=$1",[deactivationUser.rows[0].id]);
      await apiPool.query("UPDATE user_sessions SET revoked_at=NULL WHERE id=$1",[deactivationSession.rows[0].id]);
      const legacyInactiveEmployeeLogin=await app.inject({
        method:"POST",url:"/api/auth/login",payload:{username:deactivationUser.rows[0].username,password}
      });
      assert.equal(legacyInactiveEmployeeLogin.statusCode,401,
        "an active login account must still be rejected when its linked employee is inactive");
      const legacyInactiveEmployeeSession=await app.inject({method:"GET",url:"/test/auth-only",headers:{cookie:deactivationCookie}});
      assert.equal(legacyInactiveEmployeeSession.statusCode,401,
        "legacy sessions must remain invalid while the linked employee is inactive");
      await apiPool.query("UPDATE user_sessions SET revoked_at=now() WHERE id=$1",[deactivationSession.rows[0].id]);
      await apiPool.query("UPDATE users SET is_active=FALSE WHERE id=$1",[deactivationUser.rows[0].id]);
      const blockedAccountReactivation=await app.inject({
        method:"PATCH",url:"/api/users/"+deactivationUser.rows[0].id,headers:{cookie:cookieHeader},payload:{isActive:true}
      });
      assert.equal(blockedAccountReactivation.statusCode,409,blockedAccountReactivation.body);
      assert.equal(blockedAccountReactivation.json().error.code,"EMPLOYEE_INACTIVE",
        "account management must not reactivate an account while its employee record is inactive");
      const employeeReactivated=await app.inject({method:"POST",url:"/api/employees/"+deactivationEmployee.rows[0].id+"/activate",headers:{cookie:cookieHeader}});
      assert.equal(employeeReactivated.statusCode,200,employeeReactivated.body);
      const oldSessionAfterReactivation=await app.inject({method:"GET",url:"/test/auth-only",headers:{cookie:deactivationCookie}});
      assert.equal(oldSessionAfterReactivation.statusCode,401,oldSessionAfterReactivation.body,
        "reactivating an employee must never restore a session revoked during deactivation");
      const reactivatedLogin=await app.inject({method:"POST",url:"/api/auth/login",payload:{username:deactivationUser.rows[0].username,password}});
      assert.equal(reactivatedLogin.statusCode,200,reactivatedLogin.body);
      const reactivatedSetCookie=reactivatedLogin.headers["set-cookie"];
      const reactivatedCookie=(Array.isArray(reactivatedSetCookie)?reactivatedSetCookie[0]:reactivatedSetCookie).split(";")[0];
      const reactivatedSession=await apiPool.query("SELECT id FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL LIMIT 1",[deactivationUser.rows[0].id]);
      const accountDeactivated=await app.inject({method:"DELETE",url:"/api/users/"+deactivationUser.rows[0].id,headers:{cookie:cookieHeader}});
      assert.equal(accountDeactivated.statusCode,200,accountDeactivated.body);
      assert.ok((await apiPool.query("SELECT revoked_at FROM user_sessions WHERE id=$1",[reactivatedSession.rows[0].id])).rows[0].revoked_at,
        "deactivating an account from account management must revoke all sessions");
      const accountReactivated=await app.inject({method:"PATCH",url:"/api/users/"+deactivationUser.rows[0].id,headers:{cookie:cookieHeader},payload:{isActive:true}});
      assert.equal(accountReactivated.statusCode,200,accountReactivated.body);
      const oldAccountSession=await app.inject({method:"GET",url:"/test/auth-only",headers:{cookie:reactivatedCookie}});
      assert.equal(oldAccountSession.statusCode,401,oldAccountSession.body,
        "reactivating an account must not revive its revoked sessions");

      const privilegedInactiveEmployee=await apiPool.query("INSERT INTO employees(full_name,is_active) VALUES('Inactive Privileged Account Employee',TRUE) RETURNING id");
      const privilegedInactiveUser=await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,FALSE,FALSE,FALSE) RETURNING id",
        ["inactive-privileged-"+randomBytes(5).toString("hex"),hashPassword(password),privilegedInactiveEmployee.rows[0].id]
      );
      await apiPool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='manager'",[privilegedInactiveUser.rows[0].id]);
      const deniedPrivilegedAccountActivation=await app.inject({
        method:"PATCH",url:"/api/users/"+privilegedInactiveUser.rows[0].id,headers:{cookie:nonAdminCookie},payload:{isActive:true}
      });
      assert.equal(deniedPrivilegedAccountActivation.statusCode,403,deniedPrivilegedAccountActivation.body);
      assert.equal(deniedPrivilegedAccountActivation.json().error.code,"RBAC_ADMIN_REQUIRED");
      const deniedPrivilegedEmployeeActivation=await app.inject({
        method:"POST",url:"/api/employees/"+privilegedInactiveEmployee.rows[0].id+"/activate",headers:{cookie:nonAdminCookie}
      });
      assert.equal(deniedPrivilegedEmployeeActivation.statusCode,403,deniedPrivilegedEmployeeActivation.body);
      assert.equal(deniedPrivilegedEmployeeActivation.json().error.code,"RBAC_ADMIN_REQUIRED");
      assert.equal((await apiPool.query("SELECT is_active FROM users WHERE id=$1",[privilegedInactiveUser.rows[0].id])).rows[0].is_active,false);
      assert.equal((await apiPool.query("SELECT is_active FROM employees WHERE id=$1",[privilegedInactiveEmployee.rows[0].id])).rows[0].is_active,true);

      const accountResetEmployee=await apiPool.query("INSERT INTO employees(full_name) VALUES('Account Settings Password Reset Employee') RETURNING id");
      const accountResetUser=await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
        ["account-password-reset-"+randomBytes(5).toString("hex"),hashPassword(password),accountResetEmployee.rows[0].id]
      );
      await apiPool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='worker'",[accountResetUser.rows[0].id]);
      const accountOldSession=await apiPool.query(
        "INSERT INTO user_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day') RETURNING id",
        [accountResetUser.rows[0].id,randomBytes(32).toString("hex")]
      );
      const deniedAccountReset=await app.inject({
        method:"POST",url:"/api/users/"+accountResetUser.rows[0].id+"/reset-password",
        headers:{cookie:nonAdminCookie}
      });
      assert.equal(deniedAccountReset.statusCode,403,deniedAccountReset.body);
      assert.equal(deniedAccountReset.json().error.code,"RBAC_ADMIN_REQUIRED");
      assert.equal((await apiPool.query("SELECT must_change_password FROM users WHERE id=$1",[accountResetUser.rows[0].id])).rows[0].must_change_password,false);
      const accountResetResponse=await app.inject({
        method:"POST",url:"/api/users/"+accountResetUser.rows[0].id+"/reset-password",
        headers:{cookie:cookieHeader}
      });
      assert.equal(accountResetResponse.statusCode,200,accountResetResponse.body);
      assert.ok(accountResetResponse.json().data.temporaryPassword.length>=20);
      assert.equal((await apiPool.query("SELECT must_change_password FROM users WHERE id=$1",[accountResetUser.rows[0].id])).rows[0].must_change_password,true);
      assert.ok((await apiPool.query("SELECT revoked_at FROM user_sessions WHERE id=$1",[accountOldSession.rows[0].id])).rows[0].revoked_at);
      assert.equal((await apiPool.query("SELECT COUNT(*)::int AS count FROM user_notifications WHERE user_id=$1 AND type='PASSWORD_RESET'",[accountResetUser.rows[0].id])).rows[0].count,1);
      assert.equal((await apiPool.query("SELECT COUNT(*)::int AS count FROM audit_log WHERE entity_type='user' AND entity_id=$1 AND action='reset_password'",[accountResetUser.rows[0].id])).rows[0].count,1);
      const deniedReset=await app.inject({
        method:"POST",url:`/api/employees/${passwordResetEmployee.rows[0].id}/reset-password`,
        headers:{cookie:nonAdminCookie}
      });
      assert.equal(deniedReset.statusCode,403,deniedReset.body);
      assert.equal(deniedReset.json().error.code,"RBAC_ADMIN_REQUIRED",deniedReset.body,
        "a non-manager who has users.edit must still be blocked by the explicit system-manager check");
      assert.equal((await apiPool.query("SELECT must_change_password FROM users WHERE id=$1",[passwordResetUser.rows[0].id])).rows[0].must_change_password,false,
        "denied password reset must not mutate the target account");

      const resetEmployeeResponse=await app.inject({
        method:"POST",url:`/api/employees/${passwordResetEmployee.rows[0].id}/reset-password`,
        headers:{cookie:cookieHeader}
      });
      assert.equal(resetEmployeeResponse.statusCode,200,resetEmployeeResponse.body);
      assert.equal(resetEmployeeResponse.json().data.username,(await apiPool.query("SELECT username FROM users WHERE id=$1",[passwordResetUser.rows[0].id])).rows[0].username);
      assert.ok(resetEmployeeResponse.json().data.temporaryPassword.length>=20);
      const resetUserState=await apiPool.query("SELECT must_change_password,password_hash FROM users WHERE id=$1",[passwordResetUser.rows[0].id]);
      assert.equal(resetUserState.rows[0].must_change_password,true);
      assert.notEqual(resetUserState.rows[0].password_hash,hashPassword(password));
      assert.equal((await apiPool.query("SELECT revoked_at FROM user_sessions WHERE id=$1",[oldSession.rows[0].id])).rows[0].revoked_at!==null,true);
      const forcedChangeLogin=await app.inject({method:"POST",url:"/api/auth/login",payload:{username:resetEmployeeResponse.json().data.username,password:resetEmployeeResponse.json().data.temporaryPassword}});
      assert.equal(forcedChangeLogin.statusCode,200,forcedChangeLogin.body);
      const forcedChangeSetCookie=forcedChangeLogin.headers["set-cookie"];
      assert.ok(forcedChangeSetCookie,"temporary-password login must create a session limited to password change");
      const forcedChangeCookie=(Array.isArray(forcedChangeSetCookie)?forcedChangeSetCookie[0]:forcedChangeSetCookie).split(";")[0];
      const blockedUntilPasswordChange=await app.inject({method:"GET",url:"/test/auth-only",headers:{cookie:forcedChangeCookie}});
      assert.equal(blockedUntilPasswordChange.statusCode,403,blockedUntilPasswordChange.body);
      assert.equal(blockedUntilPasswordChange.json().error.code,"PASSWORD_CHANGE_REQUIRED",
        "a temporary password must not grant access to normal protected API routes");

      const changedTemporaryPassword=await app.inject({
        method:"POST",url:"/api/account/change-password",headers:{cookie:forcedChangeCookie},
        payload:{currentPassword:resetEmployeeResponse.json().data.temporaryPassword,newPassword:"New-Password-2026!",confirmPassword:"New-Password-2026!"}
      });
      assert.equal(changedTemporaryPassword.statusCode,200,changedTemporaryPassword.body);
      assert.equal((await apiPool.query("SELECT must_change_password FROM users WHERE id=$1",[passwordResetUser.rows[0].id])).rows[0].must_change_password,false,
        "changing the temporary password must clear the forced-change flag");
      const newPasswordLogin=await app.inject({
        method:"POST",url:"/api/auth/login",
        payload:{username:resetEmployeeResponse.json().data.username,password:"New-Password-2026!"}
      });
      assert.equal(newPasswordLogin.statusCode,200,newPasswordLogin.body);
      const newPasswordCookieHeader=newPasswordLogin.headers["set-cookie"];
      assert.ok(newPasswordCookieHeader,"new password login must issue a fresh session");
      const newPasswordCookie=(Array.isArray(newPasswordCookieHeader)?newPasswordCookieHeader[0]:newPasswordCookieHeader).split(";")[0];
      const allowedAfterChange=await app.inject({method:"GET",url:"/test/auth-only",headers:{cookie:newPasswordCookie}});
      assert.equal(allowedAfterChange.statusCode,200,allowedAfterChange.body,
        "the account must regain normal protected API access after changing the temporary password");
      invalidSessionHandlerExecuted=false;
      const resetNotification=await apiPool.query("SELECT type,title,entity_type,entity_id FROM user_notifications WHERE user_id=$1 AND type='PASSWORD_RESET' LIMIT 1",[passwordResetUser.rows[0].id]);
      assert.equal(resetNotification.rowCount,1,"successful employee password reset must create a schema-compatible notification");
      assert.equal(resetNotification.rows[0].entity_type,"user");
      assert.equal(resetNotification.rows[0].entity_id,passwordResetUser.rows[0].id);
      assert.equal((await apiPool.query("SELECT COUNT(*)::int AS count FROM audit_log WHERE entity_type='employee' AND entity_id=$1 AND action='reset_password'",[passwordResetEmployee.rows[0].id])).rows[0].count,1,
        "successful password reset must be audited");

      const unauthenticated = await app.inject({
        method: "POST", url: "/api/payroll/periods/00000000-0000-0000-0000-000000000000/approve"
      });
      assert.equal(unauthenticated.statusCode, 401);

      const invalidSession = await app.inject({
        method: "GET", url: "/test/auth-only", headers: { cookie: "tezkar_session=invalid-session-token" }
      });
      assert.equal(invalidSession.statusCode, 401, invalidSession.body);
      assert.equal(invalidSessionHandlerExecuted, false, "invalid sessions must stop before route handlers run");

      // Multiple leaders may serve one shift, and the same employee may lead multiple shifts.
      const rateGroup = await apiPool.query(
        "INSERT INTO rate_groups(name) VALUES($1) RETURNING id",
        ["Shift test group " + randomBytes(4).toString("hex")]
      );
      async function createShift(name: string) {
        const response = await app.inject({
          method: "POST", url: "/api/shifts", headers: { cookie: cookieHeader },
          payload: { name, startTime: "08:00", endTime: "16:00", crossesMidnight: false, rateGroupId: rateGroup.rows[0].id }
        });
        assert.equal(response.statusCode, 201, response.body);
        return response.json().data.id as string;
      }
      const morningShift = await createShift("Morning test shift");
      const eveningShift = await createShift("Evening test shift");
      const leaderA = await app.inject({
        method: "POST", url: `/api/shifts/${morningShift}/leaders`, headers: { cookie: cookieHeader },
        payload: { employeeId: employeeA.rows[0].id }
      });
      assert.equal(leaderA.statusCode, 201, leaderA.body);
      const leaderB = await app.inject({
        method: "POST", url: `/api/shifts/${morningShift}/leaders`, headers: { cookie: cookieHeader },
        payload: { employeeId: employeeB.rows[0].id }
      });
      assert.equal(leaderB.statusCode, 201, leaderB.body, "a second leader must be allowed on the same shift");
      const sameEmployeeSecondShift = await app.inject({
        method: "POST", url: `/api/shifts/${eveningShift}/leaders`, headers: { cookie: cookieHeader },
        payload: { employeeId: employeeA.rows[0].id }
      });
      assert.equal(sameEmployeeSecondShift.statusCode, 201, sameEmployeeSecondShift.body);
      const employeeShiftList = await app.inject({
        method: "GET", url: `/api/employees/${employeeA.rows[0].id}/shifts`, headers: { cookie: cookieHeader }
      });
      assert.equal(employeeShiftList.statusCode, 200, employeeShiftList.body);
      assert.equal(employeeShiftList.json().data.length, 2, "the same employee may be assigned to multiple shifts");
      const leaderList = await app.inject({
        method: "GET", url: "/api/shift-leaders", headers: { cookie: cookieHeader }
      });
      assert.equal(leaderList.statusCode, 200, leaderList.body);
      assert.equal(leaderList.json().data.filter((row: {shift_id:string}) => row.shift_id === morningShift).length, 2);

      const invalidMonthQuery = await app.inject({
        method: "GET", url: "/api/payroll?month=2099-13", headers: { cookie: cookieHeader }
      });
      assert.equal(invalidMonthQuery.statusCode, 422, invalidMonthQuery.body);

      const invalidMonthGenerate = await app.inject({
        method: "POST", url: "/api/payroll/generate", headers: { cookie: cookieHeader },
        payload: { month: "2099-00" }
      });
      assert.equal(invalidMonthGenerate.statusCode, 422, invalidMonthGenerate.body);

      const zeroYearGenerate = await app.inject({
        method: "POST", url: "/api/payroll/generate", headers: { cookie: cookieHeader },
        payload: { month: "0000-01" }
      });
      assert.equal(zeroYearGenerate.statusCode, 422, zeroYearGenerate.body);

      const period = await apiPool.query(
        "INSERT INTO payroll_periods(period_month,generated_by) VALUES ('2099-01-01',$1) RETURNING id",
        [userId]
      );
      const profileA = await apiPool.query(
        "INSERT INTO employee_salary_profiles(employee_id,monthly_salary,effective_from,created_by) VALUES ($1,1000,'2020-01-01',$2) RETURNING id",
        [employeeA.rows[0].id, userId]
      );
      const profileB = await apiPool.query(
        "INSERT INTO employee_salary_profiles(employee_id,monthly_salary,effective_from,created_by) VALUES ($1,1000,'2020-01-01',$2) RETURNING id",
        [employeeB.rows[0].id, userId]
      );
      const salaryHistory = await app.inject({
        method: "GET", url: `/api/payroll/employees/${employeeA.rows[0].id}/salary-history`,
        headers: { cookie: cookieHeader }
      });
      assert.equal(salaryHistory.statusCode, 200, salaryHistory.body);
      assert.equal(salaryHistory.json().data.employee.id, employeeA.rows[0].id);
      assert.equal(salaryHistory.json().data.history.length, 1);
      assert.equal(Number(salaryHistory.json().data.history[0].monthly_salary), 1000);

      // Salary-based advance payout must appear as a debit on the employee account immediately.
      const ledgerBeforeSalaryAdvance = await apiPool.query(
        "SELECT COALESCE(SUM(credit_amount-debit_amount),0) AS balance FROM employee_earnings_ledger WHERE employee_id=$1",
        [employeeB.rows[0].id]
      );
      const salaryAdvanceCreated = await app.inject({
        method: "POST", url: "/api/advances", headers: { cookie: cookieHeader },
        payload: { employeeId: employeeB.rows[0].id, amount: 250, reason: "Salary repayment integration test", repaymentMethod: "SALARY_PERCENTAGE", salaryPercentage: 10 }
      });
      assert.equal(salaryAdvanceCreated.statusCode, 201, salaryAdvanceCreated.body);
      const salaryAdvanceId = salaryAdvanceCreated.json().data.id as string;
      const salaryAdvanceApproved = await app.inject({
        method: "POST", url: "/api/advances/" + salaryAdvanceId + "/approve", headers: { cookie: secondCookieHeader }
      });
      assert.equal(salaryAdvanceApproved.statusCode, 200, salaryAdvanceApproved.body);
      const insufficientAdvancePay=await app.inject({
        method:"POST",url:"/api/advances/"+salaryAdvanceId+"/pay",headers:{cookie:secondCookieHeader}
      });
      assert.equal(insufficientAdvancePay.statusCode,409,insufficientAdvancePay.body);
      assert.equal(insufficientAdvancePay.json().error.code,"INSUFFICIENT_CASH_CUSTODY_BALANCE");
      assert.equal((await apiPool.query("SELECT status FROM advance_requests WHERE id=$1",[salaryAdvanceId])).rows[0].status,"APPROVED",
        "insufficient custody must leave the approved advance unpaid");
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM cash_custody_transactions WHERE source_type='ADVANCE_PAYOUT' AND source_id=$1",[salaryAdvanceId])).rows[0].count),0);
      await apiPool.query(
        "INSERT INTO cash_custody_transactions(employee_id,direction,amount,description,created_by) VALUES($1,'IN',1000,'test opening custody for advance payout',$2)",
        [employeeB.rows[0].id,secondUserId]
      );
      const salaryAdvancePaid = await app.inject({
        method: "POST", url: "/api/advances/" + salaryAdvanceId + "/pay", headers: { cookie: secondCookieHeader }
      });
      assert.equal(salaryAdvancePaid.statusCode, 200, salaryAdvancePaid.body);
      assert.equal(salaryAdvancePaid.json().data.status, "PAID");
      assert.ok(salaryAdvancePaid.json().data.ledger_entry_id, "salary-based advance must debit the employee account so the negative balance is visible");
      const ledgerAfterSalaryAdvance = await apiPool.query(
        "SELECT COALESCE(SUM(credit_amount-debit_amount),0) AS balance FROM employee_earnings_ledger WHERE employee_id=$1",
        [employeeB.rows[0].id]
      );
      assert.equal(Number(ledgerAfterSalaryAdvance.rows[0].balance), Number(ledgerBeforeSalaryAdvance.rows[0].balance)-250);
      const advanceCustodyOut=await apiPool.query("SELECT direction,amount FROM cash_custody_transactions WHERE source_type='ADVANCE_PAYOUT' AND source_id=$1",[salaryAdvanceId]);
      assert.equal(advanceCustodyOut.rowCount,1);
      assert.equal(advanceCustodyOut.rows[0].direction,"OUT");
      assert.equal(Number(advanceCustodyOut.rows[0].amount),250);
      const repaymentKey=randomUUID();
      const repaymentPayload={amount:50,repaymentType:"CUSTOM" as const,notes:"early repayment integration test",idempotencyKey:repaymentKey};
      const earlyRepayment=await app.inject({
        method:"POST",url:"/api/advances/"+salaryAdvanceId+"/repayments",headers:{cookie:secondCookieHeader},
        payload:repaymentPayload
      });
      assert.equal(earlyRepayment.statusCode,201,earlyRepayment.body);
      assert.equal(Number(earlyRepayment.json().data.remaining),200);
      const replayedRepayment=await app.inject({
        method:"POST",url:"/api/advances/"+salaryAdvanceId+"/repayments",headers:{cookie:secondCookieHeader},
        payload:repaymentPayload
      });
      assert.equal(replayedRepayment.statusCode,200,replayedRepayment.body);
      assert.equal(replayedRepayment.json().data.repayment.id,earlyRepayment.json().data.repayment.id,
        "retrying the same advance repayment must replay the original repayment");
      const changedRepaymentPayload=await app.inject({
        method:"POST",url:"/api/advances/"+salaryAdvanceId+"/repayments",headers:{cookie:secondCookieHeader},
        payload:{...repaymentPayload,amount:75}
      });
      assert.equal(changedRepaymentPayload.statusCode,409,changedRepaymentPayload.body);
      assert.equal(changedRepaymentPayload.json().error.code,"IDEMPOTENCY_KEY_REUSED");
      const concurrentRepaymentKey=randomUUID();
      const concurrentRepaymentPayload={amount:25,repaymentType:"CUSTOM" as const,notes:"concurrent repayment retry",idempotencyKey:concurrentRepaymentKey};
      const concurrentRepayments=await Promise.all([1,2].map(()=>app.inject({
        method:"POST",url:"/api/advances/"+salaryAdvanceId+"/repayments",headers:{cookie:secondCookieHeader},
        payload:concurrentRepaymentPayload
      })));
      assert.deepEqual(concurrentRepayments.map(x=>x.statusCode).sort(),[200,201]);
      assert.equal(concurrentRepayments[0].json().data.repayment.id,concurrentRepayments[1].json().data.repayment.id);
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM advance_repayments WHERE idempotency_key=$1",[concurrentRepaymentKey])).rows[0].count),1);
      const advanceCustodyIn=await apiPool.query("SELECT direction,amount FROM cash_custody_transactions WHERE source_type='ADVANCE_REPAYMENT' AND source_id=$1",[earlyRepayment.json().data.repayment.id]);
      assert.equal(advanceCustodyIn.rowCount,1);
      assert.equal(advanceCustodyIn.rows[0].direction,"IN");
      assert.equal(Number(advanceCustodyIn.rows[0].amount),50);
      const concurrentRepayment=await apiPool.query("SELECT id FROM advance_repayments WHERE idempotency_key=$1",[concurrentRepaymentKey]);
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM employee_earnings_ledger WHERE advance_repayment_id=$1",[concurrentRepayment.rows[0].id])).rows[0].count),1);
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM cash_custody_transactions WHERE source_type='ADVANCE_REPAYMENT' AND source_id=$1",[concurrentRepayment.rows[0].id])).rows[0].count),1);

      // A paid, still-open advance must not block another advance; payroll can repay both.
      const secondSalaryAdvanceCreated = await app.inject({
        method: "POST", url: "/api/advances", headers: { cookie: cookieHeader },
        payload: { employeeId: employeeB.rows[0].id, amount: 125, reason: "Second salary advance integration test", repaymentMethod: "SALARY_PERCENTAGE", salaryPercentage: 5 }
      });
      assert.equal(secondSalaryAdvanceCreated.statusCode, 201, secondSalaryAdvanceCreated.body);
      const secondSalaryAdvanceId = secondSalaryAdvanceCreated.json().data.id as string;
      const secondSalaryAdvanceApproved = await app.inject({
        method: "POST", url: "/api/advances/" + secondSalaryAdvanceId + "/approve", headers: { cookie: secondCookieHeader }
      });
      assert.equal(secondSalaryAdvanceApproved.statusCode, 200, secondSalaryAdvanceApproved.body);
      const secondSalaryAdvancePaid = await app.inject({
        method: "POST", url: "/api/advances/" + secondSalaryAdvanceId + "/pay", headers: { cookie: secondCookieHeader }
      });
      assert.equal(secondSalaryAdvancePaid.statusCode, 200, secondSalaryAdvancePaid.body);
      assert.ok(secondSalaryAdvancePaid.json().data.ledger_entry_id,"every advance payout must be posted to the employee account");
      const openPaidAdvances = await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM advance_requests WHERE employee_id=$1 AND status='PAID' AND repayment_status='OPEN'",
        [employeeB.rows[0].id]
      );
      assert.equal(openPaidAdvances.rows[0].count, 2, "multiple salary advances may remain open for payroll repayment");

      // A fixed-installment advance cannot be paid until an effective salary profile exists.
      const employeeWithoutSalary = await apiPool.query(
        "INSERT INTO employees(full_name) VALUES ($1) RETURNING id", ["No Salary Profile Advance Test"]
      );
      const missingSalaryCreated = await app.inject({
        method: "POST", url: "/api/advances", headers: { cookie: cookieHeader },
        payload: { employeeId: employeeWithoutSalary.rows[0].id, amount: 100, reason: "Missing salary profile test", repaymentMethod: "FIXED_INSTALLMENT", installmentAmount: 25 }
      });
      assert.equal(missingSalaryCreated.statusCode, 201, missingSalaryCreated.body);
      const missingSalaryId = missingSalaryCreated.json().data.id as string;
      const missingSalaryApproved = await app.inject({
        method: "POST", url: "/api/advances/" + missingSalaryId + "/approve", headers: { cookie: secondCookieHeader }
      });
      assert.equal(missingSalaryApproved.statusCode, 200, missingSalaryApproved.body);
      const missingSalaryPay = await app.inject({
        method: "POST", url: "/api/advances/" + missingSalaryId + "/pay", headers: { cookie: secondCookieHeader }
      });
      assert.equal(missingSalaryPay.statusCode, 409, missingSalaryPay.body);
      assert.equal(missingSalaryPay.json().error.code, "SALARY_PROFILE_REQUIRED");
      const missingSalaryState = await apiPool.query("SELECT status,ledger_entry_id FROM advance_requests WHERE id=$1",[missingSalaryId]);
      assert.equal(missingSalaryState.rows[0].status, "APPROVED", "failed payout must roll back without changing advance status");
      assert.equal(missingSalaryState.rows[0].ledger_entry_id, null);

      const itemA = await apiPool.query(
        "INSERT INTO payroll_items(period_id,employee_id,salary_profile_id,base_salary,bonus_amount,deduction_amount) VALUES ($1,$2,$3,1000,100,100) RETURNING id",
        [period.rows[0].id, employeeA.rows[0].id, profileA.rows[0].id]
      );
      const itemB = await apiPool.query(
        "INSERT INTO payroll_items(period_id,employee_id,salary_profile_id,base_salary,bonus_amount,deduction_amount) VALUES ($1,$2,$3,1000,100,100) RETURNING id",
        [period.rows[0].id, employeeB.rows[0].id, profileB.rows[0].id]
      );
      const adjustmentLines = await apiPool.query(
        `INSERT INTO payroll_adjustment_lines(payroll_item_id,line_type,description,amount,created_by)
         VALUES ($1,'BONUS','Test bonus',100,$3),($1,'DEDUCTION','Test deduction',100,$3),
                ($2,'BONUS','Test bonus',100,$3),($2,'DEDUCTION','Test deduction',100,$3)
         RETURNING id`,
        [itemA.rows[0].id,itemB.rows[0].id,userId]
      );
      assert.equal(adjustmentLines.rowCount,4);

      // Exercise named adjustment CRUD through the HTTP API, not only fixture SQL.
      const listedAdjustments = await app.inject({
        method: "GET", url: `/api/payroll/items/${itemA.rows[0].id}/adjustments`, headers: { cookie: cookieHeader }
      });
      assert.equal(listedAdjustments.statusCode, 200, listedAdjustments.body);
      assert.equal(listedAdjustments.json().data.length, 2);
      const bonusLineId = adjustmentLines.rows[0].id;
      const editBonus = await app.inject({
        method: "PATCH", url: `/api/payroll/items/${itemA.rows[0].id}/adjustments/${bonusLineId}`,
        headers: { cookie: cookieHeader },
        payload: { lineType: "BONUS", description: "Edited test bonus", amount: 125, notes: "API edit test" }
      });
      assert.equal(editBonus.statusCode, 200, editBonus.body);
      assert.equal(Number(editBonus.json().data.amount), 125);
      const restoreBonus = await app.inject({
        method: "PATCH", url: `/api/payroll/items/${itemA.rows[0].id}/adjustments/${bonusLineId}`,
        headers: { cookie: cookieHeader },
        payload: { lineType: "BONUS", description: "Test bonus", amount: 100 }
      });
      assert.equal(restoreBonus.statusCode, 200, restoreBonus.body);
      const temporaryAdjustment = await app.inject({
        method: "POST", url: `/api/payroll/items/${itemA.rows[0].id}/adjustments`,
        headers: { cookie: cookieHeader },
        payload: { lineType: "DEDUCTION", description: "Temporary API test deduction", amount: 10 }
      });
      assert.equal(temporaryAdjustment.statusCode, 201, temporaryAdjustment.body);
      const missingVoidReason = await app.inject({
        method: "DELETE",
        url: `/api/payroll/items/${itemA.rows[0].id}/adjustments/${temporaryAdjustment.json().data.id}`,
        headers: { cookie: cookieHeader }
      });
      assert.equal(missingVoidReason.statusCode, 422, missingVoidReason.body);
      const deleteTemporaryAdjustment = await app.inject({
        method: "DELETE",
        url: `/api/payroll/items/${itemA.rows[0].id}/adjustments/${temporaryAdjustment.json().data.id}`,
        headers: { cookie: cookieHeader },
        payload: { reason: "تم إدخال الخصم بالخطأ أثناء الاختبار" }
      });
      assert.equal(deleteTemporaryAdjustment.statusCode, 200, deleteTemporaryAdjustment.body);
      assert.equal(deleteTemporaryAdjustment.json().data.voided, true);
      const voidedRow = await apiPool.query(
        "SELECT status,void_reason,voided_by,voided_at FROM payroll_adjustment_lines WHERE id=$1",
        [temporaryAdjustment.json().data.id]
      );
      assert.equal(voidedRow.rows[0].status, "VOIDED");
      assert.equal(voidedRow.rows[0].void_reason, "تم إدخال الخصم بالخطأ أثناء الاختبار");
      assert.equal(voidedRow.rows[0].voided_by, userId);
      assert.ok(voidedRow.rows[0].voided_at);
      const retainedAdjustmentHistory = await app.inject({
        method: "GET", url: `/api/payroll/items/${itemA.rows[0].id}/adjustments`, headers: { cookie: cookieHeader }
      });
      assert.equal(retainedAdjustmentHistory.statusCode, 200, retainedAdjustmentHistory.body);
      const retainedVoidedLine = retainedAdjustmentHistory.json().data.find((line: { id: string }) => line.id === temporaryAdjustment.json().data.id);
      assert.equal(retainedVoidedLine.status, "VOIDED");
      assert.equal(retainedVoidedLine.void_reason, "تم إدخال الخصم بالخطأ أثناء الاختبار");
      const editVoidedLine = await app.inject({
        method: "PATCH",
        url: `/api/payroll/items/${itemA.rows[0].id}/adjustments/${temporaryAdjustment.json().data.id}`,
        headers: { cookie: cookieHeader },
        payload: { lineType: "DEDUCTION", description: "Should not edit voided line", amount: 10 }
      });
      assert.equal(editVoidedLine.statusCode, 409, editVoidedLine.body);
      const duplicateVoid = await app.inject({
        method: "DELETE",
        url: `/api/payroll/items/${itemA.rows[0].id}/adjustments/${temporaryAdjustment.json().data.id}`,
        headers: { cookie: cookieHeader },
        payload: { reason: "محاولة إلغاء مكرر للاختبار" }
      });
      assert.equal(duplicateVoid.statusCode, 409, duplicateVoid.body);
      const voidAudit = await apiPool.query(
        "SELECT action,module,entity_type,entity_id,metadata FROM audit_log WHERE entity_id=$1 AND action='void_adjustment_line' LIMIT 1",
        [temporaryAdjustment.json().data.id]
      );
      assert.equal(voidAudit.rowCount, 1, "voiding must create one audit-log record");
      assert.equal(voidAudit.rows[0].module, "payroll");
      assert.equal(voidAudit.rows[0].entity_type, "payroll_adjustment_line");
      assert.equal(voidAudit.rows[0].metadata.reason, "تم إدخال الخصم بالخطأ أثناء الاختبار");
      const afterAdjustmentCrud = await apiPool.query(
        "SELECT bonus_amount,deduction_amount FROM payroll_items WHERE id=$1", [itemA.rows[0].id]
      );
      assert.equal(Number(afterAdjustmentCrud.rows[0].bonus_amount), 100);
      assert.equal(Number(afterAdjustmentCrud.rows[0].deduction_amount), 100);

      const beforeApproval = await app.inject({
        method: "POST", url: `/api/payroll/items/${itemA.rows[0].id}/payments`,
        headers: { cookie: cookieHeader }, payload: { idempotencyKey: randomUUID(), amount: 100 }
      });
      assert.equal(beforeApproval.statusCode, 409, beforeApproval.body);
      assert.equal(beforeApproval.json().error.code, "PAYROLL_NOT_APPROVED");

      const attendanceSnapshot = Array.from({length:31},(_,index)=>{
        const date = `2099-01-${String(index+1).padStart(2,"0")}`;
        return [
          {date,employeeId:employeeA.rows[0].id,status:"PRESENT",isDayOff:false,firstIn:null,lastOut:null,workedMinutes:0,lateMinutes:0,earlyMinutes:0,overtimeMinutes:0,paidPermissionMinutes:0,unpaidPermissionMinutes:0,needsReview:false},
          {date,employeeId:employeeB.rows[0].id,status:"PRESENT",isDayOff:false,firstIn:null,lastOut:null,workedMinutes:0,lateMinutes:0,earlyMinutes:0,overtimeMinutes:0,paidPermissionMinutes:0,unpaidPermissionMinutes:0,needsReview:false}
        ];
      }).flat();
      const pendingPayrollPunch=await apiPool.query(
        "INSERT INTO attendance_punches(employee_id,device_code,punch_at,status,verify_method,suspicious,review_status,external_key) VALUES($1,'PAYROLL-REVIEW-DEVICE',TIMESTAMP '2099-01-15 08:00:00' AT TIME ZONE 'Africa/Cairo','IN','FINGERPRINT',TRUE,'PENDING',$2) RETURNING id",
        [employeeA.rows[0].id,randomBytes(32).toString("hex")]
      );
      const blockedByPendingAttendance=await app.inject({
        method:"POST",url:`/api/payroll/periods/${period.rows[0].id}/approve`,
        headers:{cookie:cookieHeader},payload:{attendanceSnapshot}
      });
      assert.equal(blockedByPendingAttendance.statusCode,409,blockedByPendingAttendance.body);
      assert.equal(blockedByPendingAttendance.json().error.code,"ATTENDANCE_REVIEW_REQUIRED");
      await apiPool.query("UPDATE attendance_punches SET review_status='APPROVED',reviewed_by=$2,reviewed_at=now() WHERE id=$1",
        [pendingPayrollPunch.rows[0].id,userId]);
      await apiPool.query(
        "INSERT INTO attendance_punches(employee_id,device_code,punch_at,status,verify_method,suspicious,review_status,external_key) VALUES($1,'PAYROLL-REVIEW-DEVICE',TIMESTAMP '2099-01-15 16:00:00' AT TIME ZONE 'Africa/Cairo','OUT','FINGERPRINT',FALSE,'AUTO_ACCEPTED',$2)",
        [employeeA.rows[0].id,randomBytes(32).toString("hex")]
      );
      const approval = await app.inject({
        method: "POST", url: `/api/payroll/periods/${period.rows[0].id}/approve`,
        headers: { cookie: cookieHeader },
        payload: { attendanceSnapshot }
      });
      assert.equal(approval.statusCode, 200, approval.body);
      assert.equal(approval.json().data.status, "APPROVED");
      const authoritativeDay=(await apiPool.query(
        "SELECT snapshot_data FROM payroll_attendance_snapshots WHERE payroll_item_id=(SELECT id FROM payroll_items WHERE period_id=$1 AND employee_id=$2) AND attendance_date='2099-01-15'",
        [period.rows[0].id,employeeA.rows[0].id]
      )).rows[0].snapshot_data;
      assert.equal(authoritativeDay.status,"PRESENT","approval must derive the day from persisted punch records");
      assert.equal(Number(authoritativeDay.workedMinutes),480,"client-supplied zero minutes must not override the actual punch pair");
      assert.equal(Number(authoritativeDay.lateMinutes),0,"the persisted shift boundary should determine lateness");
      const approvedPayrollItemId=(await apiPool.query(
        "SELECT id FROM payroll_items WHERE period_id=$1 AND employee_id=$2",
        [period.rows[0].id,employeeA.rows[0].id]
      )).rows[0].id;
      await assert.rejects(
        apiPool.query("UPDATE payroll_attendance_snapshots SET snapshot_data=snapshot_data || jsonb_build_object('workedMinutes',0) WHERE payroll_item_id=$1 AND attendance_date='2099-01-15'",[approvedPayrollItemId]),
        {code:"55000"},
        "approved attendance snapshots must not be editable"
      );
      await assert.rejects(
        apiPool.query("DELETE FROM payroll_attendance_snapshots WHERE payroll_item_id=$1 AND attendance_date='2099-01-15'",[approvedPayrollItemId]),
        {code:"55000"},
        "approved attendance snapshots must not be deletable"
      );
      await assert.rejects(
        apiPool.query("UPDATE payroll_attendance_calculations SET calculation_data=calculation_data || jsonb_build_object('minuteRate',0) WHERE payroll_item_id=$1",[approvedPayrollItemId]),
        {code:"55000"},
        "approved attendance calculation policy must remain frozen"
      );
      const overtimePunch=(await apiPool.query(
        "INSERT INTO attendance_punches(employee_id,device_code,punch_at,status,verify_method,suspicious,review_status,external_key) VALUES($1,'PAYROLL-REVIEW-DEVICE',TIMESTAMP '2099-01-16 17:00:00' AT TIME ZONE 'Africa/Cairo','OVERTIME_IN','FINGERPRINT',FALSE,'AUTO_ACCEPTED',$2) RETURNING id",
        [employeeA.rows[0].id,randomBytes(32).toString("hex")]
      )).rows[0];
      const correctedOvertime=await app.inject({
        method:"POST",url:`/api/attendance/punches/${overtimePunch.id}/correction`,
        headers:{cookie:cookieHeader},
        payload:{decision:"APPLY_MANUAL",correctedStatus:"OVERTIME_OUT",correctedPunchAt:"2099-01-16T17:00:00+02:00",reason:"تصحيح نوع حركة إضافي في اختبار التكامل"}
      });
      assert.equal(correctedOvertime.statusCode,200,correctedOvertime.body);
      assert.equal(correctedOvertime.json().data.corrected_status,"OVERTIME_OUT");
      const frozenNextDay=(await apiPool.query(
        "SELECT snapshot_data FROM payroll_attendance_snapshots WHERE payroll_item_id=$1 AND attendance_date='2099-01-16'",
        [approvedPayrollItemId]
      )).rows[0].snapshot_data;
      assert.equal(Number(frozenNextDay.workedMinutes),0,"post-approval punch corrections must not rewrite the frozen payroll snapshot");
      const reconciliation = await app.inject({
        method: "GET", url: "/api/accounting/reconciliation/payroll", headers: { cookie: cookieHeader }
      });
      assert.equal(reconciliation.statusCode, 200, reconciliation.body);
      assert.deepEqual(reconciliation.json().data.counts,{
        missingPayrollExpenses:0,
        missingAdjustmentLedgerEntries:0,
        zeroNetPayrollSettlementMismatches:0,
        advanceRepaymentLedgerMismatches:0,
        cashPaymentsMissingCustodyOut:0,
        payrollPaymentMismatches:0,
        advanceDeductionMismatches:0,
        paidPayrollMissingAdvanceRepayments:0,
        expensesMissingCustodyLink:0,
        advanceRepaymentsMissingCustodyIn:0,
        workerPaymentReversalMismatches:0,
        workerDifferenceEventReversalMismatches:0
      },"linked payroll records should pass the read-only reconciliation checks");

      // Payroll approval must create exactly one accounting expense per non-zero payroll item.
      const linkedPayroll = await apiPool.query(
        "SELECT i.id,i.accounting_expense_id,i.net_amount,e.category,e.amount,e.payment_method,e.expense_date::text AS expense_date " +
        "FROM payroll_items i LEFT JOIN accounting_expenses e ON e.id=i.accounting_expense_id WHERE i.period_id=$1 ORDER BY i.id",
        [period.rows[0].id]
      );
      assert.equal(linkedPayroll.rowCount, 2);
      assert.ok(linkedPayroll.rows.every((row: {accounting_expense_id:string|null;category:string|null}) =>
        row.accounting_expense_id && row.category === "SALARIES"));
      assert.ok(linkedPayroll.rows.every((row: {amount:string;net_amount:string;payment_method:string;expense_date:string}) =>
        Number(row.amount) === Number(row.net_amount) && row.payment_method === "PAYROLL" &&
        String(row.expense_date).slice(0,10) === "2099-01-01"));
      const linkedAdjustments = await apiPool.query(
        `SELECT l.id,l.line_type,l.amount,e.credit_amount,e.debit_amount
           FROM payroll_adjustment_lines l
           LEFT JOIN employee_earnings_ledger e ON e.payroll_adjustment_line_id=l.id
          WHERE l.payroll_item_id IN ($1,$2) AND l.status='ACTIVE'`,
        [itemA.rows[0].id,itemB.rows[0].id]
      );
      assert.equal(linkedAdjustments.rowCount,4);
      const voidedAdjustmentLedger = await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM employee_earnings_ledger WHERE payroll_adjustment_line_id=$1",
        [temporaryAdjustment.json().data.id]
      );
      assert.equal(voidedAdjustmentLedger.rows[0].count,0,"voided payroll adjustments must never post an employee-ledger entry");
      assert.ok(linkedAdjustments.rows.every((row:{line_type:string;credit_amount:string|null;debit_amount:string|null}) =>
        row.line_type==="BONUS" ? Number(row.credit_amount)===100 && Number(row.debit_amount??0)===0
                                : Number(row.debit_amount)===100 && Number(row.credit_amount??0)===0),
        "every approved named bonus/deduction must create one matching employee-ledger entry");
      const secondApproval = await app.inject({
        method: "POST", url: `/api/payroll/periods/${period.rows[0].id}/approve`,
        headers: { cookie: cookieHeader }
      });
      assert.equal(secondApproval.statusCode, 409, secondApproval.body);
      assert.equal(secondApproval.json().error.code, "PAYROLL_PERIOD_LOCKED");
      const salaryExpenseCount = await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM accounting_expenses WHERE category='SALARIES' AND payment_method='PAYROLL' AND expense_date='2099-01-01'"
      );
      assert.equal(salaryExpenseCount.rows[0].count, 2, "re-approval must not duplicate salary expenses");

      // Fixed monthly and salary-percentage installments reduce net pay in the approved
      // payroll, but the advance balance is not reduced until the employee is actually paid.
      const fixedAdvance = await apiPool.query(
        `INSERT INTO advance_requests(employee_id,amount,reason,status,requested_by,paid_by,paid_at,repayment_method,installment_amount,repayment_status)
         VALUES($1,800,'Fixed installment integration test','PAID',$2,$2,'2099-01-15T12:00:00Z','FIXED_INSTALLMENT',300,'OPEN')
         RETURNING id`,
        [employeeA.rows[0].id,userId]
      );
      const salaryPercentageAdvance = await apiPool.query(
        `INSERT INTO advance_requests(employee_id,amount,reason,status,requested_by,paid_by,paid_at,repayment_method,salary_percentage,repayment_status)
         VALUES($1,500,'Salary percentage integration test','PAID',$2,$2,'2099-01-15T12:00:00Z','SALARY_PERCENTAGE',10,'OPEN')
         RETURNING id`,
        [employeeA.rows[0].id,userId]
      );
      await apiPool.query(
        `INSERT INTO employee_earnings_ledger(employee_id,entry_type,debit_amount,created_by,notes)
         VALUES($1,'ADJUSTMENT',800,$2,'صرف سلفة ثابتة للاختبار'),($1,'ADJUSTMENT',500,$2,'صرف سلفة نسبة راتب للاختبار')`,
        [employeeA.rows[0].id,userId]
      );
      const februaryGenerate = await app.inject({
        method: "POST", url: "/api/payroll/generate", headers: { cookie: cookieHeader },
        payload: { month: "2099-02" }
      });
      assert.equal(februaryGenerate.statusCode, 201, februaryGenerate.body);
      const februaryData = await app.inject({
        method: "GET", url: "/api/payroll?month=2099-02", headers: { cookie: cookieHeader }
      });
      assert.equal(februaryData.statusCode, 200, februaryData.body);
      const februaryItem = februaryData.json().data.items.find((row: {employee_id:string}) => row.employee_id === employeeA.rows[0].id);
      assert.ok(februaryItem, "employee with a salary profile should be included in the February payroll");
      assert.equal(Number(februaryItem.advance_repayment_amount), 400);
      assert.equal(Number(februaryItem.net_amount), 600, "fixed and salary-percentage installments reduce take-home pay without exceeding salary");
      const februaryAttendanceSnapshot = Array.from({length:28},(_,index)=>{
        const date = `2099-02-${String(index+1).padStart(2,"0")}`;
        return [
          {date,employeeId:employeeA.rows[0].id,status:"PRESENT",isDayOff:false,firstIn:null,lastOut:null,workedMinutes:0,lateMinutes:0,earlyMinutes:0,overtimeMinutes:0,paidPermissionMinutes:0,unpaidPermissionMinutes:0,needsReview:false},
          {date,employeeId:employeeB.rows[0].id,status:"PRESENT",isDayOff:false,firstIn:null,lastOut:null,workedMinutes:0,lateMinutes:0,earlyMinutes:0,overtimeMinutes:0,paidPermissionMinutes:0,unpaidPermissionMinutes:0,needsReview:false}
        ];
      }).flat();
      const februaryApproval = await app.inject({
        method: "POST", url: `/api/payroll/periods/${februaryData.json().data.period.id}/approve`,
        headers: { cookie: cookieHeader },
        payload: {attendanceSnapshot:februaryAttendanceSnapshot}
      });
      assert.equal(februaryApproval.statusCode, 200, februaryApproval.body);
      assert.equal((await apiPool.query("SELECT COUNT(*)::int AS count FROM advance_repayments WHERE advance_id=$1",[fixedAdvance.rows[0].id])).rows[0].count,0,
        "approving payroll must not repay an advance before the salary is paid");
      assert.equal((await apiPool.query("SELECT COUNT(*)::int AS count FROM advance_repayments WHERE advance_id=$1",[salaryPercentageAdvance.rows[0].id])).rows[0].count,0);

      const limitedCustodyHolder=await apiPool.query(
        "INSERT INTO employees(full_name) VALUES('Limited Payroll Custody Holder') RETURNING id"
      );
      await apiPool.query(
        "INSERT INTO cash_custody_transactions(employee_id,direction,amount,description,created_by) VALUES($1,'IN',999,'limited payroll custody test balance',$2)",
        [limitedCustodyHolder.rows[0].id,userId]
      );
      const februaryPaymentPayload={idempotencyKey:randomUUID(),amount:600,paymentMethod:"CASH",fromCustody:true,custodyEmployeeId:limitedCustodyHolder.rows[0].id};
      const insufficientPayrollCustody=await app.inject({
        method:"POST",url:`/api/payroll/items/${februaryItem.id}/payments`,
        headers:{cookie:cookieHeader},payload:februaryPaymentPayload
      });
      assert.equal(insufficientPayrollCustody.statusCode,409,insufficientPayrollCustody.body);
      assert.equal(insufficientPayrollCustody.json().error.code,"INSUFFICIENT_CASH_CUSTODY_BALANCE",
        "cash payroll must reserve the cash payment plus the advance-repayment offset");
      assert.equal((await apiPool.query("SELECT COUNT(*)::int AS count FROM payroll_payments WHERE payroll_item_id=$1",[februaryItem.id])).rows[0].count,0,
        "insufficient custody must roll back the payroll payment and advance repayments");
      await apiPool.query(
        "INSERT INTO cash_custody_transactions(employee_id,direction,amount,description,created_by) VALUES($1,'IN',1,'complete payroll custody test balance',$2)",
        [limitedCustodyHolder.rows[0].id,userId]
      );
      const februaryPayment=await app.inject({
        method:"POST",url:`/api/payroll/items/${februaryItem.id}/payments`,
        headers:{cookie:cookieHeader},payload:februaryPaymentPayload
      });
      assert.equal(februaryPayment.statusCode,201,februaryPayment.body);
      assert.equal(februaryPayment.json().data.status,"PAID");
      const salaryAccrual=await apiPool.query("SELECT credit_amount FROM employee_earnings_ledger WHERE payroll_item_id=$1",[februaryItem.id]);
      assert.equal(salaryAccrual.rowCount,1,"approved gross salary must be visible in the employee account before payout");
      assert.equal(Number(salaryAccrual.rows[0].credit_amount),1000,"the base salary must be credited independently");
      const januaryBonusLineId = adjustmentLines.rows[0].id;
      const januaryDeductionLineId = adjustmentLines.rows[1].id;
      const bonusEntry=await apiPool.query(
        "SELECT credit_amount FROM employee_earnings_ledger WHERE employee_id=$1 AND payroll_adjustment_line_id=$2",
        [employeeA.rows[0].id,januaryBonusLineId]
      );
      assert.equal(bonusEntry.rowCount,1,"January bonus must appear as a separate source-linked employee-account credit");
      assert.equal(Number(bonusEntry.rows[0].credit_amount),100);
      const deductionEntry=await apiPool.query(
        "SELECT debit_amount FROM employee_earnings_ledger WHERE employee_id=$1 AND payroll_adjustment_line_id=$2",
        [employeeA.rows[0].id,januaryDeductionLineId]
      );
      assert.equal(deductionEntry.rowCount,1,"January deduction must appear as a separate source-linked employee-account debit");
      assert.equal(Number(deductionEntry.rows[0].debit_amount),100);
      const ownPayroll=await app.inject({method:"GET",url:"/api/payroll/my-account",headers:{cookie:cookieHeader}});
      assert.equal(ownPayroll.statusCode,200,ownPayroll.body);
      assert.equal(ownPayroll.json().data.employee.id,employeeA.rows[0].id);
      assert.ok(ownPayroll.json().data.payrollItems.every((x:any)=>x.employee_id===employeeA.rows[0].id),
        "employee salary history must never include another employee");
      const ownFebruary=ownPayroll.json().data.payrollItems.find((x:any)=>String(x.period_month).slice(0,7)==="2099-02");
      assert.ok(ownFebruary,"employees should see their approved monthly payslip");
      assert.equal(Number(ownFebruary.net_amount),600);
      assert.equal(Number(ownFebruary.bonus_amount),0);
      assert.equal(Number(ownFebruary.deduction_amount),0);
      assert.equal(Number(ownFebruary.advance_repayment_amount),400);
      assert.equal(ownFebruary.payments.length,1,"employee should see actual salary payment history");
      const ownJanuary=ownPayroll.json().data.payrollItems.find((x:any)=>String(x.period_month).slice(0,7)==="2099-01");
      assert.ok(ownJanuary,"employee should see the previous approved payslip too");
      assert.equal(Number(ownJanuary.bonus_amount),100);
      assert.equal(Number(ownJanuary.deduction_amount),100);
      const salaryPaymentLedger=await apiPool.query("SELECT debit_amount FROM employee_earnings_ledger WHERE payroll_payment_id=$1",[februaryPayment.json().data.payment.id]);
      assert.equal(salaryPaymentLedger.rowCount,1,"the actual salary payment must have a linked employee-ledger entry");
      assert.equal(Number(salaryPaymentLedger.rows[0].debit_amount),1000,"the gross salary entitlement must be cleared even when only 600 cash is paid");
      const fixedRepayment = await apiPool.query(
        "SELECT amount,repayment_type,source_payroll_item_id FROM advance_repayments WHERE advance_id=$1",
        [fixedAdvance.rows[0].id]
      );
      assert.equal(fixedRepayment.rowCount,1);
      assert.equal(Number(fixedRepayment.rows[0].amount),300);
      assert.equal(fixedRepayment.rows[0].repayment_type,"FIXED_INSTALLMENT");
      assert.equal(fixedRepayment.rows[0].source_payroll_item_id,februaryItem.id);
      const fixedBalance = await apiPool.query(
        "SELECT repayment_status,amount-(SELECT COALESCE(SUM(ar.amount),0) FROM advance_repayments ar WHERE ar.advance_id=advance_requests.id) AS remaining FROM advance_requests WHERE id=$1",
        [fixedAdvance.rows[0].id]
      );
      assert.equal(fixedBalance.rows[0].repayment_status,"OPEN");
      assert.equal(Number(fixedBalance.rows[0].remaining),500);
      const salaryPercentageRepayment = await apiPool.query(
        "SELECT amount,repayment_type,source_payroll_item_id FROM advance_repayments WHERE advance_id=$1",
        [salaryPercentageAdvance.rows[0].id]
      );
      assert.equal(salaryPercentageRepayment.rowCount,1);
      assert.equal(Number(salaryPercentageRepayment.rows[0].amount),100);
      assert.equal(salaryPercentageRepayment.rows[0].repayment_type,"SALARY_PERCENTAGE");
      assert.equal(salaryPercentageRepayment.rows[0].source_payroll_item_id,februaryItem.id);
      const repaymentLedger=await apiPool.query(
        `SELECT credit_amount,advance_repayment_id FROM employee_earnings_ledger
          WHERE employee_id=$1 AND advance_repayment_id IN (SELECT id FROM advance_repayments WHERE source_payroll_item_id=$2)`,
        [employeeA.rows[0].id,februaryItem.id]
      );
      assert.equal(repaymentLedger.rowCount,2,"each salary advance repayment must update the employee account");
      assert.equal(repaymentLedger.rows.reduce((sum:number,row:any)=>sum+Number(row.credit_amount),0),400);
      const reconciledAccount=await apiPool.query(
        "SELECT COALESCE(SUM(credit_amount-debit_amount),0) AS balance FROM employee_earnings_ledger WHERE employee_id=$1",
        [employeeA.rows[0].id]
      );
      assert.equal(Number(reconciledAccount.rows[0].balance),100,"unpaid January wages remain a positive employee balance until they are paid");
      const custodySummary=await apiPool.query(
        "SELECT direction,SUM(amount) AS amount FROM cash_custody_transactions WHERE source_type IN ('PAYROLL_PAYMENT','PAYROLL_ADVANCE_REPAYMENT_OFFSET') AND source_id=$1 GROUP BY direction",
        [februaryPayment.json().data.payment.id]
      );
      assert.equal(custodySummary.rowCount,2,"cash payroll must record both the full custody outflow and the advance-repayment offset");
      assert.equal(Number(custodySummary.rows.find((row:any)=>row.direction==="OUT").amount),1000,
        "custody outflow must include the 600 cash paid plus 400 advance repayment");
      assert.equal(Number(custodySummary.rows.find((row:any)=>row.direction==="IN").amount),400,
        "advance repayment must be returned to the cash custody balance");
      const februaryReconciliation=await app.inject({
        method:"GET",url:"/api/accounting/reconciliation/payroll",headers:{cookie:cookieHeader}
      });
      assert.equal(februaryReconciliation.statusCode,200,februaryReconciliation.body);
      assert.equal(februaryReconciliation.json().data.counts.missingPayrollExpenses,0,
        "salary expense reconciliation must compare gross salary expense (take-home net plus advance recovery), not cash take-home alone");
      const februaryEmployeeB=februaryData.json().data.items.find((row:any)=>row.employee_id===employeeB.rows[0].id);
      assert.ok(februaryEmployeeB,"second employee should have a February payroll item");
      const previousCustodyPayment=await app.inject({
        method:"POST",url:`/api/payroll/items/${februaryEmployeeB.id}/payments`,
        headers:{cookie:cookieHeader},
        payload:{idempotencyKey:randomUUID(),amount:Number(februaryEmployeeB.net_amount),paymentMethod:"CASH",settlementSource:"PREVIOUS_CUSTODY"}
      });
      assert.equal(previousCustodyPayment.statusCode,201,previousCustodyPayment.body,
        "historical cash payout must be recordable without selecting or debiting a current custodian");
      const previousCustodyMovements=await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM cash_custody_transactions WHERE source_type IN ('PAYROLL_PAYMENT','PAYROLL_ADVANCE_REPAYMENT_OFFSET') AND source_id=$1",
        [previousCustodyPayment.json().data.payment.id]
      );
      assert.equal(previousCustodyMovements.rows[0].count,0,
        "previous-custody payroll settlement must not debit a custody balance twice");
      const previousCustodyReconciliation=await app.inject({
        method:"GET",url:"/api/accounting/reconciliation/payroll",headers:{cookie:cookieHeader}
      });
      assert.equal(previousCustodyReconciliation.statusCode,200,previousCustodyReconciliation.body);
      assert.equal(previousCustodyReconciliation.json().data.counts.cashPaymentsMissingCustodyOut,0,
        "a documented previous-custody settlement must not be flagged for lacking a second current-custody outflow");

      // A payroll whose full net amount is consumed by advance installments must settle
      // those advances at approval without inventing a zero-value payment or custody movement.
      const zeroNetAdvance=await apiPool.query(
        `INSERT INTO advance_requests(employee_id,amount,reason,status,requested_by,paid_by,paid_at,repayment_method,installment_amount,repayment_status)
         VALUES($1,600,'Zero-net payroll settlement test','PAID',$2,$2,'2099-02-28T12:00:00Z','FIXED_INSTALLMENT',600,'OPEN')
         RETURNING id`,
        [employeeA.rows[0].id,userId]
      );
      await apiPool.query(
        `INSERT INTO employee_earnings_ledger(employee_id,entry_type,debit_amount,created_by,notes)
         VALUES($1,'ADJUSTMENT',600,$2,'صرف سلفة تسوية صافي صفر للاختبار')`,
        [employeeA.rows[0].id,userId]
      );
      const marchGenerate=await app.inject({
        method:"POST",url:"/api/payroll/generate",headers:{cookie:cookieHeader},payload:{month:"2099-03"}
      });
      assert.equal(marchGenerate.statusCode,201,marchGenerate.body);
      const marchData=await app.inject({method:"GET",url:"/api/payroll?month=2099-03",headers:{cookie:cookieHeader}});
      assert.equal(marchData.statusCode,200,marchData.body);
      const marchItem=marchData.json().data.items.find((row:any)=>row.employee_id===employeeA.rows[0].id);
      assert.ok(marchItem,"employee with a salary profile must be included in March payroll");
      assert.equal(Number(marchItem.advance_repayment_amount),1000,
        "the available 1,000 salary must be allocated across the three open advances");
      assert.equal(Number(marchItem.net_amount),0,"advance installments equal the full take-home salary");
      const marchApproval=await app.inject({
        method:"POST",url:`/api/payroll/periods/${marchData.json().data.period.id}/approve`,headers:{cookie:cookieHeader}
      });
      assert.equal(marchApproval.statusCode,200,marchApproval.body);
      const zeroNetState=await apiPool.query(
        `SELECT i.status,i.net_amount,i.advance_repayment_amount,
                (SELECT COUNT(*)::int FROM payroll_payments pp WHERE pp.payroll_item_id=i.id) AS payment_count,
                (SELECT COUNT(*)::int FROM advance_repayments ar WHERE ar.source_payroll_item_id=i.id) AS repayment_count,
                (SELECT COALESCE(SUM(ar.amount),0) FROM advance_repayments ar WHERE ar.source_payroll_item_id=i.id) AS repaid_amount,
                (SELECT COUNT(*)::int FROM employee_earnings_ledger el WHERE el.payroll_advance_offset_item_id=i.id) AS offset_ledger_count,
                (SELECT COALESCE(SUM(c.amount),0) FROM cash_custody_transactions c
                  WHERE c.source_id=i.id AND c.source_type IN ('PAYROLL_PAYMENT','PAYROLL_ADVANCE_REPAYMENT_OFFSET')) AS custody_amount
           FROM payroll_items i WHERE i.id=$1`,
        [marchItem.id]
      );
      assert.equal(zeroNetState.rows[0].status,"PAID");
      assert.equal(Number(zeroNetState.rows[0].net_amount),0);
      assert.equal(Number(zeroNetState.rows[0].payment_count),0,"zero-net settlement must not fabricate a cash payment");
      assert.equal(Number(zeroNetState.rows[0].repayment_count),3,"all allocated advances must be repaid exactly once");
      assert.equal(Number(zeroNetState.rows[0].repaid_amount),1000);
      assert.equal(Number(zeroNetState.rows[0].offset_ledger_count),1,"employee salary entitlement must be cleared by one source-linked ledger debit");
      assert.equal(Number(zeroNetState.rows[0].custody_amount),0,"non-cash settlement must not create custody movements");
      const zeroNetAdvanceStatus=await apiPool.query("SELECT repayment_status FROM advance_requests WHERE id=$1",[zeroNetAdvance.rows[0].id]);
      assert.equal(zeroNetAdvanceStatus.rows[0].repayment_status,"SETTLED");
      const repeatedZeroNetRepayments=await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM advance_repayments WHERE source_payroll_item_id=$1",[marchItem.id]
      );
      assert.equal(repeatedZeroNetRepayments.rows[0].count,3,"approval may not duplicate any advance repayment");
      const marchReconciliation=await app.inject({method:"GET",url:"/api/accounting/reconciliation/overview",headers:{cookie:cookieHeader}});
      assert.equal(marchReconciliation.statusCode,200,marchReconciliation.body);
      assert.equal(marchReconciliation.json().data.counts.zeroNetPayrollSettlementMismatches,0,
        "a correctly posted zero-net non-cash settlement must pass accounting reconciliation");
      assert.equal(marchReconciliation.json().data.counts.advanceRepaymentLedgerMismatches,0,
        "every advance repayment must have an exact employee-ledger credit");
      const zeroNetRepaymentLedger=await apiPool.query(
        `SELECT el.id,el.credit_amount FROM advance_repayments ar
         JOIN employee_earnings_ledger el ON el.advance_repayment_id=ar.id
         WHERE ar.source_payroll_item_id=$1 AND ar.advance_id=$2`,
        [marchItem.id,zeroNetAdvance.rows[0].id]
      );
      assert.equal(zeroNetRepaymentLedger.rowCount,1);
      await apiPool.query("UPDATE employee_earnings_ledger SET credit_amount=credit_amount+1 WHERE id=$1",[zeroNetRepaymentLedger.rows[0].id]);
      const corruptedRepaymentLedger=await app.inject({method:"GET",url:"/api/accounting/reconciliation/overview",headers:{cookie:cookieHeader}});
      assert.equal(corruptedRepaymentLedger.statusCode,200,corruptedRepaymentLedger.body);
      assert.equal(corruptedRepaymentLedger.json().data.counts.advanceRepaymentLedgerMismatches,1,
        "reconciliation must catch an incorrect advance repayment credit amount");
      await apiPool.query("UPDATE employee_earnings_ledger SET credit_amount=$2 WHERE id=$1",
        [zeroNetRepaymentLedger.rows[0].id,zeroNetRepaymentLedger.rows[0].credit_amount]);
      const restoredRepaymentLedger=await app.inject({method:"GET",url:"/api/accounting/reconciliation/overview",headers:{cookie:cookieHeader}});
      assert.equal(restoredRepaymentLedger.json().data.counts.advanceRepaymentLedgerMismatches,0);

      // Reversing a zero-net settlement must undo its offset and every linked
      // advance repayment without inventing any cash-custody movement.
      const zeroNetSettlementAmount=Number(marchItem.base_salary)+Number(marchItem.bonus_amount)-Number(marchItem.deduction_amount);
      assert.ok(zeroNetSettlementAmount>0.01);
      assert.equal(Math.abs(zeroNetSettlementAmount-Number(marchItem.advance_repayment_amount))<0.01,true);
      const zeroNetReversalPayload={
        sourceType:"ZERO_NET_PAYROLL_SETTLEMENT",sourceId:marchItem.id,
        amount:zeroNetSettlementAmount,reason:"عكس تسوية راتب بصافي صفر للاختبار",idempotencyKey:randomUUID()
      };
      const zeroNetReversal=await app.inject({
        method:"POST",url:"/api/accounting/reversals",headers:{cookie:cookieHeader},payload:zeroNetReversalPayload
      });
      assert.equal(zeroNetReversal.statusCode,201,zeroNetReversal.body);
      assert.equal(zeroNetReversal.json().data.lines.length,4,"the settlement and all three advance repayments must be reversed together");
      const zeroNetReversalReplay=await app.inject({
        method:"POST",url:"/api/accounting/reversals",headers:{cookie:cookieHeader},payload:zeroNetReversalPayload
      });
      assert.equal(zeroNetReversalReplay.statusCode,200,zeroNetReversalReplay.body);
      const zeroNetReversalId=zeroNetReversal.json().data.reversal.id;
      const reversedZeroNetState=await apiPool.query(
        `SELECT i.status,
          (SELECT COUNT(*)::int FROM advance_repayments ar WHERE ar.source_payroll_item_id=i.id) AS original_repayments,
          (SELECT COUNT(*)::int FROM financial_reversal_lines rl WHERE rl.reversal_id=$2) AS reversal_lines,
          (SELECT COALESCE(SUM(credit_amount),0) FROM employee_earnings_ledger el
            WHERE el.employee_id=i.employee_id AND el.notes LIKE '%عكس تسوية راتب بصافي صفر%'
              AND el.notes LIKE '%' || i.id::text || '%') AS offset_reversal_credit,
          (SELECT COALESCE(SUM(debit_amount),0) FROM employee_earnings_ledger el
            WHERE el.employee_id=i.employee_id AND el.notes LIKE '%عكس سداد سلفة%'
              AND EXISTS (SELECT 1 FROM advance_repayments ar WHERE ar.source_payroll_item_id=i.id
                AND el.notes LIKE '%' || ar.id::text || '%')) AS repayment_reversal_debit,
          (SELECT COUNT(*)::int FROM advance_requests a
            WHERE a.id IN (SELECT ar.advance_id FROM advance_repayments ar WHERE ar.source_payroll_item_id=i.id)
              AND a.repayment_status='OPEN') AS reopened_advances,
          (SELECT COUNT(*)::int FROM cash_custody_transactions c
            WHERE c.source_type='FINANCIAL_REVERSAL' AND c.source_id=$2) AS custody_movements
         FROM payroll_items i WHERE i.id=$1`,
        [marchItem.id,zeroNetReversalId]
      );
      assert.equal(reversedZeroNetState.rows[0].status,"REVERSED");
      assert.equal(Number(reversedZeroNetState.rows[0].original_repayments),3);
      assert.equal(Number(reversedZeroNetState.rows[0].reversal_lines),4);
      assert.equal(Number(reversedZeroNetState.rows[0].offset_reversal_credit),zeroNetSettlementAmount);
      assert.equal(Number(reversedZeroNetState.rows[0].repayment_reversal_debit),zeroNetSettlementAmount);
      assert.equal(Number(reversedZeroNetState.rows[0].reopened_advances),3);
      assert.equal(Number(reversedZeroNetState.rows[0].custody_movements),0,
        "zero-net settlement reversal must not create cash-custody movements");
      const zeroNetReversalReconciliation=await app.inject({
        method:"GET",url:"/api/accounting/reconciliation/overview",headers:{cookie:cookieHeader}
      });
      assert.equal(zeroNetReversalReconciliation.statusCode,200,zeroNetReversalReconciliation.body);
      assert.equal(zeroNetReversalReconciliation.json().data.counts.zeroNetPayrollSettlementMismatches,0);
      assert.equal(zeroNetReversalReconciliation.json().data.counts.advanceRepaymentLedgerMismatches,0);

      const concurrentCustodyHolder=await apiPool.query("INSERT INTO employees(full_name) VALUES('Concurrent Payroll Custody Holder') RETURNING id");
      await apiPool.query(
        "INSERT INTO cash_custody_transactions(employee_id,direction,amount,description,created_by) VALUES($1,'IN',100,'concurrent payroll custody opening',$2)",
        [concurrentCustodyHolder.rows[0].id,userId]
      );
      const concurrentPeriod=await apiPool.query(
        "INSERT INTO payroll_periods(period_month,status,generated_by,approved_by,approved_at) VALUES('2099-04-01','APPROVED',$1,$1,now()) RETURNING id",
        [userId]
      );
      const concurrentEmployees=await apiPool.query(
        "INSERT INTO employees(full_name) VALUES('Concurrent Payroll Employee C'),('Concurrent Payroll Employee D') RETURNING id"
      );
      const concurrentItems=await Promise.all(concurrentEmployees.rows.map(employee=>
        apiPool.query(
          "INSERT INTO payroll_items(period_id,employee_id,base_salary,status) VALUES($1,$2,80,'UNPAID') RETURNING id",
          [concurrentPeriod.rows[0].id,employee.id]
        )
      ));
      const concurrentCustodyPayments=await Promise.all(concurrentItems.map(item=>app.inject({
        method:"POST",url:`/api/payroll/items/${item.rows[0].id}/payments`,
        headers:{cookie:cookieHeader},
        payload:{idempotencyKey:randomUUID(),amount:80,paymentMethod:"CASH",fromCustody:true,custodyEmployeeId:concurrentCustodyHolder.rows[0].id}
      })));
      assert.equal(concurrentCustodyPayments.filter(response=>response.statusCode===201).length,1,
        concurrentCustodyPayments.map(response=>`${response.statusCode}: ${response.body}`).join("\n"));
      assert.equal(concurrentCustodyPayments.filter(response=>response.statusCode===409&&response.json().error.code==="INSUFFICIENT_CASH_CUSTODY_BALANCE").length,1,
        "simultaneous payments must serialize against the same cash-custody holder balance");
      assert.equal(Number((await apiPool.query(
        "SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) balance FROM cash_custody_transactions WHERE employee_id=$1",
        [concurrentCustodyHolder.rows[0].id]
      )).rows[0].balance),20,"concurrent payroll payments must not overdraw the shared custody balance");
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int count FROM cash_custody_transactions WHERE employee_id=$1 AND source_type='PAYROLL_PAYMENT' AND direction='OUT'",
        [concurrentCustodyHolder.rows[0].id]
      )).rows[0].count),1,"only one concurrent payroll cash-out may be committed");
      const duplicateFebruaryApproval = await app.inject({
        method: "POST", url: `/api/payroll/periods/${februaryData.json().data.period.id}/approve`,
        headers: { cookie: cookieHeader }
      });
      assert.equal(duplicateFebruaryApproval.statusCode,409);
      assert.equal(duplicateFebruaryApproval.json().error.code,"PAYROLL_PERIOD_LOCKED");
      assert.equal((await apiPool.query("SELECT COUNT(*)::int AS count FROM advance_repayments WHERE advance_id=$1",[fixedAdvance.rows[0].id])).rows[0].count,2,
        "the fixed advance must have one February cash repayment and one March zero-net repayment");

      const partialKey=randomUUID();
      const partialPayload={idempotencyKey:partialKey,amount:600,paymentMethod:"TEST"};
      const partial = await app.inject({
        method: "POST", url: `/api/payroll/items/${itemA.rows[0].id}/payments`,
        headers: { cookie: cookieHeader }, payload: partialPayload
      });
      assert.equal(partial.statusCode, 201, partial.body);
      assert.equal(partial.json().data.status, "PARTIAL");
      assert.equal(Number(partial.json().data.remainingAmount), 400);
      const partialRetry=await app.inject({
        method:"POST",url:`/api/payroll/items/${itemA.rows[0].id}/payments`,
        headers:{cookie:cookieHeader},payload:partialPayload
      });
      assert.equal(partialRetry.statusCode,200,partialRetry.body,"retrying the same partial payout must return the original payment");
      assert.equal(partialRetry.json().data.payment.id,partial.json().data.payment.id);
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM payroll_payments WHERE idempotency_key=$1",[partialKey])).rows[0].count),1);
      const reusedKey=await app.inject({
        method:"POST",url:`/api/payroll/items/${itemA.rows[0].id}/payments`,
        headers:{cookie:cookieHeader},payload:{...partialPayload,amount:601}
      });
      assert.equal(reusedKey.statusCode,409,reusedKey.body);
      assert.equal(reusedKey.json().error.code,"IDEMPOTENCY_KEY_REUSED");

      const full = await app.inject({
        method: "POST", url: `/api/payroll/items/${itemA.rows[0].id}/payments`,
        headers: { cookie: cookieHeader }, payload: { idempotencyKey: randomUUID(), amount: 400, paymentMethod: "TEST" }
      });
      assert.equal(full.statusCode, 201, full.body);
      assert.equal(full.json().data.status, "PAID");
      assert.equal(Number(full.json().data.remainingAmount), 0);
      const finalEmployeeAccount=await apiPool.query(
        "SELECT COALESCE(SUM(credit_amount-debit_amount),0) AS balance FROM employee_earnings_ledger WHERE employee_id=$1",
        [employeeA.rows[0].id]
      );
      assert.equal(Number(finalEmployeeAccount.rows[0].balance),-500,
        "after February cash repayment and March zero-net settlement, the employee account must equal the 500 remaining advance debt");

      const overpay = await app.inject({
        method: "POST", url: `/api/payroll/items/${itemA.rows[0].id}/payments`,
        headers: { cookie: cookieHeader }, payload: { idempotencyKey: randomUUID(), amount: 0.01, paymentMethod: "TEST" }
      });
      assert.equal(overpay.statusCode, 409, overpay.body);
      assert.equal(overpay.json().error.code, "PAYROLL_OVERPAYMENT");

      const concurrent = await Promise.all([700, 700].map(amount => app.inject({
        method: "POST", url: `/api/payroll/items/${itemB.rows[0].id}/payments`,
        headers: { cookie: cookieHeader }, payload: { idempotencyKey: randomUUID(), amount, paymentMethod: "TEST" }
      })));
      assert.equal(concurrent.filter(response => response.statusCode === 201).length, 1,
        concurrent.map(response => `${response.statusCode}: ${response.body}`).join("\n"));
      assert.equal(concurrent.filter(response => response.statusCode === 409 && response.json().error.code === "PAYROLL_OVERPAYMENT").length, 1);

      const totals = await apiPool.query(
        "SELECT i.id,i.status,i.net_amount,COALESCE(SUM(pp.amount),0) AS paid FROM payroll_items i LEFT JOIN payroll_payments pp ON pp.payroll_item_id=i.id WHERE i.id=ANY($1::uuid[]) GROUP BY i.id",
        [[itemA.rows[0].id, itemB.rows[0].id]]
      );
      const rowA = totals.rows.find(row => row.id === itemA.rows[0].id);
      const rowB = totals.rows.find(row => row.id === itemB.rows[0].id);
      assert.equal(Number(rowA.paid), 1000);
      assert.equal(Number(rowA.net_amount), 1000);
      assert.equal(rowA.status, "PAID");
      assert.equal(Number(rowB.paid), 700);
      assert.equal(Number(rowB.paid) <= Number(rowB.net_amount), true);

      // The read-only financial integrity overview must detect deliberately corrupted links.
      const diagnosticAdvance = await apiPool.query(
        `INSERT INTO advance_requests(employee_id,amount,reason,status,requested_by,paid_by,paid_at,repayment_method,installment_amount,repayment_status)
         VALUES($1,100,'Integrity diagnostic advance','PAID',$2,$2,'2099-01-15T12:00:00Z','FIXED_INSTALLMENT',10,'OPEN')
         RETURNING id`,
        [employeeA.rows[0].id,userId]
      );
      // Use a separate approved period with an unpaid item: the February item above
      // has already been fully paid, so it must not be treated as a live reservation.
      const reservationPeriod=await apiPool.query(
        "INSERT INTO payroll_periods(period_month,status,generated_by,approved_by,approved_at) VALUES('2099-05-01','APPROVED',$1,$1,now()) RETURNING id",
        [userId]
      );
      const reservationItem=await apiPool.query(
        "INSERT INTO payroll_items(period_id,employee_id,base_salary,status) VALUES($1,$2,100,'UNPAID') RETURNING id",
        [reservationPeriod.rows[0].id,employeeA.rows[0].id]
      );
      await apiPool.query(
        "INSERT INTO payroll_advance_deductions(payroll_item_id,advance_id,amount,repayment_type) VALUES($1,$2,10,'FIXED_INSTALLMENT')",
        [reservationItem.rows[0].id,diagnosticAdvance.rows[0].id]
      );
      const reservedManualRepayment=await app.inject({
        method:"POST",url:`/api/advances/${diagnosticAdvance.rows[0].id}/repayments`,
        headers:{cookie:secondCookieHeader},
        payload:{amount:10,repaymentType:"CUSTOM",idempotencyKey:randomUUID()}
      });
      assert.equal(reservedManualRepayment.statusCode,409,reservedManualRepayment.body);
      assert.equal(reservedManualRepayment.json().error.code,"ADVANCE_INSTALLMENT_RESERVED",
        "manual collection must not consume an installment already reserved by an approved unpaid payroll item");
      // Deliberately corrupt the diagnostic item into a paid state without committing
      // its reserved installment, so reconciliation must report the missing repayment.
      await apiPool.query("UPDATE payroll_items SET advance_repayment_amount=10,status='PAID' WHERE id=$1",[reservationItem.rows[0].id]);
      await apiPool.query("UPDATE payroll_items SET advance_repayment_amount=411 WHERE id=$1",[februaryItem.id]);
      await apiPool.query("UPDATE payroll_items SET status='PAID' WHERE id=$1",[itemB.rows[0].id]);
      const diagnosticExpense = await apiPool.query(
        `INSERT INTO accounting_expenses(category,description,amount,expense_date,created_by,expense_type,paid_from_employee_id)
         VALUES('OTHER','Integrity diagnostic expense',50,'2099-02-15',$1,'DIRECT',$2) RETURNING id`,
        [userId,employeeA.rows[0].id]
      );
      const diagnosticCustody = await apiPool.query(
        `INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,created_by,source_type,source_id)
         VALUES($1,'OUT',40,'2099-02-15','Mismatched diagnostic custody movement',$2,'ACCOUNTING_EXPENSE',$3)
         RETURNING id`,
        [employeeB.rows[0].id,userId,diagnosticExpense.rows[0].id]
      );
      await apiPool.query(
        "UPDATE accounting_expenses SET cash_custody_transaction_id=$1 WHERE id=$2",
        [diagnosticCustody.rows[0].id,diagnosticExpense.rows[0].id]
      );

      // Deliberately corrupt a source-linked adjustment posting: wrong employee and amount.
      await apiPool.query(
        "UPDATE employee_earnings_ledger SET employee_id=$1,credit_amount=99 WHERE payroll_adjustment_line_id=$2",
        [employeeB.rows[0].id,januaryBonusLineId]
      );
      // A direct advance repayment must have one matching cash-custody IN movement.
      await apiPool.query(
        "UPDATE cash_custody_transactions SET amount=49 WHERE source_type='ADVANCE_REPAYMENT' AND source_id=$1",
        [earlyRepayment.json().data.repayment.id]
      );
      await apiPool.query(
        "UPDATE employee_earnings_ledger SET credit_amount=49 WHERE advance_repayment_id=$1",
        [earlyRepayment.json().data.repayment.id]
      );

      // A cash payment must be reconciled against the exact custody OUT amount.
      const itemBPayment = await apiPool.query(
        "SELECT id FROM payroll_payments WHERE payroll_item_id=$1 LIMIT 1",
        [itemB.rows[0].id]
      );
      assert.equal(itemBPayment.rowCount,1,"diagnostic cash payment must exist");
      await apiPool.query("UPDATE payroll_payments SET payment_method='CASH' WHERE id=$1",[itemBPayment.rows[0].id]);
      const expectedPayrollCustody = await apiPool.query(
        `SELECT pp.amount + COALESCE((
           SELECT SUM(ci.amount) FROM cash_custody_transactions ci
            WHERE ci.source_type='PAYROLL_ADVANCE_REPAYMENT_OFFSET'
              AND ci.source_id=pp.id AND ci.direction='IN'
         ),0) AS expected_amount,
         COALESCE((
           SELECT (array_agg(ci.employee_id ORDER BY ci.employee_id::text))[1] FROM cash_custody_transactions ci
            WHERE ci.source_type='PAYROLL_ADVANCE_REPAYMENT_OFFSET'
              AND ci.source_id=pp.id AND ci.direction='IN'
         ),$2::uuid) AS holder_id
         FROM payroll_payments pp WHERE pp.id=$1`,
        [itemBPayment.rows[0].id,employeeA.rows[0].id]
      );
      // The database unique constraint must reject duplicate source movements.
      // Keep one deliberately mismatched OUT row so reconciliation also proves it catches amount drift.
      const expectedAmount = Number(expectedPayrollCustody.rows[0].expected_amount);
      await apiPool.query(
        `INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,created_by,source_type,source_id)
         VALUES($1,'OUT',$2,'2099-02-15','Mismatched payroll cash movement',$3,'PAYROLL_PAYMENT',$4)`,
        [expectedPayrollCustody.rows[0].holder_id,Math.max(0,expectedAmount-1),userId,itemBPayment.rows[0].id]
      );
      await assert.rejects(
        apiPool.query(
          `INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,created_by,source_type,source_id)
           VALUES($1,'OUT',$2,'2099-02-15','Duplicate payroll cash movement',$3,'PAYROLL_PAYMENT',$4)`,
          [expectedPayrollCustody.rows[0].holder_id,expectedAmount,userId,itemBPayment.rows[0].id]
        ),
        (error: {code?:string}) => error.code === "23505",
        "database must reject a second custody movement for the same source"
      );

      const integrityFindings = await app.inject({
        method:"GET",url:"/api/accounting/reconciliation/overview",headers:{cookie:cookieHeader}
      });
      assert.equal(integrityFindings.statusCode,200,integrityFindings.body);
      const findingData=integrityFindings.json().data;
      assert.ok(findingData.counts.payrollPaymentMismatches>=1,
        "integrity overview must detect a PAID payroll item whose recorded payments do not match net pay");
      assert.ok(findingData.counts.advanceDeductionMismatches>=1,
        "integrity overview must detect a mismatch between payroll advance deduction total and its detail rows");
      assert.ok(findingData.counts.paidPayrollMissingAdvanceRepayments>=1,
        "integrity overview must detect a paid payroll deduction without its advance repayment ledger row");
      assert.ok(findingData.counts.expensesMissingCustodyLink>=1,
        "integrity overview must detect an explicitly linked custody movement with a different employee and amount");
      assert.ok(findingData.counts.advanceRepaymentsMissingCustodyIn>=1,
        "integrity overview must detect a manual advance repayment whose custody receipt is missing or has a different amount");
      assert.ok(findingData.counts.advanceRepaymentLedgerMismatches>=1,
        "integrity overview must detect a manual advance repayment with a missing or incorrect employee-ledger credit");
      assert.ok(findingData.issues.advanceRepaymentLedgerMismatches.some((row:{repayment_id:string;credit_amount:string|number|null})=>
        row.repayment_id===earlyRepayment.json().data.repayment.id&&Number(row.credit_amount)!==50),
        "integrity overview must identify the exact manual advance repayment ledger mismatch");
      assert.ok(findingData.issues.advanceRepaymentsMissingCustodyIn.some((row:{repayment_id:string;amount:string;custody_amount:string}) =>
        row.repayment_id===earlyRepayment.json().data.repayment.id && Number(row.custody_amount)!==Number(row.amount)),
        "integrity overview must identify the mismatched manual advance repayment receipt");
      assert.ok(findingData.counts.missingAdjustmentLedgerEntries>=1,
        "integrity overview must detect a source-linked adjustment with the wrong employee and amount");
      assert.ok(findingData.counts.cashPaymentsMissingCustodyOut>=1,
        "integrity overview must detect a cash payroll custody amount mismatch");
      assert.ok(findingData.issues.cashPaymentsMissingCustodyOut.some((row: {payment_id:string;custody_out_count:number}) =>
        row.payment_id===itemBPayment.rows[0].id && row.custody_out_count===1 && Number(row.custody_out_amount)!==expectedAmount),
        "integrity overview must report the mismatched custody amount and movement count");

      const payments = await app.inject({
        method: "GET", url: `/api/payroll/items/${itemA.rows[0].id}/payments`,
        headers: { cookie: cookieHeader }
      });
      assert.equal(payments.statusCode, 200, payments.body);
      assert.equal(payments.json().data.length, 2);
    } finally {
      await app.close();
    }
  } finally {
    if (apiPool) await apiPool.end();
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await cleanup.end();
  }
});
