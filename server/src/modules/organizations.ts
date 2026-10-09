import type { PoolClient } from "pg";
import { forbidden, invalid } from "../errors";

export type OrganizationKind = "studio" | "tailor" | "brand" | "retailer";
export type MembershipRole = "owner" | "admin" | "member";

export type OrganizationRecord = {
  id: string;
  name: string;
  slug: string;
  kind: OrganizationKind;
  status: "active" | "archived";
};

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const kinds = new Set<OrganizationKind>(["studio", "tailor", "brand", "retailer"]);

export async function createOrganization(
  client: PoolClient,
  ownerUserId: string,
  input: { name: string; slug: string; kind: OrganizationKind },
): Promise<OrganizationRecord> {
  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  if (!name) throw invalid("invalid_name", "Organization name is required.");
  if (!slugPattern.test(slug)) throw invalid("invalid_slug", "Use a lowercase slug.");
  if (!kinds.has(input.kind)) throw invalid("invalid_kind", "Organization kind is not recognized.");

  const inserted = await client.query<OrganizationRecord>(
    `INSERT INTO organizations (name, slug, kind)
     VALUES ($1, $2, $3)
     RETURNING id, name, slug, kind, status`,
    [name, slug, input.kind],
  );
  const organization = inserted.rows[0];
  if (!organization) throw invalid("invalid_name", "Organization name is required.");

  await client.query(
    `INSERT INTO organization_memberships (organization_id, user_id, role, status)
     VALUES ($1, $2, 'owner', 'active')`,
    [organization.id, ownerUserId],
  );
  return organization;
}

export async function addMember(
  client: PoolClient,
  actorUserId: string,
  input: { organizationId: string; userId: string; role: MembershipRole },
): Promise<void> {
  if (input.role !== "admin" && input.role !== "member") {
    throw invalid("invalid_role", "Choose admin or member.");
  }
  const actor = await client.query<{ role: MembershipRole }>(
    `SELECT role
     FROM organization_memberships
     WHERE user_id = $1 AND organization_id = $2 AND status = 'active'`,
    [actorUserId, input.organizationId],
  );
  const role = actor.rows[0]?.role;
  if (role !== "owner" && role !== "admin") {
    throw forbidden("Only an owner or admin can add a member.");
  }
  await client.query(
    `INSERT INTO organization_memberships (organization_id, user_id, role, status)
     VALUES ($1, $2, $3, 'active')`,
    [input.organizationId, input.userId, input.role],
  );
}
