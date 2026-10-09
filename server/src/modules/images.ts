import sharp from "sharp";
import { invalid } from "../errors";

const formats = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

export type ImageFormat = keyof typeof formats;

const pixelCap = 40_000_000;

export type InspectedImage = {
  format: ImageFormat;
  mimeType: string;
  width: number;
  height: number;
};

export async function inspectImage(bytes: Buffer, maxEdge: number): Promise<InspectedImage> {
  if (bytes.length === 0) throw invalid("invalid_image", "Image could not be read.");
  let meta: { format?: string; width?: number; height?: number; orientation?: number };
  try {
    meta = await sharp(bytes, { failOn: "error", limitInputPixels: pixelCap, animated: false }).metadata();
  } catch {
    throw invalid("invalid_image", "Image could not be read.");
  }
  if (meta.format !== "jpeg" && meta.format !== "png" && meta.format !== "webp") {
    throw invalid("unsupported_image", "Use a JPEG, PNG, or WebP image.");
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const oriented = meta.orientation && meta.orientation >= 5 ? { width: height, height: width } : { width, height };
  if (oriented.width < 1 || oriented.height < 1) throw invalid("invalid_image", "Image could not be read.");
  if (oriented.width > maxEdge || oriented.height > maxEdge) {
    throw invalid("image_too_large", "Image dimensions are too large.");
  }
  return { format: meta.format, mimeType: formats[meta.format], width: oriented.width, height: oriented.height };
}

export async function thumbnailBytes(
  bytes: Buffer,
  format: ImageFormat,
): Promise<{ bytes: Buffer; width: number; height: number }> {
  try {
    const rendered = await sharp(bytes, { failOn: "error", limitInputPixels: pixelCap, animated: false })
      .rotate()
      .resize(480, 480, { fit: "inside", withoutEnlargement: true })
      .toFormat(format)
      .toBuffer({ resolveWithObject: true });
    return { bytes: rendered.data, width: rendered.info.width, height: rendered.info.height };
  } catch {
    throw invalid("invalid_image", "Image could not be read.");
  }
}

export function extensionFor(format: ImageFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

export function sanitizeFilename(value: string | undefined): string {
  const base = (value ?? "").replaceAll("\\", "/").split("/").pop() ?? "";
  const withoutTraversal = base.replaceAll("..", "");
  const cleaned = withoutTraversal.replace(/[^\w.\- ()]+/g, "").trim();
  return cleaned.slice(0, 120);
}
