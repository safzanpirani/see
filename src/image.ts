/**
 * Decoding and downsampling. This is the only file that touches `sharp`, so
 * swapping the decoder later is a one-file change.
 */
import sharp from "sharp";
import type { Sampled } from "./render.ts";

export interface LoadOptions {
  /** Target sample columns (before any braille 2× expansion). */
  cols: number;
  /** Target sample rows. */
  rows: number;
  /** Keep RGB alongside luminance (needed for `--color`). */
  keepColor?: boolean;
  /** Colour composited under transparent pixels. */
  background?: string;
  /** Stretch contrast to the full range. Big win on flat/washed-out sources. */
  normalize?: boolean;
  /** Crop before scaling: `left,top,width,height` in source pixels. */
  crop?: { left: number; top: number; width: number; height: number };
}

export interface Loaded {
  sampled: Sampled;
  /** Source dimensions, before crop/scale. */
  srcWidth: number;
  srcHeight: number;
  format: string;
}

/** The source could not be fetched at all — as opposed to fetched-but-undecodable.
 *  Callers use this to tell "your path is wrong" from "try the vision model". */
export class SourceError extends Error {}

/** Resolve `src` — a path, an http(s) URL, or `-` for stdin — to bytes. */
export async function readSource(src: string): Promise<Uint8Array> {
  if (src === "-") {
    const buf = await Bun.readableStreamToArrayBuffer(Bun.stdin.stream());
    if (buf.byteLength === 0) throw new SourceError("no image bytes on stdin");
    return new Uint8Array(buf);
  }
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new SourceError(`fetch ${src} failed: ${res.status} ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  const file = Bun.file(src);
  if (!(await file.exists())) throw new SourceError(`no such file: ${src}`);
  return new Uint8Array(await file.arrayBuffer());
}

/** Read source metadata without paying for a full decode-and-resize. */
export async function probe(bytes: Uint8Array) {
  const m = await sharp(bytes).metadata();
  return {
    width: m.width ?? 0,
    height: m.height ?? 0,
    format: m.format ?? "unknown",
    pages: m.pages ?? 1,
    hasAlpha: Boolean(m.hasAlpha),
  };
}

/** Decode, optionally crop, resize to the sample grid, and extract luminance. */
export async function loadSampled(bytes: Uint8Array, opts: LoadOptions): Promise<Loaded> {
  const meta = await probe(bytes);
  if (!meta.width || !meta.height) throw new Error(`could not decode image (format: ${meta.format})`);

  let pipeline = sharp(bytes, { animated: false });
  if (opts.crop) {
    const { left, top, width, height } = opts.crop;
    if (left < 0 || top < 0 || width <= 0 || height <= 0) throw new Error("crop values must be positive");
    if (left + width > meta.width || top + height > meta.height) {
      throw new Error(
        `crop ${left},${top},${width},${height} falls outside the ${meta.width}x${meta.height} source`,
      );
    }
    pipeline = pipeline.extract({ left, top, width, height });
  }
  pipeline = pipeline
    .flatten({ background: opts.background ?? "#ffffff" })
    .resize(opts.cols, opts.rows, { fit: "fill", kernel: "lanczos3" });
  if (opts.normalize !== false) pipeline = pipeline.normalise();

  const { data } = await pipeline.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = opts.cols * opts.rows;
  const lum = new Uint8Array(px);
  const rgb = opts.keepColor ? new Uint8Array(px * 3) : undefined;
  for (let i = 0; i < px; i++) {
    const r = data[i * 3]!, g = data[i * 3 + 1]!, b = data[i * 3 + 2]!;
    // Rec. 601 luma — matches how the eye weights the channels.
    lum[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    if (rgb) {
      rgb[i * 3] = r;
      rgb[i * 3 + 1] = g;
      rgb[i * 3 + 2] = b;
    }
  }
  return {
    sampled: { w: opts.cols, h: opts.rows, lum, rgb },
    srcWidth: meta.width,
    srcHeight: meta.height,
    format: meta.format,
  };
}
