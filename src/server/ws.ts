/**
 * Live updates.
 *
 * One WebSocket per open screen, subscribed to one topic. There are two kinds:
 *
 * - A session socket, subscribed to a topic named after the session. Any change
 *   republishes the whole session snapshot to that topic, so a game master adding
 *   an NPC, dragging the initiative order, or moving the turn marker lands on
 *   every player's screen without a refresh.
 * - A library socket, subscribed to a topic named after the game master, carrying
 *   the list of their sessions. Starting or ending a session republishes that list,
 *   so a library open in another tab follows along instead of showing a session
 *   that finished ten minutes ago.
 *
 * Authentication happens at upgrade time, from the same cookies the REST API
 * uses. An unauthenticated upgrade is refused outright — there is no anonymous
 * read of a session.
 */

import type { BunRequest, Server, ServerWebSocket } from "bun";
import { config } from "../lib/config.ts";
import { AppError } from "../lib/errors.ts";
import { log } from "../lib/log.ts";
import { currentGm, currentPlayer } from "./middleware/auth.ts";
import { checkOrigin } from "./middleware/csrf.ts";
import { playerDisconnected } from "./events.ts";
import { buildGmSessionList, buildSnapshot } from "./session-state.ts";
import { gameSessions, players, sessionEvents } from "../db/queries.ts";

/** What a socket is allowed to see, decided once at upgrade and never re-read. */
interface SocketData {
  /** The one topic this socket subscribes to, fixed for its lifetime. */
  topic: string;
  /** Null on a library socket, which follows a game master rather than a session. */
  sessionId: string | null;
  role: "gm" | "player" | "library";
  /** Set for players, so a kick can find and close their sockets. */
  playerId: string | null;
  gmId: string | null;
}

type AppSocket = ServerWebSocket<SocketData>;

/** Live sockets, so a specific player can be disconnected on a kick. */
const sockets = new Set<AppSocket>();

/** Set once the server is constructed; publishing needs the server handle. */
let serverRef: Server<SocketData> | null = null;

export function registerServer(server: Server<SocketData>): void {
  serverRef = server;
}

function topicFor(sessionId: string): string {
  return `session:${sessionId}`;
}

function libraryTopicFor(gmId: string): string {
  return `library:${gmId}`;
}

/* ------------------------------------------------------------------ publish */

/** Publishes the current snapshot of a session to everyone watching it. */
export function broadcastSession(sessionId: string): void {
  if (!serverRef) return;
  const snapshot = buildSnapshot(sessionId);
  if (!snapshot) return;
  serverRef.publish(topicFor(sessionId), JSON.stringify({ type: "snapshot", ...snapshot }));
}

/**
 * Publishes a game master's session list to every library screen they have open.
 *
 * Called wherever the list itself changes — a session started or ended, a campaign
 * renamed or deleted — rather than on the changes inside a session, which each row
 * already follows through its own socket.
 */
export function broadcastGmSessions(gmId: string): void {
  serverRef?.publish(
    libraryTopicFor(gmId),
    JSON.stringify({ type: "sessions", sessions: buildGmSessionList(gmId) }),
  );
}

/**
 * Says something to every screen watching a session — the game master's and the
 * players' alike.
 *
 * Kept apart from the snapshot because it is an event rather than a state: it
 * happened once, at a moment, and a client that reconnects afterwards should not
 * be told about it again. A snapshot arriving late is still true; a notice
 * arriving late is a toast about something the table has moved on from.
 */
export function broadcastSessionNotice(sessionId: string, message: string): void {
  serverRef?.publish(topicFor(sessionId), JSON.stringify({ type: "notice", message }));
}

/** How a notice is drawn where it lands. A missing one is the toast's own default. */
export type NoticeTone = "error" | "success" | "info";

/**
 * Says something to the game master and to one player, and to nobody else.
 *
 * The counterpart to the broadcast above, for the notices that are somebody's
 * news rather than the table's: a character being stunned is the business of
 * whoever is running the fight and whoever is playing that character, and a
 * toast about it on the other five screens is noise about a monster they cannot
 * see the numbers of anyway.
 *
 * Sent down the sockets themselves rather than published to the topic, because a
 * topic is exactly the thing that cannot be narrowed — the same reason
 * `disconnectPlayer` walks this set. `playerId` is null where nobody holds the
 * character, which leaves the game master told and is right: an unclaimed
 * monster has no player to tell.
 */
