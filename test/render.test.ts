import { expect, test, describe } from "bun:test";
import {
  RAMPS, fitRows, meanLuminance, otsu, renderAscii, renderBraille,
  resolveRamp, stripAnsi, withGrid,
} from "../src/render.ts";
import type { Sampled } from "../src/render.ts";

/** Build a sampled image from a value function. */
function grid(w: number, h: number, f: (x: number, y: number) => number): Sampled {
  const lum = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) lum[y * w + x] = f(x, y);
  return { w, h, lum };
}

describe("ramps", () => {
  test("named ramps resolve, literals pass through", () => {
    expect(resolveRamp("ascii")).toBe(RAMPS.ascii);
    expect(resolveRamp("ab")).toBe("ab");
  });
  test("a one-char ramp is rejected — it would render a flat block", () => {
    expect(() => resolveRamp("x")).toThrow(/2\+ chars/);
  });
});

describe("renderAscii", () => {
  test("black maps to the darkest char, white to the lightest", () => {
    const lines = renderAscii(grid(2, 1, (x) => (x === 0 ? 0 : 255)), { charset: "ascii" });
    expect(lines).toEqual(["@ "]);
  });

  test("invert flips the polarity", () => {
    const s = grid(2, 1, (x) => (x === 0 ? 0 : 255));
    expect(renderAscii(s, { charset: "ascii", invert: true })).toEqual([" @"]);
  });

  test("output is exactly w x h characters", () => {
    const lines = renderAscii(grid(12, 5, () => 128));
    expect(lines.length).toBe(5);
    expect(lines.every((l) => l.length === 12)).toBe(true);
  });

  test("color emits ANSI that strips back to the same art", () => {
    const s = grid(4, 2, (x) => x * 60);
    s.rgb = new Uint8Array(4 * 2 * 3).fill(200);
    const plain = renderAscii(s);
    const colored = renderAscii(s, { color: true });
    expect(colored[0]).toContain("\x1b[38;2;200;200;200m");
    expect(colored.map(stripAnsi)).toEqual(plain);
  });

  test("edges glyph a hard vertical boundary", () => {
    // Left half black, right half white — a single vertical edge down the middle.
    const s = grid(9, 5, (x) => (x < 4 ? 0 : 255));
    const lines = renderAscii(s, { edges: true, edgeThreshold: 50 });
    expect(lines[2]).toContain("|");
  });
});

describe("renderBraille", () => {
  test("packs 2x4 samples into one cell", () => {
    const lines = renderBraille(grid(8, 8, () => 255), { threshold: 128 });
    expect(lines.length).toBe(2);
    expect(lines[0]!.length).toBe(4);
  });

  test("all-dark fills every dot, all-light fills none", () => {
    expect(renderBraille(grid(2, 4, () => 0), { threshold: 128 })[0]).toBe("⣿");
    expect(renderBraille(grid(2, 4, () => 255), { threshold: 128 })[0]).toBe("⠀");
  });

  test("inverting a dark source recovers the same glyphs", () => {
    const dark = grid(2, 4, () => 20);      // light-on-dark background pixel
    expect(renderBraille(dark, { invert: true })[0]).toBe("⠀");
  });
});

describe("otsu", () => {
  test("splits a bimodal histogram between the two modes", () => {
    const lum = new Uint8Array(200);
    for (let i = 0; i < 100; i++) lum[i] = 20;
    for (let i = 100; i < 200; i++) lum[i] = 220;
    const t = otsu(lum);
    expect(t).toBeGreaterThan(20);
    expect(t).toBeLessThan(220);
  });
});

describe("withGrid", () => {
  test("labels every step-th row and adds a ruler", () => {
    const lines = withGrid(Array.from({ length: 12 }, () => "x".repeat(25)), 10);
    const body = lines.slice(lines.findIndex((l) => l.includes("─")) + 1);
    expect(body.length).toBe(12);
    expect(body[9]).toMatch(/^10 x{25}$/);
    expect(body[0]).toMatch(/^ {2} x{25}$/);
  });

  test("ANSI colour codes do not inflate the measured width", () => {
    const lines = withGrid(["\x1b[38;2;1;2;3mabcde\x1b[0m"], 2);
    expect(lines.find((l) => l.includes("─"))).toBe("  " + "─".repeat(5));
  });
});

describe("fitRows", () => {
  test("halves the row count relative to columns for a square image", () => {
    expect(fitRows(100, 100, 100, 2)).toBe(50);
  });
  test("never returns zero rows for a very wide image", () => {
    expect(fitRows(4000, 10, 40, 2)).toBe(1);
  });
});

test("meanLuminance averages the samples", () => {
  expect(meanLuminance(grid(2, 1, (x) => (x === 0 ? 0 : 100)))).toBe(50);
});
