export const styleRuleSetId = "style-rules.v1";

export type OutfitRole = "top" | "bottom" | "one_piece" | "outerwear";

export type StyleTerm = { kind: string; slug: string; name: string };

export type StyleGarment = {
  id: string;
  name: string;
  typeSlug: string | null;
  terms: StyleTerm[];
};

export type StylePreference = { polarity: "preferred" | "disliked"; kind: string; slug: string };

export type StyleNote = { kind: "match" | "limitation" | "assumption" | "attribute"; message: string };

export type StyleRecommendation = {
  items: { garmentId: string; role: OutfitRole; name: string }[];
  notes: StyleNote[];
  ruleMatchCount: number;
};

const roleByType: Record<string, OutfitRole> = {
  shirt: "top",
  trousers: "bottom",
  skirt: "bottom",
  jacket: "outerwear",
  dress: "one_piece",
  gown: "one_piece",
  kaftan: "one_piece",
  agbada: "one_piece",
};

const templates: { id: string; roles: OutfitRole[]; summary: string }[] = [
  { id: "top-bottom", roles: ["top", "bottom"], summary: "A top with a bottom is a supported combination." },
  {
    id: "top-bottom-outerwear",
    roles: ["top", "bottom", "outerwear"],
    summary: "A top, a bottom, and outerwear are a supported combination.",
  },
  { id: "one-piece", roles: ["one_piece"], summary: "This garment can be an outfit on its own." },
  {
    id: "one-piece-outerwear",
    roles: ["one_piece", "outerwear"],
    summary: "A one-piece garment with outerwear is a supported combination.",
  },
];

const neutralPairs = [
  ["black", "white"],
  ["black", "ivory"],
  ["white", "ivory"],
];

const accentPairs = [
  ["indigo", "black"],
  ["indigo", "white"],
  ["indigo", "ivory"],
  ["gold", "black"],
  ["gold", "white"],
  ["gold", "ivory"],
];

const preferenceKinds = ["style", "color", "occasion", "garment_type", "material", "tradition", "category"] as const;

export function describeStyleRules() {
  return {
    id: styleRuleSetId,
    fashionQualityScore: false,
    budgetSupported: false,
    occasionTermsSeeded: false,
    roles: roleByType,
    templates: templates.map((template) => ({ id: template.id, roles: template.roles })),
    colorRules: [
      { name: "monochromatic", meaning: "Both garments carry the same color term." },
      { name: "neutral", pairs: neutralPairs },
      { name: "accent with a neutral", pairs: accentPairs },
    ],
    ranking: "Outfits are ordered by the number of match notes. The count is not a measure of fashion quality.",
    preferenceKinds: [...preferenceKinds],
  };
}

export function outfitRoleForType(typeSlug: string | null): OutfitRole | null {
  if (!typeSlug) return null;
  return roleByType[typeSlug] ?? null;
}

