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
export function buildTransferPlan(tables: TransferPlanTable[], globalBlockers: string[] = []): TransferPlan {
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
            : table.status === "unsupported_relation"
              ? "علاقة FOREIGN TABLE غير مدعومة في فحص النقل؛ يلزم مراجعتها يدويًا قبل اعتماد أي خطة."
              : "اختلاف بنيوي بين المصدر والوجهة؛ يلزم حلّه قبل التخطيط للنقل.",
        dependencies: [...new Set(table.dependencies)]
      });
    } else if (globalBlockers.length > 0) {
      blocked.set(table.table, {
        table: table.table,
        reason: `اختلاف في كائنات قاعدة البيانات العامة يمنع اعتماد جاهزية الجدول: ${globalBlockers.join("، ")}.`,
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
  const remaining = new Set([...candidates.keys()].filter(name => !ordered.has(name)));

  // Find actual strongly connected components. Kahn's remaining nodes also
  // include tables that merely depend on a cycle; those are blocked, not cyclic.
  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycleMembers = new Set<string>();
  const visit = (name: string): void => {
    indexes.set(name, nextIndex);
    lowLinks.set(name, nextIndex);
    nextIndex += 1;
    stack.push(name);
    onStack.add(name);

    for (const dependency of [...new Set(candidates.get(name)?.dependencies ?? [])]) {
      if (!remaining.has(dependency)) continue;
      if (!indexes.has(dependency)) {
        visit(dependency);
        lowLinks.set(name, Math.min(lowLinks.get(name)!, lowLinks.get(dependency)!));
      } else if (onStack.has(dependency)) {
        lowLinks.set(name, Math.min(lowLinks.get(name)!, indexes.get(dependency)!));
      }
    }

    if (lowLinks.get(name) !== indexes.get(name)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== name);

    const selfReferential = component.length === 1 &&
      (candidates.get(component[0])?.dependencies ?? []).includes(component[0]);
    if (component.length > 1 || selfReferential) {
      for (const item of component) cycleMembers.add(item);
    }
  };

  for (const name of remaining) {
    if (!indexes.has(name)) visit(name);
  }

  const deferred = [...cycleMembers].sort().map(name => ({
    table: name,
    reason: "هذا الجدول عضو في دورة علاقات فعلية؛ يلزم تصميم معالجة خاصة للمفاتيح الأجنبية قبل نقله.",
    dependencies: [...new Set(candidates.get(name)?.dependencies ?? [])].sort()
  }));
  const cycleBlocked = [...remaining]
    .filter(name => !cycleMembers.has(name))
    .map(name => ({
      table: name,
      reason: "يعتمد هذا الجدول، بشكل مباشر أو غير مباشر، على دورة علاقات مؤجلة؛ لذلك لا يمكن نقله تلقائيًا.",
      dependencies: [...new Set(candidates.get(name)?.dependencies ?? [])].sort()
    }));
  for (const item of cycleBlocked) blocked.set(item.table, item);

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
