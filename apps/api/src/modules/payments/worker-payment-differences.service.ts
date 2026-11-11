import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import { writeAudit } from "../audit/audit.service.js";
import { assertAccountingPeriodOpen } from "../accounting/period-lock.service.js";

type DifferenceActor = { actorUserId: string | null; actorType: "USER" | "SYSTEM" };

const productionRemainingSql = `
  GREATEST(COALESCE(p.total_earning_amount,p.earning_amount,0)
    -COALESCE((SELECT SUM(a.amount-COALESCE((SELECT SUM(r.amount) FROM worker_payment_allocation_reversals r
        WHERE r.allocation_source='EMPLOYEE_EARNINGS_SETTLEMENT' AND r.source_allocation_id=a.id),0))
      FROM employee_earnings_settlement_allocations a WHERE a.production_entry_id=p.id),0)
    -COALESCE((SELECT SUM(a.amount-COALESCE((SELECT SUM(r.amount) FROM worker_payment_allocation_reversals r
        WHERE r.allocation_source='WORKER_PAYMENT_ORDER' AND r.source_allocation_id=a.id),0))
      FROM worker_payment_order_allocations a
      JOIN worker_payments wp ON wp.id=a.worker_payment_id
      WHERE a.production_entry_id=p.id
        AND NOT EXISTS(SELECT 1 FROM employee_earnings_settlements es
          JOIN employee_earnings_settlement_allocations esa ON esa.settlement_id=es.id
          WHERE es.worker_payment_id=wp.id)),0)
    -COALESCE((SELECT SUM(a.amount-COALESCE((SELECT SUM(r.amount) FROM worker_payment_allocation_reversals r
        WHERE r.allocation_source='WORKER_PAYMENT_LEGACY' AND r.source_allocation_id=a.id),0))
      FROM worker_payment_allocations a
      JOIN worker_payments wp ON wp.id=a.worker_payment_id
      WHERE a.production_entry_id=p.id
        AND NOT EXISTS(SELECT 1 FROM employee_earnings_settlements es
          JOIN employee_earnings_settlement_allocations esa ON esa.settlement_id=es.id
          WHERE es.worker_payment_id=wp.id)
        AND NOT EXISTS(SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=wp.id)),0)
    -COALESCE((SELECT SUM(hm.amount_snapshot) FROM historical_production_settlement_marks hm
      WHERE hm.production_entry_id=p.id AND hm.status='PAID_PREVIOUSLY'),0),0)
`;

async function remainingDifferenceAmount(client: PoolClient, differenceId: string, originalAmount: number) {
  const result = await client.query(
    `SELECT GREATEST($2::numeric-COALESCE(SUM(e.amount) FILTER(WHERE e.event_type IN ('ALLOCATED_TO_PRODUCTION','TRANSFERRED_TO_SOURCE_ORDER')
         AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events r
           WHERE r.reverses_event_id=e.id AND r.event_type='REVERSED')),0),0) AS remaining
       FROM worker_payment_settlement_difference_events e
      WHERE e.difference_id=$1`,
    [differenceId, originalAmount]
  );
  return Number(result.rows[0]?.remaining ?? 0);
}

