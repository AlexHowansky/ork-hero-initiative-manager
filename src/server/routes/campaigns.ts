/**
 * Campaign library. Game master only.
 */

import type { BunRequest } from "bun";
import { handler, json, noContent, type RequestContext } from "../http.ts";
import { parse, schemas } from "../../lib/validate.ts";
import { errors } from "../../lib/errors.ts";
import { requireGm, requireOwnedCampaign } from "../middleware/auth.ts";
import { campaigns } from "../../db/queries.ts";
import { collectOrphanedUploads, fileField, storeImage } from "../uploads.ts";
import { presentCampaign as present } from "../presenters.ts";
import { broadcastGmSessions } from "../ws.ts";

export const campaignRoutes = {
  "/api/campaigns": {
    GET: handler((request: BunRequest) => {
      const gm = requireGm(request);
      return json({ campaigns: campaigns.listForGm(gm.id).map(present) });
    }),

    POST: handler(async (request: BunRequest, { logger }: RequestContext) => {
      const gm = requireGm(request);
      const form = await request.formData();
      const { name } = parse(schemas.campaignInput, { name: form.get("name") });

      // Names are unique within a game master's own library, per the spec.
      if (campaigns.nameTaken(gm.id, name)) {
        throw errors.conflict(`A campaign called “${name}” already exists.`);
      }

      const image = fileField(form, "card");
      const card = image ? await storeImage(image) : null;

      const campaign = campaigns.create({
        gmId: gm.id,
        name,
        cardUploadId: card?.id ?? null,
      });
      logger.info("campaign created", { gmId: gm.id, campaignId: campaign.id });

      return json({ campaign: present(campaign) }, { status: 201 });
    }),
  },

  "/api/campaigns/:id": {
    PATCH: handler(async (request: BunRequest<"/api/campaigns/:id">, { logger }: RequestContext) => {
      const { campaign } = requireOwnedCampaign(request, request.params.id);
      const form = await request.formData();

      const changes: { name?: string; cardUploadId?: string | null } = {};

      const rawName = form.get("name");
      if (typeof rawName === "string") {
        const { name } = parse(schemas.campaignInput, { name: rawName });
        if (name !== campaign.name && campaigns.nameTaken(campaign.gm_id, name, campaign.id)) {
          throw errors.conflict(`A campaign called “${name}” already exists.`);
        }
        changes.name = name;
      }

      const image = fileField(form, "card");
      if (image) {
        changes.cardUploadId = (await storeImage(image)).id;
      } else if (form.get("removeCard") === "true") {
        changes.cardUploadId = null;
      }

      const updated = campaigns.update(campaign.id, changes);
      // A replaced or removed card image leaves its old file unreferenced.
      if (changes.cardUploadId !== undefined) await collectOrphanedUploads();
      logger.info("campaign updated", { campaignId: campaign.id });

      // A session is listed under its campaign's name, and sorted by it, so a
      // rename reorders the library's session list as well as relabelling it.
      if (changes.name !== undefined) broadcastGmSessions(campaign.gm_id);

      return json({ campaign: present(updated!) });
    }),

    DELETE: handler(
      async (request: BunRequest<"/api/campaigns/:id">, { logger }: RequestContext) => {
        const { campaign } = requireOwnedCampaign(request, request.params.id);
        // Characters and sessions cascade in the schema; their files are cleaned
        // up afterwards, once nothing references them.
        campaigns.remove(campaign.id);
        await collectOrphanedUploads();
        logger.info("campaign deleted", { campaignId: campaign.id });
        // Deleting a campaign takes its running session with it.
        broadcastGmSessions(campaign.gm_id);
        return noContent();
      },
    ),
  },
};
