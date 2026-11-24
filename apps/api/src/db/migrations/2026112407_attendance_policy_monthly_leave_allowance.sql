-- إضافة عدد أيام الإجازة المسموح بها شهريًا لكل موظف ضمن سياسة الحضور (إضافي، يقبل NULL ويعني غير محدد، لا يغيّر بيانات قائمة ولا يدخل في احتساب الأجر)
ALTER TABLE employee_payroll_attendance_policies ADD COLUMN IF NOT EXISTS allowed_leave_days_per_month NUMERIC(4,1);
COMMENT ON COLUMN employee_payroll_attendance_policies.allowed_leave_days_per_month IS 'عدد أيام الإجازة المسموح بها شهريًا؛ إعداد للمتابعة فقط حاليًا، لا يُحسب له استهلاك أو ترحيل ولا يُستخدم في احتساب المرتب. NULL يعني غير محدد.';
