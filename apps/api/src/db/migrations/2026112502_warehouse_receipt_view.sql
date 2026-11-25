-- C2: صلاحية عرض الاستلامات مستقلة عن warehouse.view العامة.
-- من يرى المخزن كله يستمر عبر warehouse.view؛ warehouse.receipt.view تمنح عرض الاستلامات فقط.
INSERT INTO permissions(code,module,entity,action,scope) VALUES
('warehouse.receipt.view','warehouse','receipt','view','all')
ON CONFLICT (code) DO NOTHING;

-- لا منح للمدير هنا: المدير يملك warehouse.view التي تمرّر مسارات الاستلامات، وأي منحة
-- إضافية خارج الفرق المعتمد (worker/shift_leader) أزيلت عبر 2026112504.
-- منح shift_leader يتم في 2026112503_shift_leader_lockdown ضمن الحزمة المعتمدة.