export async function allocatePendingWorkerPaymentDifferencesForProduction(
  client: PoolClient,
  employeeId: string,
  productionEntryId: string,
  actorUserId: string
) {
  const production = await client.query(
    `SELECT p.id,p.employee_id,p.work_date,p.created_at,p.approved_at,p.order_stage_id,os.order_id,
            ${productionRemainingSql} AS remaining
       FROM production_entries p
       LEFT JOIN order_stages os ON os.id=p.order_stage_id
       LEFT JOIN production_orders o ON o.id=os.order_id
      WHERE p.id=$1 AND p.employee_id=$2 AND p.status='APPROVED'
        AND (os.id IS NULL OR os.status NOT IN ('CANCELLED','COMPLETED'))
        AND (o.id IS NULL OR o.status NOT IN ('CANCELLED','COMPLETED'))
      FOR UPDATE OF p`,
    [productionEntryId, employeeId]
  );
  if (!production.rowCount || !production.rows[0].order_id) return [];
  const entry = production.rows[0];
  let productionRemaining = Number(entry.remaining ?? 0);
  if (productionRemaining <= 0.009) return [];

  const differences = await client.query(
    `SELECT d.id,d.worker_payment_id,d.source_order_id,d.source_expense_id,d.original_amount,wp.created_at AS payment_created_at,
            GREATEST(d.original_amount-COALESCE((
              SELECT SUM(e.amount) FROM worker_payment_settlement_difference_events e
               WHERE e.difference_id=d.id AND e.event_type IN ('ALLOCATED_TO_PRODUCTION','TRANSFERRED_TO_SOURCE_ORDER')
                 AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events r
                   WHERE r.reverses_event_id=e.id AND r.event_type='REVERSED')
            ),0),0) AS remaining
       FROM worker_payment_settlement_differences d
       JOIN worker_payments wp ON wp.id=d.worker_payment_id
      WHERE d.employee_id=$1
        AND d.status IN ('PENDING','PARTIALLY_ALLOCATED')
        AND $2::timestamptz > wp.created_at
        AND $3::date >= wp.created_at::date
        AND NOT EXISTS(SELECT 1 FROM financial_reversal_lines fr
          WHERE fr.source_type='WORKER_PAYMENT' AND fr.source_id=wp.id)
      ORDER BY d.created_at,d.id
      FOR UPDATE OF d`,
    [employeeId, entry.approved_at, entry.work_date]
  );

  const allocations: Array<{ differenceId: string; workerPaymentId: string; productionEntryId: string; orderId: string; amount: number }> = [];
  for (const difference of differences.rows) {
    if (productionRemaining <= 0.009) break;
    const differenceRemaining = Number(difference.remaining ?? 0);
    const amount = Math.round(Math.min(productionRemaining, differenceRemaining) * 100) / 100;
    if (amount <= 0.009) continue;

    const inserted = await client.query(
      `INSERT INTO worker_payment_order_allocations(worker_payment_id,production_entry_id,amount)
       VALUES($1,$2,$3)
       ON CONFLICT(worker_payment_id,production_entry_id) DO NOTHING
       RETURNING id`,
      [difference.worker_payment_id, productionEntryId, amount]
    );
    if (!inserted.rowCount) continue;

    await client.query(
      `INSERT INTO worker_payment_settlement_difference_events(
         difference_id,worker_payment_id,source_expense_id,event_type,amount,source_order_id,target_order_id,
         target_order_stage_id,production_entry_id,worker_payment_order_allocation_id,actor_type,actor_user_id,reason
       ) VALUES($1,$2,$3,'ALLOCATED_TO_PRODUCTION',$4,$5,$6,$7,$8,$9,'USER',$10,$11)`,
      [difference.id,difference.worker_payment_id,difference.source_expense_id,amount,difference.source_order_id,
       entry.order_id,entry.order_stage_id,productionEntryId,inserted.rows[0].id,actorUserId,
       "توزيع فرق تسوية سابق على إنتاج العامل بعد عودته للعمل"]
    );

    productionRemaining = Math.round((productionRemaining - amount) * 100) / 100;
    const remainingAfter = await remainingDifferenceAmount(client, difference.id, Number(difference.original_amount));
    await client.query(
      "UPDATE worker_payment_settlement_differences SET status=$1,updated_at=now() WHERE id=$2",
      [remainingAfter <= 0.009 ? "ALLOCATED" : "PARTIALLY_ALLOCATED", difference.id]
    );
    await writeAudit(client, {
      actorUserId,
      actorEmployeeId: null,
      action: "allocate_worker_payment_settlement_difference",
      module: "finance",
      entityType: "worker_payment_settlement_difference",
      entityId: difference.id,
      metadata: { workerPaymentId: difference.worker_payment_id, productionEntryId, targetOrderId: entry.order_id, amount },
      ipAddress: null,
      userAgent: null
    });
    allocations.push({ differenceId: difference.id, workerPaymentId: difference.worker_payment_id, productionEntryId, orderId: entry.order_id, amount });
  }
  return allocations;
}

