/**
 * The one function both frontends call. Given a source and a bag of options it
 * returns the rendered text plus enough metadata for a caller to explain what
 * it is looking at.
 */
import { loadSampled, readSource, probe } from "./image.ts";
import type { LoadOptions } from "./image.ts";
import {
  fitRows, meanLuminance, renderAscii, renderBraille, resolveRamp,
} from "./render.ts";

export type Mode = "ascii" | "braille";
export const MODES: Mode[] = ["ascii", "braille"];

export interface ViewOptions {
  /** Output columns. Defaults to something that fits a typical terminal. */
  width: number;
  mode: Mode;
  charset: string;
  /** `"auto"` inverts only when the source is light-on-dark. */
  invert: boolean | "auto";
  color: boolean;
  edges: boolean;
  edgeThreshold: number;
  /** Coordinate ruler step, or `false` for none. */
  grid: number | false;
  /** Terminal cell height:width ratio. 2.1 suits most monospace fonts. */
  aspect: number;
  normalize: boolean;
  background: string;
  crop?: LoadOptions["crop"];
  /** Braille ink cutoff; `"auto"` uses Otsu. */
  threshold: number | "auto";
}

export const VIEW_DEFAULTS: ViewOptions = {
  width: 100,
  mode: "ascii",
  charset: "ascii",
  invert: "auto",
  color: false,
  edges: false,
  edgeThreshold: 90,
  grid: false,
  aspect: 2.1,
  normalize: true,
  background: "#ffffff",
  threshold: "auto",
};

export interface ViewResult {
  text: string;
  lines: string[];
  info: {
    source: string;
    format: string;
    srcWidth: number;
    srcHeight: number;
    cols: number;
    rows: number;
    mode: Mode;
    inverted: boolean;
    meanLuminance: number;
  };
}

/** Below this mean luminance a source is treated as light-on-dark. */
const DARK_SOURCE_CUTOFF = 110;

export async function view(src: string, opts: Partial<ViewOptions> = {}): Promise<ViewResult> {
  const o = { ...VIEW_DEFAULTS, ...opts };
  if (!Number.isFinite(o.width) || o.width < 4) throw new Error("width must be a number ≥ 4");
  if (!Number.isFinite(o.aspect) || o.aspect <= 0) throw new Error("aspect must be a positive number");
  if (!MODES.includes(o.mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
  resolveRamp(o.charset);   // fail on a bad charset before we decode anything

  const bytes = await readSource(src);
  const meta = await probe(bytes);
  const srcW = o.crop?.width ?? meta.width;
  const srcH = o.crop?.height ?? meta.height;

  // Braille packs 2×4 samples per cell, so it needs a denser sample grid for
  // the same on-screen size.
  const cellW = o.mode === "braille" ? 2 : 1;
  const cellH = o.mode === "braille" ? 4 : 1;
  const cols = o.width;
  const rows = fitRows(srcW, srcH, cols, o.aspect);

  const loaded = await loadSampled(bytes, {
    cols: cols * cellW,
    rows: rows * cellH,
    keepColor: o.color,
    background: o.background,
    normalize: o.normalize,
    crop: o.crop,
  });

  const mean = meanLuminance(loaded.sampled);
  const inverted = o.invert === "auto" ? mean < DARK_SOURCE_CUTOFF : o.invert;

  const lines = o.mode === "braille"
    ? renderBraille(loaded.sampled, { invert: inverted, threshold: o.threshold, grid: o.grid })
    : renderAscii(loaded.sampled, {
        charset: o.charset,
        invert: inverted,
        color: o.color,
        edges: o.edges,
        edgeThreshold: o.edgeThreshold,
        grid: o.grid,
      });

  return {
    text: lines.join("\n"),
    lines,
    info: {
      source: src,
      format: loaded.format,
      srcWidth: loaded.srcWidth,
      srcHeight: loaded.srcHeight,
      cols,
      rows,
      mode: o.mode,
      inverted,
      meanLuminance: Math.round(mean),
    },
  };
}
