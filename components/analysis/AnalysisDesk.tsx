"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

type Attribute = {
  key: string;
  value: string | number | string[] | null;
  basis: string;
  note: string;
  confidence: number | null;
  reviewStatus: string;
  fiberEstablished: boolean;
};

type Analysis = {
  id: string;
  status: string;
  simulated: boolean;
  operational: boolean;
  summary: string | null;
  error: { message: string } | null;
  attributes: Attribute[];
};

type MediaItem = { id: string; originalFilename: string };
type GarmentItem = { id: string; name: string };

export function AnalysisDesk() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [notice, setNotice] = useState("");
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [garments, setGarments] = useState<GarmentItem[]>([]);
  const [mediaId, setMediaId] = useState("");
  const [garmentId, setGarmentId] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [correctionKey, setCorrectionKey] = useState("primary_type");
  const [correctionValue, setCorrectionValue] = useState("");
  const [correctionNote, setCorrectionNote] = useState("");
  const [ready, setReady] = useState(false);

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
    await refreshLists();
  }

  async function refreshLists() {
    const [mediaResponse, garmentResponse] = await Promise.all([
      fetch("/api/v1/media?limit=20"),
      fetch("/api/v1/catalog/garments?limit=20"),
    ]);
    if (mediaResponse.ok) {
      const body = (await mediaResponse.json()) as { media: MediaItem[] };
      setMedia(body.media);
      setMediaId(body.media[0]?.id ?? "");
    }
    if (garmentResponse.ok) {
      const body = (await garmentResponse.json()) as { garments: GarmentItem[] };
      setGarments(body.garments);
      setGarmentId(body.garments[0]?.id ?? "");
    }
  }

  async function upload(file: File) {
    setNotice("");
    const response = await fetch("/api/v1/media?visibility=private", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-original-filename": file.name },
      body: file,
    });
    if (!response.ok) {
      setNotice("The image was not accepted.");
      return;
    }
    await refreshLists();
  }

  async function startAnalysis() {
    setNotice("");
    const response = await fetch("/api/v1/analyses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mediaId }),
    });
    const body = (await response.json()) as { analysis?: Analysis; error?: { message: string } };
    if (!response.ok || !body.analysis) {
      setNotice(body.error?.message ?? "Analysis was not started.");
      return;
    }
    setAnalysis(body.analysis);
    if (body.analysis.status === "queued" || body.analysis.status === "running") {
      window.setTimeout(() => poll(body.analysis?.id ?? ""), 700);
    }
  }

  async function poll(id: string) {
    const response = await fetch(`/api/v1/analyses/${id}`);
    if (!response.ok) return;
    const body = (await response.json()) as { analysis: Analysis };
    setAnalysis(body.analysis);
    if (body.analysis.status === "queued" || body.analysis.status === "running") {
      window.setTimeout(() => poll(id), 700);
    }
  }

  async function review(key: string, decision: "accept" | "reject") {
    if (!analysis) return;
    const response = await fetch(`/api/v1/analyses/${analysis.id}/attributes/${key}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    if (!response.ok) {
      setNotice("That review was not saved.");
      return;
    }
    const body = (await response.json()) as { analysis: Analysis };
    setAnalysis(body.analysis);
  }

  async function correct(event: FormEvent) {
    event.preventDefault();
    if (!analysis) return;
    setNotice("");
    const response = await fetch(`/api/v1/analyses/${analysis.id}/attributes/${correctionKey}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "correct", value: correctionValue, basis: "inferred", note: correctionNote }),
    });
    const body = (await response.json()) as { analysis?: Analysis; error?: { message: string } };
    if (!response.ok || !body.analysis) {
      setNotice(body.error?.message ?? "That correction was not saved.");
      return;
    }
    setAnalysis(body.analysis);
  }

  async function apply() {
    if (!analysis || !garmentId) return;
    setNotice("");
    const response = await fetch(`/api/v1/analyses/${analysis.id}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ garmentId }),
    });
    const body = (await response.json()) as { analysis?: Analysis; error?: { message: string } };
    if (!response.ok || !body.analysis) {
      setNotice(body.error?.message ?? "The catalog was not changed.");
      return;
    }
    setAnalysis(body.analysis);
    setNotice("Accepted attributes were applied where the catalog was still empty.");
  }

  if (!ready) {
    return (
      <main className="mx-auto max-w-3xl px-5 py-10">
        <h1 className="font-editorial text-4xl text-ink">Image analysis</h1>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-8 px-5 py-10">
      <header className="flex items-end justify-between gap-4 border-b border-ink/15 pb-4">
        <div>
          <p className="text-xs tracking-[0.18em] text-muted uppercase">Bop</p>
          <h1 className="font-editorial text-4xl text-ink">Image analysis</h1>
        </div>
        <Link className="text-sm text-ink underline" href="/">
          Landing
        </Link>
      </header>
      <p className="max-w-2xl text-sm leading-6 text-muted">
        Submit one image you already own. A configured model is not connected. Simulated results are labeled and are not
        observations of the photograph. Nothing is written to a garment until you accept it.
      </p>
      {notice ? <p className="text-sm text-clay">{notice}</p> : null}
      {signedIn ? null : (
        <form className="grid max-w-md gap-3" onSubmit={signIn}>
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
        <section className="grid gap-4">
          <label className="grid gap-1 text-sm">
            Reference image
            <select className="border border-ink/20 bg-paper px-3 py-2" value={mediaId} onChange={(event) => setMediaId(event.target.value)}>
              {media.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.originalFilename || item.id}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Add an image
            <input
              className="mt-1 block"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
            />
          </label>
          <button className="w-fit bg-clay px-4 py-2 text-sm text-ivory" type="button" onClick={() => void startAnalysis()}>
            Analyze
          </button>
        </section>
      ) : null}
      {analysis ? (
        <section className="grid gap-4">
          <p className="text-sm">
            Status: {analysis.status}
            {analysis.simulated ? " · Simulated" : ""}
            {analysis.operational ? "" : " · Not operational"}
          </p>
          {analysis.summary ? <p className="text-sm text-muted">{analysis.summary}</p> : null}
          {analysis.error ? <p className="text-sm text-clay">{analysis.error.message}</p> : null}
          <ul className="divide-y divide-ink/10 border-y border-ink/10">
            {analysis.attributes.map((attribute) => (
              <li key={attribute.key} className="grid gap-2 py-3 text-sm sm:grid-cols-[1fr_auto]">
                <div>
                  <p className="font-medium">{attribute.key.replace(/_/g, " ")}</p>
                  <p className="text-muted">
                    {attribute.value === null ? "Not established" : String(attribute.value)} · {attribute.basis}
                    {attribute.confidence === null ? " · No provider confidence" : ` · Provider confidence ${attribute.confidence}`}
                    {attribute.key === "apparent_material" && attribute.fiberEstablished === false ? " · Fiber not established" : ""}
                  </p>
                  {attribute.note ? <p>{attribute.note}</p> : null}
                </div>
                <div className="flex gap-2">
                  <button className="border border-ink/20 px-2 py-1" type="button" onClick={() => void review(attribute.key, "accept")}>
                    Accept
                  </button>
                  <button className="border border-ink/20 px-2 py-1" type="button" onClick={() => void review(attribute.key, "reject")}>
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <form className="grid gap-2 border border-ink/15 p-3" onSubmit={correct}>
            <p className="text-sm font-medium">Correct an attribute</p>
            <select className="border border-ink/20 bg-paper px-3 py-2 text-sm" value={correctionKey} onChange={(event) => setCorrectionKey(event.target.value)}>
              {analysis.attributes.map((attribute) => (
                <option key={attribute.key} value={attribute.key}>
                  {attribute.key.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <input className="border border-ink/20 bg-paper px-3 py-2 text-sm" placeholder="Catalog slug" value={correctionValue} onChange={(event) => setCorrectionValue(event.target.value)} />
            <input className="border border-ink/20 bg-paper px-3 py-2 text-sm" placeholder="Why this value" value={correctionNote} onChange={(event) => setCorrectionNote(event.target.value)} />
            <button className="w-fit border border-ink px-3 py-2 text-sm" type="submit">
              Save correction
            </button>
          </form>
          <label className="grid gap-1 text-sm">
            Garment
            <select className="border border-ink/20 bg-paper px-3 py-2" value={garmentId} onChange={(event) => setGarmentId(event.target.value)}>
              {garments.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <button className="w-fit border border-ink px-4 py-2 text-sm" type="button" onClick={() => void apply()}>
            Apply accepted attributes
          </button>
        </section>
      ) : null}
    </main>
  );
}