export function sendSessionNotice(
  sessionId: string,
  message: string,
  to: { playerId: string | null },
  tone?: NoticeTone,
): void {
  const frame = JSON.stringify({ type: "notice", message, tone });
  for (const socket of sockets) {
    if (socket.data.sessionId !== sessionId) continue;
    const wanted = socket.data.role === "gm"
      || (to.playerId !== null && socket.data.playerId === to.playerId);
    if (wanted) socket.send(frame);
  }
}

/**
 * Tells everyone the session is over, then closes their sockets. The message goes
 * first so a player screen can explain what happened instead of just going quiet.
 */
export function closeSessionSockets(sessionId: string): void {
  serverRef?.publish(
    topicFor(sessionId),
    JSON.stringify({ type: "session:ended" }),
  );
  for (const socket of sockets) {
    if (socket.data.sessionId === sessionId) socket.close(1000, "Session ended");
  }
}

/** Drops a kicked player's connections. Other people in the session stay put. */
export function disconnectPlayer(playerId: string): void {
  for (const socket of sockets) {
    if (socket.data.playerId !== playerId) continue;
    socket.send(JSON.stringify({ type: "player:kicked" }));
    socket.close(4001, "Removed from session");
  }
}

/* ----------------------------------------------------------------- presence */

/**
 * A player is in the session for as long as they are connected to it.
 *
 * Closing the tab, or the browser, is how someone leaves a table in practice —
 * few people find the button first — and a player who is gone still holds their
 * character, so the seat has to be freed for them to come back to. But a socket
 * closing is not the same as a player leaving: a reload, a dropped tunnel, or a
 * phone locking itself all close it too, and the client comes straight back. So a
 * closed socket only starts a clock, and any new socket for that player stops it.
 * Only if they are still absent when it runs out are they actually removed.
 *
 * The consequence of getting it wrong is not symmetrical, which is why the grace
 * period is generous: dropping someone who was reloading takes their character
 * away mid-scene, whereas holding a seat too long is a stale row in a list.
 */
const pendingRemoval = new Map<string, ReturnType<typeof setTimeout>>();

function stillConnected(playerId: string): boolean {
  for (const socket of sockets) {
    if (socket.data.playerId === playerId) return true;
  }
  return false;
}

/** Called when a player's socket opens: they are back, so call off the clock. */
function cancelRemoval(playerId: string): void {
  const timer = pendingRemoval.get(playerId);
  if (!timer) return;
  clearTimeout(timer);
  pendingRemoval.delete(playerId);
}

function schedulePlayerRemoval(playerId: string, sessionId: string): void {
  cancelRemoval(playerId);

  const timer = setTimeout(() => {
    pendingRemoval.delete(playerId);
    // They reconnected on another socket, or were already removed — by their own
    // hand, by a kick, or with the session they were in.
    if (stillConnected(playerId)) return;
    // Kept rather than discarded: the log line is about a person, and this is the
    // last moment their name is still in the database.
    const player = players.byId(playerId);
    if (!player) return;

    // An ended session keeps its roster: nobody is coming back to it, and the
    // game master may still be looking at who was there.
    const session = gameSessions.byId(sessionId);
    if (!session || session.status !== "active") return;

    players.remove(playerId);
    sessionEvents.record(sessionId, playerDisconnected(player.name));
    log.info("player dropped after disconnect", { sessionId, playerId });
    broadcastSession(sessionId);
  }, config.playerGraceMs);

  // Nothing should be kept alive by a clock that is waiting on an absence.
  timer.unref?.();
  pendingRemoval.set(playerId, timer);
}

/* ------------------------------------------------------------------ upgrade */

/**
 * Who may watch a session: its game master, or a player who is in it. Returns a
 * `Response` where the reason is worth stating, `null` where it is not — a socket
 * is never told whether the session it was refused exists.
 */
function sessionUpgrade(request: BunRequest, sessionId: string | null): SocketData | Response | null {
  if (!sessionId) return new Response("Missing session", { status: 400 });

  const session = gameSessions.byId(sessionId);
  if (!session || session.status !== "active") {
    return new Response("Session not available", { status: 404 });
  }

  const gm = currentGm(request);
  if (gm && session.gm_id === gm.id) {
    return { topic: topicFor(sessionId), sessionId, role: "gm", playerId: null, gmId: gm.id };
  }

  const player = currentPlayer(request);
  if (player && player.session.id === sessionId) {
    return {
      topic: topicFor(sessionId),
      sessionId,
      role: "player",
      playerId: player.player.id,
      gmId: null,
    };
  }

  return null;
}

