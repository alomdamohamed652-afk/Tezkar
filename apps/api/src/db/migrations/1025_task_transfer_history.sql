CREATE TABLE IF NOT EXISTS task_transfer_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_assignees jsonb NOT NULL DEFAULT '[]'::jsonb,
  to_employee_id uuid NOT NULL REFERENCES employees(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  transferred_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_transfer_history_task_created_idx
  ON task_transfer_history(task_id, created_at DESC);

ALTER TABLE task_transfer_history ENABLE ROW LEVEL SECURITY;
