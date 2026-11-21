export type TransferTable = { name: string; primaryKey: string[] };
export type TransferForeignKey = {
  table: string;
  referencedTable: string;
  deferrable: boolean;
  initiallyDeferred: boolean;
};

export type TransferOrder = {
  orderedTables: string[];
  blockedTables: string[];
  blockers: string[];
};

/**
 * Build a parent-before-child insertion order. This is planning-only: it never
 * executes SQL and blocks all dependency cycles until a transactional,
 * deferred-constraint transfer strategy is implemented and tested.
 */
export function buildTransferOrder(
  tables: TransferTable[],
  foreignKeys: TransferForeignKey[],
  initiallyBlockedTables: string[] = []
): TransferOrder {
  const names = new Set(tables.map(table => table.name));
  const blockers: string[] = [];
  const blocked = new Set<string>(initiallyBlockedTables.filter(name => names.has(name)));
  if (names.size !== tables.length) {
    blockers.push("Duplicate table names were supplied to the transfer planner; the entire plan is blocked");
    for (const name of names) blocked.add(name);
  }
  for (const name of [...blocked].sort()) {
    blockers.push(`Table ${name} has schema differences or is missing from the target; transfer is blocked`);
  }
  for (const table of tables) {
    if (table.primaryKey.length === 0) {
      blocked.add(table.name);
      blockers.push(`Table ${table.name} has no primary key; resumable transfer is unsafe`);
    }
  }

  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const name of names) {
    outgoing.set(name, new Set());
    indegree.set(name, 0);
  }

  for (const fk of foreignKeys) {
    if (!names.has(fk.table)) {
      blockers.push(`Foreign key source table ${fk.table} is missing from the inspected table set; the entire plan is blocked`);
      for (const name of names) blocked.add(name);
      continue;
    }
    if (!names.has(fk.referencedTable)) {
      blocked.add(fk.table);
      blockers.push(`Foreign key from ${fk.table} references a table outside the inspected set (${fk.referencedTable})`);
      continue;
    }
    if (fk.table === fk.referencedTable) {
      blocked.add(fk.table);
      blockers.push(`Self-referencing foreign key on ${fk.table} requires a deferred-constraint transfer strategy`);
      continue;
    }
    // Edge direction is referenced (parent) -> referencing (child).
    const children = outgoing.get(fk.referencedTable)!;
    if (!children.has(fk.table)) {
      children.add(fk.table);
      indegree.set(fk.table, indegree.get(fk.table)! + 1);
    }
  }

  const ready = [...names].filter(name => indegree.get(name) === 0).sort();
  const orderedTables: string[] = [];
  while (ready.length) {
    const current = ready.shift()!;
    orderedTables.push(current);
    for (const child of [...outgoing.get(current)!].sort()) {
      const next = indegree.get(child)! - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }

  const cyclic = [...names].filter(name => !orderedTables.includes(name) && !blocked.has(name)).sort();
  if (cyclic.length) {
    for (const name of cyclic) blocked.add(name);
    blockers.push(`Foreign-key cycle or dependency on a cycle detected: ${cyclic.join(", ")}; automatic transfer is blocked`);
  }

  // A child must not be transferred if its referenced parent is blocked.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [parent, children] of outgoing) {
      if (!blocked.has(parent)) continue;
      for (const child of children) {
        if (!blocked.has(child)) {
          blocked.add(child);
          changed = true;
        }
      }
    }
  }

  return {
    orderedTables: orderedTables.filter(name => !blocked.has(name)),
    blockedTables: [...blocked].sort(),
    blockers
  };
}
