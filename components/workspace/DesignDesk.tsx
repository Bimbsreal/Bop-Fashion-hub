"use client";

import { useEffect, useState } from "react";
import { prepareDesign } from "@/lib/catalog-form";

type Project = {
  id: string;
  name: string;
  status: string;
  visibility: string;
  latestRevision: number | null;
};

export function DesignDesk() {
  const [signedIn, setSignedIn] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState("private");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void refresh(() => cancelled).then((result) => {
      if (cancelled || !result) return;
      setSignedIn(result.signedIn);
      setProjects(result.projects);
      if (result.notice) setNotice(result.notice);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function createProject() {
    setNotice("");
    const prepared = prepareDesign({ name, description, visibility });
    if (!prepared.ok) {
      setNotice(prepared.message);
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/v1/design-projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(prepared.body),
      });
      const body = (await response.json()) as { error?: { message: string } };
      if (!response.ok) {
        setNotice(body.error?.message ?? "The project could not be saved.");
        return;
      }
      setName("");
      setDescription("");
      const result = await refresh(() => false);
      if (result) setProjects(result.projects);
      setNotice("Design project saved.");
    } catch {
      setNotice("The design service is unavailable.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-8 px-5 py-10">
      <header className="border-b border-ink/15 pb-4">
        <h1 className="font-editorial text-4xl text-ink">Design</h1>
      </header>
      <p className="max-w-2xl text-sm leading-6 text-muted">
        A design project is a saved record. Opening one here does not generate an image. Revisions stay on the project the API already stores.
      </p>
      {notice ? <p className="text-sm text-clay">{notice}</p> : null}
      {projects === null ? <p className="text-sm text-muted">Loading design projects.</p> : null}
      {projects && projects.length === 0 ? <p className="text-sm text-muted">No design projects are visible.</p> : null}
      {projects && projects.length > 0 ? (
        <ul className="grid gap-3">
          {projects.map((project) => (
            <li key={project.id} className="border border-ink/15 p-3">
              <p className="font-editorial text-2xl text-ink">{project.name}</p>
              <p className="text-sm text-muted">
                {project.status} · {project.visibility}
                {project.latestRevision === null ? "" : ` · revision ${project.latestRevision}`}
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
            void createProject();
          }}
        >
          <h2 className="text-sm tracking-[0.14em] uppercase">New project</h2>
          <label className="grid gap-1 text-sm">
            Name
            <input className="border border-ink/20 bg-paper px-3 py-2" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm">
            Description
            <input className="border border-ink/20 bg-paper px-3 py-2" value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm">
            Visibility
            <select className="border border-ink/20 bg-paper px-3 py-2" value={visibility} onChange={(event) => setVisibility(event.target.value)}>
              <option value="private">private</option>
              <option value="public">public</option>
            </select>
          </label>
          <button className="w-fit border border-ink px-4 py-2 text-sm" type="submit" disabled={pending}>
            Save project
          </button>
        </form>
      ) : (
        <p className="text-sm text-muted">Sign in on Account to save a design project.</p>
      )}
    </main>
  );
}

async function refresh(cancelled: () => boolean) {
  try {
    const session = await fetch("/api/v1/auth/session");
    const response = await fetch("/api/v1/design-projects");
    if (cancelled()) return null;
    const body = (await response.json()) as { projects?: Project[]; error?: { message: string } };
    if (!response.ok || !body.projects) {
      return { signedIn: session.ok, projects: [] as Project[], notice: body.error?.message ?? "Design projects could not be loaded." };
    }
    return { signedIn: session.ok, projects: body.projects, notice: "" };
  } catch {
    if (cancelled()) return null;
    return { signedIn: false, projects: [] as Project[], notice: "The design service is unavailable." };
  }
}
