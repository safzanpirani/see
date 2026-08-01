import { expect, test, describe, beforeAll, afterEach } from "bun:test";
import sharp from "sharp";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  captionAll, captionPrompt, collectTargets, shotTypeHistogram, tidy,
} from "../src/caption.ts";

const DIR = `${import.meta.dir}/fixtures/caption`;
// Explicit keys everywhere: fetch is mocked, and another test file redirects
// XDG_CONFIG_HOME, so relying on the ambient key chain makes these tests depend
// on file order.
const KEYS = "test-key";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Stand in for the Gemini endpoint: one caption per call, in call order. */
function mockModel(replies: string[] | ((n: number) => string | Error)) {
  let n = 0;
  globalThis.fetch = (async () => {
    const i = n++;
    const r = typeof replies === "function" ? replies(i) : (replies[i] ?? replies.at(-1)!);
    if (r instanceof Error) return new Response(r.message, { status: 500 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: r }] } }] }));
  }) as unknown as typeof fetch;
  return () => n;
}

beforeAll(async () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  for (const name of ["b_second", "a_first", "c_third"]) {
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888888" } })
      .png().toFile(`${DIR}/${name}.png`);
  }
  writeFileSync(`${DIR}/notes.md`, "not an image");
});

describe("collectTargets", () => {
  test("reads a directory, sorted, images only", () => {
    const t = collectTargets([DIR]);
    expect(t.map((x) => x.stem)).toEqual(["a_first", "b_second", "c_third"]);
    expect(t.every((x) => x.path.endsWith(".png"))).toBe(true);
  });

  test("de-duplicates a file also covered by a directory", () => {
    expect(collectTargets([DIR, `${DIR}/a_first.png`]).length).toBe(3);
  });

  test("accepts a targets JSON in either shape, keeping its stems", () => {
    const mapPath = `${DIR}/targets-map.json`;
    writeFileSync(mapPath, JSON.stringify({ custom1: `${DIR}/a_first.png` }));
    expect(collectTargets([mapPath])).toEqual([
      { stem: "custom1", path: `${DIR}/a_first.png` },
    ]);
    const listPath = `${DIR}/targets-list.json`;
    writeFileSync(listPath, JSON.stringify([{ stem: "custom2", path: `${DIR}/b_second.png` }]));
    expect(collectTargets([listPath])[0]!.stem).toBe("custom2");
  });

  test("a missing input is a clear error, not an empty list", () => {
    expect(() => collectTargets(["/nope/gone"])).toThrow(/no such file or directory/);
  });
});

describe("captionPrompt", () => {
  test("pins the trigger token and forbids identity words", () => {
    const p = captionPrompt({ trigger: "ohwx woman" });
    expect(p).toContain('"ohwx woman, "');
    expect(p).toMatch(/Never describe the subject's face/);
  });

  test("extra context is appended, not substituted", () => {
    const p = captionPrompt({ trigger: "t", extra: "1970s wardrobe" });
    expect(p).toContain("1970s wardrobe");
    expect(p).toContain("Format:");
  });
});

describe("tidy", () => {
  test("strips fences, prefixes, quotes and extra lines", () => {
    expect(tidy('```\n"Caption: a cat, full body in a garden"\n```')).toBe("a cat, full body in a garden");
    expect(tidy("first line\nsecond line")).toBe("first line");
    expect(tidy("  spaced  ")).toBe("spaced");
  });
});

describe("captionAll", () => {
  test("captions every target and keys them by stem", async () => {
    mockModel(["one, full body in a park", "two, close-up in a studio", "three, portrait in a hall"]);
    const run = await captionAll(collectTargets([DIR]), { concurrency: 2, keys: KEYS });
    expect(Object.keys(run.captions).sort()).toEqual(["a_first", "b_second", "c_third"]);
    expect(run.failed).toEqual([]);
  });

  test("skips stems that already have a caption and never calls the model for them", async () => {
    const calls = mockModel(["fresh caption, portrait in a room"]);
    const run = await captionAll(collectTargets([DIR]), {
      existing: { a_first: "kept", b_second: "kept too" },
      concurrency: 2, keys: KEYS,
    });
    expect(calls()).toBe(1);                       // only c_third was missing
    expect(run.skipped).toBe(2);
    expect(run.captions.a_first).toBe("kept");     // pre-existing text untouched
    expect(run.captions.c_third).toBe("fresh caption, portrait in a room");
  });

  test("one bad image does not abort the batch", async () => {
    mockModel((i) => (i === 0 ? new Error("boom") : "ok, portrait in a room"));
    const run = await captionAll(collectTargets([DIR]), { concurrency: 1, retries: 1, keys: KEYS });
    expect(run.failed.length).toBe(1);
    expect(Object.keys(run.captions).length).toBe(2);
    expect(run.failed[0]!.error).toBeTruthy();
  });

  test("retries a failing image before giving up", async () => {
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      return n < 3
        ? new Response("rate limited", { status: 429 })
        : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "won, portrait in a room" }] } }] }));
    }) as unknown as typeof fetch;
    const run = await captionAll([{ stem: "solo", path: `${DIR}/a_first.png` }], { retries: 3, keys: KEYS });
    expect(run.captions.solo).toBe("won, portrait in a room");
    expect(run.failed).toEqual([]);
  }, 15_000);

  test("reports progress once per target, including skips", async () => {
    mockModel(["x, portrait in a room"]);
    const seen: number[] = [];
    await captionAll(collectTargets([DIR]), {
      existing: { a_first: "k", b_second: "k" }, keys: KEYS,
      onResult: (_r, done, total) => { seen.push(done); expect(total).toBe(3); },
    });
    expect(seen.sort()).toEqual([1, 2, 3]);
  });
});

describe("shotTypeHistogram", () => {
  test("counts the shot vocabulary and normalises spelling variants", () => {
    const h = shotTypeHistogram({
      a: "x, full body in a park",
      b: "x, full-body in a park",
      c: "x, closeup in a studio",
      d: "x, close-up in a studio",
      e: "x, standing in a hall",
    });
    expect(h["full body"]).toBe(2);
    expect(h["close-up"]).toBe(2);
    expect(h["unlabelled"]).toBe(1);
  });
});
