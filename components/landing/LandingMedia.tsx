import Image from "next/image";
import { assetCropStyle, type LandingAssetSlot } from "@/lib/landing-assets";
import type { PlaceholderTone } from "@/lib/landing-content";

type LandingMediaProps = {
  slot: LandingAssetSlot;
  sizes: string;
  priority?: boolean;
  className?: string;
  tone?: PlaceholderTone;
};

export function LandingMedia({
  slot,
  sizes,
  priority = false,
  className = "",
  tone = "sand",
}: LandingMediaProps) {
  if (!slot.src) {
    return (
      <div
        className={`asset-placeholder tone-${tone} ${className}`}
        data-asset-slot={slot.id}
        data-expected-path={slot.expectedPath}
        aria-hidden="true"
      />
    );
  }

  if (slot.view) {
    return (
      <Image
        src={slot.src}
        alt={slot.alt}
        width={slot.view.imageWidth}
        height={slot.view.imageHeight}
        sizes={sizes}
        priority={priority}
        quality={priority ? 90 : 80}
        className={`asset-crop ${className}`}
        style={assetCropStyle(slot.view, slot.frameAspect ?? 4 / 5)}
      />
    );
  }

  return (
    <Image
      src={slot.src}
      alt={slot.alt}
      fill
      sizes={sizes}
      priority={priority}
      quality={priority ? 90 : 80}
      unoptimized={slot.unoptimized}
      className={className}
      style={{
        objectFit: slot.fit ?? "cover",
        objectPosition: slot.position ?? "center",
      }}
    />
  );
}
