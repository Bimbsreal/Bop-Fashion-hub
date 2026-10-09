import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import type { PoolClient } from "pg";
import { invalid, unauthenticated } from "../errors";
import { createUser } from "./identity";

const scryptAsync = promisify(scrypt);
const sessionDays = 7;

export function sessionCookie(token: string): string {
  const maxAge = sessionDays * 24 * 60 * 60;
  return `bop_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return "bop_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

export async function registerAccount(
  client: PoolClient,
  input: { email: string; displayName: string; password: string },
): Promise<{ id: string; email: string; displayName: string; token: string }> {
  assertPassword(input.password);
  let user: { id: string; email: string; display_name: string };
  try {
    user = await createUser(client, { email: input.email, displayName: input.displayName });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw invalid("duplicate_email", "An account with that email already exists.");
    }
    throw error;
  }
  await client.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [
    user.id,
    await hashPassword(input.password),
  ]);
  const token = await startSession(client, user.id);
  return { id: user.id, email: user.email, displayName: user.display_name, token };
}

export async function loginAccount(
  client: PoolClient,
  input: { email: string; password: string },
): Promise<{ id: string; email: string; displayName: string; token: string }> {
  const email = input.email.trim().toLowerCase();
  const found = await client.query<{
    id: string;
    email: string;
    display_name: string;
    password_hash: string | null;
    status: string;
  }>(
    `SELECT id, email, display_name, password_hash, status FROM users WHERE email = $1`,
    [email],
  );
  const user = found.rows[0];
  const hash = user?.status === "active" ? user.password_hash : null;
  const matches = await verifyPassword(input.password, hash);
  if (!user || !matches) throw unauthenticated("Email or password is not valid.");
  const token = await startSession(client, user.id);
  return { id: user.id, email: user.email, displayName: user.display_name, token };
}

export async function currentAccount(
  client: PoolClient,
  userId: string,
): Promise<{ id: string; email: string; displayName: string }> {
  const found = await client.query<{ id: string; email: string; display_name: string }>(
    `SELECT id, email, display_name FROM users WHERE id = $1 AND status = 'active'`,
    [userId],
  );
  const user = found.rows[0];
  if (!user) throw unauthenticated();
  return { id: user.id, email: user.email, displayName: user.display_name };
}

export async function userIdForToken(client: PoolClient, token: string): Promise<string | null> {
  if (!token) return null;
  const found = await client.query<{ user_id: string }>(
    `SELECT sessions.user_id
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = $1
       AND sessions.expires_at > now()
       AND users.status = 'active'`,
    [hashToken(token)],
  );
  return found.rows[0]?.user_id ?? null;
}

export async function revokeToken(client: PoolClient, token: string): Promise<void> {
  if (!token) return;
  await client.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

function assertPassword(password: string) {
  if (typeof password !== "string" || password.length < 8 || password.length > 200) {
    throw invalid("invalid_password", "Use a password between 8 and 200 characters.");
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scryptAsync(password, salt, 32)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const actual = stored && stored.startsWith("scrypt$") ? stored : null;
  const [prefix, saltText, hashText] = (actual ?? dummyHash).split("$");
  if (prefix !== "scrypt" || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64url");
  const actualHash = (await scryptAsync(password, Buffer.from(saltText, "base64url"), expected.length)) as Buffer;
  if (expected.length !== actualHash.length) return false;
  return timingSafeEqual(expected, actualHash) && stored !== null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function startSession(client: PoolClient, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await client.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '7 days')`,
    [userId, hashToken(token)],
  );
  return token;
}

const dummyHash = `scrypt$${Buffer.alloc(16, 1).toString("base64url")}$${Buffer.alloc(32, 2).toString("base64url")}`;
