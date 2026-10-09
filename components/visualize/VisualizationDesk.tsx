"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

type Summary = {
  id: string;
  title: string;
  status: string;
  method: string;
  access: string;
  generated: boolean;
  referenceCount: number;
  updatedAt: string;
  previewMediaId: string | null;
  designProjectName: string | null;
};

type Reference = {
  mediaId: string;
  position: number;
  origin: string;
  note: string;
  available: boolean;
  filename: string | null;
  status: string | null;
};

type Concept = {
  id: string;
  title: string;
  notes: string;
  status: string;
  method: string;
  access: string;
  generated: boolean;
  referenceCount: number;
  designProject: { id: string; name?: string; status?: string; available?: boolean } | null;
  revision: { id: string; revisionNumber?: number; available?: boolean } | null;
  garment: {
    id: string;
    name?: string;
    description?: string;
    available?: boolean;
    garmentType: { name: string } | null;
    terms: { kind: string; name: string }[];
  } | null;
  preview: { mediaId: string; origin: string; available: boolean; filename: string | null } | null;
  references: Reference[];
  updatedAt: string;
};

type Named = { id: string; name: string };
type MediaItem = { id: string; originalFilename: string };

const originLabel: Record<string, string> = {
  original_reference: "Original reference",
  manual_upload: "Uploaded variation",
  design_revision: "Design revision reference",
};

const methodLabel: Record<string, string> = {
  reference_board: "Reference board",
  concept_preview: "Concept preview",
  manual_variation: "Manual variation",
};

const statusLabel: Record<string, string> = {
  draft: "Draft",
  arranged: "Arranged",
  archived: "Archived",
};