export async function processMaturedWorkerPaymentDifferences(
  client: PoolClient,
  actor: DifferenceActor
) {
  const candidates = await client.query(
    `SELECT d.id,d.worker_payment_id,d.source_order_id,d.source_order_stage_id,d.source_expense_id,d.original_amount,
            GREATEST(d.original_amount-COALESCE((
              SELECT SUM(e.amount) FROM worker_payment_settlement_difference_events e
               WHERE e.difference_id=d.id AND e.event_type IN ('ALLOCATED_TO_PRODUCTION','TRANSFERRED_TO_SOURCE_ORDER')
                 AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events r
                   WHERE r.reverses_event_id=e.id AND r.event_type='REVERSED')
            ),0),0) AS remaining,
            COALESCE(activity.last_activity,wp.created_at) AS last_activity,
            po.status AS source_order_status
       FROM worker_payment_settlement_differences d
       JOIN employees e ON e.id=d.employee_id
       JOIN worker_payments wp ON wp.id=d.worker_payment_id
       JOIN production_orders po ON po.id=d.source_order_id
       LEFT JOIN LATERAL (
         SELECT MAX(p.approved_at) AS last_activity
           FROM production_entries p
          WHERE p.employee_id=d.employee_id
            AND p.status='APPROVED'
            AND p.approved_at>wp.created_at
            AND p.work_date>=wp.created_at::date
       ) activity ON TRUE
      WHERE d.status IN ('PENDING','PARTIALLY_ALLOCATED')
        AND po.status<>'CANCELLED'
        AND NOT EXISTS(SELECT 1 FROM financial_reversal_lines fr
          WHERE fr.source_type='WORKER_PAYMENT' AND fr.source_id=wp.id)
        AND NOT EXISTS(SELECT 1 FROM production_entries pending
          WHERE pending.employee_id=d.employee_id AND pending.status='PENDING'
            AND pending.work_date>=wp.created_at::date)
        AND (
          COALESCE(activity.last_activity,wp.created_at)+INTERVAL '30 days'<=now()
          OR (
            po.status='COMPLETED'
            AND NOT EXISTS(
              SELECT 1 FROM production_entries pending_order
              JOIN order_stages os ON os.id=pending_order.order_stage_id
               WHERE os.order_id=d.source_order_id
                 AND pending_order.status='PENDING'
            )
            AND NOT EXISTS(
              SELECT 1 FROM production_entries p
              JOIN order_stages os ON os.id=p.order_stage_id
               WHERE os.order_id=d.source_order_id
                 AND p.status='APPROVED' AND ${productionRemainingSql}>0.009
            )
          )
        )
      ORDER BY d.eligible_at,d.created_at,d.id
      LIMIT 100
      FOR UPDATE OF e,d SKIP LOCKED`
  );

  if (candidates.rowCount) {
    await assertAccountingPeriodOpen(client);
  }

  let transferred = 0;
  for (const difference of candidates.rows) {
    const remaining = Number(difference.remaining ?? 0);
    if (remaining <= 0.009) {
      await client.query("UPDATE worker_payment_settlement_differences SET status='ALLOCATED',updated_at=now() WHERE id=$1",[difference.id]);
      continue;
    }
    const reason = difference.source_order_status === "COMPLETED"
      ? "ترحيل فرق التسوية بعد إقفال الطلبية واستكمال مستحقات العامل"
      : "ترحيل فرق التسوية بعد مرور 30 يومًا دون عمل جديد";
    await client.query(
      `INSERT INTO worker_payment_settlement_difference_events(
         difference_id,worker_payment_id,source_expense_id,event_type,amount,source_order_id,target_order_id,
         target_order_stage_id,actor_type,actor_user_id,reason
       ) VALUES($1,$2,$3,'TRANSFERRED_TO_SOURCE_ORDER',$4,$5,$5,$6,$7,$8,$9)`,
      [difference.id,difference.worker_payment_id,difference.source_expense_id,remaining,difference.source_order_id,
       difference.source_order_stage_id,actor.actorType,actor.actorUserId,reason]
    );
    await client.query(
      "UPDATE worker_payment_settlement_differences SET status='TRANSFERRED_TO_SOURCE_ORDER',updated_at=now() WHERE id=$1",
      [difference.id]
    );
    await writeAudit(client, {
      actorUserId: actor.actorUserId,
      actorEmployeeId: null,
      action: "transfer_worker_payment_settlement_difference",
      module: "finance",
      entityType: "worker_payment_settlement_difference",
      entityId: difference.id,
      metadata: { workerPaymentId: difference.worker_payment_id, sourceOrderId: difference.source_order_id, amount: remaining, reason, actorType: actor.actorType },
      ipAddress: null,
      userAgent: null
    });
    transferred++;
  }
  return transferred;
}

export async function runMaturedWorkerPaymentDifferenceJob() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock(hashtext('tezkar_worker_payment_settlement_differences')) AS acquired"
    );
    if (!lock.rows[0]?.acquired) {
      await client.query("ROLLBACK");
      return 0;
    }
    const transferred = await processMaturedWorkerPaymentDifferences(client, { actorUserId: null, actorType: "SYSTEM" });
    await client.query("COMMIT");
    return transferred;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
