/**
 * A game master's export templates. Game master only, and their own only.
 *
 * A template is the frame a character sheet is drawn in. Each game master keeps
 * their own collection — a file uploaded here is never another game master's to
 * see, select or delete — and the one this app ships is always in the list, as
 * the default nobody can take away.
 *
 * Which of them is *active* is not here. That is a setting, and it goes through
 * `PATCH /api/settings` with the rest of them, so it comes home on the identity
 * and the console has it before its first render.
 */

import type { BunRequest } from "bun";
import { handler, json, noContent, type RequestContext } from "../http.ts";
import { errors } from "../../lib/errors.ts";
import { requireGm } from "../middleware/auth.ts";
import { templates } from "../../db/queries.ts";
import { BUILT_IN_TEMPLATE_ID, BUILT_IN_TEMPLATE_NAME } from "../../lib/templates.ts";
import { deleteTemplate, storeTemplate } from "../templates.ts";
import { fileField, requireTotalWithinLimit } from "../uploads.ts";
import { presentTemplate } from "../presenters.ts";
import type { GmRow } from "../../db/types.ts";

/** Loads a template and confirms it is this game master's own. */
function requireOwnedTemplate(gm: GmRow, id: string) {
  const template = templates.byId(id);
  // A 404 rather than a 403, as everywhere else, so that ids reveal nothing
  // about what exists in somebody else's collection.
  if (!template || template.gm_id !== gm.id) {
    throw errors.notFound("We couldn't find that export template.");
  }
  return template;
}

export const templateRoutes = {
  "/api/templates": {
    GET: handler(async (request: BunRequest) => {
      const gm = requireGm(request);
      return json({
        templates: [
          // First, and always there: it is the default, and a list whose first
          // row cannot be taken away is a list nobody can empty by accident.
          {
            id: BUILT_IN_TEMPLATE_ID,
            name: BUILT_IN_TEMPLATE_NAME,
            builtIn: true,
            // It is three files, and which one is used is the shape of the
            // reader's window rather than anything on record — so there is no
            // one filename to name.
            originalName: null,
            createdAt: null,
          },
          ...templates.listForGm(gm.id).map(presentTemplate),
        ],
      });
    }),

    POST: handler(async (request: BunRequest, { logger }: RequestContext) => {
      const gm = requireGm(request);
      const form = await request.formData();

      const file = fileField(form, "template");
      if (!file) throw errors.badRequest("Please choose a .hde export template to upload.");
      requireTotalWithinLimit(file);

      // A name this game master already has is that template being updated, so
      // the answer is the resource they already had rather than a new one — and
      // 201 would be saying something untrue about what just happened.
      const { template, replaced } = await storeTemplate(gm.id, file);
      logger.info("export template uploaded", { templateId: template.id, replaced });

      return json(
        { template: presentTemplate(template), replaced },
        { status: replaced ? 200 : 201 },
      );
    }),
  },

  "/api/templates/:id": {
    DELETE: handler(async (request: BunRequest<"/api/templates/:id">, { logger }: RequestContext) => {
      const gm = requireGm(request);

      if (request.params.id === BUILT_IN_TEMPLATE_ID) {
        throw errors.conflict("The built-in template comes with the app and can't be deleted.");
      }

      const template = requireOwnedTemplate(gm, request.params.id);

      // The same guard a character in a running session gets: the thing in use
      // is not deleted out from under the person using it. Told rather than
      // worked around, because the fix is one press away and silently moving
      // them back to the built-in would change every sheet at their table.
      if (gm.template_id === template.id) {
        throw errors.conflict(
          "Your character sheets are drawn with this template. Choose another one first.",
        );
      }

      await deleteTemplate(template);
      logger.info("export template deleted", { templateId: template.id });
      return noContent();
    }),
  },
};
