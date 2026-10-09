"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

type Definition = { slug: string; name: string; minCm: string; maxCm: string };
type Measurement = {
  id: string;
  definition: string;
  name: string;
  enteredValue: string;
  enteredUnit: string;
  canonicalCm: string;
  displayValue: string;
  displayUnit: string;
  source: string;
  verificationStatus: string;
  recordStatus: string;
  note: string;
  recordedAt: string;
};
type Grant = { userId: string; displayName: string; email: string; permission: string };
type Profile = {
  id: string;
  name: string;
  notes: string;
  preferredUnit: string;
  status: string;
  access: string;
  fitAnalysis: boolean;
  measurements: Measurement[];
  grants: Grant[];
  updatedAt: string;
};

const sourceLabel: Record<string, string> = {
  user_entered: "Entered by you",
  tailor_recorded: "Recorded by a tailor",
  professionally_verified: "Professionally verified",
  imported: "Imported",
  ai_estimated: "AI estimate",
};

export function MeasureDesk() {
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [notice, setNotice] = useState("");
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [history, setHistory] = useState<Measurement[] | null>(null);
  const [profileName, setProfileName] = useState("");
  const [preferredUnit, setPreferredUnit] = useState("cm");
  const [definition, setDefinition] = useState("");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("cm");
  const [note, setNote] = useState("");
  const [grantEmail, setGrantEmail] = useState("");
  const [permission, setPermission] = useState("read");

  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function signIn(event: { preventDefault(): void }) {
    event.preventDefault();
    setNotice("");
    const response = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) {
      setNotice("Sign-in did not succeed.");
      return;
    }
    setSignedIn(true);
    await refresh();
  }

  async function refresh(selectedId?: string) {
    const [definitionResponse, profileResponse] = await Promise.all([
      fetch("/api/v1/measurements/definitions"),
      fetch("/api/v1/measurements/profiles"),
    ]);
    if (!definitionResponse.ok || !profileResponse.ok) {
      setNotice("Measurements could not be loaded.");
      return;
    }
    const definitionBody = (await definitionResponse.json()) as { definitions: Definition[] };
    const profileBody = (await profileResponse.json()) as { profiles: Profile[] };
    setDefinitions(definitionBody.definitions);
    setDefinition((current) => current || definitionBody.definitions[0]?.slug || "");
    setProfiles(profileBody.profiles);
    const nextId = selectedId ?? profile?.id ?? profileBody.profiles[0]?.id;
    if (!nextId) {
      setProfile(null);
      return;
    }
    await openProfile(nextId);
  }

  async function openProfile(id: string) {
    const response = await fetch(`/api/v1/measurements/profiles/${id}`);
    const body = (await response.json()) as { profile?: Profile; error?: { message: string } };
    if (!response.ok || !body.profile) {
      setNotice(body.error?.message ?? "That profile is not available.");
      return;
    }
    setProfile(body.profile);
    setHistory(null);
  }

  async function createProfile(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    const response = await fetch("/api/v1/measurements/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: profileName, preferredUnit }),
    });
    const body = (await response.json()) as { profile?: Profile; error?: { message: string } };
    if (!response.ok || !body.profile) {
      setNotice(body.error?.message ?? "The profile was not saved.");
      return;
    }
    setProfileName("");
    await refresh(body.profile.id);
  }

  async function recordMeasurement(event: FormEvent) {
    event.preventDefault();
    if (!profile) return;
    setNotice("");
    const response = await fetch(`/api/v1/measurements/profiles/${profile.id}/measurements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definition, value, unit, source: "user_entered", note }),
    });
    const body = (await response.json()) as { error?: { message: string } };
    if (!response.ok) {
      setNotice(body.error?.message ?? "The measurement was not saved.");
      return;
    }
    setValue("");
    setNote("");
    await openProfile(profile.id);
  }

  async function loadHistory(slug: string) {
    if (!profile) return;
    setNotice("");
    const response = await fetch(`/api/v1/measurements/profiles/${profile.id}/history?definition=${encodeURIComponent(slug)}`);
    const body = (await response.json()) as { measurements?: Measurement[]; error?: { message: string } };
    if (!response.ok || !body.measurements) {
      setNotice(body.error?.message ?? "History could not be loaded.");
      setHistory(null);
      return;
    }
    setHistory(body.measurements);
  }

  async function archiveMeasurement(id: string) {
    if (!profile) return;
    setNotice("");
    const response = await fetch(`/api/v1/measurements/profiles/${profile.id}/measurements/${id}/archive`, { method: "POST" });
    const body = (await response.json()) as { error?: { message: string } };
    if (!response.ok) {
      setNotice(body.error?.message ?? "The measurement was not archived.");
      return;
    }
    await openProfile(profile.id);
  }

  async function grantAccess(event: FormEvent) {
    event.preventDefault();
    if (!profile) return;
    setNotice("");
    const response = await fetch(`/api/v1/measurements/profiles/${profile.id}/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: grantEmail, permission }),
    });
    const body = (await response.json()) as { error?: { message: string } };
    if (!response.ok) {
      setNotice(body.error?.message ?? "Access was not granted.");
      return;
    }
    setGrantEmail("");
    await openProfile(profile.id);
  }

  async function revokeAccess(userId: string) {
    if (!profile) return;
    setNotice("");
    const response = await fetch(`/api/v1/measurements/profiles/${profile.id}/grants/${userId}`, { method: "DELETE" });
    if (!response.ok) {
      setNotice("Access was not removed.");
      return;
    }
    await openProfile(profile.id);
  }

  if (!ready) {
    return (
      <main className="mx-auto max-w-3xl px-5 py-10">
        <h1 className="font-editorial text-4xl text-ink">Measurements</h1>
      </main>
    );
  }

  const selected = definitions.find((item) => item.slug === definition);

  return (
    <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-8 px-5 py-10">
      <header className="flex items-end justify-between gap-4 border-b border-ink/15 pb-4">
        <div>
          <p className="text-xs tracking-[0.18em] text-muted uppercase">Bop</p>
          <h1 className="font-editorial text-4xl text-ink">Measurements</h1>
        </div>
        <nav className="flex gap-4 text-sm">
          <Link className="text-ink underline" href="/fit">
            Fit
          </Link>
          <Link className="text-ink underline" href="/">
            Landing
          </Link>
        </nav>
      </header>
      <p className="max-w-2xl text-sm leading-6 text-muted">
        These are body measurements you or an authorized tailor record. They are not garment dimensions, size labels, or a
        fit prediction. Nothing is estimated from a photograph.
      </p>
      {notice ? <p className="text-sm text-clay">{notice}</p> : null}
      {signedIn ? null : (
        <form className="grid max-w-md gap-3">
          <label className="grid gap-1 text-sm">
            Email
            <input className="border border-ink/20 bg-paper px-3 py-2" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm">
            Password
            <input className="border border-ink/20 bg-paper px-3 py-2" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <button className="bg-ink px-4 py-2 text-sm text-ivory" type="button" onClick={(event) => void signIn(event)}>
            Sign in
          </button>
        </form>
      )}
      {signedIn ? (
        <div className="grid gap-8">
          {profiles.length === 0 && !profile ? <p className="text-sm text-muted">No measurement profile yet.</p> : null}
          <form className="grid max-w-md gap-3" onSubmit={(event) => void createProfile(event)}>
            <h2 className="text-sm tracking-[0.14em] uppercase">New profile</h2>
            <label className="grid gap-1 text-sm">
              Profile name
              <input className="border border-ink/20 bg-paper px-3 py-2" value={profileName} onChange={(event) => setProfileName(event.target.value)} />
            </label>
            <label className="grid gap-1 text-sm">
              Preferred display unit
              <select className="border border-ink/20 bg-paper px-3 py-2" value={preferredUnit} onChange={(event) => setPreferredUnit(event.target.value)}>
                <option value="cm">Centimetres</option>
                <option value="m">Metres</option>
                <option value="in">Inches</option>
              </select>
            </label>
            <button className="w-fit border border-ink px-3 py-2 text-sm" type="submit">
              Create profile
            </button>
          </form>
          {profile ? (
            <section className="grid gap-4">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <h2 className="font-editorial text-3xl text-ink">{profile.name}</h2>
                  <p className="text-sm text-muted">
                    Preferred unit {profile.preferredUnit}. Updated {new Date(profile.updatedAt).toLocaleString()}. Dimension comparison
                    is on the fit page and does not predict physical fit.
                  </p>
                </div>
                {profiles.length > 1 ? (
                  <label className="grid gap-1 text-sm">
                    Profile
                    <select className="border border-ink/20 bg-paper px-3 py-2" value={profile.id} onChange={(event) => void openProfile(event.target.value)}>
                      {profiles.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
              <p className="text-sm text-muted">
                Only you can see this profile unless you grant access to a specific person. Membership in a tailor or studio
                organization does not share these measurements.
              </p>
              {profile.measurements.length === 0 ? <p className="text-sm text-muted">No measurements recorded.</p> : null}
              <ul className="grid gap-3">
                {profile.measurements.map((item) => (
                  <li key={item.id} className="grid gap-1 border-t border-ink/15 pt-3 text-sm">
                    <p className="text-ink">{item.name}</p>
                    <p>
                      Entered {item.enteredValue} {item.enteredUnit}. Stored {item.canonicalCm} cm. Display {item.displayValue}{" "}
                      {item.displayUnit}.
                    </p>
                    <p className="text-muted">
                      {sourceLabel[item.source] ?? item.source}.{" "}
                      {item.verificationStatus === "verified" ? "Verified." : "Unverified."}
                    </p>
                    {item.note ? <p className="text-muted">{item.note}</p> : null}
                    <div className="flex gap-3">
                      <button className="underline" type="button" onClick={() => void loadHistory(item.definition)}>
                        Earlier values
                      </button>
                      <button className="underline" type="button" onClick={() => void archiveMeasurement(item.id)}>
                        Archive
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {history ? (
                <div className="grid gap-2 text-sm">
                  <h3 className="tracking-[0.14em] uppercase">History</h3>
                  {history.length === 0 ? <p className="text-muted">No earlier measurements.</p> : null}
                  {history.map((item) => (
                    <p key={item.id}>
                      {item.recordStatus}: {item.enteredValue} {item.enteredUnit} ({item.canonicalCm} cm).{" "}
                      {sourceLabel[item.source] ?? item.source}. {item.verificationStatus === "verified" ? "Verified." : "Unverified."}
                    </p>
                  ))}
                </div>
              ) : null}
              {profile.access === "subject" && profile.status === "active" ? (
                <form className="grid gap-3 border-t border-ink/15 pt-4" onSubmit={(event) => void recordMeasurement(event)}>
                  <h3 className="text-sm tracking-[0.14em] uppercase">Record a measurement</h3>
                  <label className="grid gap-1 text-sm">
                    Measurement
                    <select className="border border-ink/20 bg-paper px-3 py-2" value={definition} onChange={(event) => setDefinition(event.target.value)}>
                      {definitions.map((item) => (
                        <option key={item.slug} value={item.slug}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selected ? (
                    <p className="text-sm text-muted">
                      Accepted range {trimCm(selected.minCm)}–{trimCm(selected.maxCm)} cm. This limit is for clothing measurements,
                      not a health assessment.
                    </p>
                  ) : null}
                  <label className="grid gap-1 text-sm">
                    Value
                    <input className="border border-ink/20 bg-paper px-3 py-2" inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} />
                  </label>
                  <label className="grid gap-1 text-sm">
                    Unit
                    <select className="border border-ink/20 bg-paper px-3 py-2" value={unit} onChange={(event) => setUnit(event.target.value)}>
                      <option value="cm">Centimetres</option>
                      <option value="m">Metres</option>
                      <option value="in">Inches</option>
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm">
                    Note
                    <input className="border border-ink/20 bg-paper px-3 py-2" value={note} onChange={(event) => setNote(event.target.value)} />
                  </label>
                  <button className="w-fit border border-ink px-3 py-2 text-sm" type="submit">
                    Save measurement
                  </button>
                </form>
              ) : null}
              {profile.access === "subject" ? (
                <form className="grid gap-3 border-t border-ink/15 pt-4" onSubmit={(event) => void grantAccess(event)}>
                  <h3 className="text-sm tracking-[0.14em] uppercase">Who can see this</h3>
                  {profile.grants.length === 0 ? <p className="text-sm text-muted">No one else has access.</p> : null}
                  <ul className="grid gap-2 text-sm">
                    {profile.grants.map((grant) => (
                      <li key={grant.userId} className="flex items-center justify-between gap-3">
                        <span>
                          {grant.displayName} · {grant.permission}
                        </span>
                        <button className="underline" type="button" onClick={() => void revokeAccess(grant.userId)}>
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                  <label className="grid gap-1 text-sm">
                    Email
                    <input className="border border-ink/20 bg-paper px-3 py-2" value={grantEmail} onChange={(event) => setGrantEmail(event.target.value)} />
                  </label>
                  <label className="grid gap-1 text-sm">
                    Access
                    <select className="border border-ink/20 bg-paper px-3 py-2" value={permission} onChange={(event) => setPermission(event.target.value)}>
                      <option value="read">Read</option>
                      <option value="record">Record</option>
                      <option value="verify">Verify</option>
                    </select>
                  </label>
                  <button className="w-fit border border-ink px-3 py-2 text-sm" type="submit">
                    Grant access
                  </button>
                </form>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

function trimCm(value: string) {
  return value.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}
