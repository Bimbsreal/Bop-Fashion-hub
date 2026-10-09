const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function prepareGarment(input: { name: string; visibility: string; typeSlug: string }):
  | {
      ok: true;
      body: { name: string; visibility: "public" | "private"; terms?: { kind: string; slug: string }[] };
    }
  | { ok: false; message: string } {
  const name = input.name.trim();
  if (!name) return { ok: false, message: "Garment name is required." };
  if (name.length > 160) return { ok: false, message: "Garment name is too long." };
  if (input.visibility !== "public" && input.visibility !== "private") {
    return { ok: false, message: "Visibility must be public or private." };
  }
  const typeSlug = input.typeSlug.trim();
  if (typeSlug && !slugPattern.test(typeSlug)) return { ok: false, message: "Garment type must be a catalog slug." };
  return {
    ok: true,
    body: {
      name,
      visibility: input.visibility,
      ...(typeSlug ? { terms: [{ kind: "garment_type", slug: typeSlug }] } : {}),
    },
  };
}

export function prepareDesign(input: { name: string; description: string; visibility: string }):
  | { ok: true; body: { name: string; description: string; visibility: "public" | "private" } }
  | { ok: false; message: string } {
  const name = input.name.trim();
  if (!name) return { ok: false, message: "Project name is required." };
  if (name.length > 160) return { ok: false, message: "Project name is too long." };
  const description = input.description.trim();
  if (description.length > 2000) return { ok: false, message: "Description is too long." };
  if (input.visibility !== "public" && input.visibility !== "private") {
    return { ok: false, message: "Visibility must be public or private." };
  }
  return { ok: true, body: { name, description, visibility: input.visibility } };
}
