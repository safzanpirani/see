import { expect, test, describe, beforeAll } from "bun:test";
import sharp from "sharp";
import { availableBackends, BACKENDS, ocrImage } from "../src/ocr.ts";
import { SourceError } from "../src/image.ts";

const DIR = `${import.meta.dir}/fixtures`;
const TEXT = `${DIR}/ocr-text.png`;
const PHRASE = "INVOICE TOTAL 4271";

beforeAll(async () => {
  await Bun.$`mkdir -p ${DIR}`.quiet();
  // Big, high-contrast, single-line: every backend should manage this, so a
  // failure means the backend is broken rather than the image being hard.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="200">
    <rect width="900" height="200" fill="white"/>
    <text x="40" y="130" font-family="Helvetica,Arial,sans-serif" font-size="72"
          fill="black">${PHRASE}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(TEXT);
});

describe("availableBackends", () => {
  test("returns known backend names, best first", async () => {
    const have = await availableBackends();
    expect(have.every((b) => BACKENDS.includes(b))).toBe(true);
    expect(new Set(have).size).toBe(have.length);
  });

  test("offers the platform-native engine first when there is one", async () => {
    const have = await availableBackends();
    if (process.platform === "darwin" && have.includes("vision")) expect(have[0]).toBe("vision");
    if (process.platform === "win32") expect(have[0]).toBe("windows");
  });
});

describe("ocrImage", () => {
  test("reads a plain line of text with whatever backend this machine has", async () => {
    const have = await availableBackends();
    if (!have.length) return;   // CI without any engine: nothing to assert
    const r = await ocrImage(TEXT);
    expect(r.text.toUpperCase().replace(/[^A-Z0-9 ]/g, "")).toContain("INVOICE TOTAL");
    expect(r.text).toContain("4271");
    expect(have).toContain(r.backend);
    expect(r.lines.length).toBeGreaterThan(0);
  }, 60_000);

  test("every backend this machine has can read the same fixture", async () => {
    for (const backend of await availableBackends()) {
      const r = await ocrImage(TEXT, { backend });
      expect(r.backend).toBe(backend);
      expect(r.text).toContain("4271");
    }
  }, 120_000);

  test("a backend this machine lacks is a clear error, not a silent fallback", async () => {
    const have = await availableBackends();
    const missing = BACKENDS.find((b) => !have.includes(b));
    if (!missing) return;
    await expect(ocrImage(TEXT, { backend: missing })).rejects.toThrow(/not available here/);
  });

  test("a missing source fails as a SourceError before any backend runs", async () => {
    await expect(ocrImage("/nope/missing.png")).rejects.toBeInstanceOf(SourceError);
  });

  test("lines are trimmed and blank lines dropped", async () => {
    if (!(await availableBackends()).length) return;
    const r = await ocrImage(TEXT);
    expect(r.lines.every((l) => l.trim().length > 0)).toBe(true);
    expect(r.lines.every((l) => l === l.trimEnd())).toBe(true);
  }, 60_000);
});
