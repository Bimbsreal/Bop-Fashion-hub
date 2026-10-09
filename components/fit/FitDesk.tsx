"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Measurement = {
  definition: string;
  name: string;
  canonicalCm: string;
  source: string;
  verificationStatus: string;
};
type Profile = { id: string; name: string; measurements: Measurement[] };
type GarmentMeasurement = {
  definition: string;
  value: string;
  enteredUnit: string;
  sizeLabel: string | null;
  provenance: string;
};
type Garment = {
  id: string;
  name: string;
  garmentType: { slug: string; name: string } | null;
  sizeLabels: { system: string; label: string }[];
  measurements: GarmentMeasurement[];
};
type Comparison = {
  label: string;
  bodyDefinition: string;
  garmentDefinition: string;
  bodyCm: string;
  garmentCm: string;
  differenceCm: string;
  bodySource: string;
  bodyVerification: string;
  garmentProvenance: string;
  size: { system: string; label: string } | null;
};
type Note = { kind: string; message: string };
type Analysis = {
  id: string;
  classification: string;
  summary: string;
  easeApplied: boolean;
  fitGuarantee: boolean;
  comparisons: Comparison[];
  notes: Note[];
  dimensionalProximity: { size: { label: string }; message: string } | null;
};
type Rules = { id: string; easeRuleCount: number; mappings: { bodyDefinition: string; garmentDefinition: string; label: string }[] };

const classificationLabel: Record<string, string> = {
  potentially_compatible: "Potentially compatible",
  potentially_restrictive: "Potentially restrictive",
  potentially_loose: "Potentially loose",
  mixed: "Mixed dimensional compatibility",
  insufficient_data: "Insufficient data",
  unsupported_garment: "Unsupported garment category",
  requires_verification: "Requires verification",
};

const sourceLabel: Record<string, string> = {
  user_entered: "Entered by you",
  tailor_recorded: "Recorded by a tailor",
  professionally_verified: "Professionally verified",
  imported: "Imported",
  ai_estimated: "AI estimate",
};

