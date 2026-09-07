/**
 * Test bootstrap, loaded via bunfig.toml before any test file.
 *
 * Points the application at a scratch database so a test run can never touch
 * development or production data, then applies the migrations to it.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "ttrpg-test-"));
process.env.DATABASE_PATH = join(directory, "test.db");
process.env.UPLOAD_DIR = join(directory, "uploads");
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.LOG_LEVEL = "error";
// A disconnected player is dropped after this long. Tests wait it out, so it is
// short here; the deployed default is measured in seconds, not milliseconds.
process.env.PLAYER_GRACE_MS = "300";

// Imported after the environment is set, so the connection opens on the scratch file.
const { migrate } = await import("../src/db/migrate.ts");
migrate();

// The HERO rules data is not in this repository — it is Hero Games' own, and an
// operator extracts it from their copy of HERO Designer. A run that has it set
// exercises the sheet rendering and the characteristics; a run that does not
// skips those and tests everything else. See `rulesAvailable` in helpers.ts.
