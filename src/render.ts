/**
 * The pixel→text engine. Everything here is pure: it takes a grid of samples
 * and returns lines of text, so it is trivially testable and shared by the CLI
 * and the MCP server. Nothing in this file knows how to decode a JPEG.
 */

/** A downsampled image: `w*h` pixels, each 0-255 luminance, plus optional RGB. */
export interface Sampled {
  w: number;
  h: number;
  /** Luminance, row-major, length w*h. */
  lum: Uint8Array;
  /** Optional RGB triplets, row-major, length w*h*3. */
  rgb?: Uint8Array;
}

/** Character ramps, always ordered DARKEST → LIGHTEST. */
export const RAMPS = {
  ascii: "@%#*+=-:. ",
  dense: "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"^`'. ",
  simple: "@#+-. ",
  blocks: "█▓▒░ ",
  binary: "█ ",
} as const;

export type RampName = keyof typeof RAMPS;
export const RAMP_NAMES = Object.keys(RAMPS) as RampName[];

export interface RenderOptions {
  /** Ramp name or a literal custom ramp string (darkest → lightest). */
  charset: string;
  /** Flip luminance. Needed for light-on-dark sources (terminals, dark UIs). */
  invert: boolean;
  /** Emit ANSI truecolor per character. */
  color: boolean;
  /** Overlay Sobel edge glyphs (`- / | \`) where the gradient is strong. */
  edges: boolean;
  /** 0-255 gradient magnitude above which an edge glyph wins. */
  edgeThreshold: number;
  /** Draw a coordinate ruler around the art so a reader can cite positions. */
  grid: number | false;
}

export const DEFAULTS: RenderOptions = {
  charset: "ascii",
  invert: false,
  color: false,
  edges: false,
  edgeThreshold: 90,
  grid: false,
};

/** Resolve a `--charset` value: a known ramp name, else a literal ramp. */
export function resolveRamp(charset: string): string {
  const known = RAMPS[charset as RampName];
  if (known) return known;
  if (charset.length < 2) {
    throw new Error(
      `charset must be one of ${RAMP_NAMES.join(", ")} or a literal ramp of 2+ chars (darkest first)`,
    );
  }
  return charset;
}

/** Mean luminance, used to decide whether a source is light-on-dark. */
export function meanLuminance(s: Sampled): number {
  let sum = 0;
  for (let i = 0; i < s.lum.length; i++) sum += s.lum[i]!;
  return s.lum.length ? sum / s.lum.length : 0;
}

/** Edge glyphs by quantised gradient angle: a horizontal gradient (bucket 0)
 *  means a vertical edge, so the ramp is already rotated 90° from the angle. */
const EDGE_GLYPHS = ["|", "/", "-", "\\"];

/** Per-pixel Sobel. Returns magnitude (0-255, clamped) and a glyph per pixel. */
function sobel(s: Sampled): { mag: Uint8Array; glyph: string[] } {
  const { w, h, lum } = s;
  const mag = new Uint8Array(w * h);
  const glyph = new Array<string>(w * h).fill(" ");
  const at = (x: number, y: number) => lum[y * w + x]!;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx =
        -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) +
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy =
        -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) +
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      const i = y * w + x;
      mag[i] = Math.min(255, Math.round(Math.hypot(gx, gy) / 4));
      // The glyph traces the edge, which runs perpendicular to the gradient —
      // that perpendicular flip is already baked into EDGE_GLYPHS' order.
      const angle = Math.atan2(gy, gx);
      const bucket = ((Math.round(angle / (Math.PI / 4)) % 4) + 4) % 4;
      glyph[i] = EDGE_GLYPHS[bucket]!;
    }
  }
  return { mag, glyph };
}

const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const RESET = "\x1b[0m";

/**
 * Render a sampled image as lines of text. One character per sample, so the
 * caller is responsible for having already corrected for cell aspect ratio.
 */
export function renderAscii(s: Sampled, opts: Partial<RenderOptions> = {}): string[] {
  const o = { ...DEFAULTS, ...opts };
  const ramp = resolveRamp(o.charset);
  const last = ramp.length - 1;
  const edge = o.edges ? sobel(s) : null;

  const lines: string[] = [];
  for (let y = 0; y < s.h; y++) {
    let line = "";
    let currentColor = "";
    for (let x = 0; x < s.w; x++) {
      const i = y * s.w + x;
      const v = o.invert ? 255 - s.lum[i]! : s.lum[i]!;
      let ch: string;
      if (edge && edge.mag[i]! >= o.edgeThreshold) {
        ch = edge.glyph[i]!;
      } else {
        ch = ramp[Math.round((v / 255) * last)]!;
      }
      if (o.color && s.rgb) {
        const c = fg(s.rgb[i * 3]!, s.rgb[i * 3 + 1]!, s.rgb[i * 3 + 2]!);
        if (c !== currentColor) {
          line += c;
          currentColor = c;
        }
      }
      line += ch;
    }
    lines.push(o.color && s.rgb ? line + RESET : line);
  }
  return o.grid ? withGrid(lines, o.grid) : lines;
}

/**
 * Braille rendering: each cell packs a 2×4 block of samples into one glyph, so
 * a braille frame carries 8× the detail of an ascii frame at the same cell
 * count. Best mode for reading text out of a screenshot.
 */
export function renderBraille(
  s: Sampled,
  opts: { invert?: boolean; threshold?: number | "auto"; grid?: number | false } = {},
): string[] {
  const invert = opts.invert ?? false;
  const auto = opts.threshold === undefined || opts.threshold === "auto";
  // Otsu runs on the raw luminance, so when we flip the pixels we flip the
  // cutoff with them — otherwise a dark source loses every dot.
  const threshold = auto
    ? (invert ? 255 - otsu(s.lum) : otsu(s.lum))
    : (opts.threshold as number);
  // Dot bit order within a braille cell, as (dx, dy) → bit.
  const DOTS: Array<[number, number, number]> = [
    [0, 0, 0x01], [0, 1, 0x02], [0, 2, 0x04], [1, 0, 0x08],
    [1, 1, 0x10], [1, 2, 0x20], [0, 3, 0x40], [1, 3, 0x80],
  ];
  const cols = Math.floor(s.w / 2);
  const rows = Math.floor(s.h / 4);
  const lines: string[] = [];
  for (let cy = 0; cy < rows; cy++) {
    let line = "";
    for (let cx = 0; cx < cols; cx++) {
      let bits = 0;
      for (const [dx, dy, bit] of DOTS) {
        const raw = s.lum[(cy * 4 + dy) * s.w + (cx * 2 + dx)]!;
        const v = invert ? 255 - raw : raw;
        // A "set" dot is ink, i.e. dark, which is why the test is `<`.
        if (v < threshold) bits |= bit;
      }
      line += String.fromCharCode(0x2800 + bits);
    }
    lines.push(line);
  }
  return opts.grid ? withGrid(lines, opts.grid) : lines;
}

/** Otsu's method — picks the threshold that best splits ink from background. */
export function otsu(lum: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < lum.length; i++) {
    const v = lum[i]!;
    hist[v] = hist[v]! + 1;
  }
  const total = lum.length;
  if (!total) return 128;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t]!;
  let sumB = 0, wB = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t]!;
    const between = wB * wF * Math.pow(sumB / wB - (sum - sumB) / wF, 2);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  // Otsu's `threshold` is the last background level; callers test `v < t` for
  // ink, so hand back the first foreground level instead of an off-by-one.
  return threshold + 1;
}

/**
 * Wrap the art in a coordinate ruler. Column numbers read top-to-bottom in the
 * header rows; row numbers sit in the gutter. Every `step` columns/rows are
 * labelled so a vision-less reader can say "the box at col 40, row 12".
 */
export function withGrid(lines: string[], step: number): string[] {
  const width = Math.max(0, ...lines.map((l) => stripAnsi(l).length));
  const gutter = String(lines.length).length;
  const pad = " ".repeat(gutter);
  const labels: string[][] = [];
  for (let x = step; x <= width; x += step) {
    const text = String(x);
    for (let d = 0; d < text.length; d++) {
      (labels[d] ??= [])[x - 1] = text[d]!;
    }
  }
  const header = labels.map((row) => {
    let s = "";
    for (let x = 0; x < width; x++) s += row[x] ?? " ";
    return `${pad} ${s}`;
  });
  const body = lines.map((l, i) => {
    const n = i + 1;
    const label = n % step === 0 ? String(n).padStart(gutter) : pad;
    return `${label} ${l}`;
  });
  return [...header, `${pad} ${"─".repeat(width)}`, ...body];
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

/**
 * Rows needed to keep an image looking un-squashed, given that terminal cells
 * are roughly twice as tall as they are wide.
 */
export function fitRows(srcW: number, srcH: number, cols: number, cellAspect = 2.1): number {
  return Math.max(1, Math.round((srcH / srcW) * cols / cellAspect));
}
