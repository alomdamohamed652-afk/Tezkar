-- إضافة رصيد الراحة/الإجازة المدفوعة المشترك شهريًا لكل موظف ضمن سياسة الحضور (إضافي، يقبل NULL ويعني غير محدد):
-- أيام الراحة غير المعمولة تُستهلك منه، والمتبقي يُصرف مرة واحدة بسعر يوم الراحة المضبوط عند اعتماد المسير بعد نهاية الشهر.
ALTER TABLE employee_payroll_attendance_policies ADD COLUMN IF NOT EXISTS allowed_leave_days_per_month NUMERIC(4,1);
COMMENT ON COLUMN employee_payroll_attendance_policies.allowed_leave_days_per_month IS 'رصيد الراحة والإجازات المدفوعة الشهري المشترك لكل موظف؛ أيام الراحة غير المعمولة تُستهلك منه عند الاحتساب، والمتبقي يُصرف مرة واحدة بسعر يوم الراحة المضبوط (day_off_pay_amount) عند اعتماد مسير الشهر بعد نهايته. NULL يعني غير محدد ويبقي سلوك بونص العمل في أيام الراحة القديم.';
