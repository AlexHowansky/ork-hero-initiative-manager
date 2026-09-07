/**
 * Authorised delivery of uploaded files.
 *
 * Uploads live outside any statically served directory, so the only way to reach
 * one is through these handlers — which means every request is authenticated and
 * authorised first.
 *
 * Character sheets are the sensitive case. They are no longer stored at all —
 * each one is rendered from the character file on request — but they are still
 * not this app's markup to trust: a character's own notes fields carry whatever
 * CSS and web fonts the game master put in HERO Designer, and the export
 * template is a document in its own right. So they are served exactly as the
 * uploaded HTML sheets were, with a `sandbox` Content-Security-Policy that puts
 * the document in an *opaque origin*. It is same-site by URL, but the browser
 * treats it as its own origin with no relationship to the app: it cannot read
 * `document.cookie`, touch `localStorage`, reach into the parent frame, or call
 * the API as the signed-in user. The embedding iframe repeats the sandbox as an
 * attribute, so the restriction holds even if the frame is reached some other
 * way.
 */

import type { BunRequest } from "bun";
import { handler } from "../http.ts";
import { errors } from "../../lib/errors.ts";
import { currentGm, currentPlayer } from "../middleware/auth.ts";
import { campaigns, characters, uploads } from "../../db/queries.ts";
import { uploadPath } from "../uploads.ts";
import { HDC_MIME, renderSheet } from "../hero-sheet.ts";
import { log } from "../../lib/log.ts";
import type { UploadRow } from "../../db/types.ts";

/** Streams an upload from disk, or 404s if the row points at a missing file. */
async function serveUpload(upload: UploadRow, headers: Record<string, string>): Promise<Response> {
  const file = Bun.file(uploadPath(upload));
  if (!(await file.exists())) {
    throw errors.notFound("That file is no longer available.");
  }
  return new Response(file, { headers });
}

export const fileRoutes = {
  /**
   * A character's sheet, rendered now.
   *
   * Readable by the game master who owns the campaign, or by the one player who
   * has claimed that character in an active session. Everyone else gets a 404
   * rather than a 403, so probing character ids reveals nothing about what exists.
   *
   * Nothing is stored or cached. What is on disk is the character file; the
   * sheet is what that character looks like through today's export template and
   * today's rules, built fresh every time anyone opens it. Re-export a character
   * and drop the file back, and the next person to look sees the new one, with
   * nothing to invalidate.
   */
  "/characters/:characterId": {
    GET: handler(async (request: BunRequest<"/characters/:characterId">) => {
      const { characterId } = request.params;
      const character = characters.byId(characterId);
      if (!character) throw errors.notFound("We couldn't find that character sheet.");

      let allowed = false;

      const gm = currentGm(request);
      if (gm) {
        const campaign = campaigns.byId(character.campaign_id);
        allowed = campaign?.gm_id === gm.id;
      } else {
        const identity = currentPlayer(request);
        // Players see only the sheet of the character they have claimed.
        allowed = identity?.player.claimed_character_id === characterId;
      }

      if (!allowed) throw errors.notFound("We couldn't find that character sheet.");

      const upload = uploads.byId(character.sheet_upload_id);
      if (!upload) throw errors.notFound("That character sheet is no longer available.");

      // Characters filed before this app read `.hdc` files have an HTML sheet
      // stored against them, and there is nothing to render one from. Said
      // plainly, because the fix is a file the game master already has.
      if (upload.mime !== HDC_MIME) {
        throw errors.notFound(
          "This character was filed from an HTML sheet, which this app no longer reads. " +
            "Upload their .hdc file to see their sheet.",
        );
      }

      const file = Bun.file(uploadPath(upload));
      if (!(await file.exists())) {
        throw errors.notFound("That character sheet is no longer available.");
      }

      let html: string;
      try {
        html = await renderSheet(new Uint8Array(await file.arrayBuffer()), upload);
      } catch (error) {
        // Not a 404, which everything above it is: those say "this is not yours
        // to see", and this says "this is yours and it would not build". A game
        // master told the wrong one of those goes looking for the wrong problem.
        log.error("could not render a character sheet", { characterId, error });
        throw errors.internal(
          "We couldn't build this character's sheet. Please re-export them from HERO Designer.",
        );
      }

      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // The isolation boundary. `sandbox` with only `allow-scripts` gives the
          // document an opaque origin: its JavaScript still runs, but it has no
          // access to this app's cookies, storage, DOM or authenticated API.
          // `frame-ancestors 'self'` keeps the sheet embeddable by this app and
          // nobody else's site.
          "Content-Security-Policy":
            "sandbox allow-scripts allow-forms allow-popups; frame-ancestors 'self'",
          // Overrides the app-wide DENY: a sheet exists to be framed by this app.
          // The sandbox above is what makes that safe.
          "X-Frame-Options": "SAMEORIGIN",
          "Content-Disposition": "inline",
          "Referrer-Policy": "no-referrer",
          // Doubly true now: there is no stored artifact to go stale.
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }),
  },

  /**
   * A card image for a campaign or character.
   *
   * Readable by the game master whose library it belongs to, or by a player of a
   * session that actually puts it on screen — the campaign they are sitting at,
   * or a character standing on their stage.
   *
   * Being signed in is deliberately not enough. These ids are random, so nobody
   * guesses one, but an id that gets out — a shared screenshot, a browser
   * history, a proxy log — used to be readable by every account on the instance,
   * including a game master with no relationship to the table it came from. The
   * check below is the same shape as the sheet's above: what the viewer is
   * entitled to, not merely who they are.
   *
   * A 404 rather than a 403, as everywhere else here, so that probing ids says
   * nothing about which of them exist.
   */
  "/uploads/images/:uploadId": {
    GET: handler(async (request: BunRequest<"/uploads/images/:uploadId">) => {
      // The game master first, as `currentIdentity` does: a signed-in game master
      // looking at their own library is the common case, and the one identity
      // that can see a picture outside any session.
      const gm = currentGm(request);
      const player = gm ? null : currentPlayer(request);
      if (!gm && !player) throw errors.unauthorized();

      const upload = uploads.byId(request.params.uploadId);
      if (!upload || upload.kind !== "image") {
        throw errors.notFound("We couldn't find that image.");
      }

      const allowed = gm
        ? uploads.isVisibleToGm(upload.id, gm.id)
        : uploads.isVisibleInSession(upload.id, player!.session.id);
      if (!allowed) throw errors.notFound("We couldn't find that image.");

      return await serveUpload(upload, {
        // The type comes from the magic bytes checked at upload time, never from
        // what the client claimed — paired with nosniff below.
        "Content-Type": upload.mime,
        "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'self'",
        "X-Frame-Options": "SAMEORIGIN",
        "Content-Disposition": "inline",
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      });
    }),
  },
};
