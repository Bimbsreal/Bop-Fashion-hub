"use client";

import { useEffect, useState } from "react";
import { prepareGarment } from "@/lib/catalog-form";

type Garment = {
  id: string;
  name: string;
  visibility: string;
  garmentType: { name: string; slug: string } | null;
};

export function CatalogDesk() {
  const [signedIn, setSignedIn] = useState(false);
  const [garments, setGarments] = useState<Garment[] | null>(null);
  const [typeDraft, setTypeDraft] = useState("");
  const [typeSlug, setTypeSlug] = useState("");
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState("private");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void refresh(typeSlug, () => cancelled).then((result) => {
      if (cancelled || !result) return;
      setSignedIn(result.signedIn);
      setGarments(result.garments);
      if (result.notice) setNotice(result.notice);
    });
    return () => {
      cancelled = true;
    };
  }, [typeSlug]);

  async function createGarment() {
    setNotice("");
    const prepared = prepareGarment({ name, visibility, typeSlug });
    if (!prepared.ok) {
      setNotice(prepared.message);
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/v1/catalog/garments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(prepared.body),
      });
      const body = (await response.json()) as { error?: { message: string } };
      if (!response.ok) {
        setNotice(body.error?.message ?? "The garment could not be saved.");
        return;
      }
      setName("");
      const result = await refresh(typeSlug, () => false);
      if (result) setGarments(result.garments);
      setNotice("Garment saved.");
    } catch {
      setNotice("The catalog service is unavailable.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-8 px-5 py-10">
      <header className="border-b border-ink/15 pb-4">
        <h1 className="font-editorial text-4xl text-ink">Catalog</h1>
      </header>
      <p className="max-w-2xl text-sm leading-6 text-muted">
        These are garments the catalog already stores. A private garment appears only to its owner. This list is not a shop inventory count.
      </p>
      {notice ? <p className="text-sm text-clay">{notice}</p> : null}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setTypeSlug(typeDraft.trim());
        }}
      >
        <label className="grid gap-1 text-sm">
          Garment type slug
          <input className="border border-ink/20 bg-paper px-3 py-2" value={typeDraft} onChange={(event) => setTypeDraft(event.target.value)} />
        </label>
        <button className="border border-ink px-3 py-2 text-sm" type="submit">
          Apply
        </button>
      </form>
      {garments === null ? <p className="text-sm text-muted">Loading garments.</p> : null}
      {garments && garments.length === 0 ? <p className="text-sm text-muted">No garments match this view.</p> : null}
      {garments && garments.length > 0 ? (
        <ul className="grid gap-3">
          {garments.map((garment) => (
            <li key={garment.id} className="border border-ink/15 p-3">
              <p className="font-editorial text-2xl text-ink">{garment.name}</p>
              <p className="text-sm text-muted">
                {garment.garmentType?.name ?? "No garment type"} · {garment.visibility}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {signedIn ? (
        <form
          className="grid max-w-md gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void createGarment();
          }}
        >
          <h2 className="text-sm tracking-[0.14em] uppercase">New garment</h2>
          <label className="grid gap-1 text-sm">
            Name
            <input className="border border-ink/20 bg-paper px-3 py-2" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm">
            Visibility
            <select className="border border-ink/20 bg-paper px-3 py-2" value={visibility} onChange={(event) => setVisibility(event.target.value)}>
              <option value="private">private</option>
              <option value="public">public</option>
            </select>
          </label>
          <button className="w-fit border border-ink px-4 py-2 text-sm" type="submit" disabled={pending}>
            Save garment
          </button>
        </form>
      ) : (
        <p className="text-sm text-muted">Sign in on Account to save a garment.</p>
      )}
    </main>
  );
}

async function refresh(typeSlug: string, cancelled: () => boolean) {
  try {
    const session = await fetch("/api/v1/auth/session");
    const query = typeSlug.trim() ? `?type=${encodeURIComponent(typeSlug.trim())}` : "";
    const response = await fetch(`/api/v1/catalog/garments${query}`);
    if (cancelled()) return null;
    const body = (await response.json()) as { garments?: Garment[]; error?: { message: string } };
    if (!response.ok || !body.garments) {
      return { signedIn: session.ok, garments: [] as Garment[], notice: body.error?.message ?? "The catalog could not be loaded." };
    }
    return { signedIn: session.ok, garments: body.garments, notice: "" };
  } catch {
    if (cancelled()) return null;
    return { signedIn: false, garments: [] as Garment[], notice: "The catalog service is unavailable." };
  }
}
