import type { NextFunction, Request, Response } from "express";
import { getPool } from "../db/pool";
import { unauthenticated } from "../errors";
import { readCookie, userIdForToken } from "../modules/session";

export async function attachUser(request: Request, response: Response, next: NextFunction) {
  try {
    const token = readCookie(request.header("cookie"), "bop_session");
    const pool = token ? getPool() : null;
    if (!token || !pool) {
      response.locals.userId = null;
      next();
      return;
    }
    const client = await pool.connect();
    try {
      response.locals.userId = await userIdForToken(client, token);
    } finally {
      client.release();
    }
    next();
  } catch (error) {
    next(error);
  }
}

export function requireUser(response: Response): string {
  const userId = response.locals.userId;
  if (typeof userId !== "string" || !userId) throw unauthenticated();
  return userId;
}