export function FitDesk() {
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [rules, setRules] = useState<Rules | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [garments, setGarments] = useState<Garment[]>([]);
  const [profileId, setProfileId] = useState("");
  const [garmentId, setGarmentId] = useState("");
  const [sizeKey, setSizeKey] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const profile = profiles.find((item) => item.id === profileId) ?? null;
  const garment = garments.find((item) => item.id === garmentId) ?? null;

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

  async function refresh() {
    setLoading(true);
    setNotice("");
    const [ruleResponse, profileResponse, garmentResponse] = await Promise.all([
      fetch("/api/v1/fit/rules"),
      fetch("/api/v1/measurements/profiles"),
      fetch("/api/v1/catalog/garments"),
    ]);
    setLoading(false);
    if (!ruleResponse.ok || !profileResponse.ok || !garmentResponse.ok) {
      setNotice("Fit inputs could not be loaded.");
      return;
    }
    const ruleBody = (await ruleResponse.json()) as { rules: Rules };
    const profileBody = (await profileResponse.json()) as { profiles: Profile[] };
    const garmentBody = (await garmentResponse.json()) as { garments: Garment[] };
    setRules(ruleBody.rules);
    setProfiles(profileBody.profiles);
    setGarments(garmentBody.garments);
    setProfileId((current) => current || profileBody.profiles[0]?.id || "");
    setGarmentId((current) => current || garmentBody.garments[0]?.id || "");
  }

  async function compare(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!profileId || !garmentId) return;
    setNotice("");
    setAnalysis(null);
    const size = garment?.sizeLabels.find((label) => `${label.system}:${label.label}` === sizeKey);
    const response = await fetch("/api/v1/fit/analyses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profileId,
        garmentId,
        ...(size ? { size: { system: size.system, label: size.label } } : {}),
      }),
    });
    const body = (await response.json()) as { analysis?: Analysis; error?: { message: string } };
    if (!response.ok || !body.analysis) {
      setNotice(body.error?.message ?? "The comparison could not be saved.");
      return;
    }
    setAnalysis(body.analysis);
  }

  if (!ready) {
    return (
      <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-8 px-5 py-10">
        <h1 className="font-editorial text-4xl text-ink">Fit</h1>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-8 px-5 py-10">
      <header className="flex items-end justify-between gap-4 border-b border-ink/15 pb-4">
        <div>
          <p className="text-xs tracking-[0.18em] text-muted uppercase">Bop</p>
          <h1 className="font-editorial text-4xl text-ink">Fit</h1>
        </div>
        <nav className="flex gap-4 text-sm">
          <Link className="text-ink underline" href="/measure">
            Measurements
          </Link>
          <Link className="text-ink underline" href="/style">
            Style
          </Link>
          <Link className="text-ink underline" href="/">
            Landing
          </Link>
        </nav>
      </header>
      <p className="max-w-2xl text-sm leading-6 text-muted">
        This workspace compares stored body measurements with stored garment dimensions. A difference is not a prediction of
        how the garment will fit on a body. No ease allowance is applied.
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
            <input
              className="border border-ink/20 bg-paper px-3 py-2"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button className="bg-ink px-4 py-2 text-sm text-ivory" type="button" onClick={(event) => void signIn(event)}>
            Sign in
          </button>
        </form>
      )}
      {signedIn && loading ? <p className="text-sm text-muted">Loading profiles and garments.</p> : null}
      {signedIn && !loading && profiles.length === 0 ? (
        <p className="text-sm text-muted">No measurement profile is available. Record one before comparing dimensions.</p>
      ) : null}
      {signedIn && !loading && garments.length === 0 ? (
        <p className="text-sm text-muted">No catalog garment is available. A comparison needs a garment with stated dimensions.</p>
      ) : null}
      {signedIn && profile && garment ? (
        <form className="grid gap-6" onSubmit={(event) => void compare(event)}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              Measurement profile
              <select
                className="border border-ink/20 bg-paper px-3 py-2"
                value={profileId}
                onChange={(event) => {
                  setProfileId(event.target.value);
                  setAnalysis(null);
                }}
              >
                {profiles.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Garment
              <select
                className="border border-ink/20 bg-paper px-3 py-2"
                value={garmentId}
                onChange={(event) => {
                  setGarmentId(event.target.value);
                  setSizeKey("");
                  setAnalysis(null);
                }}
              >
                {garments.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {garment.sizeLabels.length > 0 ? (
            <label className="grid max-w-md gap-1 text-sm">
              Size label
              <select className="border border-ink/20 bg-paper px-3 py-2" value={sizeKey} onChange={(event) => setSizeKey(event.target.value)}>
                <option value="">All recorded sizes</option>
                {garment.sizeLabels.map((label) => (
                  <option key={`${label.system}:${label.label}`} value={`${label.system}:${label.label}`}>
                    {label.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="text-sm text-muted">This garment has no size label. Only unsized dimensions can be compared.</p>
          )}
          <Review profile={profile} garment={garment} rules={rules} sizeKey={sizeKey} />
          <button className="w-fit border border-ink px-3 py-2 text-sm" type="submit">
            Compare dimensions
          </button>
        </form>
      ) : null}
      {analysis ? <Result analysis={analysis} /> : null}
    </main>
  );
}

function Review({ profile, garment, rules, sizeKey }: { profile: Profile; garment: Garment; rules: Rules | null; sizeKey: string }) {
  const mappings = rules?.mappings ?? [];
  const selectedLabel = sizeKey.split(":")[1] ?? "";
  const garmentRows = garment.measurements.filter((item) => (selectedLabel ? item.sizeLabel === selectedLabel : true));
  const rows = mappings.map((mapping) => {
    const body = profile.measurements.find((item) => item.definition === mapping.bodyDefinition);
    const garmentDimension = garmentRows.find((item) => item.definition === mapping.garmentDefinition);
    return { mapping, body, garmentDimension };
  });
  const comparable = rows.filter((row) => row.body && row.garmentDimension);
  return (
    <section className="grid gap-3 border border-ink/15 p-4">
      <h2 className="text-sm tracking-[0.14em] uppercase">Inputs</h2>
      <p className="text-sm text-muted">
        {garment.garmentType ? garment.garmentType.name : "No garment category"} · Rule set {rules?.id ?? "fit-rules.v1"} ·{" "}
        {rules?.easeRuleCount ?? 0} ease rules · Units are stored centimetres
      </p>
      {profile.measurements.length === 0 ? <p className="text-sm text-muted">This profile has no current body measurements.</p> : null}
      {garment.measurements.length === 0 ? <p className="text-sm text-muted">This garment has no stated dimensions.</p> : null}
      <ul className="grid gap-2 text-sm">
        {profile.measurements.map((item) => (
          <li key={item.definition}>
            {item.name}: {item.canonicalCm} cm · {sourceLabel[item.source] ?? item.source} · {item.verificationStatus}
          </li>
        ))}
      </ul>
      <ul className="grid gap-2 text-sm">
        {garmentRows.map((item) => (
          <li key={`${item.definition}:${item.sizeLabel ?? "none"}`}>
            {item.definition}
            {item.sizeLabel ? ` (${item.sizeLabel})` : ""}: {item.value} cm · {item.provenance}
          </li>
        ))}
      </ul>
      {comparable.length === 0 ? (
        <p className="text-sm text-muted">No mapped body measurement and garment dimension are both present.</p>
      ) : (
        <p className="text-sm text-muted">{comparable.map((row) => row.mapping.label).join(", ")} can be compared.</p>
      )}
    </section>
  );
}

function Result({ analysis }: { analysis: Analysis }) {
  return (
    <section className="grid gap-4">
      <div>
        <p className="text-xs tracking-[0.18em] text-muted uppercase">Result</p>
        <h2 className="font-editorial text-3xl text-ink">{classificationLabel[analysis.classification] ?? analysis.classification}</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6">{analysis.summary}</p>
      </div>
      <p className="text-sm text-muted">
        Ease applied: {analysis.easeApplied ? "yes" : "no"}. Physical fit guaranteed: {analysis.fitGuarantee ? "yes" : "no"}.
      </p>
      {analysis.comparisons.length === 0 ? <p className="text-sm text-muted">No dimension pair was stored.</p> : null}
      <ul className="grid gap-3">
        {analysis.comparisons.map((item) => (
          <li key={`${item.bodyDefinition}:${item.size?.label ?? "none"}`} className="border border-ink/15 p-3 text-sm">
            <p className="font-medium">
              {item.label}
              {item.size ? ` · ${item.size.label}` : ""}
            </p>
            <p>
              Body {item.bodyCm} cm · Garment {item.garmentCm} cm · Difference {item.differenceCm} cm
            </p>
            <p className="text-muted">
              {sourceLabel[item.bodySource] ?? item.bodySource} · {item.bodyVerification} · garment {item.garmentProvenance}
            </p>
          </li>
        ))}
      </ul>
      {analysis.dimensionalProximity ? <p className="text-sm">{analysis.dimensionalProximity.message}</p> : null}
      <ul className="grid gap-2 text-sm text-muted">
        {analysis.notes.map((note) => (
          <li key={note.message}>{note.message}</li>
        ))}
      </ul>
    </section>
  );
}
