"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";

type Employee = {
  id: string;
  code: string;
  full_name: string;
  phone: string | null;
  department_code: string | null;
  department_name: string | null;
  job_title_code: string | null;
  job_title_name: string | null;
  is_active: boolean;
  hired_at: string | null;
};

type Department = { id: string; code: string; name: string };
type JobTitle = { id: string; code: string; name: string; department_id: string | null };

export default function EmployeesPage() {
  const { has } = usePermissions();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [jobTitles, setJobTitles] = useState<JobTitle[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [jobTitleId, setJobTitleId] = useState("");
  const [hiredAt, setHiredAt] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [employeesResponse, departmentsResponse, jobsResponse] = await Promise.all([
        api<{ data: Employee[] }>("/api/employees"),
        api<{ data: Department[] }>("/api/departments"),
        api<{ data: JobTitle[] }>("/api/job-titles")
      ]);
      setEmployees(employeesResponse.data);
      setDepartments(departmentsResponse.data);
      setJobTitles(jobsResponse.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر تحميل البيانات");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!fullName.trim()) return;

    setSaving(true);
    setError("");
    try {
      await api("/api/employees", {
        method: "POST",
        body: JSON.stringify({
          fullName,
          phone: phone || undefined,
          departmentId: departmentId || null,
          jobTitleId: jobTitleId || null,
          hiredAt: hiredAt || null
        })
      });
      setFullName("");
      setPhone("");
      setDepartmentId("");
      setJobTitleId("");
      setHiredAt("");
      setShowForm(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر حفظ الموظف");
    } finally {
      setSaving(false);
    }
  }

  const filteredJobs = jobTitles.filter((job) => !departmentId || job.department_id === departmentId);

  return (
    <div className="app-shell">
      <Sidebar active="/employees" />

      <main className="main">
        <header className="topbar">
          <div>
            <h1 className="page-title">الموظفون</h1>
            <p className="page-subtitle">ملفات العاملين والبيانات الإدارية الأساسية</p>
          </div>
          {has("users.create") && <button className="primary-button" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "إلغاء" : "+ إضافة موظف"}
          </button>}
        </header>

        <section className="content">
          {error && <div className="alert error">{error}</div>}

          {showForm && has("users.create") && (
            <form className="card form-card" onSubmit={submit}>
              <div className="card-header"><h2 className="card-title">موظف جديد</h2></div>
              <div className="form-grid">
                <label>الاسم الكامل<input value={fullName} onChange={(e) => setFullName(e.target.value)} required /></label>
                <label>رقم الهاتف<input value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
                <label>القسم
                  <select value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setJobTitleId(""); }}>
                    <option value="">بدون قسم</option>
                    {departments.map((d) => <option key={d.id} value={d.id}>{d.name} — {d.code}</option>)}
                  </select>
                </label>
                <label>الوظيفة
                  <select value={jobTitleId} onChange={(e) => setJobTitleId(e.target.value)}>
                    <option value="">بدون وظيفة</option>
                    {filteredJobs.map((j) => <option key={j.id} value={j.id}>{j.name} — {j.code}</option>)}
                  </select>
                </label>
                <label>تاريخ التعيين<input type="date" value={hiredAt} onChange={(e) => setHiredAt(e.target.value)} /></label>
              </div>
              <div className="form-actions">
                <button className="primary-button" disabled={saving}>{saving ? "جارٍ الحفظ..." : "حفظ الموظف"}</button>
              </div>
            </form>
          )}

          <section className="card">
            <div className="card-header">
              <h2 className="card-title">قائمة الموظفين</h2>
              <span className="count-badge">{employees.length}</span>
            </div>
            {loading ? (
              <div className="empty">جارٍ تحميل البيانات...</div>
            ) : employees.length === 0 ? (
              <div className="empty">لا يوجد موظفون مسجلون حتى الآن.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>الكود</th><th>الاسم</th><th>القسم</th><th>الوظيفة</th><th>الهاتف</th><th>الحالة</th></tr></thead>
                  <tbody>
                    {employees.map((employee) => (
                      <tr key={employee.id}>
                        <td className="mono">{employee.code}</td>
                        <td className="strong">{employee.full_name}</td>
                        <td>{employee.department_name ?? "—"}</td>
                        <td>{employee.job_title_name ?? "—"}</td>
                        <td>{employee.phone ?? "—"}</td>
                        <td><span className={`status ${employee.is_active ? "success" : "muted"}`}>{employee.is_active ? "نشط" : "غير نشط"}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </section>
      </main>
    </div>
  );
}
