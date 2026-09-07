/**
 * The server's shape: every route, and the WebSocket handlers.
 *
 * Kept apart from index.ts so that the entry point owns starting a listener and
 * the tests can start their own on an ephemeral port.
 */

import { authRoutes } from "./routes/auth.ts";
import { campaignRoutes } from "./routes/campaigns.ts";
import { characterRoutes } from "./routes/characters.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { fileRoutes } from "./routes/files.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { templateRoutes } from "./routes/templates.ts";
import { appearanceRoutes } from "./routes/appearance.ts";
import { frameRoutes } from "./routes/frames.ts";
import { websocket, wsRoute } from "./ws.ts";
import { clientRoutes } from "./client.ts";
import { log } from "../lib/log.ts";

export const routes = {
  // The client and its assets. Awaited here because in production the document
  // is built before the first request rather than bundled on the way out — see
  // `client.ts` for why it is served by the app rather than by the bundler.
  ...(await clientRoutes()),
  ...authRoutes,
  ...campaignRoutes,
  ...characterRoutes,
  ...sessionRoutes,
  ...fileRoutes,
  ...settingsRoutes,
  ...templateRoutes,
  ...appearanceRoutes,
  ...frameRoutes,
  "/ws": wsRoute,
};

export const serverOptions = {
  routes,
  websocket,

  /** Anything that matched no route at all. */
  fetch() {
    return new Response("Not found", { status: 404 });
  },

  error(error: Error) {
    log.error("server error", { error });
    return new Response("Something went wrong on our end. Please try again.", { status: 500 });
  },
};
