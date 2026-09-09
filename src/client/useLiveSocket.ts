/**
 * One reconnecting WebSocket, shared by everything on the client that watches
 * something live.
 *
 * The server has two kinds of socket — a session and a game master's library —
 * and they differ only in what they carry: both authenticate from the same
 * cookies, both are sent the current state the moment they open, and both need to
 * come back after a drop. That machinery lives here, and the hooks above it are
 * left to interpret messages.
 *
 * A dropped connection reconnects with backoff, and because the server sends the
 * current state on open, reconnecting is also how the client catches up on
 * anything it missed while away.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { clearSocketTrouble, reportSocketTrouble } from "./liveStatus.ts";

export type ConnectionState = "connecting" | "open" | "reconnecting" | "ended" | "kicked";

/** Every message is a tagged object; the caller knows what its own tags mean. */
export type LiveMessage = { type?: string } & Record<string, unknown>;

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
const PING_INTERVAL_MS = 30_000;

/**
 * `query` is the query string identifying what to watch (`sessionId=…`,
 * `scope=library`), or null to stay disconnected. Changing it reconnects.
 */
export function useLiveSocket(query: string | null, onMessage: (message: LiveMessage) => void) {
  const [connection, setConnection] = useState<ConnectionState>("connecting");

  const socketRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Set when there is definitively nothing more to watch, so we stop trying to
  // return.
  const stoppedRef = useRef(false);

  // Held in a ref so a caller can pass an inline handler without the socket
  // tearing down and reconnecting on every render.
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  /*
   * What this socket tells `liveStatus.ts`, which is what the warning in the
   * header is drawn from.
   *
   * All refs rather than state: none of it is rendered *here*, and a socket
   * retrying every half second must not re-render the page it is retrying for.
   * The store is the channel, and the only thing this hook returns is the
   * `connection` it always returned.
   *
   * `useId` names this socket. It is stable across a re-mount — which StrictMode
   * does to every effect in development — and distinct per call site, so a page
   * holding a dozen sockets holds a dozen entries and not one they overwrite.
   */
  const id = useId();
  const everOpenedRef = useRef(false);
  /** When this socket stopped being open. Zero while it is. */
  const troubleSinceRef = useRef(0);
  const attemptsRef = useRef(0);
  const lastCloseRef = useRef<{ code: number; reason: string } | null>(null);

  const publishTrouble = useCallback(() => {
    reportSocketTrouble(id, {
      kind: everOpenedRef.current ? "dropped" : "unreachable",
      since: troubleSinceRef.current,
      attempts: attemptsRef.current,
      code: lastCloseRef.current?.code ?? null,
      reason: lastCloseRef.current?.reason || null,
    });
  }, [id]);

  const cleanup = useCallback(() => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    if (pingTimerRef.current) clearInterval(pingTimerRef.current);
    retryTimerRef.current = null;
    pingTimerRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
  }, []);

  /** Settles on a final state: no more reconnecting, and the socket goes. */
  const finish = useCallback(
    (state: "ended" | "kicked") => {
      stoppedRef.current = true;
      setConnection(state);
      cleanup();
      // Not a fault: the session ended, or this player was removed. Both are
      // things the screen says for itself, and neither is an outage to warn
      // about — the socket is gone because there is nothing left to watch.
      clearSocketTrouble(id);
    },
    [cleanup, id],
  );

  useEffect(() => {
    // Nothing to watch is not the same as failing to watch it: a screen that has
    // deliberately asked for no socket has nothing to report.
    if (!query) {
      clearSocketTrouble(id);
      return;
    }

    stoppedRef.current = false;
    let disposed = false;

    // A fresh subject to watch is a fresh socket, so nothing carries over from
    // whatever this hook was connected to before.
    everOpenedRef.current = false;
    lastCloseRef.current = null;
    attemptsRef.current = 0;
    troubleSinceRef.current = 0;

    const connect = () => {
      if (disposed || stoppedRef.current) return;

      // Reported before the attempt rather than after it fails, because the
      // failure that matters most never fails out loud: a handshake a proxy
      // swallows produces no error and no close, and a socket that waits to be
      // told it is broken would sit silently in `connecting` for ever. So being
      // open is the only thing that counts as well, and the delay in
      // `liveStatus.ts` is what keeps a healthy connect from ever being drawn.
      if (troubleSinceRef.current === 0) troubleSinceRef.current = Date.now();
      attemptsRef.current += 1;
      publishTrouble();

      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/ws?${query}`);
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) return;
        backoffRef.current = INITIAL_BACKOFF_MS;
        setConnection("open");

        everOpenedRef.current = true;
        troubleSinceRef.current = 0;
        attemptsRef.current = 0;
        lastCloseRef.current = null;
        clearSocketTrouble(id);

        pingTimerRef.current = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send("ping");
        }, PING_INTERVAL_MS);
      };

      socket.onmessage = (event) => {
        if (disposed) return;
        let message: LiveMessage;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        handlerRef.current(message);
      };

      socket.onclose = (event) => {
        if (disposed || stoppedRef.current) return;
        if (pingTimerRef.current) clearInterval(pingTimerRef.current);
        setConnection("reconnecting");

        // The only detail a browser gives about a failed socket, and worth
        // keeping: 1006 is a network drop or a server that is not answering,
        // 1008 is a refusal, and knowing which turns "it doesn't work" into
        // something to go and look at. `since` deliberately stays where it was —
        // the outage began when the connection was lost, not when this attempt
        // gave up, and a clock restarted by each retry would never run out.
        lastCloseRef.current = { code: event.code, reason: event.reason };
        publishTrouble();

        // Exponential backoff with jitter, so a server restart doesn't bring
        // every client back in the same instant.
        const delay = Math.min(backoffRef.current, MAX_BACKOFF_MS);
        backoffRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
        retryTimerRef.current = setTimeout(connect, delay + Math.random() * 250);
      };
    };

    connect();

    return () => {
      disposed = true;
      cleanup();
      // A socket whose screen has gone cannot be in trouble. This is what keeps
      // a warning from outliving the session row that raised it, on a library
      // page where rows come and go as sessions start and end.
      clearSocketTrouble(id);
    };
  }, [query, cleanup, id, publishTrouble]);

  return { connection, finish };
}
