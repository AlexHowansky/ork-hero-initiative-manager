/**
 * A game master's own settings.
 *
 * What is here is about the person rather than about the table: how big they
 * want cards drawn, and whatever else joins it later. It hangs off the `gms` row
 * so that it follows them to whichever machine they sign in on — the theme,
 * which is about the room they are sitting in rather than about them, stays in
 * the browser instead (`client/theme.ts`).
 *
 * There is no GET. The one caller is the console at boot, and it already asks
 * who it is talking to — `/api/auth/me` carries the settings back with the
 * identity, which saves a second round trip before the first card is drawn.
 */

import type { BunRequest } from "bun";
import { handler, json, type RequestContext } from "../http.ts";
import { parseJsonBody, schemas } from "../../lib/validate.ts";
import { requireGm } from "../middleware/auth.ts";
import { gms, sessionCharacters, templates } from "../../db/queries.ts";
import { errors } from "../../lib/errors.ts";
import { presentGm } from "../presenters.ts";
import { BUILT_IN_TEMPLATE_ID } from "../../lib/templates.ts";

export const settingsRoutes = {
  "/api/settings": {
    PATCH: handler(async (request: BunRequest, { logger }: RequestContext) => {
      const gm = requireGm(request);
      const changes = await parseJsonBody(request, schemas.gmSettings);

      // The one setting that cannot simply be set. Switching `Show All NPCs` off
      // is what takes a borrowed monster out of the library, and doing that while
      // one is standing in a fight would leave a slot whose character the library
      // no longer lists. The console greys the control out for the fight it can
      // see; this is the rule itself, which also covers the second console, the
      // other browser, and the library page, none of which can see that fight.
      if (changes.showAllNpcs === false) {
        const borrowed = sessionCharacters.borrowedNpcsForGm(gm.id);
        if (borrowed > 0) {
          throw errors.conflict(
            borrowed === 1
              ? "A monster from another campaign is in a running session. Take it off the stage first."
              : `${borrowed} monsters from other campaigns are in running sessions. ` +
                "Take them off the stage first.",
          );
        }
      }

      // The built-in is stored as no choice at all, which is what it is; anything
      // else has to be one of this game master's own, since an id is the only
      // thing a request carries and one from somebody else's collection would
      // otherwise render their sheets through a stranger's template.
      let templateId: string | null | undefined;
      if (changes.templateId !== undefined) {
        if (changes.templateId === BUILT_IN_TEMPLATE_ID) {
          templateId = null;
        } else {
          const template = templates.byId(changes.templateId);
          if (!template || template.gm_id !== gm.id) {
            throw errors.notFound("We couldn't find that export template.");
          }
          templateId = template.id;
        }
      }

      gms.update(gm.id, { ...changes, templateId });
      logger.info("gm settings changed", { gmId: gm.id, fields: Object.keys(changes) });

      // What was actually saved, read back rather than echoed: a field the
      // schema dropped should not come home looking as though it had been kept.
      // The identity's own shape, so a caller comparing the two is comparing
      // like with like.
      return json({ settings: presentGm(gms.byId(gm.id)!) });
    }),
  },
};
