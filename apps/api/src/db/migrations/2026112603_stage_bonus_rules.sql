-- البونص الثابت المتدرج على المرحلة: لكل مرحلة أهداف كمية، والعامل يأخذ بونص أعلى هدف وصله في السجل الواحد (طلب محمد 26 نوفمبر).
-- البونص يُكتب في خانة البونص الحالية لسجل الإنتاج ببيان «تارجت N»، ومصيره في الحسابات هو نفس مصير البونص اليدوي.
-- آمن لإعادة التشغيل.
CREATE TABLE IF NOT EXISTS stage_bonus_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id UUID NOT NULL REFERENCES stages(id),
  target_qty NUMERIC(18,3) NOT NULL CHECK (target_qty > 0),
  bonus_amount NUMERIC(18,4) NOT NULL CHECK (bonus_amount > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stage_bonus_rules_stage_target ON stage_bonus_rules(stage_id, target_qty);
