"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

type Capability = {
  operational: boolean;
  configured: boolean;
  supportedCategories: string[];
  message: string;
  input: { minEdge: number; formats: string[] };
};

type MediaItem = { id: string; originalFilename: string };
type GarmentItem = { id: string; name: string; media: { id: string; role: string }[] };

const blockedRoles = new Set(["sketch", "fabric", "generated", "construction"]);

function SourcePreview({ mediaId, label }: { mediaId: string; label: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <p className="text-sm text-muted">This image could not be loaded.</p>;
  return (
    <span className="relative block h-48 w-36 border border-ink/15 bg-sand">
      <Image
        fill
        unoptimized
        className="object-contain"
        alt={label}
        src={`/api/v1/media/${mediaId}/content`}
        onError={() => setBroken(true)}
      />
    </span>
  );
}

function roleLabel(role: string) {
  return blockedRoles.has(role) ? `${role} (not eligible)` : role;
}

type TryOnRequest = {
  id: string;
  status: string;
  operational: boolean;
  generated: boolean;
  fitClaim: boolean;
  output: null;
  message: string;
  garmentCategory: string;
  garmentPresentation: string;
};

export function TryOnDesk() {
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [notice, setNotice] = useState("");
  const [capability, setCapability] = useState<Capability | null>(null);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [garments, setGarments] = useState<GarmentItem[]>([]);
  const [personMediaId, setPersonMediaId] = useState("");
  const [garmentId, setGarmentId] = useState("");
  const [garmentMediaId, setGarmentMediaId] = useState("");
  const [presentation, setPresentation] = useState("catalog");
  const [consent, setConsent] = useState(false);
  const [requestView, setRequestView] = useState<TryOnRequest | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ready) return;
    void fetch("/api/v1/try-on/capability")
      .then((response) => response.json())
      .then((body: { capability?: Capability }) => {
        if (body.capability) setCapability(body.capability);
      })
      .catch(() => setNotice("Try-on requirements could not be loaded."));
  }, [ready]);

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

  async function refresh(selected?: { personMediaId?: string }) {
    const [mediaResponse, garmentResponse] = await Promise.all([
      fetch("/api/v1/media?limit=20"),
      fetch("/api/v1/catalog/garments?limit=20"),
    ]);
    if (!mediaResponse.ok || !garmentResponse.ok) {
      setNotice("Images and garments could not be loaded.");
      return;
    }
    const mediaBody = (await mediaResponse.json()) as { media: MediaItem[] };
    const garmentBody = (await garmentResponse.json()) as { garments: GarmentItem[] };
    setMedia(mediaBody.media);
    setPersonMediaId(selected?.personMediaId ?? mediaBody.media[0]?.id ?? "");
    setGarments(garmentBody.garments);
    const first = garmentBody.garments[0];
    setGarmentId(first?.id ?? "");
    setGarmentMediaId(first?.media[0]?.id ?? "");
  }

  function chooseGarment(id: string) {
    setGarmentId(id);
    const garment = garments.find((item) => item.id === id);
    setGarmentMediaId(garment?.media[0]?.id ?? "");
  }

  async function upload(file: File, kind: "person" | "garment") {
    setNotice("");
    const response = await fetch("/api/v1/media?visibility=private", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-original-filename": file.name },
      body: file,
    });
    const body = (await response.json()) as { media?: { id: string }; error?: { message: string } };
    if (!response.ok || !body.media) {
      setNotice(body.error?.message ?? "The image was not accepted.");
      return;
    }
    await refresh(kind === "person" ? { personMediaId: body.media.id } : undefined);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    setRequestView(null);
    if (!consent) {
      setNotice("Confirm this image may be used for this try-on request only.");
      return;
    }
    const response = await fetch("/api/v1/try-on", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        personMediaId,
        garmentId,
        garmentMediaId,
        garmentPresentation: presentation,
        consent: { purpose: "try_on_request" },
      }),
    });
    const body = (await response.json()) as { request?: TryOnRequest; error?: { message: string } };
    if (!response.ok || !body.request) {
      setNotice(body.error?.message ?? "The request was not saved.");
      return;
    }
    setRequestView(body.request);
  }

  if (!ready) {
    return (
      <main className="mx-auto max-w-3xl px-5 py-10">
        <h1 className="font-editorial text-4xl text-ink">Try on</h1>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-8 px-5 py-10">
      <header className="flex items-end justify-between gap-4 border-b border-ink/15 pb-4">
        <div>
          <p className="text-xs tracking-[0.18em] text-muted uppercase">Bop</p>
          <h1 className="font-editorial text-4xl text-ink">Try on</h1>
        </div>
        <nav className="flex gap-4 text-sm">
          <Link className="text-ink underline" href="/">
            Landing
          </Link>
          <Link className="text-ink underline" href="/visualize">
            Visualization
          </Link>
        </nav>
      </header>
      <p className="max-w-2xl text-sm leading-6 text-muted">
        {capability?.message ?? "Virtual try-on is not configured. No image was generated."} A recorded request is not a
        result. It is not a measurement of fit.
      </p>
      <ul className="grid gap-1 text-sm text-muted">
        <li>Use a JPEG, PNG, or WebP original you are allowed to process.</li>
        <li>The shorter side must be at least {capability?.input.minEdge ?? 256} pixels.</li>
        <li>Sketches, fabric swatches, construction drawings, and generated images are not garment inputs.</li>
        <li>Confirmation covers this request only. It does not allow model training.</li>
        {capability && capability.supportedCategories.length === 0 ? <li>No garment category is supported by a provider.</li> : null}
      </ul>
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
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <label className="grid gap-1 text-sm">
            Person image
            <select className="border border-ink/20 bg-paper px-3 py-2" value={personMediaId} onChange={(event) => setPersonMediaId(event.target.value)}>
              {media.length === 0 ? <option value="">No images yet</option> : null}
              {media.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.originalFilename || "Untitled image"}
                </option>
              ))}
            </select>
          </label>
          {personMediaId ? <SourcePreview mediaId={personMediaId} label="Selected person image" /> : null}
          <label className="text-sm">
            Upload a person image
            <input
              className="mt-1 block"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file, "person");
              }}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Garment
            <select className="border border-ink/20 bg-paper px-3 py-2" value={garmentId} onChange={(event) => chooseGarment(event.target.value)}>
              {garments.length === 0 ? <option value="">No garments yet</option> : null}
              {garments.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Garment image
            <select className="border border-ink/20 bg-paper px-3 py-2" value={garmentMediaId} onChange={(event) => setGarmentMediaId(event.target.value)}>
              {(garments.find((item) => item.id === garmentId)?.media ?? []).length === 0 ? <option value="">No garment image</option> : null}
              {(garments.find((item) => item.id === garmentId)?.media ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {roleLabel(item.role)}
                </option>
              ))}
            </select>
          </label>
          {garmentMediaId ? <SourcePreview mediaId={garmentMediaId} label="Selected garment image" /> : null}
          <label className="grid gap-1 text-sm">
            How the garment was photographed
            <select className="border border-ink/20 bg-paper px-3 py-2" value={presentation} onChange={(event) => setPresentation(event.target.value)}>
              <option value="catalog">Catalog photograph</option>
              <option value="flat_lay">Flat lay</option>
              <option value="mannequin">Mannequin</option>
              <option value="worn">Worn by a person</option>
            </select>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            I have permission to use the person image for this try-on request only.
          </label>
          <button className="w-fit border border-ink px-3 py-2 text-sm" type="submit">
            Record request
          </button>
          <p className="text-sm text-muted">Processing is not available. This does not generate an image.</p>
          {requestView ? (
            <div className="grid gap-2 border-t border-ink/15 pt-4 text-sm">
              <p>Status: {requestView.status}</p>
              <p>{requestView.message}</p>
              <p>Category: {requestView.garmentCategory}</p>
              <p>No result image. Nothing was compared, and fit was not measured.</p>
            </div>
          ) : null}
        </form>
      ) : null}
    </main>
  );
}
