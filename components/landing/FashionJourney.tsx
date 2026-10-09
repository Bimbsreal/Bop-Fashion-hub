import { LandingMedia } from "@/components/landing/LandingMedia";
import { MotionSection } from "@/components/landing/MotionSection";
import { getLandingAsset } from "@/lib/landing-assets";
import { fashionJourney } from "@/lib/landing-content";

export function FashionJourney() {
  return (
    <MotionSection className="journey" id="journey" aria-labelledby="journey-heading">
      <h2 id="journey-heading" className="journey-heading">
        The fashion journey
      </h2>
      <ol className="section-gutter journey-rail">
        {fashionJourney.map((step) => (
          <li key={step.id} id={step.id} className="journey-card motion-item">
            <div className="media-frame journey-frame">
              <LandingMedia
                slot={getLandingAsset(step.assetId)}
                tone={step.tone}
                sizes="(max-width: 1099px) 70vw, 16vw"
              />
            </div>
            <h3>
              <span className="journey-index">{step.index}</span>
              {step.title}
            </h3>
            <p>{step.summary}</p>
          </li>
        ))}
      </ol>
    </MotionSection>
  );
}
