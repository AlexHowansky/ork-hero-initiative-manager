#!/usr/bin/env bun
/**
 * Game master account management.
 *
 * The spec deliberately keeps account management out of the web UI, so this is
 * the only way to create, edit or remove a GM. Passwords are read without echo
 * when they aren't supplied on the command line, hashed with argon2id, and never
 * written to a log.
 */

import { migrate } from "../db/migrate.ts";
import { gms, uploads } from "../db/queries.ts";
import {
  collectOrphanedUploads,
  collectStrayFiles,
  findStrayFiles,
} from "../server/uploads.ts";
import { deleteTemplatesForGm } from "../server/templates.ts";
import { parse, schemas } from "../lib/validate.ts";
import { limits } from "../lib/config.ts";
import { AppError } from "../lib/errors.ts";

/* --------------------------------------------------------------------- input */

interface Args {
  command: string;
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

function flagValue(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

/** Reads a line from the terminal with echo disabled, so passwords stay off-screen. */
async function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  if (!stdin.isTTY) {
    // Non-interactive (piped input): fall back to a plain read.
    for await (const line of console) return line;
    return "";
  }
  stdin.setRawMode(true);
  stdin.resume();

  return await new Promise<string>((resolve) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 0x03) {
          // Ctrl-C
          stdin.setRawMode(wasRaw ?? false);
          stdin.pause();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (byte === 0x0d || byte === 0x0a) {
          stdin.off("data", onData);
          stdin.setRawMode(wasRaw ?? false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(buffer);
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += String.fromCharCode(byte);
      }
    };
    stdin.on("data", onData);
  });
}

async function promptLine(question: string): Promise<string> {
  process.stdout.write(question);
  for await (const line of console) return line.trim();
  return "";
}

/** Collects a password, confirming it when it wasn't given on the command line. */
async function resolvePassword(supplied: string | undefined): Promise<string> {
  if (supplied !== undefined) return parse(schemas.password, supplied);

  const first = await promptHidden(
    `Password (min ${limits.passwordMinLength} characters): `,
  );
  const password = parse(schemas.password, first);
  const confirm = await promptHidden("Confirm password: ");
  if (password !== confirm) throw new AppError("bad_request", "The passwords didn't match.");
  return password;
}

function requireEmail(args: Args): string {
  const email = flagValue(args, "email");
  if (!email) throw new AppError("bad_request", "Missing --email.");
  return parse(schemas.email, email);
}

async function hash(password: string): Promise<string> {
  return await Bun.password.hash(password, { algorithm: "argon2id" });
}

/* ------------------------------------------------------------------ commands */

async function gmAdd(args: Args): Promise<void> {
  const email = requireEmail(args);
  if (gms.byEmail(email)) {
    throw new AppError("conflict", `A game master with the email ${email} already exists.`);
  }
  const password = await resolvePassword(flagValue(args, "password"));
  const gm = gms.create(email, await hash(password));
  console.log(`Created game master ${gm.email}.`);
}

function gmList(): void {
  const all = gms.all();
  if (all.length === 0) {
    console.log("No game masters yet. Create one with: bun run cli gm:add --email <address>");
    return;
  }
  console.log(`${all.length} game master(s):`);
  for (const gm of all) {
    console.log(`  ${gm.email.padEnd(36)} created ${gm.created_at.slice(0, 10)}`);
  }
}

async function gmEdit(args: Args): Promise<void> {
  const email = requireEmail(args);
  const gm = gms.byEmail(email);
  if (!gm) throw new AppError("not_found", `No game master found with the email ${email}.`);

  const newEmail = flagValue(args, "new-email");
  const wantsPassword = flagValue(args, "password") !== undefined || args.flags["password"] === true;

  if (!newEmail && !wantsPassword) {
    throw new AppError("bad_request", "Nothing to change. Pass --new-email and/or --password.");
  }

  const changes: { email?: string; passwordHash?: string } = {};

  if (newEmail) {
    const parsed = parse(schemas.email, newEmail);
    const existing = gms.byEmail(parsed);
    if (existing && existing.id !== gm.id) {
      throw new AppError("conflict", `A game master with the email ${parsed} already exists.`);
    }
    changes.email = parsed;
  }

  if (wantsPassword) {
    const supplied = flagValue(args, "password");
    changes.passwordHash = await hash(await resolvePassword(supplied));
  }

  gms.update(gm.id, changes);
  console.log(
    changes.passwordHash
      ? `Updated ${changes.email ?? gm.email}. Existing sign-ins were revoked.`
      : `Updated ${changes.email ?? gm.email}.`,
  );
}

