/**
 * Central configuration, read once at startup from the environment.
 *
 * Everything the app needs to know about its deployment lives here so that no
 * other module reads `process.env` directly.
 */

import { CARD_IMAGE_PX } from "./cards.ts";

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

/** A positive number, or the fallback: a misconfigured duration is worse than none. */
function duration(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A whole number within a range a layout can survive.
 *
 * Out-of-range is clamped rather than refused: how big a card or a sheet is drawn
 * is a matter of taste, and an odd number in the environment should give someone
 * an odd-looking page, not a server that will not start.
 */
function whole(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * A whole percentage that may legitimately be zero.
 *
 * `whole` reads zero as "unset" and hands back its fallback, which is right for
 * the things it measures — a card or a sheet with no size is a misconfiguration
 * rather than a choice. Turning an effect off *is* a choice, so it needs its own
 * helper rather than a loosening of that one. Nonsense still falls back, and
 * anything above the ceiling is clamped, as there.
 */
function scale(value: string | undefined, fallback: number, max: number): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * Settings that were set but not usable, so startup can say so.
 *
 * This module cannot log: `log.ts` reads `config` for its level, and importing it
 * back would be a cycle. So a rejected value is recorded here and
 * `server/index.ts` reports the lot once the logger exists. Silence is the thing
 * to avoid — a misspelled font that simply does nothing is a bad afternoon.
 */
export const configWarnings: string[] = [];

/**
 * The stylesheet a deployment wants the card names set in.
 *
 * Only `https://fonts.googleapis.com`, and that is not arbitrary strictness: the
 * page's CSP names that host (see `client/index.html`), so a URL anywhere else
 * would be blocked by the browser with nothing said. Refusing it here turns a
 * silent failure into a line in the log. A deployment that wants another provider
 * has to widen the CSP as well as this list.
 */
const FONT_STYLESHEET_HOSTS = ["fonts.googleapis.com"];

function fontUrl(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    configWarnings.push(`CARD_FONT_URL is not a URL and was ignored: ${value}`);
    return null;
  }
  if (parsed.protocol !== "https:" || !FONT_STYLESHEET_HOSTS.includes(parsed.host)) {
    configWarnings.push(
      `CARD_FONT_URL must be an https URL on ${FONT_STYLESHEET_HOSTS.join(", ")} ` +
        `— the page's CSP allows no other, so this was ignored: ${value}`,
    );
    return null;
  }
  return parsed.href;
}

/**
 * The family name to actually draw with, which the stylesheet above cannot say —
 * one of those URLs often carries several.
 *
 * The pattern is deliberately narrow. This value is interpolated into a
 * stylesheet every page loads, so a quote or a brace in it would end the
 * declaration and let the rest become CSS of the operator's choosing. Letters,
 * digits, spaces and hyphens name every family a font service offers and cannot
 * escape a `font-family` value.
 */
function fontFamily(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  const name = value.trim();
  if (!/^[A-Za-z0-9 -]{1,64}$/.test(name)) {
    configWarnings.push(
      `CARD_FONT_FAMILY may only contain letters, digits, spaces and hyphens, ` +
        `and was ignored: ${value}`,
    );
    return null;
  }
  return name;
}

const logLevels = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof logLevels)[number];

function logLevel(value: string | undefined): LogLevel {
  const candidate = (value ?? "info").toLowerCase();
  return (logLevels as readonly string[]).includes(candidate)
    ? (candidate as LogLevel)
    : "info";
}

const appOrigin = (process.env.APP_ORIGIN ?? "http://localhost:3000").replace(/\/+$/, "");