export function VisualizationDesk() {
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [concepts, setConcepts] = useState<Summary[]>([]);
  const [concept, setConcept] = useState<Concept | null>(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [garments, setGarments] = useState<Named[]>([]);
  const [projects, setProjects] = useState<Named[]>([]);
  const [mediaId, setMediaId] = useState("");
  const [garmentId, setGarmentId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [broken, setBroken] = useState<Record<string, boolean>>({});

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
    const [conceptResponse, mediaResponse, garmentResponse, projectResponse] = await Promise.all([
      fetch("/api/v1/visualizations"),
      fetch("/api/v1/media?limit=20"),
      fetch("/api/v1/catalog/garments?limit=20"),
      fetch("/api/v1/design-projects?limit=20"),
    ]);
    setLoading(false);
    if (!conceptResponse.ok || !mediaResponse.ok || !garmentResponse.ok || !projectResponse.ok) {
      setNotice("The workspace could not be loaded.");
      return;
    }
    const conceptBody = (await conceptResponse.json()) as { concepts: Summary[] };
    const mediaBody = (await mediaResponse.json()) as { media: MediaItem[] };
    const garmentBody = (await garmentResponse.json()) as { garments: Named[] };
    const projectBody = (await projectResponse.json()) as { projects: Named[] };
    setConcepts(conceptBody.concepts);
    setMedia(mediaBody.media);
    setMediaId(mediaBody.media[0]?.id ?? "");
    setGarments(garmentBody.garments);
    setGarmentId(garmentBody.garments[0]?.id ?? "");
    setProjects(projectBody.projects);
    setProjectId(projectBody.projects[0]?.id ?? "");
  }

  async function openConcept(id: string) {
    setNotice("");
    setLoading(true);
    const response = await fetch(`/api/v1/visualizations/${id}`);
    setLoading(false);
    const body = (await response.json()) as { concept?: Concept; error?: { message: string } };
    if (!response.ok || !body.concept) {
      setNotice(body.error?.message ?? "That concept is not available.");
      return;
    }
    setConcept(body.concept);
    setNotes(body.concept.notes);
    setBroken({});
  }

  async function createConcept(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    const response = await fetch("/api/v1/visualizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const body = (await response.json()) as { concept?: Concept; error?: { message: string } };
    if (!response.ok || !body.concept) {
      setNotice(body.error?.message ?? "The concept was not created.");
      return;
    }
    setTitle("");
    setConcept(body.concept);
    setNotes(body.concept.notes);
    await refresh();
  }

  async function saveNotes(event: FormEvent) {
    event.preventDefault();
    if (!concept || !canEdit(concept)) return;
    const response = await fetch(`/api/v1/visualizations/${concept.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    await applyConcept(response, "Notes were not saved.");
  }

  async function addExisting() {
    if (!concept || !mediaId) return;
    const response = await fetch(`/api/v1/visualizations/${concept.id}/references`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mediaId, origin: "original_reference" }),
    });
    await applyConcept(response, "That image was not added.");
  }

  async function upload(file: File) {
    if (!concept) return;
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
    const linked = await fetch(`/api/v1/visualizations/${concept.id}/references`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mediaId: body.media.id, origin: "manual_upload" }),
    });
    await applyConcept(linked, "The upload was saved, but it was not added to the concept.");
    await refresh();
  }

  async function removeReference(mediaIdToRemove: string) {
    if (!concept) return;
    const response = await fetch(`/api/v1/visualizations/${concept.id}/references/${mediaIdToRemove}`, {
      method: "DELETE",
    });
    await applyConcept(response, "That reference was not removed.");
  }

  async function move(index: number, direction: -1 | 1) {
    if (!concept) return;
    const ids = concept.references.map((item) => item.mediaId);
    const next = index + direction;
    const current = ids[index];
    const neighbor = ids[next];
    if (current === undefined || neighbor === undefined) return;
    ids[index] = neighbor;
    ids[next] = current;
    const response = await fetch(`/api/v1/visualizations/${concept.id}/references/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mediaIds: ids }),
    });
    await applyConcept(response, "The order was not saved.");
  }

  async function associateGarment() {
    if (!concept || !garmentId) return;
    const response = await fetch(`/api/v1/visualizations/${concept.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ garmentId }),
    });
    await applyConcept(response, "That garment was not associated.");
  }

  async function associateProject() {
    if (!concept || !projectId) return;
    const response = await fetch(`/api/v1/visualizations/${concept.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ designProjectId: projectId }),
    });
    await applyConcept(response, "That design project was not associated.");
  }

  async function setStatus(status: string) {
    if (!concept) return;
    const response = await fetch(`/api/v1/visualizations/${concept.id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await applyConcept(response, "The status was not changed.");
  }

  async function requestGeneration() {
    if (!concept) return;
    setNotice("");
    const response = await fetch(`/api/v1/visualizations/${concept.id}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = (await response.json()) as { error?: { message: string } };
    setNotice(body.error?.message ?? "Image generation is not configured.");
  }

  async function applyConcept(response: Response, fallback: string) {
    const body = (await response.json()) as { concept?: Concept; error?: { message: string } };
    if (!response.ok || !body.concept) {
      setNotice(body.error?.message ?? fallback);
      return;
    }
    setConcept(body.concept);
    setNotes(body.concept.notes);
    setConcepts((current) =>
      current.map((item) =>
        item.id === body.concept?.id
          ? {
              ...item,
              title: body.concept.title,
              status: body.concept.status,
              method: body.concept.method,
              referenceCount: body.concept.referenceCount,
              updatedAt: body.concept.updatedAt,
              previewMediaId: body.concept.preview?.mediaId ?? null,
              designProjectName:
                body.concept.designProject && "name" in body.concept.designProject
                  ? (body.concept.designProject.name ?? null)
                  : null,
            }
          : item,
      ),
    );
  }

  if (!ready) {
    return (
      <main className="mx-auto max-w-6xl px-5 py-10">
        <h1 className="font-editorial text-4xl text-ink">Visualization</h1>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-full max-w-6xl flex-col gap-8 px-5 py-10">
      <header className="flex items-end justify-between gap-4 border-b border-ink/15 pb-4">
        <div>
          <p className="text-xs tracking-[0.18em] text-muted uppercase">Bop</p>
          <h1 className="font-editorial text-4xl text-ink">Visualization</h1>
        </div>
        <nav className="flex gap-4 text-sm">
          <Link className="text-ink underline" href="/">
            Landing
          </Link>
          <Link className="text-ink underline" href="/analysis">
            Analysis
          </Link>
        </nav>
      </header>
      <p className="max-w-3xl text-sm leading-6 text-muted">
        Arrange images and garments you already own. A reference preview is the image you selected. Image generation is
        not configured, so nothing on this page is a newly generated design.
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
        <div className="grid gap-8 lg:grid-cols-[16rem_1fr]">
          <aside className="grid content-start gap-4">
            <form className="grid gap-2" onSubmit={(event) => void createConcept(event)}>
              <label className="grid gap-1 text-sm">
                New concept
                <input className="border border-ink/20 bg-paper px-3 py-2" value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>
              <button className="border border-ink px-3 py-2 text-sm" type="submit">
                Create concept
              </button>
            </form>
            {loading && concepts.length === 0 ? <p className="text-sm text-muted">Loading concepts.</p> : null}
            {!loading && concepts.length === 0 ? <p className="text-sm text-muted">No concepts yet.</p> : null}
            <ul className="grid gap-2">
              {concepts.map((item) => (
                <li key={item.id}>
                  <button className="grid w-full gap-1 border border-ink/15 px-3 py-2 text-left" type="button" onClick={() => void openConcept(item.id)}>
                    <span className="font-editorial text-xl">{item.title}</span>
                    <span className="text-xs text-muted">
                      {statusLabel[item.status] ?? item.status} · {item.referenceCount} references
                      {item.designProjectName ? ` · ${item.designProjectName}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
          {concept ? (
            <section className="grid gap-6">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="font-editorial text-3xl">{concept.title}</h2>
                  <p className="text-sm text-muted">
                    {statusLabel[concept.status] ?? concept.status} · {methodLabel[concept.method] ?? concept.method} · Not generated
                  </p>
                </div>
                {concept.access === "manage" && concept.status !== "archived" ? (
                  <button className="text-sm underline" type="button" onClick={() => void setStatus("archived")}>
                    Archive
                  </button>
                ) : null}
                {concept.access === "manage" && concept.status === "archived" ? (
                  <button className="text-sm underline" type="button" onClick={() => void setStatus("draft")}>
                    Reopen
                  </button>
                ) : null}
                {canEdit(concept) && concept.status === "draft" ? (
                  <button className="text-sm underline" type="button" onClick={() => void setStatus("arranged")}>
                    Mark arranged
                  </button>
                ) : null}
              </div>
              <Preview concept={concept} broken={broken} onBroken={(id) => setBroken((current) => ({ ...current, [id]: true }))} />
              <form className="grid gap-2" onSubmit={(event) => void saveNotes(event)}>
                <label className="grid gap-1 text-sm">
                  Design notes
                  <textarea className="min-h-24 border border-ink/20 bg-paper px-3 py-2" value={notes} onChange={(event) => setNotes(event.target.value)} disabled={!canEdit(concept) || concept.status === "archived"} />
                </label>
                {canEdit(concept) && concept.status !== "archived" ? (
                  <button className="w-fit border border-ink px-3 py-2 text-sm" type="submit">
                    Save notes
                  </button>
                ) : null}
              </form>
              <div className="grid gap-3">
                <h3 className="text-sm tracking-[0.14em] uppercase">References</h3>
                {concept.references.length === 0 ? <p className="text-sm text-muted">No reference images yet.</p> : null}
                <ul className="grid gap-4 sm:grid-cols-2">
                  {concept.references.map((item, index) => (
                    <li className="grid gap-2 border border-ink/15 p-3" key={item.mediaId}>
                      <ReferenceImage item={item} broken={Boolean(broken[item.mediaId])} onBroken={() => setBroken((current) => ({ ...current, [item.mediaId]: true }))} />
                      <p className="text-sm">{originLabel[item.origin] ?? item.origin}</p>
                      <p className="text-xs text-muted">{item.filename ?? "Filename hidden"}</p>
                      {canEdit(concept) && concept.status !== "archived" ? (
                        <div className="flex gap-3 text-sm">
                          <button type="button" onClick={() => void move(index, -1)} disabled={index === 0}>
                            Earlier
                          </button>
                          <button type="button" onClick={() => void move(index, 1)} disabled={index === concept.references.length - 1}>
                            Later
                          </button>
                          <button type="button" onClick={() => void removeReference(item.mediaId)}>
                            Remove
                          </button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
              {canEdit(concept) && concept.status !== "archived" ? (
                <div className="grid gap-3 border-t border-ink/15 pt-4">
                  <label className="grid gap-1 text-sm">
                    Existing image
                    <select className="border border-ink/20 bg-paper px-3 py-2" value={mediaId} onChange={(event) => setMediaId(event.target.value)}>
                      {media.length === 0 ? <option value="">No images yet</option> : null}
                      {media.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.originalFilename || "Untitled image"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="w-fit border border-ink px-3 py-2 text-sm" type="button" onClick={() => void addExisting()} disabled={!mediaId}>
                    Add as original reference
                  </button>
                  <label className="grid gap-1 text-sm">
                    Upload a variation
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void upload(file);
                      }}
                    />
                  </label>
                  <label className="grid gap-1 text-sm">
                    Catalog garment
                    <select className="border border-ink/20 bg-paper px-3 py-2" value={garmentId} onChange={(event) => setGarmentId(event.target.value)}>
                      {garments.length === 0 ? <option value="">No garments yet</option> : null}
                      {garments.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="w-fit border border-ink px-3 py-2 text-sm" type="button" onClick={() => void associateGarment()} disabled={!garmentId}>
                    Associate garment
                  </button>
                  <label className="grid gap-1 text-sm">
                    Design project
                    <select className="border border-ink/20 bg-paper px-3 py-2" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                      {projects.length === 0 ? <option value="">No design projects yet</option> : null}
                      {projects.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="w-fit border border-ink px-3 py-2 text-sm" type="button" onClick={() => void associateProject()} disabled={!projectId}>
                    Associate design project
                  </button>
                  <button className="w-fit text-sm underline" type="button" onClick={() => void requestGeneration()}>
                    Request a generated preview
                  </button>
                </div>
              ) : null}
              <GarmentFacts concept={concept} />
            </section>
          ) : (
            <p className="text-sm text-muted">{loading ? "Loading concepts." : "Select a concept, or create one."}</p>
          )}
        </div>
      ) : null}
    </main>
  );
}

function canEdit(concept: Concept): boolean {
  return concept.access === "manage" || concept.access === "edit";
}

function Preview({ concept, broken, onBroken }: { concept: Concept; broken: Record<string, boolean>; onBroken: (id: string) => void }) {
  const preview = concept.preview;
  if (!preview) return <p className="text-sm text-muted">No preview yet. Add a reference image.</p>;
  return (
    <figure className="grid gap-2">
      <ReferenceImage
        item={{ ...preview, position: 0, note: "", status: preview.available ? "ready" : null, filename: preview.filename }}
        broken={Boolean(broken[preview.mediaId])}
        onBroken={() => onBroken(preview.mediaId)}
      />
      <figcaption className="text-sm text-muted">
        {originLabel[preview.origin] ?? preview.origin}. This is not a generated image.
      </figcaption>
    </figure>
  );
}

function ReferenceImage({ item, broken, onBroken }: { item: Reference; broken: boolean; onBroken: () => void }) {
  if (!item.available || item.status !== "ready") {
    return <p className="text-sm text-muted">This image is not available.</p>;
  }
  if (broken) return <p className="text-sm text-muted">This image could not be loaded.</p>;
  return (
    <span className="relative block aspect-[4/5] w-full bg-sand">
      <Image
        fill
        unoptimized
        className="object-contain"
        alt={item.filename ?? "Fashion reference"}
        src={`/api/v1/media/${item.mediaId}/content`}
        onError={onBroken}
      />
    </span>
  );
}

function GarmentFacts({ concept }: { concept: Concept }) {
  const garment = concept.garment;
  const project = concept.designProject;
  return (
    <div className="grid gap-2 border-t border-ink/15 pt-4 text-sm">
      <h3 className="tracking-[0.14em] uppercase">Associated records</h3>
      {!garment ? <p className="text-muted">No garment is associated.</p> : null}
      {garment && garment.available === false ? <p className="text-muted">The associated garment is not available.</p> : null}
      {garment && garment.available !== false ? (
        <p>
          {garment.name}
          {garment.garmentType ? ` · ${garment.garmentType.name}` : ""}
          {garment.terms.length > 0 ? ` · ${garment.terms.map((term) => term.name).join(", ")}` : ""}
        </p>
      ) : null}
      {!project ? <p className="text-muted">No design project is associated.</p> : null}
      {project && project.available === false ? <p className="text-muted">The associated design project is not available.</p> : null}
      {project && project.name ? <p>Design project: {project.name}</p> : null}
      {concept.revision && "revisionNumber" in concept.revision && concept.revision.revisionNumber ? (
        <p>Revision {concept.revision.revisionNumber}</p>
      ) : null}
      {concept.revision?.available === false ? <p className="text-muted">The associated revision is not available.</p> : null}
    </div>
  );
}
