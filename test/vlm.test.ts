import { expect, test, describe, afterEach } from "bun:test";
import { ask, resolveKeys, sniffMime } from "../src/vlm.ts";

const realFetch = globalThis.fetch;
// Point the key-file lookup at an empty directory so a real ~/.config/see/key
// on the dev machine cannot leak an extra key into these assertions.
process.env.XDG_CONFIG_HOME = `${import.meta.dir}/fixtures/empty-config`;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.SEE_API_KEYS;
  delete process.env.GEMINI_API_KEY;
});

const ok = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });

describe("resolveKeys", () => {
  test("explicit keys come first, then env, in order", () => {
    process.env.SEE_API_KEYS = "env1, env2";
    process.env.GEMINI_API_KEY = "env3";
    expect(resolveKeys("cli1").slice(0, 4)).toEqual(["cli1", "env1", "env2", "env3"]);
  });

  test("duplicates collapse so a key is never retried twice", () => {
    process.env.GEMINI_API_KEY = "same";
    expect(resolveKeys("same").filter((k) => k === "same").length).toBe(1);
  });

  test("no key is compiled into the source", async () => {
    const src = await Bun.file(`${import.meta.dir}/../src/vlm.ts`).text();
    expect(src).not.toMatch(/AIza[0-9A-Za-z_-]{10}/);
  });
});

describe("sniffMime", () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);
  test("recognises the formats we actually get handed", () => {
    expect(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47))).toBe("image/png");
    expect(sniffMime(bytes(0xff, 0xd8, 0xff))).toBe("image/jpeg");
    expect(sniffMime(bytes(0x25, 0x50, 0x44, 0x46))).toBe("application/pdf");
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
    expect(sniffMime(webp)).toBe("image/webp");
  });
});

describe("ask", () => {
  test("returns the first key's answer without touching the rest", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return ok("a cat");
    }) as unknown as typeof fetch;
    const r = await ask(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { keys: "k1,k2" });
    expect(r.text).toBe("a cat");
    expect(r.keyIndex).toBe(0);
    expect(calls).toBe(1);
  });

  test("rotates past a rate-limited key", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>)["x-goog-api-key"]!;
      seen.push(key);
      return key === "k1" ? new Response("quota", { status: 429 }) : ok("answered");
    }) as unknown as typeof fetch;
    const r = await ask(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { keys: "k1,k2" });
    expect(seen).toEqual(["k1", "k2"]);
    expect(r.keyIndex).toBe(1);
    expect(r.attempts[0]).toMatch(/HTTP 429/);
  });

  test("a bad model (404) stops immediately instead of burning every key", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("model not found", { status: 404 });
    }) as unknown as typeof fetch;
    await expect(ask(new Uint8Array([0x89]), { keys: "k1,k2,k3", model: "nope" }))
      .rejects.toThrow(/HTTP 404/);
    expect(calls).toBe(1);
  });

  test("a blocked response rotates rather than returning empty text", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), { status: 200 })
        : ok("fine");
    }) as unknown as typeof fetch;
    const r = await ask(new Uint8Array([0x89]), { keys: "k1,k2" });
    expect(r.text).toBe("fine");
    expect(r.attempts[0]).toMatch(/blocked \(SAFETY\)/);
  });

  test("exhausting every key reports what each one did", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    await expect(ask(new Uint8Array([0x89]), { keys: "k1,k2" }))
      .rejects.toThrow(/all 2 key\(s\) failed/);
  });
});
