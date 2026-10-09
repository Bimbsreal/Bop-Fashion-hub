/**
 * Central mapping for Bop landing imagery.
 *
 * Files live in `public/landing/bop landing page UI/` and are not renamed.
 * Paths are URL-encoded. Composite sheets are shown through a source
 * rectangle (`view`) so one file can fill several slots without being cropped
 * on disk.
 *
 * Confidence is recorded in `docs/bop-landing-asset-map.md`.
 */

export type LandingAssetId =
  | "logo"
  | "heroModel"
  | "heroBackground"
  | "fabricThumbnail"
  | "garmentThumbnail"
  | "styleThumbnail"
  | "accessoryThumbnail"
  | "tryOnThumbnail"
  | "lookFormal"
  | "lookOccasion"
  | "measurementModel"
  | "createImage"
  | "visualizeImage"
  | "tryImage"
  | "fitImage"
  | "styleImage"
  | "orderImage"
  | "audienceFeature"
  | "individualsImage"
  | "designersImage"
  | "tailorsImage"
  | "retailersImage"
  | "africanFashion"
  | "traditionalImage"
  | "contemporaryImage"
  | "streetwearImage"
  | "formalwearImage"
  | "footwearImage"
  | "accessoriesImage"
  | "occasionsImage"
  | "andMoreImage";

export type AssetConfidence = "high" | "medium" | "low" | "missing";

/** Source rectangle, in pixels, inside a larger file. */
export type AssetView = {
  x: number;
  y: number;
  w: number;
  h: number;
  imageWidth: number;
  imageHeight: number;
};

export type LandingAssetSlot = {
  id: LandingAssetId;
  src: string | null;
  alt: string;
  expectedPath: string;
  note: string;
  confidence: AssetConfidence;
  /** CSS object-fit when the whole file is shown. */
  fit?: "cover" | "contain";
  /** CSS object-position when the whole file is shown. */
  position?: string;
  /**
   * Serve the file as stored. Used when the source is smaller than the
   * optimizer's next size bucket, so a resized derivative would only soften it.
   */
  unoptimized?: boolean;
  /** Non-destructive window into a composite. */
  view?: AssetView;
  /**
   * Aspect ratio (width / height) of the frame this view was fitted to.
   * Must match the CSS frame or the crop will drift.
   */
  frameAspect?: number;
};

const LIBRARY = "/landing/bop%20landing%20page%20UI";

function file(name: string): string {
  return `${LIBRARY}/${encodeURIComponent(name)}`;
}

/** Normal visual for the African fashion field. The still remains the reduced-motion fallback. */
export const africanFashionFilm = file("footer video.mp4");

const ECOSYSTEM = "Connected Fashion Ecosystem.png";
const ECOSYSTEM_SIZE = { imageWidth: 2172, imageHeight: 724 } as const;
const ICONS = "Fashion Icon Set_ Eight Categories.png";
const ICONS_SIZE = { imageWidth: 2172, imageHeight: 724 } as const;

const META_ASPECT = 2.35 / 2.85;
const CATEGORY_ASPECT = 1;

function panel(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  size: { imageWidth: number; imageHeight: number },
): AssetView {
  return {
    x: x0,
    y: y0,
    w: x1 - x0,
    h: y1 - y0,
    imageWidth: size.imageWidth,
    imageHeight: size.imageHeight,
  };
}

/** Icon circles only. The printed labels sit below y=464 and are excluded. */
function iconPanel(x0: number, x1: number): AssetView {
  return panel(x0, x1, 196, 452, ICONS_SIZE);
}