export function recommendOutfits(input: {
  garments: StyleGarment[];
  preferences: StylePreference[];
  occasion: StyleTerm | null;
  style: StyleTerm | null;
  anchorId: string | null;
  poolLimited: boolean;
}): {
  status: "completed" | "insufficient_data";
  summary: string;
  sessionNotes: StyleNote[];
  recommendations: StyleRecommendation[];
} {
  const sessionNotes: StyleNote[] = [
    {
      kind: "assumption",
      message:
        "Rule set style-rules.v1 uses catalog tags and explicit composition rules. It does not judge fashion quality, cultural meaning, or who should wear a garment.",
    },
  ];
  if (input.poolLimited) {
    sessionNotes.push({
      kind: "limitation",
      message: "Only the first 80 readable garments, ordered by name, were considered.",
    });
  }
  if (input.occasion) {
    sessionNotes.push({
      kind: "limitation",
      message: `Occasion ${input.occasion.name} is used only when a garment carries that tag. A missing occasion tag is not treated as unsuitable.`,
    });
  } else {
    sessionNotes.push({
      kind: "limitation",
      message: "No occasion was requested. The catalog has no seeded occasion vocabulary, so occasion suitability was not assessed.",
    });
  }

  const disliked = input.preferences.filter((item) => item.polarity === "disliked");
  const usable = input.garments.filter((garment) => !disliked.some((item) => hasTerm(garment, item.kind, item.slug)));
  const removed = input.garments.length - usable.length;
  if (removed > 0) {
    sessionNotes.push({
      kind: "limitation",
      message: `${removed} readable garment${removed === 1 ? "" : "s"} carried a disliked term and ${removed === 1 ? "was" : "were"} not used.`,
    });
  }

  const anchor = input.anchorId ? usable.find((garment) => garment.id === input.anchorId) ?? null : null;
  if (input.anchorId && !anchor) {
    return {
      status: "insufficient_data",
      summary: "The selected garment was not available for styling, or it carries a disliked term.",
      sessionNotes,
      recommendations: [],
    };
  }
  if (anchor && !outfitRoleForType(anchor.typeSlug)) {
    return {
      status: "insufficient_data",
      summary: "The selected garment has no outfit role in this rule set, so an outfit was not assembled around it.",
      sessionNotes,
      recommendations: [],
    };
  }

  const grouped = new Map<OutfitRole, StyleGarment[]>();
  for (const garment of usable) {
    const role = outfitRoleForType(garment.typeSlug);
    if (!role) continue;
    const list = grouped.get(role) ?? [];
    list.push(garment);
    grouped.set(role, list);
  }
  for (const list of grouped.values()) {
    list.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  const drafts: StyleRecommendation[] = [];
  let evaluated = 0;
  let truncated = false;
  for (const template of templates) {
    if (anchor) {
      const anchorRole = outfitRoleForType(anchor.typeSlug);
      if (!anchorRole || !template.roles.includes(anchorRole)) continue;
    }
    const groups = template.roles.map((role) => {
      const anchorRole = anchor ? outfitRoleForType(anchor.typeSlug) : null;
      if (anchor && anchorRole === role) return [anchor];
      return grouped.get(role) ?? [];
    });
    if (groups.some((group) => group.length === 0)) continue;
    const built = fillTemplate(groups, 240 - evaluated);
    evaluated += built.length;
    if (evaluated >= 240) truncated = true;
    for (const items of built) {
      drafts.push(explainOutfit(template, items, input.preferences, input.occasion, input.style, input.anchorId));
    }
    if (truncated) break;
  }
  if (truncated) {
    sessionNotes.push({
      kind: "limitation",
      message: "Combination stopped at 240 outfits. The returned order is among those considered.",
    });
  }

  drafts.sort((left, right) => {
    if (right.ruleMatchCount !== left.ruleMatchCount) return right.ruleMatchCount - left.ruleMatchCount;
    return itemKey(left).localeCompare(itemKey(right));
  });
  const recommendations = drafts.slice(0, 6);
  if (recommendations.length === 0) {
    return {
      status: "insufficient_data",
      summary: "No outfit could be assembled from the readable garments and the supported composition rules.",
      sessionNotes,
      recommendations: [],
    };
  }
  return {
    status: "completed",
    summary:
      "Outfits were assembled from catalog tags. They are ordered by how many documented rules matched. That count is not a fashion-quality score.",
    sessionNotes,
    recommendations,
  };
}

export function explainAlternative(
  garment: StyleGarment,
  role: OutfitRole,
  others: StyleGarment[],
  preferences: StylePreference[],
): StyleNote[] {
  const notes: StyleNote[] = [
    {
      kind: "match",
      message: `${garment.name} can fill the ${roleLabel(role)} place because its garment type is supported for that place.`,
    },
  ];
  for (const other of others) {
    notes.push(...colorNotes(garment, other));
  }
  notes.push(...preferenceNotes(garment, preferences));
  notes.push(...attributeNotes(garment));
  return notes;
}

function explainOutfit(
  template: { summary: string },
  items: StyleGarment[],
  preferences: StylePreference[],
  occasion: StyleTerm | null,
  style: StyleTerm | null,
  anchorId: string | null,
): StyleRecommendation {
  const notes: StyleNote[] = [{ kind: "match", message: template.summary }];
  const roles = items.map((item) => ({
    garmentId: item.id,
    role: outfitRoleForType(item.typeSlug) as OutfitRole,
    name: item.name,
  }));
  if (anchorId && items.some((item) => item.id === anchorId)) {
    const selected = items.find((item) => item.id === anchorId);
    notes.push({ kind: "match", message: `${selected?.name ?? "The selected garment"} is the garment you selected.` });
  }
  for (let index = 0; index < items.length; index += 1) {
    for (let next = index + 1; next < items.length; next += 1) {
      const left = items[index];
      const right = items[next];
      if (left && right) notes.push(...colorNotes(left, right), ...styleShareNotes(left, right));
    }
  }
  for (const item of items) {
    notes.push(...preferenceNotes(item, preferences));
    if (style && hasTerm(item, "style", style.slug)) {
      notes.push({ kind: "match", message: `${item.name} carries the requested style ${style.name}.` });
    } else if (style) {
      notes.push({
        kind: "limitation",
        message: `${item.name} has no ${style.name} style tag. It was kept because a missing style tag is not treated as unsuitable.`,
      });
    }
    if (occasion && hasTerm(item, "occasion", occasion.slug)) {
      notes.push({ kind: "match", message: `${item.name} carries the occasion tag ${occasion.name}.` });
    } else if (occasion) {
      notes.push({
        kind: "limitation",
        message: `${item.name} has no ${occasion.name} occasion tag. Occasion suitability was not confirmed.`,
      });
    }
    notes.push(...attributeNotes(item));
    if (item.typeSlug === "agbada" || item.typeSlug === "kaftan" || item.typeSlug === "gown") {
      notes.push({
        kind: "assumption",
        message: `${item.name} is included because its garment type has an outfit role. No ceremonial or cultural suitability was inferred.`,
      });
    }
  }
  notes.push({
    kind: "assumption",
    message: "A catalog outfit board shows separate garment records. It is not a photograph of the garments worn together.",
  });
  return {
    items: roles,
    notes,
    ruleMatchCount: notes.filter((note) => note.kind === "match").length,
  };
}

function colorNotes(left: StyleGarment, right: StyleGarment): StyleNote[] {
  const leftColors = termsOf(left, "color");
  const rightColors = termsOf(right, "color");
  if (leftColors.length === 0 || rightColors.length === 0) {
    const missing = leftColors.length === 0 ? left.name : right.name;
    return [{ kind: "limitation", message: `${missing} has no color term, so color was not compared.` }];
  }
  for (const leftColor of leftColors) {
    for (const rightColor of rightColors) {
      if (leftColor.slug === rightColor.slug) {
        return [
          {
            kind: "match",
            message: `${left.name} and ${right.name} both carry ${leftColor.name}. That follows the documented monochromatic rule. It is not a claim that the pairing suits every person.`,
          },
        ];
      }
      if (pairListed(neutralPairs, leftColor.slug, rightColor.slug)) {
        return [
          {
            kind: "match",
            message: `${leftColor.name} on ${left.name} and ${rightColor.name} on ${right.name} follow the documented neutral color rule.`,
          },
        ];
      }
      if (pairListed(accentPairs, leftColor.slug, rightColor.slug)) {
        return [
          {
            kind: "match",
            message: `${leftColor.name} on ${left.name} and ${rightColor.name} on ${right.name} follow the documented accent-with-neutral rule.`,
          },
        ];
      }
    }
  }
  return [
    {
      kind: "limitation",
      message: `${left.name} and ${right.name} have color terms, and no documented relationship covers them. The outfit was not rejected for color.`,
    },
  ];
}

function styleShareNotes(left: StyleGarment, right: StyleGarment): StyleNote[] {
  const leftStyles = termsOf(left, "style");
  const rightStyles = termsOf(right, "style");
  const shared = leftStyles.find((item) => rightStyles.some((other) => other.slug === item.slug));
  if (shared) {
    return [{ kind: "match", message: `${left.name} and ${right.name} share the style tag ${shared.name}.` }];
  }
  if (leftStyles.length > 0 && rightStyles.length > 0) {
    return [
      {
        kind: "limitation",
        message: `${left.name} and ${right.name} do not share a style tag. Mixed styles were kept because no rule forbids them.`,
      },
    ];
  }
  return [];
}

function preferenceNotes(garment: StyleGarment, preferences: StylePreference[]): StyleNote[] {
  const notes: StyleNote[] = [];
  for (const preference of preferences) {
    if (preference.polarity !== "preferred") continue;
    const term = garment.terms.find((item) => item.kind === preference.kind && item.slug === preference.slug);
    if (term) {
      notes.push({ kind: "match", message: `${garment.name} matches your preferred ${preference.kind.split("_").join(" ")} ${term.name}.` });
    }
  }
  return notes;
}

function attributeNotes(garment: StyleGarment): StyleNote[] {
  return garment.terms
    .filter((term) => term.kind === "material" || term.kind === "pattern" || term.kind === "tradition")
    .map((term) => ({
      kind: "attribute" as const,
      message: `${garment.name} is tagged ${term.kind} ${term.name}.`,
    }));
}

function fillTemplate(groups: StyleGarment[][], room: number): StyleGarment[][] {
  if (room <= 0) return [];
  const complete: StyleGarment[][] = [];
  const walk = (depth: number, partial: StyleGarment[]) => {
    if (complete.length >= room) return;
    const group = groups[depth];
    if (!group) {
      complete.push(partial);
      return;
    }
    for (const item of group) {
      if (complete.length >= room) return;
      if (partial.some((chosen) => chosen.id === item.id)) continue;
      walk(depth + 1, [...partial, item]);
    }
  };
  walk(0, []);
  return complete;
}

function hasTerm(garment: StyleGarment, kind: string, slug: string): boolean {
  return garment.terms.some((term) => term.kind === kind && term.slug === slug);
}

function termsOf(garment: StyleGarment, kind: string): StyleTerm[] {
  return garment.terms.filter((term) => term.kind === kind);
}

function pairListed(pairs: string[][], left: string, right: string): boolean {
  return pairs.some((pair) => (pair[0] === left && pair[1] === right) || (pair[0] === right && pair[1] === left));
}

function itemKey(recommendation: StyleRecommendation): string {
  return recommendation.items
    .map((item) => item.garmentId)
    .slice()
    .sort()
    .join(",");
}

function roleLabel(role: OutfitRole): string {
  if (role === "one_piece") return "one-piece";
  return role;
}
