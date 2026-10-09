"use client";

import { useEffect, useState } from "react";
import { prepareAccount } from "@/lib/account-form";

type SessionUser = { id: string; email: string; displayName: string };

export function AccountDesk() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadSession()
      .then((session) => {
        if (!cancelled) setUser(session);
      })
      .catch(() => {
        if (!cancelled) {
          setNotice("The account service is unavailable.");
          setUser(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(mode: "register" | "sign-in") {
    setNotice("");
    const prepared = prepareAccount({ mode, email, displayName, password });
    if (!prepared.ok) {
      setNotice(prepared.message);
      return;
    }
    setPending(true);
    try {
      const response = await fetch(mode === "register" ? "/api/v1/auth/register" : "/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(prepared.body),
      });
      const body = (await response.json()) as { user?: SessionUser; error?: { message: string } };
      if (!response.ok || !body.user) {
        setNotice(body.error?.message ?? "The account request did not succeed.");
        return;
      }
      setUser(body.user);
      setPassword("");
    } catch {
      setNotice("The account service is unavailable.");
    } finally {
      setPending(false);
    }
  }

  async function signOut() {
    setNotice("");
    setPending(true);
    try {
      const response = await fetch("/api/v1/auth/logout", { method: "POST" });
      if (!response.ok && response.status !== 204) {
        setNotice("Sign-out did not succeed.");
        return;
      }
      setUser(null);
    } catch {
      setNotice("The account service is unavailable.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-8 px-5 py-10">
      <header className="border-b border-ink/15 pb-4">
        <h1 className="font-editorial text-4xl text-ink">Account</h1>
      </header>
      <p className="max-w-2xl text-sm leading-6 text-muted">
        Sign-in uses the local Bop session. Password recovery is not available. The landing page sign-in dialog does not create this session.
      </p>
      {notice ? <p className="text-sm text-clay">{notice}</p> : null}
      {user === undefined ? <p className="text-sm text-muted">Loading the session.</p> : null}
      {user ? (
        <section className="grid gap-3">
          <h2 className="font-editorial text-2xl text-ink">{user.displayName}</h2>
          <p className="text-sm text-muted">{user.email}</p>
          <button className="w-fit border border-ink px-4 py-2 text-sm" type="button" disabled={pending} onClick={() => void signOut()}>
            Sign out
          </button>
        </section>
      ) : null}
      {user === null ? (
        <form
          className="grid max-w-md gap-3"
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <label className="grid gap-1 text-sm">
            Display name
            <input className="border border-ink/20 bg-paper px-3 py-2" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm">
            Email
            <input className="border border-ink/20 bg-paper px-3 py-2" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm">
            Password
            <input className="border border-ink/20 bg-paper px-3 py-2" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <div className="flex gap-3">
            <button className="bg-ink px-4 py-2 text-sm text-ivory" type="button" disabled={pending} onClick={() => void submit("sign-in")}>
              Sign in
            </button>
            <button className="border border-ink px-4 py-2 text-sm" type="button" disabled={pending} onClick={() => void submit("register")}>
              Create account
            </button>
          </div>
        </form>
      ) : null}
    </main>
  );
}

async function loadSession(): Promise<SessionUser | null> {
  const response = await fetch("/api/v1/auth/session");
  if (response.status === 401) return null;
  const body = (await response.json()) as { user?: SessionUser; error?: { message: string } };
  if (!response.ok || !body.user) throw new Error(body.error?.message ?? "The account could not be loaded.");
  return body.user;
}
