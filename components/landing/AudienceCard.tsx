import { LandingMedia } from "@/components/landing/LandingMedia";
import { ArrowRightIcon } from "@/components/landing/icons";
import { getLandingAsset } from "@/lib/landing-assets";
import type { AudienceCard as AudienceCardData } from "@/lib/landing-content";

export function AudienceCard({ card }: { card: AudienceCardData }) {
  return (
    <article id={card.id} className="audience-card motion-item">
      <div className="media-frame ratio-wide">
        <LandingMedia
          slot={getLandingAsset(card.assetId)}
          tone={card.tone}
          sizes="(max-width: 1099px) 100vw, 25vw"
        />
      </div>
      <div className="audience-card-body">
        <div>
          <h3>{card.title}</h3>
          <p>{card.summary}</p>
        </div>
        <a className="circle-link" href={`#${card.id}`} aria-label={`Explore ${card.title}`}>
          <ArrowRightIcon />
        </a>
      </div>
    </article>
  );
}
