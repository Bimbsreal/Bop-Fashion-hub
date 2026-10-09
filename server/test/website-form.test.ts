import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareAccount } from "../../lib/account-form";
import { prepareDesign, prepareGarment } from "../../lib/catalog-form";
import { workspaceRoute, workspaceRoutes } from "../../lib/workspace-routes";

test("account drafts reject a short password and keep sign-in free of a display name", () => {
  const signedIn = prepareAccount({ mode: "sign-in", email: "Ada@Bop.test", displayName: "", password: "long-enough" });
  assert.equal(signedIn.ok, true);
  if (!signedIn.ok) return;
  assert.equal(signedIn.body.email, "ada@bop.test");
  assert.equal("displayName" in signedIn.body, false);
  const short = prepareAccount({ mode: "register", email: "ada@bop.test", displayName: "Ada", password: "short" });
  assert.equal(short.ok, false);
  const nameless = prepareAccount({ mode: "register", email: "ada@bop.test", displayName: " ", password: "long-enough" });
  assert.equal(nameless.ok, false);
});

test("catalog and design drafts stay inside the stored fields", () => {
  const garment = prepareGarment({ name: " Indigo shirt ", visibility: "public", typeSlug: "shirt" });
  assert.equal(garment.ok, true);
  if (!garment.ok) return;
  assert.deepEqual(garment.body.terms, [{ kind: "garment_type", slug: "shirt" }]);
  const badType = prepareGarment({ name: "Shirt", visibility: "private", typeSlug: "Shirt" });
  assert.equal(badType.ok, false);
  const project = prepareDesign({ name: " Agbada study ", description: "", visibility: "private" });
  assert.equal(project.ok, true);
  assert.equal(workspaceRoutes.length, 11);
  assert.equal(workspaceRoute("/orders")?.label, "Orders");
  assert.equal(workspaceRoute("/admin"), null);
});
