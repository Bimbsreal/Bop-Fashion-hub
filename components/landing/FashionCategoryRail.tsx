import { LandingMedia } from "@/components/landing/LandingMedia";
import { getLandingAsset } from "@/lib/landing-assets";
import { fashionCategories, type CategoryIconName } from "@/lib/landing-content";

function CategoryIcon({ name }: { name: CategoryIconName }) {
  const common = {
    width: 28,
    height: 28,
    viewBox: "0 0 32 32",
    fill: "none",
    "aria-hidden": true as const,
  };

  switch (name) {
    case "traditional":
      return (
        <svg {...common}>
          <path d="M8 10l8-4 8 4-2 4H10l-2-4z" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10 14l-2 12h16l-2-12" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      );
    case "contemporary":
      return (
        <svg {...common}>
          <path d="M11 8l5-3 5 3 2 4-3 1v12H12V13l-3-1 2-4z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      );
    case "streetwear":
      return (
        <svg {...common}>
          <path d="M10 12c0-3 2.2-5 6-5s6 2 6 5v2l3 2v3h-4v8H11v-8H7v-3l3-2v-2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      );
    case "formalwear":
      return (
        <svg {...common}>
          <path d="M12 7l4 3 4-3 3 4-3 14H12L9 11l3-4z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M16 10v14" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      );
    case "footwear":
      return (
        <svg {...common}>
          <path d="M7 20c2-6 5-8 8-8 2 0 3 1 5 1 3 0 5 2 5 4v3H7v0z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      );
    case "accessories":
      return (
        <svg {...common}>
          <path d="M11 13h10l1 10H10l1-10z" stroke="currentColor" strokeWidth="1.4" />
          <path d="M13 13V10a3 3 0 0 1 6 0v3" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      );
    case "occasions":
      return (
        <svg {...common}>
          <path d="M12 8h8l-1 4H13l-1-4zM11 12l-2 13h14l-2-13" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <rect x="6" y="6" width="8" height="8" stroke="currentColor" strokeWidth="1.4" />
          <rect x="18" y="6" width="8" height="8" stroke="currentColor" strokeWidth="1.4" />
          <rect x="6" y="18" width="8" height="8" stroke="currentColor" strokeWidth="1.4" />
          <rect x="18" y="18" width="8" height="8" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      );
  }
}

export function FashionCategoryRail() {
  return (
    <nav className="category-rail motion-fade motion-delay-3" id="categories" aria-label="Fashion categories">
      <ul className="category-list">
        {fashionCategories.map((category) => {
          const slot = getLandingAsset(category.assetId);
          return (
            <li key={category.id}>
              <a href={`#${category.id === "and-more" ? "categories" : "journey"}`}>
                <span className="category-mark">
                  {slot.src ? (
                    <LandingMedia slot={slot} sizes="640px" />
                  ) : (
                    <CategoryIcon name={category.icon} />
                  )}
                </span>
                {category.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
