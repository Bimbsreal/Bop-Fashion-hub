import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { actorMayAccessOwner, assertCanActForOwner, ownerColumns, ownerFromIds, type OwnerRef } from "./access";
import { invalid, notFound } from "../errors";
import { extensionFor, inspectImage, sanitizeFilename, thumbnailBytes } from "./images";
import { linkGarmentMedia } from "./media";
import { isSafeStorageKey, withStoredFiles, type MediaStorage } from "./storage";

export type ImageLimits = { maxBytes: number; maxEdge: number };

export type MediaView = {
  id: string;
  mediaType: string;
  mimeType: string;
  byteSize: number;
  widthPx: number | null;
  heightPx: number | null;
  status: string;
  visibility: "private" | "public";
  variant: string;
  originalFilename: string;
  access: "view" | "edit";
  thumbnailId: string | null;
  createdAt: string;
  updatedAt: string;
};

type MediaRow = {
  id: string;
  media_type: string;
  mime_type: string;
  byte_size: string | number;
  width_px: number | null;
  height_px: number | null;
  status: string;
  visibility: "private" | "public";
  variant: string;
  original_filename: string;
  owner_user_id: string | null;
  owner_organization_id: string | null;
  storage_key: string;
  created_at: Date;
  updated_at: Date;
  thumbnail_id: string | null;
};

export async function uploadImage(
  client: PoolClient,
  actorUserId: string,
  input: {
    bytes: Buffer;
    filename?: string;
    visibility: "private" | "public";
    owner: OwnerRef;
    garmentId?: string;
    role?: string;
  },
  storage: MediaStorage,
  limits: ImageLimits,
  noteKey: (key: string) => void,
): Promise<MediaView> {
  if (input.bytes.length > limits.maxBytes) {
    throw invalid("file_too_large", "File is too large.");
  }
  const owner = input.owner;
  if (owner.organizationId) {
    const organization = await client.query<{ status: string }>(
      `SELECT status FROM organizations WHERE id = $1`,
      [owner.organizationId],
    );
    if (organization.rows[0]?.status !== "active") throw invalid("invalid_owner", "Organization is not active.");
  }
  await assertCanActForOwner(client, actorUserId, owner);

  const inspected = await inspectImage(input.bytes, limits.maxEdge);
  const preview = await thumbnailBytes(input.bytes, inspected.format);
  const extension = extensionFor(inspected.format);
  const originalId = randomUUID();
  const thumbnailId = randomUUID();
  const originalKey = `originals/${originalId}.${extension}`;
  const thumbnailKey = `thumbnails/${thumbnailId}.${extension}`;
  if (!isSafeStorageKey(originalKey) || !isSafeStorageKey(thumbnailKey)) {
    throw invalid("invalid_media", "Storage key is not valid.");
  }
  noteKey(originalKey);
  noteKey(thumbnailKey);
  const filename = sanitizeFilename(input.filename);
  const columns = ownerColumns(owner);

  const id = await withStoredFiles(
    storage,
    [
      { key: originalKey, bytes: input.bytes },
      { key: thumbnailKey, bytes: preview.bytes },
    ],
    async () => {
      await insertAsset(client, {
        id: originalId,
        ownerUserId: columns.ownerUserId,
        ownerOrganizationId: columns.ownerOrganizationId,
        mimeType: inspected.mimeType,
        byteSize: input.bytes.length,
        storageKey: originalKey,
        width: inspected.width,
        height: inspected.height,
        filename,
        visibility: input.visibility,
        variant: "original",
        derivativeOf: null,
      });
      await insertAsset(client, {
        id: thumbnailId,
        ownerUserId: columns.ownerUserId,
        ownerOrganizationId: columns.ownerOrganizationId,
        mimeType: inspected.mimeType,
        byteSize: preview.bytes.length,
        storageKey: thumbnailKey,
        width: preview.width,
        height: preview.height,
        filename,
        visibility: input.visibility,
        variant: "thumbnail",
        derivativeOf: originalId,
      });
      if (input.garmentId) {
        await linkGarmentMedia(client, actorUserId, {
          garmentId: input.garmentId,
          mediaId: originalId,
          role: input.role,
        });
      }
      return originalId;
    },
  );

  const media = await getMedia(client, actorUserId, id);
  if (!media) throw notFound("Media was not found.");
  return media;
}

export async function getMedia(
  client: PoolClient,
  actorUserId: string | null,
  mediaId: string,
): Promise<MediaView | null> {
  const loaded = await loadMedia(client, actorUserId, [mediaId]);
  return loaded[0] ?? null;
}

export async function requireMedia(
  client: PoolClient,
  actorUserId: string | null,
  mediaId: string,
): Promise<MediaView> {
  const media = await getMedia(client, actorUserId, mediaId);
  if (!media) throw notFound("Media was not found.");
  return media;
}

