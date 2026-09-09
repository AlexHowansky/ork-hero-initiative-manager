/**
 * Whether the live connections this page depends on are actually working.
 *
 * Every screen here is drawn from a socket (`useLiveSocket.ts`), and a socket
 * that fails is the one failure this app cannot show by simply not drawing
 * something: the page keeps displaying whatever it last knew, which looks
 * exactly like a session where nothing is happening. That is not a hypothetical
 * — a deployment whose `APP_ORIGIN` did not name the address browsers use had
 * every upgrade refused, and the console sat there drawing an empty stage.
 *
 * A module-level store rather than a context, for the same reason `gmSettings.ts`
 * is one: the sockets and the header that reports on them are nowhere near each
 * other in the tree. The library page makes the point — it holds one socket for
 * the session list and one more for every session in progress, each retrying on
 * its own clock, and threading all of that up through a list to a header would be
 * a lot of plumbing for one icon. A store also keeps the re-rendering where it
 * belongs: a retry redraws the indicator, not the page.
 *
 * **Trouble is "not open", not "closed".** A socket reports the moment it starts
 * connecting and clears when it opens, so a handshake that hangs for ever —
 * a proxy swallowing the upgrade, which is the commonest way this breaks — is
 * reported like any other failure. Waiting for a close event would say nothing
 * at all about it, since there is never a close. The delay below is what makes
 * that free: a healthy socket opens in milliseconds and is never drawn.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * How long a socket must be down before the reader is told.
 *
 * A page load, a `bun --hot` restart and a one-second blip all resolve well
 * inside this, and none of them are worth a red icon. A real outage is still
 * reported within a couple of seconds, which is faster than anyone can wonder
 * why the turn marker has stopped moving.
 */
export const TROUBLE_DELAY_MS = 2000;

export interface SocketTrouble {
  /**
   * Whether this socket has ever been open.
   *
   * The difference matters to the reader more than any close code does:
   * `unreachable` is "this screen never had live updates", which is usually a
   * deployment that is wrong for everybody, while `dropped` is "it had them and
   * lost them", which is usually this one network.
   */
  readonly kind: "unreachable" | "dropped";
  /**
   * When this socket stopped being open, which is not when it last tried.
   *
   * Kept across retries on purpose. Backoff starts at half a second, so a
   * refused socket tries several times inside the delay above — and a clock
   * restarted by each attempt would never run out, leaving the outage the
   * reader can see reported by nothing at all.
   */
  readonly since: number;
  /** Connection attempts since then, so a message can say it is still trying. */
  readonly attempts: number;
  /** The last close code, or null while the connection is merely hanging. */
  readonly code: number | null;
  /** What the server said with it, which is nearly always nothing. */
  readonly reason: string | null;
}

export interface TroubleSummary {
  /**
   * The longest-standing trouble, which is the one worth describing: when a
   * server goes away every socket on the page fails within a few milliseconds of
   * the others, and the first of them is the one whose clock decides when the
   * reader hears about it.
   */
  readonly worst: SocketTrouble;
  /** How many sockets on this page are down, for a page that holds several. */
  readonly count: number;
}

const troubles = new Map<string, SocketTrouble>();
const listeners = new Set<() => void>();

/**
 * The summary as it stands, rebuilt only when something changes.
 *
 * `useSyncExternalStore` compares what `getSnapshot` returns against what it
 * returned last time, so building a fresh object per call is an infinite render
 * rather than a wasted allocation.
 */
let snapshot: TroubleSummary | null = null;

function summarise(): TroubleSummary | null {
  let worst: SocketTrouble | null = null;
  for (const trouble of troubles.values()) {
    if (!worst || trouble.since < worst.since) worst = trouble;
  }
  return worst ? { worst, count: troubles.size } : null;
}

function notify(): void {
  snapshot = summarise();
  for (const listener of listeners) listener();
}

/**
 * A socket saying it is not open.
 *
 * Keyed rather than counted, so a socket may say it as often as it likes — every
 * attempt, every close — and the store holds one entry for it either way. The key
 * is the caller's to choose and to reuse; `useLiveSocket` uses React's `useId`,
 * which is stable across a re-mount.
 */
export function reportSocketTrouble(id: string, trouble: SocketTrouble): void {
  troubles.set(id, trouble);
  notify();
}

/**
 * A socket saying it is fine, or going away.
 *
 * Both are the same message here: an open socket, one that has been deliberately
 * finished (a session that ended, a player who was removed — neither of which is
 * a fault), one whose page has unmounted, and one that was never asked to connect
 * at all all mean there is nothing to warn about.
 */