/** The library socket follows the signed-in game master, and nobody else. */
function libraryUpgrade(request: BunRequest): SocketData | null {
  const gm = currentGm(request);
  if (!gm) return null;
  return {
    topic: libraryTopicFor(gm.id),
    sessionId: null,
    role: "library",
    playerId: null,
    gmId: gm.id,
  };
}

/**
 * The upgrade endpoint. Declared as a route (rather than in a bare `fetch`) so
 * that `request.cookies` is available and identity resolution is identical to
 * every other endpoint.
 */
export const wsRoute = (request: BunRequest, server: Server<SocketData>): Response | undefined => {
  // The same Origin check every mutating API request goes through, for a reason
  // that is sharper here than there: a handshake is exempt from CORS, so nothing
  // in the browser refuses one another site opened. `SameSite=Lax` keeps the
  // cookies off such a request and is what actually stops it today; this is the
  // second lock, and the one that does not depend on the cookie policy of
  // whichever browser is asking.
  //
  // Caught rather than left to propagate because this route is registered raw
  // instead of behind `handler()` — the thing that made the check necessary — so
  // there is no error boundary above it, and an escaping throw would land in
  // Bun's own handler as a 500 rather than the 403 this is.
  try {
    checkOrigin(request);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    // `expected` is here because this refusal has one likely cause and the
    // line is where it gets diagnosed. A handshake carries no Sec-Fetch-Site,
    // so it is the one request checked against APP_ORIGIN itself — which means
    // a deployment whose APP_ORIGIN does not name the address browsers actually
    // use works in every respect except live updates, and says nothing about
    // why. Printed side by side, the mismatch is the whole answer.
    log.warn("socket refused: unexpected origin", {
      origin: request.headers.get("origin"),
      expected: config.appOrigin,
      fetchSite: request.headers.get("sec-fetch-site"),
    });
    return new Response(error.message, { status: error.status });
  }

  const params = new URL(request.url).searchParams;
  const data = params.get("scope") === "library"
    ? libraryUpgrade(request)
    : sessionUpgrade(request, params.get("sessionId"));

  if (data instanceof Response) return data;
  if (!data) return new Response("Unauthorized", { status: 401 });

  // Bun replies 101 itself when the upgrade succeeds.
  if (server.upgrade(request, { data })) return undefined;
  return new Response("Expected a WebSocket upgrade", { status: 426 });
};

/* ----------------------------------------------------------------- handlers */

export const websocket = {
  open(socket: AppSocket) {
    sockets.add(socket);
    socket.subscribe(socket.data.topic);

    // Whatever closed their last socket, they are plainly still here.
    if (socket.data.playerId) cancelRemoval(socket.data.playerId);

    // Send the current state immediately, so a reconnecting client is correct
    // before the next mutation happens to come along.
    if (socket.data.role === "library") {
      socket.send(
        JSON.stringify({ type: "sessions", sessions: buildGmSessionList(socket.data.gmId!) }),
      );
    } else {
      const snapshot = buildSnapshot(socket.data.sessionId!);
      if (snapshot) socket.send(JSON.stringify({ type: "snapshot", ...snapshot }));
    }

    log.debug("socket opened", {
      topic: socket.data.topic,
      role: socket.data.role,
      sockets: sockets.size,
    });
  },

  message(socket: AppSocket, message: string | Buffer) {
    // Clients are read-only over the socket: every change goes through the API,
    // where it is authorised and validated. The only thing accepted here is a
    // liveness ping.
    if (typeof message === "string" && message === "ping") {
      socket.send(JSON.stringify({ type: "pong" }));
    }
  },

  close(socket: AppSocket) {
    sockets.delete(socket);
    socket.unsubscribe(socket.data.topic);

    // Deleted from `sockets` first, so the check for another connection of the
    // same player cannot see the one that has just gone.
    if (socket.data.playerId && socket.data.sessionId && !stillConnected(socket.data.playerId)) {
      schedulePlayerRemoval(socket.data.playerId, socket.data.sessionId);
    }

    log.debug("socket closed", { topic: socket.data.topic, sockets: sockets.size });
  },

  /** Bun sends its own pings on this interval; idle sockets stay alive. */
  idleTimeout: 120,
  maxPayloadLength: 16 * 1024,
};
