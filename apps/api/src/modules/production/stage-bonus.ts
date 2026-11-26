import type { PoolClient } from "pg";

// Auto tiered stage bonus: the single record's quantity picks the highest reached
// tier configured for its stage (1500→50, 2000→100 means 2000 yields 100 only,
// never both). The statement always names the reached target ("تارجت 1500").
export const AUTO_BONUS_REASON_PREFIX = "تارجت ";

export async function resolveAutoStageBonus(
  client: PoolClient,
  stageId: string | null | undefined,
  quantity: number
): Promise<{ amount: number; reason: string } | null> {
  if (!stageId || !Number.isFinite(quantity) || quantity <= 0) return null;
  const tier = await client.query(
    `SELECT target_qty, bonus_amount
       FROM stage_bonus_rules
      WHERE stage_id=$1 AND is_active=TRUE AND target_qty <= $2::numeric
      ORDER BY target_qty DESC
      LIMIT 1`,
    [stageId, quantity]
  );
  if (!tier.rowCount) return null;
  const target = Number(tier.rows[0].target_qty);
  const amount = Number(tier.rows[0].bonus_amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, reason: `${AUTO_BONUS_REASON_PREFIX}${target}` };
}
