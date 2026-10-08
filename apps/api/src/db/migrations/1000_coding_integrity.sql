-- Tezkar coding integrity: enforce relationships for coding records without breaking existing installations.
ALTER TABLE coding_templates
  ADD CONSTRAINT coding_templates_packaging_fk
  FOREIGN KEY (packaging_type_id) REFERENCES coding_packaging_types(id) NOT VALID;

ALTER TABLE coding_units
  ADD CONSTRAINT coding_units_packaging_fk
  FOREIGN KEY (packaging_type_id) REFERENCES coding_packaging_types(id) NOT VALID,
  ADD CONSTRAINT coding_units_template_fk
  FOREIGN KEY (template_id) REFERENCES coding_templates(id) NOT VALID,
  ADD CONSTRAINT coding_units_product_fk
  FOREIGN KEY (product_id) REFERENCES products(id) NOT VALID,
  ADD CONSTRAINT coding_units_order_fk
  FOREIGN KEY (production_order_id) REFERENCES production_orders(id) NOT VALID,
  ADD CONSTRAINT coding_units_order_stage_fk
  FOREIGN KEY (order_stage_id) REFERENCES order_stages(id) NOT VALID,
  ADD CONSTRAINT coding_units_unit_fk
  FOREIGN KEY (unit_id) REFERENCES units(id) NOT VALID,
  ADD CONSTRAINT coding_units_production_owner_fk
  FOREIGN KEY (production_owner_employee_id) REFERENCES employees(id) NOT VALID,
  ADD CONSTRAINT coding_units_packed_by_fk
  FOREIGN KEY (packed_by_employee_id) REFERENCES employees(id) NOT VALID,
  ADD CONSTRAINT coding_units_received_by_fk
  FOREIGN KEY (received_by_employee_id) REFERENCES employees(id) NOT VALID,
  ADD CONSTRAINT coding_units_warehouse_fk
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) NOT VALID,
  ADD CONSTRAINT coding_units_location_fk
  FOREIGN KEY (location_id) REFERENCES warehouse_locations(id) NOT VALID,
  ADD CONSTRAINT coding_units_created_by_fk
  FOREIGN KEY (created_by) REFERENCES users(id) NOT VALID;

ALTER TABLE coding_unit_movements
  ADD CONSTRAINT coding_unit_movements_unit_fk
  FOREIGN KEY (coding_unit_id) REFERENCES coding_units(id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT coding_unit_movements_created_by_fk
  FOREIGN KEY (created_by) REFERENCES users(id) NOT VALID;

ALTER TABLE coding_print_logs
  ADD CONSTRAINT coding_print_logs_unit_fk
  FOREIGN KEY (coding_unit_id) REFERENCES coding_units(id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT coding_print_logs_template_fk
  FOREIGN KEY (template_id) REFERENCES coding_templates(id) NOT VALID,
  ADD CONSTRAINT coding_print_logs_printed_by_fk
  FOREIGN KEY (printed_by) REFERENCES users(id) NOT VALID;

ALTER TABLE coding_corrections
  ADD CONSTRAINT coding_corrections_unit_fk
  FOREIGN KEY (coding_unit_id) REFERENCES coding_units(id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT coding_corrections_corrected_by_fk
  FOREIGN KEY (corrected_by) REFERENCES users(id) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_coding_units_warehouse_location
  ON coding_units(warehouse_id,location_id,status);

CREATE INDEX IF NOT EXISTS idx_coding_unit_movements_reference
  ON coding_unit_movements(reference_type,reference_id);

INSERT INTO schema_migrations(version)
VALUES ('1000_coding_integrity')
ON CONFLICT(version) DO NOTHING;
