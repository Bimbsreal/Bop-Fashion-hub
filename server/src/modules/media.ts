import type { PoolClient } from "pg";
import { actorMayAccessOwner, assertCanActForOwner, ownerColumns, ownerFromIds, type OwnerRef } from "./access";
import { forbidden, invalid, notFound } from "../errors";
import { isSafeStorageKey } from "./storage";

export type MediaRecord = {
  id: string;
  storage_key: string;
  status: "pending" | "ready" | "failed";
};

const mediaTypes = new Set(["image", "video", "other"]);

export async function registerMedia(
  client: PoolClient,
  actorUserId: string,
  input: {
    owner: OwnerRef;
    mediaType: string;
    mimeType: string;
    byteSize: number;
    storageKey: string;
    widthPx?: number | null;
    heightPx?: number | null;
  },
): Promise<MediaRecord> {
  await assertCanActForOwner(client, actorUserId, input.owner);
  if (!mediaTypes.has(input.mediaType)) throw invalid("invalid_media", "Media type is not recognized.");
  const mimeType = input.mimeType.trim();
  const storageKey = input.storageKey.trim();
  if (!mimeType) throw invalid("invalid_media", "MIME type is required.");
  if (!isSafeStorageKey(storageKey)) throw invalid("invalid_media", "Storage key is not valid.");
  if (!Number.isInteger(input.byteSize) || input.byteSize < 0) {
    throw invalid("invalid_media", "File size must be zero or greater.");
  }

  const columns = ownerColumns(input.owner);
  const inserted = await client.query<MediaRecord>(
    `INSERT INTO media_assets (
       owner_user_id, owner_organization_id, media_type, mime_type, byte_size, storage_key, width_px, height_px
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, storage_key, status`,
    [
      columns.ownerUserId,
      columns.ownerOrganizationId,
      input.mediaType,
      mimeType,
      input.byteSize,
      storageKey,
      input.widthPx ?? null,
      input.heightPx ?? null,
    ],
  );
  const media = inserted.rows[0];
  if (!media) throw invalid("invalid_media", "Media could not be registered.");
  return media;
}

const mediaRoles = new Set([
  "primary",
  "front",
  "back",
  "side",
  "detail",
  "fabric",
  "sketch",
  "construction",
  "reference",
  "generated",
]);

export async function linkGarmentMedia(
  client: PoolClient,
  actorUserId: string,
  input: { garmentId: string; mediaId: string; role?: string },
): Promise<void> {
  const role = input.role ?? "reference";
  if (!mediaRoles.has(role)) throw invalid("invalid_media", "Media role is not recognized.");

  const garment = await client.query<{ owner_user_id: string | null; owner_organization_id: string | null }>(
    `SELECT owner_user_id, owner_organization_id FROM garments WHERE id = $1`,
    [input.garmentId],
  );
  const asset = await client.query<{ owner_user_id: string | null; owner_organization_id: string | null }>(
    `SELECT owner_user_id, owner_organization_id FROM media_assets WHERE id = $1`,
    [input.mediaId],
  );
  const garmentRow = garment.rows[0];
  const assetRow = asset.rows[0];
  if (!garmentRow || !assetRow) throw invalid("not_found", "Garment or media was not found.");
  if (
    garmentRow.owner_user_id !== assetRow.owner_user_id ||
    garmentRow.owner_organization_id !== assetRow.owner_organization_id
  ) {
    throw forbidden("Media and garment must share an owner.");
  }

  await assertCanActForOwner(client, actorUserId, ownerFromIds(garmentRow.owner_user_id, garmentRow.owner_organization_id));
  await client.query(
    `INSERT INTO garment_media (garment_id, media_id, role) VALUES ($1, $2, $3)`,
    [input.garmentId, input.mediaId, role],
  );
}

export async function attachGarmentMedia(
  client: PoolClient,
  actorUserId: string,
  garmentId: string,
  input: {
    role?: string;
    mediaId?: string;
    mediaType?: string;
    mimeType?: string;
    byteSize?: number;
    storageKey?: string;
    widthPx?: number | null;
    heightPx?: number | null;
  },
): Promise<void> {
  const garment = await client.query<{ owner_user_id: string | null; owner_organization_id: string | null }>(
    `SELECT owner_user_id, owner_organization_id FROM garments WHERE id = $1 FOR UPDATE`,
    [garmentId],
  );
  const row = garment.rows[0];
  if (!row) throw notFound("Garment was not found.");
  const owner = ownerFromIds(row.owner_user_id, row.owner_organization_id);
  if (!(await actorMayAccessOwner(client, actorUserId, owner))) throw notFound("Garment was not found.");

  const mediaId = input.mediaId
    ? input.mediaId
    : (
        await registerMedia(client, actorUserId, {
          owner,
          mediaType: input.mediaType ?? "",
          mimeType: input.mimeType ?? "",
          byteSize: input.byteSize ?? Number.NaN,
          storageKey: input.storageKey ?? "",
          widthPx: input.widthPx,
          heightPx: input.heightPx,
        })
      ).id;
  await linkGarmentMedia(client, actorUserId, { garmentId, mediaId, role: input.role });
}
