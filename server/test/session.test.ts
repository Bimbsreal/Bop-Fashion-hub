import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import { createApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { closePool, getPool } from "../src/db/pool";

const password = "session-pass-1";
let pool: Pool | null = null;
let server: Server | null = null;
let baseUrl = "";

before(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set, so session tests were not executed.");
  pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set, so session tests were not executed.");
  await migrate(pool);
  await pool.query(`DELETE FROM users WHERE email LIKE '%@site.test'`);
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  }
  if (pool) await pool.query(`DELETE FROM users WHERE email LIKE '%@site.test'`);
  await closePool();
});

test("a session survives a later read and ends on sign-out", async () => {
  const anonymous = await request("GET", "/api/v1/auth/session");
  assert.equal(anonymous.status, 401);
  const email = `${randomUUID()}@site.test`;
  const created = await request("POST", "/api/v1/auth/register", {
    body: { email, displayName: "Site Tester", password },
  });
  assert.equal(created.status, 201);
  const token = created.headers.get("set-cookie")?.match(/bop_session=([^;]+)/);
  assert.ok(token);
  const cookie = `bop_session=${token[1]}`;
  const session = await request("GET", "/api/v1/auth/session", { cookie });
  assert.equal(session.status, 200);
  const user = (session.body as { user: { email: string; displayName: string } }).user;
  assert.equal(user.email, email);
  assert.equal(user.displayName, "Site Tester");
  assert.equal("password" in (session.body as object), false);
  const signedOut = await request("POST", "/api/v1/auth/logout", { cookie });
  assert.equal(signedOut.status, 204);
  const ended = await request("GET", "/api/v1/auth/session", { cookie });
  assert.equal(ended.status, 401);
});

async function request(method: string, path: string, options: { cookie?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? (JSON.parse(text) as unknown) : null };
}