export const landingAssets: Record<LandingAssetId, LandingAssetSlot> = {
  logo: {
    id: "logo",
    src: null,
    alt: "Bop",
    expectedPath: "/landing/logo.svg",
    confidence: "missing",
    note: "No wordmark file in the asset library. The header keeps the text wordmark.",
  },
  heroModel: {
    id: "heroModel",
    src: file("Regal Ankara Fashion Portrait Cutout.png"),
    alt: "Model in a flowing orange and black Ankara gown, looking upward",
    expectedPath: file("Regal Ankara Fashion Portrait Cutout.png"),
    confidence: "high",
    fit: "cover",
    position: "center 16%",
    note: "Same model, gown, and upward editorial pose as the reference hero. The stone-arch interior is not in this file; the cutout sits on the page backdrop.",
  },
  heroBackground: {
    id: "heroBackground",
    src: null,
    alt: "Sunlit stone arches",
    expectedPath: "/landing/hero-background.jpg",
    confidence: "missing",
    note: "No architectural interior was supplied. The hero uses the cutout on the ivory backdrop.",
  },
  fabricThumbnail: {
    id: "fabricThumbnail",
    src: file(ECOSYSTEM),
    alt: "Rolled Ankara fabrics",
    expectedPath: file(ECOSYSTEM),
    confidence: "high",
    view: panel(408, 771, 140, 606, ECOSYSTEM_SIZE),
    frameAspect: META_ASPECT,
    note: "Visualize panel of the ecosystem sheet: rolled Ankara, matching the fabric chip.",
  },
  garmentThumbnail: {
    id: "garmentThumbnail",
    src: file("Regal Ankara Fashion Portrait.png"),
    alt: "Orange and black Ankara top",
    expectedPath: file("Regal Ankara Fashion Portrait.png"),
    confidence: "medium",
    view: panel(500, 1100, 430, 820, { imageWidth: 1536, imageHeight: 1024 }),
    frameAspect: META_ASPECT,
    note: "Bodice of the hero gown. No separate product shot of the top was supplied.",
  },
  styleThumbnail: {
    id: "styleThumbnail",
    src: file("Glamorous Ankara Headwrap Portrait.png"),
    alt: "Styled Ankara headwrap look",
    expectedPath: file("Glamorous Ankara Headwrap Portrait.png"),
    confidence: "medium",
    position: "center 18%",
    note: "Completed styled portrait. The reference chip is a smaller contemporary look.",
  },
  accessoryThumbnail: {
    id: "accessoryThumbnail",
    src: file(ECOSYSTEM),
    alt: "Handbag and shoes completing a look",
    expectedPath: file(ECOSYSTEM),
    confidence: "high",
    view: panel(1454, 1815, 178, 578, ECOSYSTEM_SIZE),
    frameAspect: META_ASPECT,
    note: "Style panel of the ecosystem sheet: bags and shoes.",
  },
  tryOnThumbnail: {
    id: "tryOnThumbnail",
    src: file("Elegant Ankara Fashionista Using Smartphone.png"),
    alt: "Model looking at a phone while wearing Ankara",
    expectedPath: file("Elegant Ankara Fashionista Using Smartphone.png"),
    confidence: "medium",
    position: "center 22%",
    note: "Same hero model, now with a phone. Closest standalone virtual try-on image.",
  },
  lookFormal: {
    id: "lookFormal",
    src: file("Elegant Agbada Fashion Portrait.png"),
    alt: "Full-length cream traditional formal look",
    expectedPath: file("Elegant Agbada Fashion Portrait.png"),
    confidence: "medium",
    position: "center 12%",
    note: "Full-body formal traditional look. The reference thumbnail is a smaller tailored suit.",
  },
  lookOccasion: {
    id: "lookOccasion",
    src: file("Elegant Copper Gele Portrait.png"),
    alt: "Occasion portrait with a copper gele and jewelry",
    expectedPath: file("Elegant Copper Gele Portrait.png"),
    confidence: "medium",
    position: "center 16%",
    note: "Occasion dressing with gele, beads, and a clutch. Not the green full-body look in the reference.",
  },
  measurementModel: {
    id: "measurementModel",
    src: null,
    alt: "Fashion measurement diagram",
    expectedPath: "/landing/measurement-model.png",
    confidence: "missing",
    note: "No body diagram was supplied. The hero keeps the drawn croquis and the sample measurements.",
  },
  createImage: {
    id: "createImage",
    src: file("01-create.png"),
    alt: "Hands sketching a fashion figure on paper",
    expectedPath: file("01-create.png"),
    confidence: "high",
    fit: "cover",
    position: "center",
    unoptimized: true,
    note: "Separate photographic crop for Create. Served as the original PNG because the file is about 178 by 142 pixels.",
  },
  visualizeImage: {
    id: "visualizeImage",
    src: file("02-visualize.png"),
    alt: "Rolled orange, brown, and patterned fabrics",
    expectedPath: file("02-visualize.png"),
    confidence: "high",
    fit: "cover",
    position: "center",
    unoptimized: true,
    note: "Separate photographic crop for Visualize. Served as the original PNG.",
  },
  tryImage: {
    id: "tryImage",
    src: file("03-try.png"),
    alt: "Model wearing a patterned orange gown",
    expectedPath: file("03-try.png"),
    confidence: "high",
    fit: "cover",
    position: "center",
    unoptimized: true,
    note: "Separate photographic crop for Try. Served as the original PNG.",
  },
  fitImage: {
    id: "fitImage",
    src: file("04-fit.png"),
    alt: "A shoulder fitting measured with yellow tape",
    expectedPath: file("04-fit.png"),
    confidence: "high",
    fit: "cover",
    position: "center",
    unoptimized: true,
    note: "Separate photographic crop for Fit. Served as the original PNG.",
  },
  styleImage: {
    id: "styleImage",
    src: file("05-style.png"),
    alt: "Handbag, shoes, and a tailored jacket arranged as an outfit",
    expectedPath: file("05-style.png"),
    confidence: "high",
    fit: "cover",
    position: "center",
    unoptimized: true,
    note: "Separate photographic crop for Style. Served as the original PNG.",
  },
  orderImage: {
    id: "orderImage",
    src: file("06-order.png"),
    alt: "White shopping bag marked Bop",
    expectedPath: file("06-order.png"),
    confidence: "high",
    fit: "cover",
    position: "center",
    unoptimized: true,
    note: "Separate photographic crop for Order. Served as the original PNG.",
  },
  audienceFeature: {
    id: "audienceFeature",
    src: file("Stylish African Man in Traditional Attire.png"),
    alt: "Man in a cream traditional tunic, embroidered cap, and sunglasses, hands clasped",
    expectedPath: file("Stylish African Man in Traditional Attire.png"),
    confidence: "high",
    position: "center 18%",
    note: "Clasped-hands portrait. This is the prominent traditional subject beside People. Culture. Style. Technology.",
  },
  individualsImage: {
    id: "individualsImage",
    src: file("Thoughtful Braids in Golden Elegance.png"),
    alt: "Woman with braids resting a hand on her cheek, wearing a gold lace top",
    expectedPath: file("Thoughtful Braids in Golden Elegance.png"),
    confidence: "high",
    position: "center 30%",
    note: "The individuals photograph without the card chrome. The supplied card file already contains the heading and is not used.",
  },
  designersImage: {
    id: "designersImage",
    src: file("Focused Fashion Atelier Designer.png"),
    alt: "Designer sketching beside a dress form in a studio",
    expectedPath: file("Focused Fashion Atelier Designer.png"),
    confidence: "high",
    position: "center 40%",
    note: "Studio interior of the designer at work. Opaque photograph, not a black cutout.",
  },
  tailorsImage: {
    id: "tailorsImage",
    src: file("Tailor\u2019s Hands Measuring Dark Fabric.png"),
    alt: "Tailor’s hands measuring dark cloth with yellow tape and chalk",
    expectedPath: file("Tailor\u2019s Hands Measuring Dark Fabric.png"),
    confidence: "high",
    position: "center 45%",
    note: "Hands, tape, and chalk on dark cloth. The filename uses a typographic apostrophe.",
  },
  retailersImage: {
    id: "retailersImage",
    src: file("Elegant Boutique Browsing.png"),
    alt: "Woman in a cream suit browsing a clothing rail with a black handbag",
    expectedPath: file("Elegant Boutique Browsing.png"),
    confidence: "high",
    position: "center 35%",
    note: "Boutique rail and shopper. Closest brands and retailers scene.",
  },
  africanFashion: {
    id: "africanFashion",
    src: file("Ornate Draped Tribal Textile.png"),
    alt: "Draped orange, navy, and gold patterned cloth",
    expectedPath: file("Ornate Draped Tribal Textile.png"),
    confidence: "medium",
    position: "center 62%",
    note: "Reduced-motion still only. The normal field is footer video.mp4.",
  },
  traditionalImage: {
    id: "traditionalImage",
    src: file(ICONS),
    alt: "",
    expectedPath: file(ICONS),
    confidence: "high",
    view: iconPanel(36, 283),
    frameAspect: CATEGORY_ASPECT,
    note: "Traditional icon from the eight-category sheet, circle only.",
  },
  contemporaryImage: {
    id: "contemporaryImage",
    src: file(ICONS),
    alt: "",
    expectedPath: file(ICONS),
    confidence: "high",
    view: iconPanel(312, 565),
    frameAspect: CATEGORY_ASPECT,
    note: "Contemporary icon, circle only.",
  },
  streetwearImage: {
    id: "streetwearImage",
    src: file(ICONS),
    alt: "",
    expectedPath: file(ICONS),
    confidence: "high",
    view: iconPanel(594, 825),
    frameAspect: CATEGORY_ASPECT,
    note: "Streetwear icon, circle only.",
  },
  formalwearImage: {
    id: "formalwearImage",
    src: file(ICONS),
    alt: "",
    expectedPath: file(ICONS),
    confidence: "high",
    view: iconPanel(870, 1105),
    frameAspect: CATEGORY_ASPECT,
    note: "Formalwear icon, circle only.",
  },
  footwearImage: {
    id: "footwearImage",
    src: file(ICONS),
    alt: "",
    expectedPath: file(ICONS),
    confidence: "high",
    view: iconPanel(1140, 1369),
    frameAspect: CATEGORY_ASPECT,
    note: "Footwear icon, circle only.",
  },
  accessoriesImage: {
    id: "accessoriesImage",
    src: file(ICONS),
    alt: "",
    expectedPath: file(ICONS),
    confidence: "high",
    view: iconPanel(1406, 1641),
    frameAspect: CATEGORY_ASPECT,
    note: "Accessories icon, circle only.",
  },
  occasionsImage: {
    id: "occasionsImage",
    src: file(ICONS),
    alt: "",
    expectedPath: file(ICONS),
    confidence: "high",
    view: iconPanel(1680, 1905),
    frameAspect: CATEGORY_ASPECT,
    note: "Occasions icon, circle only.",
  },
  andMoreImage: {
    id: "andMoreImage",
    src: file(ICONS),
    alt: "",
    expectedPath: file(ICONS),
    confidence: "high",
    view: iconPanel(1928, 2143),
    frameAspect: CATEGORY_ASPECT,
    note: "And more icon, circle only. The printed label under the circle is not shown.",
  },
};

