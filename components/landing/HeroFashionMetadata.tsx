import { LandingMedia } from "@/components/landing/LandingMedia";
import { getLandingAsset } from "@/lib/landing-assets";
import { heroMetadata } from "@/lib/landing-content";

export function HeroFashionMetadata() {
  return (
    <ul className="hero-meta hero-overlay" aria-label="Look details">
      {heroMetadata.map((item) => {
        const slot = getLandingAsset(item.assetId);
        return (
          <li key={item.id} className="hero-meta-item">
            <div className="hero-meta-thumb">
              <LandingMedia slot={slot} tone={item.tone} sizes="180px" />
            </div>
            <div>
              <p className="hero-meta-label">{item.label}</p>
              <p className="hero-meta-value">{item.value}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
