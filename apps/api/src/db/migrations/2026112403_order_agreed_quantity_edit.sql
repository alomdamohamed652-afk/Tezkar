-- Agreed-quantity editing mid-run: a dedicated permission for changing a final
-- product's agreed quantity after the order has production, stock movements or
-- deliveries. Guarded in orders.routes (floor = recorded production/deliveries,
-- mandatory reason, audit_log entry). Granted to manager only by default.
INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('orders.edit_agreed_quantity','orders','order_line','edit_agreed_quantity','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='manager'
  AND p.code IN ('orders.edit_agreed_quantity')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('2026112403_order_agreed_quantity_edit')
ON CONFLICT(version) DO NOTHING;
