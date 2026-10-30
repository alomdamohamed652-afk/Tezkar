CREATE SEQUENCE IF NOT EXISTS reverse_code_number_seq START 1;
CREATE TABLE IF NOT EXISTS reverse_code_groups (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), group_number BIGINT NOT NULL UNIQUE,
 name TEXT NOT NULL, packaging_type TEXT NOT NULL, product_id UUID NULL, order_id UUID NULL,
 total_quantity INTEGER NOT NULL CHECK(total_quantity>0), pieces_per_code INTEGER NOT NULL CHECK(pieces_per_code>0),
 code_count INTEGER NOT NULL CHECK(code_count>0), created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), notes TEXT NULL
);
CREATE TABLE IF NOT EXISTS reverse_codes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), group_id UUID NOT NULL REFERENCES reverse_code_groups(id) ON DELETE RESTRICT,
 code_number BIGINT NOT NULL UNIQUE, code TEXT NOT NULL UNIQUE, quantity INTEGER NOT NULL CHECK(quantity>0),
 weight_grams NUMERIC(12,3) NULL CHECK(weight_grams IS NULL OR weight_grams>=0),
 status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','VOIDED')),
 print_snapshot JSONB NULL, first_printed_at TIMESTAMPTZ NULL, last_printed_at TIMESTAMPTZ NULL,
 print_count INTEGER NOT NULL DEFAULT 0 CHECK(print_count>=0), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reverse_codes_group ON reverse_codes(group_id,code_number);
CREATE TABLE IF NOT EXISTS reverse_code_workers (
 code_id UUID NOT NULL REFERENCES reverse_codes(id) ON DELETE CASCADE,
 employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(code_id,employee_id)
);
CREATE TABLE IF NOT EXISTS reverse_code_scan_logs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code_id UUID NULL REFERENCES reverse_codes(id) ON DELETE SET NULL,
 scanned_value TEXT NOT NULL, session_id UUID NULL,
 result TEXT NOT NULL CHECK(result IN('FOUND','UNKNOWN','DUPLICATE','VOIDED')),
 scanned_by UUID NULL REFERENCES users(id) ON DELETE SET NULL, scanned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reverse_code_scans_created ON reverse_code_scan_logs(scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_reverse_code_scans_session ON reverse_code_scan_logs(session_id,scanned_at DESC);
CREATE TABLE IF NOT EXISTS reverse_code_print_logs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code_id UUID NOT NULL REFERENCES reverse_codes(id) ON DELETE RESTRICT,
 printed_by UUID NULL REFERENCES users(id) ON DELETE SET NULL, printed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 reprint BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS reverse_code_settings (
 setting_key TEXT PRIMARY KEY, setting_value JSONB NOT NULL DEFAULT '{}'::jsonb,
 updated_by UUID NULL REFERENCES users(id) ON DELETE SET NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('reverse_coding.view','reverse_coding','reverse_code','view','all'),
 ('reverse_coding.manage','reverse_coding','reverse_code','manage','all'),
 ('reverse_coding.scan','reverse_coding','reverse_code','scan','all'),
 ('reverse_coding.print','reverse_coding','reverse_code','print','all')
ON CONFLICT(code) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='manager'
AND p.code IN('reverse_coding.view','reverse_coding.manage','reverse_coding.scan','reverse_coding.print') ON CONFLICT DO NOTHING;
