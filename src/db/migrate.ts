/**
 * Forward-only migration runner.
 *
 * Migrations are `.sql` files in ./migrations, applied in filename order and
 * recorded in `schema_migrations` so each runs exactly once. Each file is applied
 * inside a transaction, so a failure leaves the database on the previous version.
 *
 * Foreign keys are enforced by the app but not during a migration, because a
 * migration that rebuilds a table has to drop the old one, and a drop under
 * enforcement takes every child row with it. `PRAGMA foreign_keys` is a no-op
 * inside a transaction, so it is turned off out here and on again afterwards;
 * what stands in for it is a `foreign_key_check` run before the commit, which
 * rolls the file back if it left a row pointing at nothing.
 */

import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { db, now } from "./index.ts";
import { log } from "../lib/log.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

export function migrate(target: Database = db): number {
  target.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    target.query<{ name: string }, []>("SELECT name FROM schema_migrations").all()
      .map((row) => row.name),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const contents = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

    const run = target.transaction(() => {
      target.exec(contents);

      const violations = target.query<{ table: string; parent: string }, []>(
        "PRAGMA foreign_key_check",
      ).all();
      if (violations.length > 0) {
        const [first] = violations;
        throw new Error(
          `migration ${file} left ${violations.length} row(s) with a broken reference ` +
          `(${first!.table} -> ${first!.parent})`,
        );
      }

      target
        .query("INSERT INTO schema_migrations (name, applied_at) VALUES ($name, $appliedAt)")
        .run({ name: file, appliedAt: now() });
    });

    target.exec("PRAGMA foreign_keys = OFF");
    try {
      run();
    } finally {
      target.exec("PRAGMA foreign_keys = ON");
    }

    log.info("migration applied", { migration: file });
    count += 1;
  }

  if (count === 0) log.info("database is up to date");
  return count;
}

if (import.meta.main) {
  const count = migrate();
  console.log(count === 0 ? "Database is already up to date." : `Applied ${count} migration(s).`);
}