export const missingLandingAssets: LandingAssetSlot[] = Object.values(
  landingAssets,
).filter((slot) => slot.src === null);

export function getLandingAsset(id: LandingAssetId): LandingAssetSlot {
  return landingAssets[id];
}

/** Cover-fit a source rectangle into a frame of the given width/height ratio. */
export function assetCropStyle(
  view: AssetView,
  frameAspect: number,
): {
  position: "absolute";
  width: string;
  height: string;
  left: string;
  top: string;
  maxWidth: "none";
} {
  const { x, y, w, h, imageWidth, imageHeight } = view;
  const scaleOverFrameWidth = Math.max(1 / w, 1 / (h * frameAspect));
  const scaleOverFrameHeight = Math.max(frameAspect / w, 1 / h);
  const panelWidth = w * scaleOverFrameWidth * 100;
  const panelHeight = h * scaleOverFrameHeight * 100;

  return {
    position: "absolute",
    width: `${imageWidth * scaleOverFrameWidth * 100}%`,
    height: `${imageHeight * scaleOverFrameHeight * 100}%`,
    left: `${-x * scaleOverFrameWidth * 100 - Math.max(0, panelWidth - 100) / 2}%`,
    top: `${-y * scaleOverFrameHeight * 100 - Math.max(0, panelHeight - 100) / 2}%`,
    maxWidth: "none",
  };
}
