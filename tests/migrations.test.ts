/**
 * The migration runner against a database that predates a migration.
 *
 * The scratch database the rest of the suite uses is migrated all at once, so it
 * can never exercise a backfill. These build the older shape by hand and let the
 * runner bring it forward.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.ts";
import { CARD_IMAGE_PX } from "../src/lib/cards.ts";

const MIGRATIONS = join(import.meta.dir, "../src/db/migrations");

/** A database on 001 only, with the runner told that much has been applied. */
function atInitialSchema(): Database {
  const target = new Database(":memory:", { strict: true });
  target.exec("PRAGMA foreign_keys = ON");
  target.exec(readFileSync(join(MIGRATIONS, "001_init.sql"), "utf8"));
  target.exec(`
    CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES ('001_init.sql', '2026-01-01T00:00:00.000Z');
    INSERT INTO gms VALUES ('gm1', 'gm@example.com', 'hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO campaigns (id, gm_id, name, created_at, updated_at)
      VALUES ('c1', 'gm1', 'Campaign', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  return target;
}

/** One active session on campaign c1, created at the given time. */
function addActiveSession(target: Database, id: string, createdAt: string): void {
  target.query(`
    INSERT INTO game_sessions (id, campaign_id, gm_id, code, status, round, created_at)
    -- round is the column 001 created; 006 renames it to turn.
    VALUES ($id, 'c1', 'gm1', $code, 'active', 1, $createdAt)
  `).run({ id, code: id.toUpperCase(), createdAt });
}

describe("one active session per campaign", () => {
  test("the migration keeps the newest and ends the rest", () => {
    const target = atInitialSchema();
    addActiveSession(target, "old", "2026-01-01T10:00:00.000Z");
    addActiveSession(target, "mid", "2026-01-01T11:00:00.000Z");
    addActiveSession(target, "new", "2026-01-01T12:00:00.000Z");

    // Every migration after 001, which `atInitialSchema` has already applied.
    expect(migrate(target)).toBe(15);

    const statuses = Object.fromEntries(
      target.query<{ id: string; status: string }, []>(
        "SELECT id, status FROM game_sessions",
      ).all().map((row) => [row.id, row.status]),
    );
    // 002 ends the two it cannot keep, and 006 ends the survivor too — a fight
    // tracked in rounds has no honest reading as turns and segments.
    expect(statuses).toEqual({ old: "ended", mid: "ended", new: "ended" });

    // Ended by the migration, so they carry the timestamp the app writes.
    const endedAt = target.query<{ ended_at: string | null }, []>(
      "SELECT ended_at FROM game_sessions WHERE id = 'old'",
    ).get()!.ended_at;
    expect(endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("and then refuses a second one", () => {
    const target = atInitialSchema();
    migrate(target);

    // The index is what enforces it, so it has to be tested after the migrations
    // rather than through them — 006 leaves nothing active to collide with.
    const add = (id: string) =>
      target.query(`
        INSERT INTO game_sessions (id, campaign_id, gm_id, code, status, turn, segment, created_at)
        VALUES ($id, 'c1', 'gm1', $code, 'active', 1, 12, '2026-01-01T10:00:00.000Z')
      `).run({ id, code: id.toUpperCase() });

    add("first");
    expect(() => add("second")).toThrow(/UNIQUE constraint/i);
  });
});

describe("turns and segments", () => {
  test("the round column becomes a turn, with a segment beside it", () => {
    const target = atInitialSchema();
    migrate(target);

    const columns = target.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('game_sessions')",
    ).all().map((row) => row.name);
    expect(columns).toContain("turn");
    expect(columns).toContain("segment");
    expect(columns).not.toContain("round");
  });

  test("a fight that was being tracked in rounds is ended rather than guessed at", () => {
    const target = atInitialSchema();
    addActiveSession(target, "only", "2026-01-01T10:00:00.000Z");

    migrate(target);

    const row = target.query<
      { status: string; ended_at: string | null; turn: number; segment: number },
      []
    >("SELECT status, ended_at, turn, segment FROM game_sessions WHERE id = 'only'").get()!;
    expect(row.status).toBe("ended");
    expect(row.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Left where a fresh session starts: turn one, segment twelve.
    expect(row.turn).toBe(1);
    expect(row.segment).toBe(12);
  });

  test("the campaign and its characters survive it", () => {
    const target = atInitialSchema();
    addActiveSession(target, "only", "2026-01-01T10:00:00.000Z");

    migrate(target);

    // Only the fight is thrown away. The library is the game master's work.
    expect(
      target.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM campaigns").get()!.n,
    ).toBe(1);
  });
});

describe("copies of an NPC on the stage", () => {
  test("the stage is rebuilt with a slot id and a copy number", () => {
    const target = atInitialSchema();
    addActiveSession(target, "only", "2026-01-01T10:00:00.000Z");
    migrate(target);

    const columns = target.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('session_characters')",
    ).all().map((row) => row.name);
    expect(columns).toContain("id");
    expect(columns).toContain("copy_number");

    // The turn marker moved off the character and onto the slot.
    const sessionColumns = target.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('game_sessions')",
    ).all().map((row) => row.name);
    expect(sessionColumns).toContain("active_slot_id");
    expect(sessionColumns).not.toContain("active_character_id");
  });

  test("the same character can now be on the stage twice", () => {
    const target = atInitialSchema();
    addActiveSession(target, "only", "2026-01-01T10:00:00.000Z");
    migrate(target);

    target.exec(`
      INSERT INTO uploads
        (id, kind, disk_path, mime, byte_size, sha256, original_name, created_at)
        VALUES ('u1', 'sheet', 'p', 'text/html', 1, 'x', 'sheet.html', '2026-01-01T00:00:00.000Z');
      INSERT INTO characters (id, campaign_id, kind, name, sheet_upload_id, created_at, updated_at)
        VALUES ('goblin', 'c1', 'npc', 'Goblin', 'u1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);

    const add = (id: string, copy: number, position: number) =>
      target.query(`
        INSERT INTO session_characters
          (id, game_session_id, character_id, copy_number, position, added_at)
        VALUES ($id, 'only', 'goblin', $copy, $position, '2026-01-01T00:00:00.000Z')
      `).run({ id, copy, position });

    // Two rows naming one character: the pair that used to be the primary key.
    add("s1", 1, 0);
    expect(() => add("s2", 2, 1)).not.toThrow();

    expect(
      target.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM session_characters WHERE character_id = 'goblin'",
      ).get()!.n,
    ).toBe(2);
  });
});

