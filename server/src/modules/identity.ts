import type { PoolClient } from "pg";
import { invalid } from "../errors";

export type UserRecord = {
  id: string;
  email: string;
  display_name: string;
  status: "active" | "disabled";
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function createUser(
  client: PoolClient,
  input: { email: string; displayName: string; givenName?: string | null; familyName?: string | null },
): Promise<UserRecord> {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (!emailPattern.test(email)) throw invalid("invalid_email", "Enter a valid email address.");
  if (!displayName) throw invalid("invalid_name", "Display name is required.");

  const inserted = await client.query<UserRecord>(
    `INSERT INTO users (email, display_name)
     VALUES ($1, $2)
     RETURNING id, email, display_name, status`,
    [email, displayName],
  );
  const user = inserted.rows[0];
  if (!user) throw invalid("invalid_name", "Display name is required.");

  await client.query(
    `INSERT INTO user_profiles (user_id, given_name, family_name)
     VALUES ($1, $2, $3)`,
    [user.id, blankToNull(input.givenName), blankToNull(input.familyName)],
  );
  return user;
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