export const config = {
  port: Number(process.env.PORT ?? 3000),
  appOrigin,
  /** Hostname:port pairs accepted in the Origin header of mutating requests. */
  trustedProxy: bool(process.env.TRUSTED_PROXY),
  databasePath: process.env.DATABASE_PATH ?? "./data/app.db",
  uploadDir: process.env.UPLOAD_DIR ?? "./data/uploads",
  /**
   * The compiled HERO rules a character sheet is rendered against.
   *
   * A `.hdc` file records structure, not presentation — a skill is
   * `XMLID="ACTING" LEVELS="1"`, and what it costs and how it prints is computed
   * against the game system's own data. That data is Hero Games' copyrighted
   * material and so is not distributed with the renderer or with this app: an
   * operator extracts it from their own copy of HERO Designer with
   * `bunx ork-hero-extract-rules /path/to/HD6.jar`, which by default writes to
   * `./rules` — the same directory this falls back to.
   *
   * Without it no sheet can be rendered and no characteristic can be read off an
   * upload, so `server/index.ts` says so at startup rather than leaving it to be
   * discovered mid-session.
   */
  heroRulesDir: process.env.HERO_RULES_DIR ?? "./rules",
  logLevel: logLevel(process.env.LOG_LEVEL),
  /** Development escape hatch: serve cookies without the Secure flag over plain HTTP. */
  insecureCookies: bool(process.env.INSECURE_COOKIES),
  /**
   * How long a player may have no connection open before they are dropped from
   * the session. Long enough to cover a reload, a tunnel, or a phone waking up;
   * short enough that a closed browser doesn't sit in the list all evening.
   */
  playerGraceMs: duration(process.env.PLAYER_GRACE_MS, 30_000),
  /**
   * How much of the window a character sheet is opened over, as a percentage.
   *
   * It sets both dimensions, which is what keeps the sheet in the window's own
   * aspect ratio: at 90 it is nine tenths of the window's width and nine tenths
   * of its height, at 100 it fills the viewport outright. Reaches the browser the
   * same way the card size does (see routes/appearance.ts).
   */
  sheetWidthPct: whole(process.env.SHEET_WIDTH_PCT, 90, 10, 100),
  /**
   * How strongly a card's picture catches the light as it tilts, as a percentage
   * of the strength the effect was tuned at.
   *
   * 100 is that tuning and the default is a quarter of it, which is a glint
   * rather than a gloss — the full strength reads as varnish, and on a wall of
   * cards that is a lot of varnish. 0 turns the highlight off altogether, and
   * past about 165 the brightest part of it is already pure white and stops
   * climbing. It scales the glare band and the hotspot together, so what was
   * tuned — the balance between the two — is preserved whatever the number.
   * Reaches the browser as a custom property the same way the card size does
   * (see routes/appearance.ts).
   */
  cardSheenPct: scale(process.env.CARD_SHEEN_PCT, 25, 300),
  /**
   * The typeface a card's name is set in, as a stylesheet to load and the family
   * within it to use. A display face suits a card in a way the interface sans
   * does not, and which one is a matter of the table's taste.
   *
   * Both are needed for either to do anything: the stylesheet carries the font
   * but often names several families, and the family name alone has nothing to
   * load. Unset — or set to something unusable — the names keep the interface
   * font. Reaches the browser through routes/appearance.ts, as the rest of the
   * card's appearance does.
   */
  cardFontUrl: fontUrl(process.env.CARD_FONT_URL),
  cardFontFamily: fontFamily(process.env.CARD_FONT_FAMILY),
  isProduction: process.env.NODE_ENV === "production",
} as const;

/** Upload limits, enforced during multipart intake. */
export const limits = {
  /**
   * How large an upload may be, in bytes.
   *
   * One ceiling covers both a character sheet and a card image: a sheet with a
   * portrait embedded in it is much the same thing as the picture on its own, and
   * a deployment that wants to allow bigger files wants to allow bigger files.
   * It is the size of an upload rather than of a file: the one route that takes
   * two at once holds their total to it as well (`requireTotalWithinLimit`), so a
   * proxy in front can be sized to this number and not to a multiple of it.
   *
   * Clamped to something a request can plausibly carry — below 64 KB no real
   * sheet fits, and past 512 MB the proxy in front will refuse it first.
   */
  uploadBytes: whole(process.env.UPLOAD_LIMIT_BYTES, 10 * 1024 * 1024, 64 * 1024, 512 * 1024 * 1024),
  /**
   * The shorter side a stored image is scaled down to.
   *
   * Every picture the app shows is cropped into a square card, so the shorter
   * side is what has to cover it, and twice the card's own size covers a 2x
   * screen exactly — which is the whole of the reasoning, and used to make this
   * twice the deployment's card size.
   *
   * It is twice the *largest* card instead now that how big a card is drawn is
   * each game master's own setting (see `lib/cards.ts`). A picture is stored
   * once and looked at by readers who have chosen different sizes, so the only
   * size that keeps all of them sharp is the biggest any of them may ask for.
   * The cost is a bigger file for a table that never leaves the default — worth
   * it against a picture that cannot be made sharp again once it is stored soft.
   */
  storedImagePx: CARD_IMAGE_PX.max * 2,
  /** Sliding window before a GM has to log in again. */
  gmSessionTtlMs: 7 * 24 * 60 * 60 * 1000,
  /** Hard ceiling regardless of activity. */
  gmSessionMaxMs: 30 * 24 * 60 * 60 * 1000,
  passwordMinLength: 12,
  nameMaxLength: 60,
} as const;