export function clearSocketTrouble(id: string): void {
  if (troubles.delete(id)) notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * What is wrong right now, as one value.
 *
 * The store's whole output, and what `useSyncExternalStore` is handed below —
 * so a test of the aggregation reads exactly what a screen would, without
 * needing React to be running.
 */
export function currentTrouble(): TroubleSummary | null {
  return snapshot;
}

/** The same, for a component. Undelayed; `useLiveTrouble` is what screens want. */
export function useSocketTroubleNow(): TroubleSummary | null {
  return useSyncExternalStore(subscribe, currentTrouble, () => null);
}

/**
 * What is wrong, once it has been wrong long enough to be worth saying.
 *
 * The deadline is `since + delay` rather than "delay from now", which is the
 * whole of what makes this correct: the store publishes again on every attempt
 * and every close, so this effect re-runs constantly while a socket is down, and
 * a timer restarted each time would never fire.
 *
 * Recovery is not delayed. There is no reason to keep telling somebody about an
 * outage that has ended.
 */
export function useLiveTrouble(delayMs: number = TROUBLE_DELAY_MS): TroubleSummary | null {
  const now = useSocketTroubleNow();
  const [shown, setShown] = useState<TroubleSummary | null>(null);

  useEffect(() => {
    if (!now) {
      setShown(null);
      return;
    }
    const remaining = now.worst.since + delayMs - Date.now();
    if (remaining <= 0) {
      // Already past the threshold, so this is either the moment it crosses or
      // an update to something already on screen — the close code arriving, or a
      // second socket joining the first.
      setShown(now);
      return;
    }
    const timer = setTimeout(() => setShown(now), remaining);
    return () => clearTimeout(timer);
  }, [now, delayMs]);

  return shown;
}

/**
 * What a close code means, in words rather than as a number.
 *
 * Only the ones a table might actually meet. The number is printed alongside
 * whatever this says, so an unlisted code is still something to search for.
 */
const CLOSE_CODES: Record<number, string> = {
  1000: "a normal close",
  1001: "the server going away, usually a restart",
  1005: "no code given",
  1006: "an abnormal close, usually a network drop or a server that is not answering",
  1008: "the server refusing the connection",
  1011: "an error on the server",
  1012: "the server restarting",
  1013: "the server being overloaded",
  1015: "a failed TLS handshake",
};

function meaningOf(code: number): string {
  if (CLOSE_CODES[code]) return CLOSE_CODES[code]!;
  return code >= 4000 && code <= 4999 ? "a close code of the application's own" : "an unfamiliar close code";
}

/**
 * The outage in two sentences: what it means for the reader, then why.
 *
 * Split in two because the two halves are for different people. The first is for
 * whoever is at the table and needs to know that what they are looking at may be
 * behind — it says nothing about sockets. The second is for whoever is going to
 * do something about it, and carries the only facts the browser gives us: a close
 * code where there was one, and how many times it has tried.
 *
 * A pure function, and exported, because the wording is the part of this feature
 * most worth pinning down and the only part testable without a browser.
 */
export function describeTrouble(summary: TroubleSummary): { headline: string; detail: string } {
  const { worst, count } = summary;

  const headline = count > 1
    ? `Live updates are not reaching this screen. ${count} connections to the server are down, `
      + "so parts of this page may be out of date. It is still trying."
    : worst.kind === "unreachable"
    ? "Live updates are not reaching this screen. It could not connect to the server, "
      + "so what you are looking at may be out of date. It is still trying."
    : "Live updates have stopped reaching this screen. The connection to the server was lost, "
      + "so what you are looking at may be out of date. It is trying to reconnect.";

  const attempts = `Attempt ${worst.attempts}.`;

  if (worst.code === null) {
    // Nothing closed, so there is no code to give: the connection was opened and
    // the server has not answered either way. A proxy that is not passing the
    // upgrade through looks exactly like this.
    return {
      headline,
      detail: worst.kind === "unreachable"
        ? `Reason: the connection was opened and the server never answered — an upgrade `
          + `blocked in front of the app looks like this. ${attempts}`
        : `Reason: the connection went quiet and has not answered. ${attempts}`,
    };
  }

  const said = worst.reason ? ` (“${worst.reason}”)` : "";
  return {
    headline,
    detail: `Reason: the connection closed with code ${worst.code}${said} — `
      + `${meaningOf(worst.code)}. ${attempts}`,
  };
}
