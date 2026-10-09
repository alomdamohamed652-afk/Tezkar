import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const adminUrl = process.env.TEST_DATABASE_URL;
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertDisposableDatabaseUrl(connectionString: string) {
  const url = new URL(connectionString);
  assert.ok(url.protocol === "postgres:" || url.protocol === "postgresql:", "TEST_DATABASE_URL must use PostgreSQL");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase()),
    "TEST_DATABASE_URL must point to a local disposable PostgreSQL test server");
  assert.equal(url.pathname.slice(1), "postgres",
    "TEST_DATABASE_URL must use the disposable admin database named postgres");
}

async function withWarehouseDatabase(run: (db: pg.Pool) => Promise<void>) {
  assert.ok(adminUrl, "TEST_DATABASE_URL must point to a disposable PostgreSQL test server");
  assertDisposableDatabaseUrl(adminUrl);
  const name = "tezkar_warehouse_test_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const target = new URL(adminUrl);
  target.pathname = "/" + name;
  const db = new pg.Pool({ connectionString: target.toString(), max: 8 });
  try {
    const migration = spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate.ts"], {
      cwd: apiDir, env: { ...process.env, DATABASE_URL: target.toString() }, encoding: "utf8"
    });
    assert.equal(migration.status, 0, migration.stderr || migration.stdout);
    await run(db);
  } finally {
    await db.end();
    const cleanup = new pg.Client({ connectionString: adminUrl });
    try {
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  }
}

async function seedWarehouse(db: pg.Pool) {
  const unit = await db.query("SELECT id FROM units WHERE code='PCS' LIMIT 1");
  assert.ok(unit.rowCount, "migrations should seed the PCS unit");
  const product = await db.query(
    "INSERT INTO products(name,product_type,unit_id,track_inventory,is_active) VALUES ($1,'FINISHED_GOOD',$2,TRUE,TRUE) RETURNING id",
    ["Concurrency test " + randomBytes(4).toString("hex"), unit.rows[0].id]
  );
  const sourceWarehouse = await db.query("INSERT INTO warehouses(name) VALUES ('Concurrency source') RETURNING id");
  const targetWarehouse = await db.query("INSERT INTO warehouses(name) VALUES ('Concurrency target') RETURNING id");
  const sourceLocation = await db.query(
    "INSERT INTO warehouse_locations(warehouse_id,code,name) VALUES ($1,'A','Source') RETURNING id",
    [sourceWarehouse.rows[0].id]
  );
  const targetLocation = await db.query(
    "INSERT INTO warehouse_locations(warehouse_id,code,name) VALUES ($1,'B','Target') RETURNING id",
    [targetWarehouse.rows[0].id]
  );
  return {
    productId: product.rows[0].id as string,
    sourceWarehouseId: sourceWarehouse.rows[0].id as string,
    targetWarehouseId: targetWarehouse.rows[0].id as string,
    sourceLocationId: sourceLocation.rows[0].id as string,
    targetLocationId: targetLocation.rows[0].id as string
  };
}

test("warehouse product lock serializes concurrent first balance inserts and opposing transfers", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  await withWarehouseDatabase(async db => {
    const ids = await seedWarehouse(db);

    // Mirror the lock ordering used by POST /api/warehouse/movements: lock the
    // tracked product before reading or mutating any stock-balance rows.
    async function addInitialStock(quantity: number) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const product = await client.query(
          "SELECT id FROM products WHERE id=$1 AND is_active=TRUE AND track_inventory=TRUE FOR UPDATE",
          [ids.productId]
        );
        assert.equal(product.rowCount, 1);
        const balance = await client.query(
          "SELECT quantity FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",
          [ids.productId, ids.sourceWarehouseId, ids.sourceLocationId]
        );
        if (balance.rowCount) {
          await client.query(
            "UPDATE stock_balances SET quantity=quantity+$1 WHERE product_id=$2 AND warehouse_id=$3 AND location_id=$4",
            [quantity, ids.productId, ids.sourceWarehouseId, ids.sourceLocationId]
          );
        } else {
          await client.query(
            "INSERT INTO stock_balances(product_id,warehouse_id,location_id,quantity) VALUES ($1,$2,$3,$4)",
            [ids.productId, ids.sourceWarehouseId, ids.sourceLocationId, quantity]
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    await Promise.all([addInitialStock(5), addInitialStock(7)]);
    const firstBalance = await db.query(
      "SELECT quantity FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [ids.productId, ids.sourceWarehouseId, ids.sourceLocationId]
    );
    assert.equal(firstBalance.rowCount, 1, "concurrent first inserts must produce one balance row");
    assert.equal(Number(firstBalance.rows[0].quantity), 12, "both receipts must be reflected in the balance");

    await db.query(
      "UPDATE stock_balances SET quantity=10 WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [ids.productId, ids.sourceWarehouseId, ids.sourceLocationId]
    );
    await db.query(
      "INSERT INTO stock_balances(product_id,warehouse_id,location_id,quantity) VALUES ($1,$2,$3,10)",
      [ids.productId, ids.targetWarehouseId, ids.targetLocationId]
    );

    async function transfer(sourceWarehouseId: string, sourceLocationId: string, destinationWarehouseId: string,
      destinationLocationId: string, quantity: number) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT id FROM products WHERE id=$1 AND is_active=TRUE AND track_inventory=TRUE FOR UPDATE",
          [ids.productId]
        );
        const source = await client.query(
          "SELECT quantity FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",
          [ids.productId, sourceWarehouseId, sourceLocationId]
        );
        assert.ok(Number(source.rows[0]?.quantity) >= quantity, "source must have enough stock");
        await client.query(
          "UPDATE stock_balances SET quantity=quantity-$1 WHERE product_id=$2 AND warehouse_id=$3 AND location_id=$4",
          [quantity, ids.productId, sourceWarehouseId, sourceLocationId]
        );
        const destination = await client.query(
          "SELECT quantity FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",
          [ids.productId, destinationWarehouseId, destinationLocationId]
        );
        if (destination.rowCount) {
          await client.query(
            "UPDATE stock_balances SET quantity=quantity+$1 WHERE product_id=$2 AND warehouse_id=$3 AND location_id=$4",
            [quantity, ids.productId, destinationWarehouseId, destinationLocationId]
          );
        } else {
          await client.query(
            "INSERT INTO stock_balances(product_id,warehouse_id,location_id,quantity) VALUES ($1,$2,$3,$4)",
            [ids.productId, destinationWarehouseId, destinationLocationId, quantity]
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    await Promise.all([
      transfer(ids.sourceWarehouseId, ids.sourceLocationId,
        ids.targetWarehouseId, ids.targetLocationId, 3),
      transfer(ids.targetWarehouseId, ids.targetLocationId, ids.sourceWarehouseId, ids.sourceLocationId, 4)
    ]);
    const total = await db.query(
      "SELECT SUM(quantity) AS quantity FROM stock_balances WHERE product_id=$1",
      [ids.productId]
    );
    assert.equal(Number(total.rows[0].quantity), 20, "opposing concurrent transfers must preserve total stock");
  });
});
