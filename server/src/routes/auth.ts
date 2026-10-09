import { Router } from "express";
import { withTransaction } from "../db/pool";
import { objectBody, requiredString } from "../http/body";
import { requireUser } from "../http/actor";
import { clearSessionCookie, currentAccount, loginAccount, readCookie, registerAccount, revokeToken, sessionCookie } from "../modules/session";

export const authRouter = Router();

authRouter.get("/session", async (_request, response) => {
  const actorUserId = requireUser(response);
  const user = await withTransaction((client) => currentAccount(client, actorUserId));
  response.json({ user });
});

authRouter.post("/register", async (request, response) => {
  const body = objectBody(request.body);
  const account = await withTransaction((client) =>
    registerAccount(client, {
      email: requiredString(body.email, "invalid_email", "Enter a valid email address."),
      displayName: requiredString(body.displayName, "invalid_name", "Display name is required."),
      password: requiredString(body.password, "invalid_password", "Use a password between 8 and 200 characters."),
    }),
  );
  response.setHeader("Set-Cookie", sessionCookie(account.token));
  response.status(201).json({
    user: { id: account.id, email: account.email, displayName: account.displayName },
  });
});

authRouter.post("/login", async (request, response) => {
  const body = objectBody(request.body);
  const account = await withTransaction((client) =>
    loginAccount(client, {
      email: requiredString(body.email, "invalid_email", "Email or password is not valid."),
      password: requiredString(body.password, "invalid_password", "Email or password is not valid."),
    }),
  );
  response.setHeader("Set-Cookie", sessionCookie(account.token));
  response.json({
    user: { id: account.id, email: account.email, displayName: account.displayName },
  });
});

authRouter.post("/logout", async (request, response) => {
  const token = readCookie(request.header("cookie"), "bop_session");
  if (token) await withTransaction((client) => revokeToken(client, token));
  response.setHeader("Set-Cookie", clearSessionCookie());
  response.status(204).end();
});
