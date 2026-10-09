import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fashionJourney } from "../../lib/landing-content";
import { getLandingAsset } from "../../lib/landing-assets";

const expected = [
  "01-create.png",
  "02-visualize.png",
  "03-try.png",
  "04-fit.png",
  "05-style.png",
  "06-order.png",
];

test("each fashion journey step uses its own image file", () => {
  assert.equal(fashionJourney.length, 6);
  const sources = fashionJourney.map((step, index) => {
    const slot = getLandingAsset(step.assetId);
    assert.equal(slot.view, undefined);
    assert.equal(slot.unoptimized, true);
    assert.ok(slot.src);
    assert.equal(slot.src.startsWith("/landing/"), true);
    assert.ok(slot.alt.length > 0);
    assert.match(slot.src, new RegExp(`${expected[index]}$`));
    const relative = decodeURIComponent(slot.src.slice(1));
    assert.equal(existsSync(path.resolve("public", relative)), true);
    return slot.src;
  });
  assert.equal(new Set(sources).size, 6);
});
