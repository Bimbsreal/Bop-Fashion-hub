"use client";

import { useLayoutEffect, useState } from "react";
import { LandingMedia } from "@/components/landing/LandingMedia";
import { africanFashionFilm, getLandingAsset } from "@/lib/landing-assets";

export function AfricanFashionFilm() {
  const textile = getLandingAsset("africanFashion");
  const [reduce, setReduce] = useState(false);

  useLayoutEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduce(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  if (reduce) {
    return <LandingMedia slot={textile} sizes="100vw" className="african-still" />;
  }

  return (
    <video
      className="african-film"
      src={africanFashionFilm}
      autoPlay
      muted
      loop
      playsInline
      preload="auto"
      tabIndex={-1}
      disablePictureInPicture
      aria-hidden="true"
    />
  );
}
