import { expect, test, describe, beforeAll } from "bun:test";
import sharp from "sharp";
import { view } from "../src/core.ts";
import { loadSampled, probe } from "../src/image.ts";
import { stripAnsi } from "../src/render.ts";

const DIR = `${import.meta.dir}/fixtures`;
const CHECKER = `${DIR}/checker.png`;   // black left half, white right half
const DARK = `${DIR}/dark.png`;         // white bar on a black field

beforeAll(async () => {
  await Bun.$`mkdir -p ${DIR}`.quiet();
  await sharp({
    create: { width: 200, height: 100, channels: 3, background: "#ffffff" },
  })
    .composite([{
      input: await sharp({ create: { width: 100, height: 100, channels: 3, background: "#000000" } })
        .png().toBuffer(),
      left: 0, top: 0,
    }])
    .png().toFile(CHECKER);

  await sharp({ create: { width: 200, height: 100, channels: 3, background: "#000000" } })
    .composite([{
      input: await sharp({ create: { width: 200, height: 20, channels: 3, background: "#ffffff" } })
        .png().toBuffer(),
      left: 0, top: 40,
    }])
    .png().toFile(DARK);
});

describe("probe", () => {
  test("reports source dimensions and format", async () => {
    const m = await probe(new Uint8Array(await Bun.file(CHECKER).arrayBuffer()));
    expect(m).toMatchObject({ width: 200, height: 100, format: "png" });
  });
});

describe("view", () => {
  test("renders at the requested width with aspect-corrected rows", async () => {
    const r = await view(CHECKER, { width: 40, aspect: 2 });
    expect(r.info.cols).toBe(40);
    expect(r.info.rows).toBe(10);
    expect(r.lines.length).toBe(10);
    expect(r.lines.every((l) => l.length === 40)).toBe(true);
  });

  test("preserves left/right structure: dark half stays dark", async () => {
    const r = await view(CHECKER, { width: 40, aspect: 2 });
    const row = r.lines[5]!;
    expect(row.slice(0, 18)).toMatch(/^@+$/);
    expect(row.slice(22)).toMatch(/^ +$/);
  });

  test("auto-inverts a light-on-dark source so ink reads as dark chars", async () => {
    const r = await view(DARK, { width: 40, aspect: 2 });
    expect(r.info.inverted).toBe(true);
    // The white bar sits at 40-60% height, which is row 4 of 10.
    expect(r.lines[4]).toMatch(/@/);
    expect(r.lines[0]).not.toMatch(/@/);
  });

  test("--no-invert leaves polarity alone", async () => {
    const r = await view(DARK, { width: 40, aspect: 2, invert: false });
    expect(r.info.inverted).toBe(false);
    expect(r.lines[0]).toMatch(/@/);
  });

  test("crop restricts the render to a region of the source", async () => {
    const r = await view(CHECKER, { width: 20, aspect: 2, crop: { left: 120, top: 0, width: 80, height: 100 } });
    expect(r.lines.every((l) => /^ +$/.test(l))).toBe(true);
  });

  test("a crop outside the source is a clear error, not a silent clamp", async () => {
    await expect(view(CHECKER, { crop: { left: 0, top: 0, width: 999, height: 10 } }))
      .rejects.toThrow(/outside the 200x100 source/);
  });

  test("braille mode yields the same cell count as ascii", async () => {
    const r = await view(CHECKER, { width: 40, aspect: 2, mode: "braille" });
    expect(r.lines.length).toBe(10);
    expect(r.lines[0]!.length).toBe(40);
    expect(r.lines[5]).toMatch(/⣿/);
  });

  test("color mode stays the same art underneath the escapes", async () => {
    const plain = await view(CHECKER, { width: 30, aspect: 2 });
    const colored = await view(CHECKER, { width: 30, aspect: 2, color: true });
    expect(colored.lines.map(stripAnsi)).toEqual(plain.lines);
  });

  test("grid adds a ruler and row labels around the art", async () => {
    const r = await view(CHECKER, { width: 40, aspect: 2, grid: 5 });
    expect(r.text).toContain("─".repeat(40));
    expect(r.lines.some((l) => l.startsWith("10 "))).toBe(true);
  });

  test("bad options fail before any decoding happens", async () => {
    await expect(view(CHECKER, { width: 2 })).rejects.toThrow(/width/);
    await expect(view(CHECKER, { charset: "x" })).rejects.toThrow(/charset/);
    await expect(view("/nope/missing.png")).rejects.toThrow(/no such file/);
  });

  test("normalize stretches a low-contrast source into the full ramp", async () => {
    const flat = `${DIR}/flat.png`;
    await sharp({ create: { width: 100, height: 50, channels: 3, background: "#787878" } })
      .composite([{
        input: await sharp({ create: { width: 50, height: 50, channels: 3, background: "#7a7a7a" } })
          .png().toBuffer(),
        left: 50, top: 0,
      }])
      .png().toFile(flat);
    const on = await view(flat, { width: 20, aspect: 2 });
    const off = await view(flat, { width: 20, aspect: 2, normalize: false });
    expect(new Set(on.text.replace(/\n/g, "")).size).toBeGreaterThan(1);
    expect(new Set(off.text.replace(/\n/g, "")).size).toBe(1);
  });
});

describe("loadSampled", () => {
  test("luminance is Rec. 601 weighted, not a flat channel average", async () => {
    const green = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#00ff00" } })
      .png().toBuffer();
    const { sampled } = await loadSampled(new Uint8Array(green), { cols: 2, rows: 2, normalize: false });
    expect(sampled.lum[0]).toBe(150);
  });
});
