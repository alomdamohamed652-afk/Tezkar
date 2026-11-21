export type TransferPlanTable = {
  table: string;
  status: string;
  sourceEstimate: number;
  targetEstimate: number;
  dependencies: string[];
  hasPrimaryKey: boolean;
  differences: string[];
};

export type TransferPlan = {
  readyOrder: Array<{ table: string; estimatedRows: number; dependsOn: string[] }>;
  blocked: Array<{ table: string; reason: string; dependencies: string[] }>;
  deferred: Array<{ table: string; reason: string; dependencies: string[] }>;
  totals: { sourceTables: number; readyTables: number; blockedTables: number; deferredTables: number };
  writeEnabled: false;
};

/**
 * Produces a read-only preview only. It never connects to PostgreSQL or writes data.
 * Only schema-compatible tables can enter the order; dependencies must also be eligible.
 */
export function buildTransferPlan(tables: TransferPlanTable[]): TransferPlan {
  const byName = new Map(tables.map(table => [table.table, table]));
  const blocked = new Map<string, { table: string; reason: string; dependencies: string[] }>();
  const candidates = new Map<string, TransferPlanTable>();

  for (const table of tables) {
    if (table.status !== "compatible") {
      blocked.set(table.table, {
        table: table.table,
        reason: table.status === "source_only"
          ? "الجدول غير موجود في الوجهة؛ لا يمكن إدراج بياناته قبل تجهيز المخطط ومراجعته."
          : table.status === "target_only"
            ? "الجدول موجود في الوجهة فقط ولا يقابله جدول مصدر."
            : "اختلاف بنيوي بين المصدر والوجهة؛ يلزم حلّه قبل التخطيط للنقل.",
        dependencies: [...new Set(table.dependencies)]
      });
    } else if (!table.hasPrimaryKey) {
      blocked.set(table.table, {
        table: table.table,
        reason: "الجدول لا يحتوي على مفتاح أساسي صالح في المصدر والوجهة؛ لا يمكن ضمان منع التكرار أو الاستئناف بأمان.",
        dependencies: [...new Set(table.dependencies)]
      });
    } else {
      candidates.set(table.table, table);
    }
  }

  for (const [name, table] of candidates) {
    const unavailable = [...new Set(table.dependencies)].filter(dependency => !candidates.has(dependency));
    if (unavailable.length) {
      candidates.delete(name);
      blocked.set(name, {
        table: name,
        reason: "يعتمد الجدول على جداول غير جاهزة أو خارج نطاق public.",
        dependencies: unavailable
      });
    }
  }

  // Propagate blocked dependencies until the remaining graph is closed.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, table] of candidates) {
      const unavailable = [...new Set(table.dependencies)].filter(dependency => !candidates.has(dependency));
      if (unavailable.length) {
        candidates.delete(name);
        blocked.set(name, {
          table: name,
          reason: "يعتمد الجدول على جدول لم يصبح جاهزًا للنقل.",
          dependencies: unavailable
        });
        changed = true;
      }
    }
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const [name, table] of candidates) {
    const dependencies = [...new Set(table.dependencies)];
    indegree.set(name, dependencies.length);
    for (const dependency of dependencies) {
      const list = dependents.get(dependency) ?? [];
      list.push(name);
      dependents.set(dependency, list);
    }
  }

  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([name]) => name).sort();
  const readyOrder: TransferPlan["readyOrder"] = [];
  while (queue.length) {
    const name = queue.shift()!;
    const table = candidates.get(name)!;
    readyOrder.push({
      table: name,
      estimatedRows: table.sourceEstimate,
      dependsOn: [...new Set(table.dependencies)].sort()
    });
    for (const dependent of dependents.get(name) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        queue.push(dependent);
        queue.sort();
      }
    }
  }

  const ordered = new Set(readyOrder.map(item => item.table));
  const deferred = [...candidates.entries()]
    .filter(([name]) => !ordered.has(name))
    .map(([name, table]) => ({
      table: name,
      reason: "تعذر تحديد ترتيب آمن بسبب دورة علاقات أو اعتماد دائري؛ لن يُدرج في ترتيب النقل التلقائي.",
      dependencies: [...new Set(table.dependencies)].sort()
    }));

  return {
    readyOrder,
    blocked: [...blocked.values()].sort((a, b) => a.table.localeCompare(b.table)),
    deferred,
    totals: {
      sourceTables: tables.filter(table => table.status !== "target_only").length,
      readyTables: readyOrder.length,
      blockedTables: blocked.size,
      deferredTables: deferred.length
    },
    writeEnabled: false
  };
}
