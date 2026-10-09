import { AudienceCard } from "@/components/landing/AudienceCard";
import { LandingMedia } from "@/components/landing/LandingMedia";
import { MotionSection } from "@/components/landing/MotionSection";
import { ArrowRightIcon } from "@/components/landing/icons";
import { getLandingAsset } from "@/lib/landing-assets";
import { audiences } from "@/lib/landing-content";

export function AudienceSection() {
  return (
    <MotionSection className="audience" id="audiences" aria-labelledby="audience-heading">
      <div className="section-gutter audience-layout">
        <div className="audience-feature">
          <div className="audience-photo motion-media">
            <LandingMedia
              slot={getLandingAsset("audienceFeature")}
              tone="cocoa"
              sizes="(max-width: 1099px) 100vw, 50vw"
            />
          </div>
          <div className="audience-copy motion-copy motion-delay-2">
            <p className="eyebrow">For everyone in fashion</p>
            <h2 id="audience-heading" className="editorial">
              People.
              <br />
              Culture.
              <br />
              Style.
              <br />
              Technology.
            </h2>
            <a className="btn btn-light" href="#individuals">
              Explore solutions
              <ArrowRightIcon />
            </a>
          </div>
        </div>
        <div className="audience-grid">
          {audiences.map((card) => (
            <AudienceCard key={card.id} card={card} />
          ))}
        </div>
      </div>
    </MotionSection>
  );
}