describe("HERO characteristics", () => {
  test("a character from before the migration reads as zeros, not nulls", () => {
    const target = atInitialSchema();
    target.exec(`
      INSERT INTO uploads
        (id, kind, disk_path, mime, byte_size, sha256, original_name, created_at)
        VALUES ('u1', 'sheet', 'p', 'text/html', 1, 'x', 'sheet.html', '2026-01-01T00:00:00.000Z');
      INSERT INTO characters (id, campaign_id, kind, name, sheet_upload_id, created_at, updated_at)
        VALUES ('old', 'c1', 'pc', 'Thorin', 'u1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);

    migrate(target);

    expect(
      target.query<Record<string, number>, []>(
        "SELECT speed, dexterity, initiative, constitution, recovery, endurance, stun, body " +
          "FROM characters WHERE id = 'old'",
      ).get(),
    ).toEqual({
      speed: 0,
      dexterity: 0,
      initiative: 0,
      constitution: 0,
      recovery: 0,
      endurance: 0,
      stun: 0,
      body: 0,
    });
  });
});

describe("card images", () => {
  test("the background column becomes a card, keeping what it pointed at", () => {
    const target = atInitialSchema();
    target.exec(`
      INSERT INTO uploads
        VALUES ('u1', 'image', '/tmp/u1', 'image/png', 10, 'sha', 'art.png', '2026-01-01T00:00:00.000Z');
      UPDATE campaigns SET background_upload_id = 'u1' WHERE id = 'c1';
      INSERT INTO characters
        (id, campaign_id, kind, name, sheet_upload_id, background_upload_id, created_at, updated_at)
        VALUES ('ch1', 'c1', 'pc', 'Hero', 'u1', 'u1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);

    migrate(target);

    for (const table of ["campaigns", "characters"]) {
      const columns = target.query<{ name: string }, []>(
        `SELECT name FROM pragma_table_info('${table}')`,
      ).all().map((row) => row.name);
      expect(columns).toContain("card_upload_id");
      expect(columns).not.toContain("background_upload_id");
    }

    // A rename, not a reset: the library keeps the artwork it already had.
    expect(
      target.query<{ card_upload_id: string | null }, []>(
        "SELECT card_upload_id FROM campaigns WHERE id = 'c1'",
      ).get()!.card_upload_id,
    ).toBe("u1");
    expect(
      target.query<{ card_upload_id: string | null }, []>(
        "SELECT card_upload_id FROM characters WHERE id = 'ch1'",
      ).get()!.card_upload_id,
    ).toBe("u1");
  });
});

describe("upload paths", () => {
  test("an absolute path from an older checkout becomes one relative to the upload directory", () => {
    const target = atInitialSchema();
    target.exec(`
      INSERT INTO uploads
        VALUES ('u1', 'image', '/home/someone/old-name/data/uploads/images/u1',
                'image/png', 10, 'sha', 'art.png', '2026-01-01T00:00:00.000Z');
      INSERT INTO uploads
        VALUES ('u2', 'sheet', '/home/someone/old-name/data/uploads/sheets/u2',
                'text/html', 10, 'sha', 'hero.html', '2026-01-01T00:00:00.000Z');
    `);

    migrate(target);

    // The directory the checkout happened to sit in is gone from the row, so
    // renaming or moving it no longer orphans the file.
    expect(
      Object.fromEntries(
        target.query<{ id: string; disk_path: string }, []>(
          "SELECT id, disk_path FROM uploads",
        ).all().map((row) => [row.id, row.disk_path]),
      ),
    ).toEqual({ u1: "images/u1", u2: "sheets/u2" });
  });
});

describe("held actions", () => {
  test("nobody is waiting and the clock has nothing pending", () => {
    const target = atInitialSchema();
    addActiveSession(target, "only", "2026-01-01T10:00:00.000Z");

    migrate(target);

    // The stage is filled after the run rather than before it: 003 rebuilds
    // `session_characters` to give a slot an id, so a row written at the initial
    // schema does not survive to be read here. What this is about is the two new
    // columns being there with the state a fight already running was in.
    target.exec(`
      INSERT INTO uploads
        VALUES ('u1', 'sheet', 'sheets/u1', 'text/html', 1, 'x', 'sheet.html', '2026-01-01T00:00:00.000Z');
      INSERT INTO characters (id, campaign_id, kind, name, sheet_upload_id, created_at, updated_at)
        VALUES ('ch1', 'c1', 'npc', 'Goblin', 'u1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO session_characters (id, game_session_id, character_id, copy_number, position, added_at)
        VALUES ('slot1', 'only', 'ch1', 1, 0, '2026-01-01T00:00:00.000Z');
    `);

    // Holding is something nobody has done yet, and the clock has nothing to
    // resume from — which is what every row written before the feature means.
    expect(
      target.query<{ held: number }, []>("SELECT held FROM session_characters").get()!.held,
    ).toBe(0);
    expect(
      target.query<{ resume_slot_id: string | null }, []>(
        "SELECT resume_slot_id FROM game_sessions WHERE id = 'only'",
      ).get()!.resume_slot_id,
    ).toBeNull();
  });
});

describe("a game master's library reach", () => {
  test("an existing account keeps the one campaign it has always seen", () => {
    const target = atInitialSchema();

    migrate(target);

    // Off, so a console that has always listed one campaign goes on listing one
    // campaign until somebody asks otherwise.
    const flag = target.query<{ show_all_npcs: number }, []>(
      "SELECT show_all_npcs FROM gms WHERE id = 'gm1'",
    ).get()!.show_all_npcs;
    expect(flag).toBe(0);
  });
});

describe("a game master's export templates", () => {
  test("an account that has never chosen one renders through the built-in", () => {
    const target = atInitialSchema();

    migrate(target);

    // NULL, which is what "has never chosen" means and the only value that needs
    // no template row to exist. A sheet drawn for this account goes through the
    // template the app ships, exactly as it did before there was a choice.
    expect(
      target.query<{ template_id: string | null }, []>(
        "SELECT template_id FROM gms WHERE id = 'gm1'",
      ).get()!.template_id,
    ).toBeNull();
  });

  test("one name per game master, but two game masters may use the same one", () => {
    const target = atInitialSchema();
    migrate(target);
    target.exec(`
      INSERT INTO gms VALUES
        ('gm2', 'other@example.com', 'hash', '2026-01-01T00:00:00.000Z',
         '2026-01-01T00:00:00.000Z', 176, 0, NULL);
      INSERT INTO templates VALUES
        ('t1', 'gm1', 'Ork 16x9', 'ork.hde', 10, 'sha', '2026-01-01T00:00:00.000Z',
         '2026-01-01T00:00:00.000Z');
    `);

    // Their own collection each: the same template exported by two game masters
    // is two files, and neither is in the other's way.
    expect(() =>
      target.exec(`
        INSERT INTO templates VALUES
          ('t2', 'gm2', 'Ork 16x9', 'ork.hde', 10, 'sha', '2026-01-01T00:00:00.000Z',
           '2026-01-01T00:00:00.000Z')
      `)
    ).not.toThrow();

    // But one of them twice is that template being updated, which is a rewrite
    // of the row it already has rather than a second one.
    expect(() =>
      target.exec(`
        INSERT INTO templates VALUES
          ('t3', 'gm1', 'ORK 16X9', 'ork.hde', 10, 'sha', '2026-01-01T00:00:00.000Z',
           '2026-01-01T00:00:00.000Z')
      `)
    ).toThrow();
  });

  test("a deleted game master takes their templates with them", () => {
    const target = atInitialSchema();
    migrate(target);
    target.exec(`
      INSERT INTO templates VALUES
        ('t1', 'gm1', 'Mine', 'mine.hde', 10, 'sha', '2026-01-01T00:00:00.000Z',
         '2026-01-01T00:00:00.000Z');
      UPDATE gms SET template_id = 't1' WHERE id = 'gm1';
    `);

    target.exec("DELETE FROM gms WHERE id = 'gm1'");

    // The cascade, which is what keeps one account's collection from outliving
    // it. The files it leaves behind are the CLI's business — see `gm:delete`.
    expect(
      target.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM templates").get()!.count,
    ).toBe(0);
  });
});

describe("a game master's card size", () => {
  test("an existing account comes through at the size the deployment used to set", () => {
    const target = atInitialSchema();

    migrate(target);

    // The default the env var carried, so a table that upgrades sees the library
    // it went to bed with. And it is the same number the app reads from
    // `lib/cards.ts` — the migration writes it as a literal because SQL cannot
    // import, so this is the assertion that keeps the two honest.
    const size = target.query<{ card_image_px: number }, []>(
      "SELECT card_image_px FROM gms WHERE id = 'gm1'",
    ).get()!.card_image_px;
    expect(size).toBe(CARD_IMAGE_PX.default);
  });
});

describe("campaign names per game master", () => {
  /** A second game master, and a character and a session hanging off c1. */
  function withNeighbours(target: Database): void {
    target.exec(`
      INSERT INTO gms VALUES
        ('gm2', 'other@example.com', 'hash', '2026-01-01T00:00:00.000Z',
         '2026-01-01T00:00:00.000Z');
      INSERT INTO uploads VALUES
        ('u1', 'sheet', 'sheets/u1', 'text/html', 10, 'sha', 'grognard.hdc',
         '2026-01-01T00:00:00.000Z');
      INSERT INTO characters (id, campaign_id, kind, name, sheet_upload_id, created_at, updated_at)
        VALUES ('ch1', 'c1', 'pc', 'Grognard', 'u1', '2026-01-01T00:00:00.000Z',
                '2026-01-01T00:00:00.000Z');
    `);
    addActiveSession(target, "s1", "2026-01-01T10:00:00.000Z");
  }

  test("the rebuild leaves the campaign's characters and sessions where they were", () => {
    const target = atInitialSchema();
    withNeighbours(target);

    migrate(target);

    // The whole risk of this migration: `campaigns` is dropped and rebuilt, and
    // both of these cascade from it.
    expect(
      target.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM characters").get()!.count,
    ).toBe(1);
    expect(
      target.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM game_sessions").get()!
        .count,
    ).toBe(1);
    // And they still point at a campaign that exists.
    expect(target.query<{ n: number }, []>("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("the campaign itself comes through unchanged", () => {
    const target = atInitialSchema();

    migrate(target);

    const row = target.query<
      { gm_id: string; name: string; created_at: string },
      []
    >("SELECT gm_id, name, created_at FROM campaigns WHERE id = 'c1'").get()!;
    expect(row).toEqual({
      gm_id: "gm1",
      name: "Campaign",
      created_at: "2026-01-01T00:00:00.000Z",
    });
  });

  test("two game masters may each run a campaign of the same name", () => {
    const target = atInitialSchema();
    withNeighbours(target);
    migrate(target);

    const add = (id: string, gm: string, name: string) =>
      target.query(`
        INSERT INTO campaigns (id, gm_id, name, created_at, updated_at)
        VALUES ($id, $gm, $name, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run({ id, gm, name });

    // Nobody sees another game master's library, so the name is not in the way.
    expect(() => add("c2", "gm2", "Campaign")).not.toThrow();

    // Within one library it still is, case and all.
    expect(() => add("c3", "gm1", "CAMPAIGN")).toThrow(/UNIQUE constraint/i);
  });
});
