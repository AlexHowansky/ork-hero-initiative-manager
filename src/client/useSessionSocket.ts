/**
 * Subscribes to a session's live updates.
 *
 * The server publishes a complete snapshot on every change, so this hook simply
 * replaces its state each time one arrives — there is no merging to get wrong.
 *
 * The connection itself, including reconnecting after a drop, is `useLiveSocket`.
 *
 * The state a screen opens with is fetched from the API rather than waited for
 * on the socket, so a screen is never left drawing an empty session because an
 * upgrade was refused somewhere it could not be seen. See the effect below.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import { useLiveSocket } from "./useLiveSocket.ts";
import type { ToastTone } from "./components/Toast.tsx";
import type { Snapshot } from "./types.ts";

export type { ConnectionState } from "./useLiveSocket.ts";

/** The tones a notice may ask for. Anything else on the wire is not one. */
const TONES: readonly string[] = ["error", "success", "info"];

/**
 * `onNotice` is called with something the server wants said out loud on this
 * screen — the Post-Segment 12 Recovery, which the whole table hears, and a
 * character being stunned, which only their player and the game master do. Who
 * is told is the server's decision and has already been made by the time it
 * arrives here. It is an event rather than part of the state, so it is handed
 * straight to the caller to toast rather than being kept: nothing on the page is
 * drawn from it.
 *
 * The tone comes with it where the news is not good news. It is optional on the
 * wire, and a notice without one is left to the toast's own default.
 */
export function useSessionSocket(
  sessionId: string | null,
  onNotice?: (message: string, tone?: ToastTone) => void,
) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  /*
   * The first snapshot, fetched rather than waited for.
   *
   * The socket sends one the moment it opens, so this is a second route to the
   * same thing — and it is here because the socket is the half of the pair that
   * can fail quietly. An upgrade a proxy declines never becomes an error the
   * page can show; it becomes a screen that draws a session with nobody in it,
   * which is a lie a game master has no reason to doubt: the stage says "no
   * characters in the session yet" and a hero's Add button, which goes quiet
   * only for someone already on stage, is live. The next mutation returns a
   * snapshot over this same API and the whole party appears at once, as though
   * one click had added all of them.
   *
   * So the state a screen opens with comes from the API, which fails loudly, and
   * the socket is left to do what only it can — say what has changed since.
   *
   * `current ?? fetched` because the two are racing and the socket's is the
   * newer of them: a snapshot already applied is never replaced by this one,
   * whether it arrived over the socket or from a mutation the caller made while
   * this was in flight.
   */
  useEffect(() => {
    if (!sessionId) return;
    let dropped = false;
    void (async () => {
      try {
        const { snapshot: initial } = await api.get<{ snapshot: Snapshot }>(
          `/api/sessions/${encodeURIComponent(sessionId)}`,
        );
        if (!dropped) setSnapshot((current) => current ?? initial);
      } catch {
        // Nothing is said here. A session that cannot be read is a session
        // whose screen has already failed elsewhere — the page's own load, or
        // the socket, which reports what it is doing — and a second complaint
        // about the same outage helps nobody.
      }
    })();
    return () => {
      dropped = true;
    };
  }, [sessionId]);

  const { connection, finish } = useLiveSocket(
    sessionId ? `sessionId=${encodeURIComponent(sessionId)}` : null,
    (message) => {
      switch (message.type) {
        case "snapshot": {
          const { session, players, characters, events } =
            message as unknown as Partial<Snapshot>;
          if (session && players && characters && events) {
            setSnapshot({ session, players, characters, events });
          }
          break;
        }
        case "notice": {
          // The tone is whatever the server sent, and nothing if it sent none:
          // an unrecognised one is dropped rather than passed on, since a toast
          // asked for a tone it does not have draws as no toast at all.
          const tone = TONES.includes(message.tone as ToastTone)
            ? (message.tone as ToastTone)
            : undefined;
          if (typeof message.message === "string") onNotice?.(message.message, tone);
          break;
        }
        case "session:ended":
          finish("ended");
          break;
        case "player:kicked":
          finish("kicked");
          break;
      }
    },
  );

  /**
   * Lets a caller apply the result of its own mutation immediately, rather than
   * waiting for the broadcast to make the round trip.
   */
  const applySnapshot = useCallback((next: Snapshot) => setSnapshot(next), []);

  return { snapshot, connection, applySnapshot };
}
