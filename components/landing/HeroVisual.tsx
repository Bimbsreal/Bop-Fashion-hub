"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";
import { HeroFashionMetadata } from "@/components/landing/HeroFashionMetadata";
import { HeroLookRail } from "@/components/landing/HeroLookRail";
import { HeroMeasurementOverlay } from "@/components/landing/HeroMeasurementOverlay";
import { LandingMedia } from "@/components/landing/LandingMedia";
import { ArrowRightIcon } from "@/components/landing/icons";
import { getLandingAsset } from "@/lib/landing-assets";

export function HeroVisual() {
  const heroModel = getLandingAsset("heroModel");
  const tryOn = getLandingAsset("tryOnThumbnail");
  const visualRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  function beginEntrance() {
    if (started.current) return;
    started.current = true;
    visualRef.current?.closest(".hero-section")?.classList.add("is-ready");
  }

  useEffect(() => {
    const image = visualRef.current?.querySelector("img");
    if (!image || image.complete) {
      beginEntrance();
      return;
    }
    const fallback = window.setTimeout(beginEntrance, 1400);
    return () => window.clearTimeout(fallback);
  }, []);

  return (
    <div className="hero-visual" ref={visualRef}>
      <div className="hero-model-frame">
        {heroModel.src ? (
          <Image
            src={heroModel.src}
            alt={heroModel.alt}
            fill
            priority
            quality={90}
            sizes="(max-width: 1099px) 100vw, 68vw"
            className="hero-model-photo"
            onLoad={beginEntrance}
          />
        ) : (
          <div
            className="hero-model-fallback"
            data-asset-slot={heroModel.id}
            data-expected-path={heroModel.expectedPath}
            aria-hidden="true"
          />
        )}
      </div>
      <HeroFashionMetadata />
      <HeroMeasurementOverlay />
      <HeroLookRail />
      <a className="hero-tryon hero-overlay" href="#try">
        <div className="hero-tryon-thumb">
          <LandingMedia slot={tryOn} tone="cocoa" sizes="80px" />
        </div>
        <span>
          <span className="hero-tryon-kicker">Virtual Try-On</span>
          <span className="hero-tryon-text">See it on you</span>
        </span>
        <span className="hero-tryon-arrow" aria-hidden="true">
          <ArrowRightIcon />
        </span>
      </a>
    </div>
  );
}