async function gmDelete(args: Args): Promise<void> {
  const email = requireEmail(args);
  const gm = gms.byEmail(email);
  if (!gm) throw new AppError("not_found", `No game master found with the email ${email}.`);

  if (args.flags["yes"] !== true) {
    const answer = await promptLine(
      `Delete ${gm.email}? Their campaigns, characters and sessions go too. [y/N] `,
    );
    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      console.log("Cancelled.");
      return;
    }
  }

  // Before the account, not after: their export templates go with them by
  // database cascade, and once those rows are gone nothing on the instance can
  // name the files any more — `collectOrphanedUploads` reads the `uploads` table
  // and would never see them.
  const templatesDeleted = await deleteTemplatesForGm(gm.id);

  gms.remove(gm.id);
  // The cascade takes their campaigns, characters and sessions, but an upload
  // row is referenced rather than owned, so their sheets and cards would survive
  // as orphans. Sweeping here is what keeps `db:gc` from having anything to find.
  const collected = await collectOrphanedUploads();
  const also = [
    collected > 0 ? `${collected} upload(s) nothing referenced any more` : null,
    templatesDeleted > 0 ? `${templatesDeleted} export template(s)` : null,
  ].filter(Boolean);
  console.log(
    also.length > 0 ? `Deleted ${gm.email}, and ${also.join(" and ")}.` : `Deleted ${gm.email}.`,
  );
}

/**
 * Sweeps both directions of upload wreckage: rows nothing references, and files
 * no row claims. Deleting a game master or a character collects the first kind
 * as it goes, so a run that finds anything is usually cleaning up after an older
 * version of the app, an interrupted upload, or a database restored from a
 * backup older than the files beside it.
 */
async function dbGc(args: Args): Promise<void> {
  if (args.flags["dry-run"] === true) {
    const orphans = uploads.orphaned();
    const stray = await findStrayFiles();
    console.log(`${orphans.length} upload row(s) nothing references.`);
    console.log(`${stray.length} file(s) no upload row claims.`);
    if (orphans.length + stray.length > 0) console.log("Run without --dry-run to delete them.");
    return;
  }

  // Rows first: collecting one deletes its file too, which keeps that file from
  // being counted a second time as a stray.
  const collected = await collectOrphanedUploads();
  const stray = await collectStrayFiles();
  console.log(`Deleted ${collected} orphaned upload row(s) and ${stray} stray file(s).`);
}

function usage(): void {
  console.log(`HERO Initiative Manager — game master accounts

Usage: bun run cli <command> [flags]

Commands:
  gm:add     --email <address> [--password <password>]   Create a game master
  gm:list                                                List game masters
  gm:edit    --email <address> [--new-email <address>] [--password <password>]
  gm:delete  --email <address> [--yes]                   Delete a game master
  db:migrate                                             Apply pending migrations
  db:gc      [--dry-run]                                 Delete uploads nothing references

Passwords are prompted for (without echo) when not passed as a flag. Prefer the
prompt: a password on the command line is visible to other users via the process
list and is saved in your shell history.`);
}

/* --------------------------------------------------------------------- entry */

const args = parseArgs(process.argv.slice(2));

try {
  // Every command needs a current schema, and this is the one entry point that
  // runs before the server is ever started.
  migrate();

  switch (args.command) {
    case "gm:add":
      await gmAdd(args);
      break;
    case "gm:list":
      gmList();
      break;
    case "gm:edit":
      await gmEdit(args);
      break;
    case "gm:delete":
      await gmDelete(args);
      break;
    case "db:migrate":
      console.log("Database is up to date.");
      break;
    case "db:gc":
      await dbGc(args);
      break;
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      console.error(`Unknown command: ${args.command}\n`);
      usage();
      process.exit(1);
  }
  process.exit(0);
} catch (error) {
  if (error instanceof AppError) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
