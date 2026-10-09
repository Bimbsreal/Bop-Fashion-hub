import type { LandingAssetId } from "@/lib/landing-assets";

export type PlaceholderTone =
  | "plaster"
  | "sand"
  | "clay"
  | "cocoa"
  | "ink"
  | "gold"
  | "leaf";

export type NavLink = {
  label: string;
  href: string;
};

export const mainNav: NavLink[] = [
  { label: "Individuals", href: "#individuals" },
  { label: "Designers", href: "#designers" },
  { label: "Tailors", href: "#tailors" },
  { label: "Retailers", href: "#retailers" },
];

export const exploreLinks: NavLink[] = [
  { label: "Fashion journey", href: "#journey" },
  { label: "Individuals", href: "#individuals" },
  { label: "Designers", href: "#designers" },
  { label: "Tailors", href: "#tailors" },
  { label: "Retailers", href: "#retailers" },
  { label: "African fashion", href: "#african" },
  { label: "Categories", href: "#categories" },
];

export const heroStats = [
  { id: "looks", value: "1M+", label: "Looks created" },
  { id: "designers", value: "50K+", label: "Designers" },
  { id: "tailors", value: "10K+", label: "Tailors" },
  { id: "brands", value: "2K+", label: "Brands & Retailers" },
] as const;

export const heroMetadata: {
  id: string;
  label: string;
  value: string;
  assetId: LandingAssetId;
  tone: PlaceholderTone;
}[] = [
  { id: "fabric", label: "Fabric", value: "Ankara", assetId: "fabricThumbnail", tone: "clay" },
  { id: "garment", label: "Garment", value: "Top", assetId: "garmentThumbnail", tone: "cocoa" },
  { id: "style", label: "Style", value: "Contemporary", assetId: "styleThumbnail", tone: "gold" },
  {
    id: "accessories",
    label: "Accessories",
    value: "Completes the look",
    assetId: "accessoryThumbnail",
    tone: "sand",
  },
];

export const heroMeasurements = [
  { id: "shoulder", label: "Shoulder", value: "38 cm" },
  { id: "chest", label: "Chest", value: "88 cm" },
  { id: "waist", label: "Waist", value: "72 cm" },
  { id: "hip", label: "Hip", value: "94 cm" },
  { id: "inseam", label: "Inseam", value: "78 cm" },
] as const;

export const heroLooks: {
  id: string;
  label: string;
  assetId: LandingAssetId;
  tone: PlaceholderTone;
}[] = [
  { id: "formal", label: "Formal look", assetId: "lookFormal", tone: "ink" },
  { id: "occasion", label: "Occasion look", assetId: "lookOccasion", tone: "leaf" },
];

export type JourneyStep = {
  id: string;
  index: string;
  title: string;
  summary: string;
  assetId: LandingAssetId;
  tone: PlaceholderTone;
};

export const fashionJourney: JourneyStep[] = [
  {
    id: "create",
    index: "01",
    title: "Create",
    summary: "Design or choose your look.",
    assetId: "createImage",
    tone: "plaster",
  },
  {
    id: "visualize",
    index: "02",
    title: "Visualize",
    summary: "See it on a real model or yourself.",
    assetId: "visualizeImage",
    tone: "clay",
  },
  {
    id: "try",
    index: "03",
    title: "Try",
    summary: "Virtually try it on.",
    assetId: "tryImage",
    tone: "cocoa",
  },
  {
    id: "fit",
    index: "04",
    title: "Fit",
    summary: "Get the right fit with real measurements.",
    assetId: "fitImage",
    tone: "sand",
  },
  {
    id: "style",
    index: "05",
    title: "Style",
    summary: "Complete your look.",
    assetId: "styleImage",
    tone: "gold",
  },
  {
    id: "order",
    index: "06",
    title: "Order",
    summary: "Buy, make, or produce.",
    assetId: "orderImage",
    tone: "ink",
  },
];

export type AudienceCard = {
  id: string;
  title: string;
  summary: string;
  assetId: LandingAssetId;
  tone: PlaceholderTone;
};

export const audiences: AudienceCard[] = [
  {
    id: "individuals",
    title: "Individuals",
    summary: "Explore styles, try looks and find your fit.",
    assetId: "individualsImage",
    tone: "cocoa",
  },
  {
    id: "designers",
    title: "Designers",
    summary: "Design, visualize and showcase.",
    assetId: "designersImage",
    tone: "ink",
  },
  {
    id: "tailors",
    title: "Tailors",
    summary: "Measure, fit and create with precision.",
    assetId: "tailorsImage",
    tone: "clay",
  },
  {
    id: "retailers",
    title: "Brands & Retailers",
    summary: "Showcase, sell and scale your collections.",
    assetId: "retailersImage",
    tone: "gold",
  },
];

export type FashionCategory = {
  id: string;
  label: string;
  icon: CategoryIconName;
  assetId: LandingAssetId;
};

export type CategoryIconName =
  | "traditional"
  | "contemporary"
  | "streetwear"
  | "formalwear"
  | "footwear"
  | "accessories"
  | "occasions"
  | "andMore";

export const fashionCategories: FashionCategory[] = [
  { id: "traditional", label: "Traditional", icon: "traditional", assetId: "traditionalImage" },
  { id: "contemporary", label: "Contemporary", icon: "contemporary", assetId: "contemporaryImage" },
  { id: "streetwear", label: "Streetwear", icon: "streetwear", assetId: "streetwearImage" },
  { id: "formalwear", label: "Formalwear", icon: "formalwear", assetId: "formalwearImage" },
  { id: "footwear", label: "Footwear", icon: "footwear", assetId: "footwearImage" },
  { id: "accessories", label: "Accessories", icon: "accessories", assetId: "accessoriesImage" },
  { id: "occasions", label: "Occasions", icon: "occasions", assetId: "occasionsImage" },
  { id: "and-more", label: "And More", icon: "andMore", assetId: "andMoreImage" },
];
