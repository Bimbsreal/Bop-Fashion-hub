import { ArrowRightIcon } from "@/components/landing/icons";
import { MotionSection } from "@/components/landing/MotionSection";

export function EcosystemIntro() {
  return (
    <MotionSection className="ecosystem" id="ecosystem" aria-labelledby="ecosystem-heading">
      <div className="section-gutter ecosystem-grid">
        <div className="motion-copy">
          <p className="eyebrow">From creation to commerce</p>
          <h2 id="ecosystem-heading" className="editorial">
            One connected fashion ecosystem.
          </h2>
        </div>
        <div className="motion-copy motion-delay-2">
          <p className="ecosystem-copy">
            Bop gives individuals, designers, tailors and retailers the tools to create, visualize,
            fit, style and bring fashion to life — powered by data, intelligence and real-world
            fashion understanding.
          </p>
          <a className="text-link" href="#journey">
            See how it works
            <ArrowRightIcon />
          </a>
        </div>
      </div>
    </MotionSection>
  );
}
