import { LandingMedia } from "@/components/landing/LandingMedia";
import { getLandingAsset } from "@/lib/landing-assets";
import { heroLooks } from "@/lib/landing-content";

export function HeroLookRail() {
  return (
    <ul className="hero-looks hero-overlay" aria-label="Alternate looks">
      {heroLooks.map((look) => {
        const slot = getLandingAsset(look.assetId);
        return (
          <li key={look.id}>
            <div className="hero-look">
              <LandingMedia slot={slot} tone={look.tone} sizes="160px" />
            </div>
            <span className="sr-only">{look.label}</span>
          </li>
        );
      })}
    </ul>
  );
}
