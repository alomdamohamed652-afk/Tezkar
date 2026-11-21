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
 * executes SQL and deliberately refuses cycles unless every participating
 * cycle edge is deferrable and initially deferred.
 */
export function buildTransferOrder(
  tables: TransferTable[],
  foreignKeys: TransferForeignKey[]
): TransferOrder {
  const names = new Set(tables.map(table => table.name));
  const blockers: string[] = [];
  const blocked = new Set<string>();
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
    if (!names.has(fk.table) || !names.has(fk.referencedTable)) continue;
    if (fk.table === fk.referencedTable) {
      if (!fk.deferrable || !fk.initiallyDeferred) {
        blocked.add(fk.table);
        blockers.push(`Self-referencing foreign key on ${fk.table} is not initially deferred`);
      }
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

  const cyclic = [...names].filter(name => !orderedTables.includes(name)).sort();
  if (cyclic.length) {
    for (const name of cyclic) blocked.add(name);
    blockers.push(`Foreign-key dependency cycle detected: ${cyclic.join(", ")}; automatic transfer is blocked`);
  }

  return {
    orderedTables: orderedTables.filter(name => !blocked.has(name)),
    blockedTables: [...blocked].sort(),
    blockers
  };
}
