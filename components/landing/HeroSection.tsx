import Image from "next/image";
import { HeroHeadline } from "@/components/landing/HeroHeadline";
import { HeroStats } from "@/components/landing/HeroStats";
import { HeroVisual } from "@/components/landing/HeroVisual";
import { TryOnMarkIcon } from "@/components/landing/icons";
import { getLandingAsset } from "@/lib/landing-assets";

export function HeroSection() {
  const background = getLandingAsset("heroBackground");

  return (
    <section className="hero-section" aria-labelledby="hero-heading">
      <div className="hero-backdrop" aria-hidden="true">
        {background.src ? (
          <Image
            src={background.src}
            alt=""
            fill
            priority
            quality={85}
            sizes="100vw"
            className="object-cover"
          />
        ) : null}
      </div>
      <div className="hero-intro">
        <p className="hero-eyebrow">Fashion intelligence platform</p>
        <HeroHeadline />
        <div className="hero-support">
          <p className="hero-lede">
            Bop connects people, garments, fabrics, measurements, styles and commerce into one
            intelligent fashion infrastructure.
          </p>
          <div className="hero-actions">
            <a className="btn btn-dark" href="#ecosystem">
              Explore Bop
            </a>
            <a className="btn btn-light" href="#try">
              Try it on
              <TryOnMarkIcon />
            </a>
          </div>
        </div>
      </div>
      <HeroVisual />
      <HeroStats />
    </section>
  );
}
