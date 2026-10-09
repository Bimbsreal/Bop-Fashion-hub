"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Term = { kind: string; slug: string; name: string };
type Preference = { polarity: "preferred" | "disliked"; kind: string; slug: string; name: string };
type Garment = { id: string; name: string; garmentType: { slug: string; name: string } | null; terms: Term[] };
type Item = { garmentId: string; role: string; available: boolean; name: string | null; terms: Term[]; mediaId: string | null };
type Note = { kind: string; message: string };
type Recommendation = { id: string; ruleMatchCount: number; rejected: boolean; items: Item[]; notes: Note[]; rankingMeaning: string };
type Session = { id: string; status: string; summary: string; notes: Note[]; recommendations: Recommendation[]; fashionQualityScore: boolean };
type Outfit = { id: string; name: string; notes: string; preview: string; items: Item[] };
type Alternative = { garmentId: string; name: string; notes: Note[] };

const roleForType: Record<string, string> = {
  shirt: "top",
  trousers: "bottom",
  skirt: "bottom",
  jacket: "outerwear",
  dress: "one_piece",
  gown: "one_piece",
  kaftan: "one_piece",
  agbada: "one_piece",
};

export function StyleDesk() {
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [terms, setTerms] = useState<Record<string, Term[]>>({});
  const [occasionVocabulary, setOccasionVocabulary] = useState("empty");
  const [preferences, setPreferences] = useState<Preference[]>([]);
  const [notes, setNotes] = useState("");
  const [garments, setGarments] = useState<Garment[]>([]);
  const [wardrobeIds, setWardrobeIds] = useState<string[]>([]);
  const [styleSlug, setStyleSlug] = useState("");
  const [anchorId, setAnchorId] = useState("");
  const [source, setSource] = useState("catalog");
  const [session, setSession] = useState<Session | null>(null);
  const [outfits, setOutfits] = useState<Outfit[]>([]);
  const [outfitName, setOutfitName] = useState("");
  const [builderGarmentId, setBuilderGarmentId] = useState("");
  const [activeOutfit, setActiveOutfit] = useState<Outfit | null>(null);
  const [alternatives, setAlternatives] = useState<Alternative[]>([]);

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

  async function refresh() {
    setLoading(true);
    setNotice("");
    const [vocabularyResponse, profileResponse, garmentResponse, wardrobeResponse, outfitResponse] = await Promise.all([
      fetch("/api/v1/style/vocabulary"),
      fetch("/api/v1/style/profile"),
      fetch("/api/v1/catalog/garments"),
      fetch("/api/v1/style/wardrobe"),
      fetch("/api/v1/style/outfits"),
    ]);
    setLoading(false);
    if (!vocabularyResponse.ok || !profileResponse.ok || !garmentResponse.ok || !wardrobeResponse.ok || !outfitResponse.ok) {
      setNotice("Styling could not be loaded.");
      return;
    }
    const vocabulary = (await vocabularyResponse.json()) as { vocabulary: { terms: Record<string, Term[]>; occasionVocabulary: string } };
    const profile = (await profileResponse.json()) as { profile: { notes: string; preferences: Preference[] } };
    const catalog = (await garmentResponse.json()) as { garments: Garment[] };
    const wardrobe = (await wardrobeResponse.json()) as { wardrobe: { items: Item[] } };
    const saved = (await outfitResponse.json()) as { outfits: Outfit[] };
    setTerms(vocabulary.vocabulary.terms);
    setOccasionVocabulary(vocabulary.vocabulary.occasionVocabulary);
    setNotes(profile.profile.notes);
    setPreferences(profile.profile.preferences);
    setGarments(catalog.garments);
    setWardrobeIds(wardrobe.wardrobe.items.map((item) => item.garmentId));
    setOutfits(saved.outfits);
    setBuilderGarmentId((current) => current || catalog.garments[0]?.id || "");
  }

  function togglePreferred(term: Term) {
    setPreferences((current) => {
      const exists = current.some((item) => item.polarity === "preferred" && item.kind === term.kind && item.slug === term.slug);
      const without = current.filter((item) => !(item.kind === term.kind && item.slug === term.slug));
      return exists ? without : [...without, { polarity: "preferred", kind: term.kind, slug: term.slug, name: term.name }];
    });
  }

  async function savePreferences(event: { preventDefault(): void }) {
    event.preventDefault();
    setNotice("");
    const response = await fetch("/api/v1/style/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        notes,
        preferences: preferences.map((item) => ({ polarity: item.polarity, kind: item.kind, slug: item.slug })),
      }),
    });
    const body = (await response.json()) as { error?: { message: string } };
    if (!response.ok) {
      setNotice(body.error?.message ?? "Preferences could not be saved.");
      return;
    }
    await refresh();
  }

  async function clearPreferences() {
    setNotice("");
    const response = await fetch("/api/v1/style/profile", { method: "DELETE" });
    if (!response.ok) {
      setNotice("Preferences could not be cleared.");
      return;
    }
    setPreferences([]);
    setNotes("");
    await refresh();
  }

  async function requestRecommendations(event: { preventDefault(): void }) {
    event.preventDefault();
    setNotice("");
    setSession(null);
    const response = await fetch("/api/v1/style/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(styleSlug ? { style: styleSlug } : {}),
        ...(anchorId ? { anchorGarmentId: anchorId } : {}),
        source,
      }),
    });
    const body = (await response.json()) as { session?: Session; error?: { message: string } };
    if (!response.ok || !body.session) {
      setNotice(body.error?.message ?? "The recommendation could not be made.");
      return;
    }
    setSession(body.session);
  }

  async function reject(recommendationId: string) {
    if (!session) return;
    const response = await fetch(`/api/v1/style/sessions/${session.id}/recommendations/${recommendationId}/reject`, { method: "POST" });
    const body = (await response.json()) as { session?: Session; error?: { message: string } };
    if (!response.ok || !body.session) {
      setNotice(body.error?.message ?? "That suggestion could not be rejected.");
      return;
    }
    setSession(body.session);
  }

  async function saveSuggestion(recommendationId: string) {
    if (!session) return;
    const response = await fetch(`/api/v1/style/sessions/${session.id}/recommendations/${recommendationId}/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: outfitName.trim() || "Saved outfit" }),
    });
    const body = (await response.json()) as { error?: { message: string } };
    if (!response.ok) {
      setNotice(body.error?.message ?? "That outfit could not be saved.");
      return;
    }
    await refresh();
  }

  async function createOutfit(event: { preventDefault(): void }) {
    event.preventDefault();
    setNotice("");
    const garment = garments.find((item) => item.id === builderGarmentId);
    const role = roleForType[garment?.garmentType?.slug ?? ""];
    const response = await fetch("/api/v1/style/outfits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: outfitName.trim() || "Outfit board",
        items: garment && role ? [{ garmentId: garment.id, role }] : [],
      }),
    });
    const body = (await response.json()) as { outfit?: Outfit; error?: { message: string } };
    if (!response.ok || !body.outfit) {
      setNotice(body.error?.message ?? "The outfit could not be created.");
      return;
    }
    setActiveOutfit(body.outfit);
    await refresh();
  }

  async function replaceItem(garmentId: string) {
    if (!activeOutfit) return;
    const garment = garments.find((item) => item.id === garmentId);
    const role = roleForType[garment?.garmentType?.slug ?? ""];
    if (!role) {
      setNotice("That garment type has no outfit place.");
      return;
    }
    const response = await fetch(`/api/v1/style/outfits/${activeOutfit.id}/items`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ garmentId, role }),
    });
    const body = (await response.json()) as { outfit?: Outfit; error?: { message: string } };
    if (!response.ok || !body.outfit) {
      setNotice(body.error?.message ?? "That item could not be added.");
      return;
    }
    setActiveOutfit(body.outfit);
    setAlternatives([]);
  }

  async function removeItem(role: string) {
    if (!activeOutfit) return;
    const response = await fetch(`/api/v1/style/outfits/${activeOutfit.id}/items/${role}`, { method: "DELETE" });
    const body = (await response.json()) as { outfit?: Outfit; error?: { message: string } };
    if (!response.ok || !body.outfit) {
      setNotice(body.error?.message ?? "That item could not be removed.");
      return;
    }
    setActiveOutfit(body.outfit);
  }

  async function loadAlternatives(role: string) {
    if (!activeOutfit) return;
    setNotice("");
    const response = await fetch(`/api/v1/style/outfits/${activeOutfit.id}/alternatives?role=${encodeURIComponent(role)}`);
    const body = (await response.json()) as { alternatives?: Alternative[]; error?: { message: string } };
    if (!response.ok || !body.alternatives) {
      setNotice(body.error?.message ?? "Alternatives could not be loaded.");
      return;
    }
    setAlternatives(body.alternatives);
  }

  async function toggleWardrobe(garmentId: string) {
    setNotice("");
    const saved = wardrobeIds.includes(garmentId);
    const response = await fetch(saved ? `/api/v1/style/wardrobe/${garmentId}` : "/api/v1/style/wardrobe", {
      method: saved ? "DELETE" : "POST",
      ...(saved ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify({ garmentId }) }),
    });
    if (!response.ok) {
      setNotice("The wardrobe list could not be updated.");
      return;
    }
    await refresh();
  }

  if (!ready) {
    return (
      <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-8 px-5 py-10">
        <h1 className="font-editorial text-4xl text-ink">Style</h1>
      </main>
    );
  }

  const styleTerms = terms.style ?? [];
  const colorTerms = terms.color ?? [];
  const materialTerms = terms.material ?? [];

  return (
    <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-8 px-5 py-10">
      <header className="flex items-end justify-between gap-4 border-b border-ink/15 pb-4">
        <div>
          <p className="text-xs tracking-[0.18em] text-muted uppercase">Bop</p>
          <h1 className="font-editorial text-4xl text-ink">Style</h1>
        </div>
        <nav className="flex gap-4 text-sm">
          <Link className="text-ink underline" href="/fit">
            Fit
          </Link>
          <Link className="text-ink underline" href="/commerce">
            Commerce
          </Link>
          <Link className="text-ink underline" href="/">
            Landing
          </Link>
        </nav>
      </header>
      <p className="max-w-2xl text-sm leading-6 text-muted">
        Outfits are assembled from catalog tags you can read. A suggestion explains the rule that matched. It is not a judgment
        of taste, culture, or who should wear a garment.
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
      {signedIn && loading ? <p className="text-sm text-muted">Loading catalog tags and garments.</p> : null}
      {signedIn && !loading ? (
        <div className="grid gap-8">
          <form className="grid gap-4" onSubmit={(event) => void savePreferences(event)}>
            <h2 className="text-sm tracking-[0.14em] uppercase">Preferences</h2>
            <p className="text-sm text-muted">Preferences are optional. Leave them empty and recommendations will not claim a personal match.</p>
            {occasionVocabulary === "empty" ? (
              <p className="text-sm text-muted">No occasion vocabulary is seeded, so occasion suitability cannot be selected.</p>
            ) : null}
            <PreferenceGroup label="Styles" terms={styleTerms} preferences={preferences} onToggle={togglePreferred} />
            <PreferenceGroup label="Colors" terms={colorTerms} preferences={preferences} onToggle={togglePreferred} />
            <PreferenceGroup label="Materials" terms={materialTerms} preferences={preferences} onToggle={togglePreferred} />
            <label className="grid gap-1 text-sm">
              Notes
              <input className="border border-ink/20 bg-paper px-3 py-2" value={notes} onChange={(event) => setNotes(event.target.value)} />
            </label>
            <div className="flex gap-3">
              <button className="border border-ink px-3 py-2 text-sm" type="submit">
                Save preferences
              </button>
              <button className="px-3 py-2 text-sm underline" type="button" onClick={() => void clearPreferences()}>
                Clear preferences
              </button>
            </div>
          </form>
          <form className="grid gap-4" onSubmit={(event) => void requestRecommendations(event)}>
            <h2 className="text-sm tracking-[0.14em] uppercase">Recommendation</h2>
            {garments.length === 0 ? <p className="text-sm text-muted">No readable garments are in the catalog.</p> : null}
            <label className="grid gap-1 text-sm">
              Style tag
              <select className="border border-ink/20 bg-paper px-3 py-2" value={styleSlug} onChange={(event) => setStyleSlug(event.target.value)}>
                <option value="">No style requested</option>
                {styleTerms.map((term) => (
                  <option key={term.slug} value={term.slug}>
                    {term.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Starting garment
              <select className="border border-ink/20 bg-paper px-3 py-2" value={anchorId} onChange={(event) => setAnchorId(event.target.value)}>
                <option value="">None</option>
                {garments.map((garment) => (
                  <option key={garment.id} value={garment.id}>
                    {garment.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Source
              <select className="border border-ink/20 bg-paper px-3 py-2" value={source} onChange={(event) => setSource(event.target.value)}>
                <option value="catalog">Catalog</option>
                <option value="wardrobe">Wardrobe list</option>
              </select>
            </label>
            {source === "wardrobe" && wardrobeIds.length === 0 ? (
              <p className="text-sm text-muted">Your wardrobe list is empty. Adding a garment here does not record a purchase.</p>
            ) : null}
            <button className="w-fit border border-ink px-3 py-2 text-sm" type="submit">
              Assemble outfits
            </button>
          </form>
          {session ? <SessionView session={session} onReject={reject} onSave={saveSuggestion} /> : null}
          <section className="grid gap-3">
            <h2 className="text-sm tracking-[0.14em] uppercase">Wardrobe list</h2>
            {garments.length === 0 ? <p className="text-sm text-muted">No catalog garments to add.</p> : null}
            <ul className="grid gap-2 text-sm">
              {garments.map((garment) => (
                <li key={garment.id} className="flex items-center justify-between gap-3 border border-ink/15 px-3 py-2">
                  <span>
                    {garment.name}
                    <span className="text-muted"> · {garment.garmentType?.name ?? "No type"}</span>
                  </span>
                  <button className="underline" type="button" onClick={() => void toggleWardrobe(garment.id)}>
                    {wardrobeIds.includes(garment.id) ? "Remove from list" : "Add to list"}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <form className="grid gap-3" onSubmit={(event) => void createOutfit(event)}>
            <h2 className="text-sm tracking-[0.14em] uppercase">Outfit board</h2>
            <p className="text-sm text-muted">This board places separate catalog records side by side. It is not a photograph of the garments worn together.</p>
            <label className="grid gap-1 text-sm">
              Outfit name
              <input className="border border-ink/20 bg-paper px-3 py-2" value={outfitName} onChange={(event) => setOutfitName(event.target.value)} />
            </label>
            <label className="grid gap-1 text-sm">
              First garment
              <select className="border border-ink/20 bg-paper px-3 py-2" value={builderGarmentId} onChange={(event) => setBuilderGarmentId(event.target.value)}>
                {garments.map((garment) => (
                  <option key={garment.id} value={garment.id}>
                    {garment.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="w-fit border border-ink px-3 py-2 text-sm" type="submit">
              Create outfit
            </button>
          </form>
          {outfits.length === 0 ? <p className="text-sm text-muted">No saved outfits.</p> : null}
          {outfits.length > 0 ? (
            <label className="grid gap-1 text-sm">
              Saved outfits
              <select
                className="border border-ink/20 bg-paper px-3 py-2"
                value={activeOutfit?.id ?? ""}
                onChange={(event) => setActiveOutfit(outfits.find((item) => item.id === event.target.value) ?? null)}
              >
                <option value="">Choose an outfit</option>
                {outfits.map((outfit) => (
                  <option key={outfit.id} value={outfit.id}>
                    {outfit.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {activeOutfit ? (
            <OutfitBoard
              outfit={activeOutfit}
              garments={garments}
              alternatives={alternatives}
              onReplace={replaceItem}
              onRemove={removeItem}
              onAlternatives={loadAlternatives}
            />
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

function PreferenceGroup({
  label,
  terms,
  preferences,
  onToggle,
}: {
  label: string;
  terms: Term[];
  preferences: Preference[];
  onToggle: (term: Term) => void;
}) {
  if (terms.length === 0) return <p className="text-sm text-muted">No {label.toLowerCase()} are seeded.</p>;
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm">{label}</legend>
      <div className="flex flex-wrap gap-3 text-sm">
        {terms.map((term) => {
          const checked = preferences.some((item) => item.polarity === "preferred" && item.slug === term.slug && item.kind === term.kind);
          return (
            <label key={`${term.kind}:${term.slug}`} className="flex items-center gap-2">
              <input type="checkbox" checked={checked} onChange={() => onToggle(term)} />
              {term.name}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function SessionView({
  session,
  onReject,
  onSave,
}: {
  session: Session;
  onReject: (id: string) => void;
  onSave: (id: string) => void;
}) {
  return (
    <section className="grid gap-4">
      <h2 className="font-editorial text-3xl text-ink">{session.status === "insufficient_data" ? "Insufficient data" : "Suggestions"}</h2>
      <p className="text-sm leading-6">{session.summary}</p>
      <ul className="grid gap-1 text-sm text-muted">
        {session.notes.map((note) => (
          <li key={note.message}>{note.message}</li>
        ))}
      </ul>
      {session.recommendations.length === 0 ? <p className="text-sm text-muted">No outfit was assembled.</p> : null}
      {session.recommendations.map((recommendation) => (
        <article key={recommendation.id} className="grid gap-2 border border-ink/15 p-3 text-sm">
          <p>
            {recommendation.items.map((item) => item.name ?? "Unavailable garment").join(" · ")}
          </p>
          <p className="text-muted">
            {recommendation.ruleMatchCount} documented rule matches. {recommendation.rankingMeaning}
          </p>
          <ul className="grid gap-1 text-muted">
            {recommendation.notes.map((note) => (
              <li key={note.message}>{note.message}</li>
            ))}
          </ul>
          <div className="flex gap-3">
            <button className="underline" type="button" onClick={() => onSave(recommendation.id)}>
              Save outfit
            </button>
            <button className="underline" type="button" disabled={recommendation.rejected} onClick={() => onReject(recommendation.id)}>
              {recommendation.rejected ? "Rejected" : "Reject"}
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

function OutfitBoard({
  outfit,
  garments,
  alternatives,
  onReplace,
  onRemove,
  onAlternatives,
}: {
  outfit: Outfit;
  garments: Garment[];
  alternatives: Alternative[];
  onReplace: (garmentId: string) => void;
  onRemove: (role: string) => void;
  onAlternatives: (role: string) => void;
}) {
  return (
    <section className="grid gap-3 border border-ink/15 p-4">
      <h2 className="font-editorial text-3xl text-ink">{outfit.name}</h2>
      <p className="text-sm text-muted">Catalog outfit board. These are separate garment records, not one worn look.</p>
      {outfit.items.length === 0 ? <p className="text-sm text-muted">This outfit has no items.</p> : null}
      <ul className="grid gap-2 text-sm">
        {outfit.items.map((item) => (
          <li key={item.role} className="flex items-center justify-between gap-3">
            <span>
              {item.role}: {item.available ? item.name : "No longer readable"}
            </span>
            <span className="flex gap-3">
              <button className="underline" type="button" onClick={() => onAlternatives(item.role)}>
                Alternatives
              </button>
              <button className="underline" type="button" onClick={() => onRemove(item.role)}>
                Remove
              </button>
            </span>
          </li>
        ))}
      </ul>
      <label className="grid gap-1 text-sm">
        Add or replace
        <select className="border border-ink/20 bg-paper px-3 py-2" defaultValue="" onChange={(event) => event.target.value && onReplace(event.target.value)}>
          <option value="">Choose a garment</option>
          {garments.map((garment) => (
            <option key={garment.id} value={garment.id}>
              {garment.name}
            </option>
          ))}
        </select>
      </label>
      {alternatives.length === 0 ? null : (
        <ul className="grid gap-2 text-sm">
          {alternatives.map((item) => (
            <li key={item.garmentId}>
              <button className="underline" type="button" onClick={() => onReplace(item.garmentId)}>
                {item.name}
              </button>
              <span className="text-muted"> — {item.notes[0]?.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
