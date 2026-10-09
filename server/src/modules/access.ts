import type { PoolClient } from "pg";
import { forbidden } from "../errors";
import type { MembershipRole } from "./organizations";

export type OwnerRef =
  | { userId: string; organizationId?: null }
  | { userId?: null; organizationId: string };

type MembershipRow = {
  role: MembershipRole;
  status: string;
};

export async function activeMembership(
  client: PoolClient,
  userId: string,
  organizationId: string,
): Promise<MembershipRow | null> {
  const result = await client.query<MembershipRow>(
    `SELECT role, status
     FROM organization_memberships
     WHERE user_id = $1 AND organization_id = $2 AND status = 'active'`,
    [userId, organizationId],
  );
  return result.rows[0] ?? null;
}

export async function actorMayAccessOwner(
  client: PoolClient,
  actorUserId: string | null,
  owner: OwnerRef,
): Promise<boolean> {
  if (!actorUserId) return false;
  if (owner.userId) return owner.userId === actorUserId;
  if (!owner.organizationId) return false;
  const membership = await activeMembership(client, actorUserId, owner.organizationId);
  return membership !== null;
}

export async function assertCanActForOwner(
  client: PoolClient,
  actorUserId: string,
  owner: OwnerRef,
): Promise<void> {
  if (await actorMayAccessOwner(client, actorUserId, owner)) return;
  if (owner.organizationId && !owner.userId) {
    throw forbidden("You are not an active member of this organization.");
  }
  throw forbidden();
}

export function ownerFromIds(userId: string | null, organizationId: string | null): OwnerRef {
  if (userId && !organizationId) return { userId };
  if (organizationId && !userId) return { organizationId };
  throw forbidden();
}

export function ownerColumns(owner: OwnerRef): {
  ownerUserId: string | null;
  ownerOrganizationId: string | null;
} {
  if (owner.userId) {
    return { ownerUserId: owner.userId, ownerOrganizationId: null };
  }
  return { ownerUserId: null, ownerOrganizationId: owner.organizationId ?? null };
}
