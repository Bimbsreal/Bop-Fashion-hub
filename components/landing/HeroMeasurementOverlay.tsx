import { LandingMedia } from "@/components/landing/LandingMedia";
import { getLandingAsset } from "@/lib/landing-assets";
import { heroMeasurements } from "@/lib/landing-content";

export function HeroMeasurementOverlay() {
  const diagram = getLandingAsset("measurementModel");

  return (
    <div className="hero-measure hero-overlay">
      {diagram.src ? (
        <div className="measure-photo">
          <LandingMedia slot={diagram} sizes="120px" tone="plaster" />
        </div>
      ) : (
        <svg className="croquis" viewBox="0 0 140 320" fill="none" aria-hidden="true">
          <ellipse cx="70" cy="28" rx="13" ry="16" stroke="currentColor" strokeWidth="1.25" />
          <path d="M63 43c1 8 4 12 7 13 3-1 6-5 7-13" stroke="currentColor" strokeWidth="1.25" />
          <path
            d="M70 56c-16 3-30 16-33 34-2 22 2 48 8 78 4 18 8 28 12 34M70 56c16 3 30 16 33 34 2 22-2 48-8 78-4 18-8 28-12 34"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
          <path
            d="M40 92c-12 22-14 52-8 82M100 92c12 22 14 52 8 82"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
          <path
            d="M57 168c8 10 18 10 26 0"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
          <path
            d="M58 176c-2 40-6 78-8 118M82 176c2 40 6 78 8 118"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
          <path d="M34 78h28M36 112h30M40 146h26M46 188h22" stroke="currentColor" strokeWidth="1" strokeDasharray="1.5 3" />
        </svg>
      )}
      <ul className="measure-list" aria-label="Sample body measurements">
        {heroMeasurements.map((item) => (
          <li key={item.id}>
            <span className="measure-name">{item.label}</span>
            <span className="measure-value">{item.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