export async function listMedia(
  client: PoolClient,
  actorUserId: string | null,
  query: { limit: number; offset: number },
): Promise<{ media: MediaView[]; total: number }> {
  const params: unknown[] = [];
  const actor = bind(params, actorUserId);
  const where = `media.variant = 'original' AND ${visibleSql(actor)}`;
  const total = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM media_assets AS media WHERE ${where}`,
    params,
  );
  const pageParams = [...params];
  const limit = bind(pageParams, query.limit);
  const offset = bind(pageParams, query.offset);
  const page = await client.query<{ id: string }>(
    `SELECT media.id
     FROM media_assets AS media
     WHERE ${where}
     ORDER BY media.created_at DESC, media.id DESC
     LIMIT ${limit} OFFSET ${offset}`,
    pageParams,
  );
  const media = await loadMedia(client, actorUserId, page.rows.map((row) => row.id));
  return { media, total: Number(total.rows[0]?.total ?? 0) };
}

export async function readMediaContent(
  client: PoolClient,
  actorUserId: string | null,
  mediaId: string,
  storage: MediaStorage,
): Promise<{ bytes: Buffer; mimeType: string; filename: string }> {
  const params: unknown[] = [mediaId];
  const actor = bind(params, actorUserId);
  const found = await client.query<{
    storage_key: string;
    mime_type: string;
    original_filename: string;
    status: string;
  }>(
    `SELECT storage_key, mime_type, original_filename, status
     FROM media_assets AS media
     WHERE media.id = $1 AND ${visibleSql(actor)}`,
    params,
  );
  const row = found.rows[0];
  if (!row || row.status !== "ready") throw notFound("Media was not found.");
  try {
    const bytes = await storage.read(row.storage_key);
    return { bytes, mimeType: row.mime_type, filename: row.original_filename || "image" };
  } catch {
    throw notFound("Media was not found.");
  }
}

export async function deleteMedia(
  client: PoolClient,
  actorUserId: string,
  mediaId: string,
  storage: MediaStorage,
): Promise<void> {
  const found = await client.query<MediaRow>(
    `SELECT
       media.id, media.media_type, media.mime_type, media.byte_size, media.width_px, media.height_px,
       media.status, media.visibility, media.variant, media.original_filename,
       media.owner_user_id, media.owner_organization_id, media.storage_key,
       media.created_at, media.updated_at, NULL::uuid AS thumbnail_id
     FROM media_assets AS media
     WHERE media.id = $1
     FOR UPDATE`,
    [mediaId],
  );
  const row = found.rows[0];
  if (!row) throw notFound("Media was not found.");
  const allowed = await actorMayAccessOwner(
    client,
    actorUserId,
    ownerFromIds(row.owner_user_id, row.owner_organization_id),
  );
  if (!allowed) throw notFound("Media was not found.");

  const related = await client.query<{ id: string; storage_key: string }>(
    `SELECT id, storage_key FROM media_assets WHERE id = $1 OR derivative_of_id = $1`,
    [mediaId],
  );
  const ids = related.rows.map((item) => item.id);
  await client.query(`DELETE FROM garment_media WHERE media_id = ANY($1::uuid[])`, [ids]);
  await client.query(`DELETE FROM media_assets WHERE id = $1`, [row.variant === "thumbnail" ? mediaId : row.id]);
  for (const item of related.rows) {
    if (row.variant === "thumbnail" && item.id !== mediaId) continue;
    await storage.remove(item.storage_key);
  }
}

async function insertAsset(
  client: PoolClient,
  input: {
    id: string;
    ownerUserId: string | null;
    ownerOrganizationId: string | null;
    mimeType: string;
    byteSize: number;
    storageKey: string;
    width: number | null;
    height: number | null;
    filename: string;
    visibility: "private" | "public";
    variant: "original" | "thumbnail";
    derivativeOf: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO media_assets (
       id, owner_user_id, owner_organization_id, media_type, mime_type, byte_size, storage_key,
       width_px, height_px, status, original_filename, visibility, variant, derivative_of_id
     )
     VALUES ($1, $2, $3, 'image', $4, $5, $6, $7, $8, 'ready', $9, $10, $11, $12)`,
    [
      input.id,
      input.ownerUserId,
      input.ownerOrganizationId,
      input.mimeType,
      input.byteSize,
      input.storageKey,
      input.width,
      input.height,
      input.filename,
      input.visibility,
      input.variant,
      input.derivativeOf,
    ],
  );
}

async function loadMedia(client: PoolClient, actorUserId: string | null, ids: string[]): Promise<MediaView[]> {
  if (ids.length === 0) return [];
  const rows = await client.query<MediaRow>(
    `SELECT
       media.id, media.media_type, media.mime_type, media.byte_size, media.width_px, media.height_px,
       media.status, media.visibility, media.variant, media.original_filename,
       media.owner_user_id, media.owner_organization_id, media.storage_key,
       media.created_at, media.updated_at, thumb.id AS thumbnail_id
     FROM media_assets AS media
     LEFT JOIN media_assets AS thumb
       ON thumb.derivative_of_id = media.id AND thumb.variant = 'thumbnail'
     WHERE media.id = ANY($1::uuid[])
       AND ${visibleSql("$2")}
     `,
    [ids, actorUserId],
  );
  const memberships = actorUserId
    ? await client.query<{ organization_id: string }>(
        `SELECT organization_id FROM organization_memberships WHERE user_id = $1 AND status = 'active'`,
        [actorUserId],
      )
    : { rows: [] as { organization_id: string }[] };
  const memberOrgs = new Set(memberships.rows.map((row) => row.organization_id));
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    const access =
      (actorUserId && row.owner_user_id === actorUserId) ||
      (row.owner_organization_id !== null && memberOrgs.has(row.owner_organization_id))
        ? "edit"
        : "view";
    return [
      {
        id: row.id,
        mediaType: row.media_type,
        mimeType: row.mime_type,
        byteSize: Number(row.byte_size),
        widthPx: row.width_px,
        heightPx: row.height_px,
        status: row.status,
        visibility: row.visibility,
        variant: row.variant,
        originalFilename: row.original_filename,
        access,
        thumbnailId: row.thumbnail_id,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      },
    ];
  });
}

function visibleSql(actor: string): string {
  return `(
    media.visibility = 'public'
    OR (${actor}::uuid IS NOT NULL AND media.owner_user_id = ${actor}::uuid)
    OR (${actor}::uuid IS NOT NULL AND EXISTS (
      SELECT 1 FROM organization_memberships AS membership
      WHERE membership.organization_id = media.owner_organization_id
        AND membership.user_id = ${actor}::uuid
        AND membership.status = 'active'
    ))
  )`;
}

function bind(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}
