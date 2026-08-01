/**
 * The eyes of last resort. When the ASCII render is not enough — an unreadable
 * font, a photo, a format the decoder chokes on — we hand the raw bytes to a
 * real vision model and get prose back.
 *
 * Keys are tried in order and rotated on any failure, so a rate-limited or dead
 * key costs one retry rather than the whole run.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Last resort in the key chain: one key (or a comma/newline list) per user.
 *  Resolved per call so a test (or a wrapper) can move it with XDG_CONFIG_HOME. */
export const keyFilePath = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "see", "key");

export const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export const DEFAULT_PROMPT =
  "Describe this image for a reader who cannot see it. Transcribe ALL visible text verbatim, " +
  "preserving reading order and structure (headings, lists, code, UI labels, buttons). Then " +
  "describe the layout, and any diagrams, charts, or images. Be complete and literal — do not " +
  "summarise away detail, and do not speculate about anything you cannot actually see.";

/** Read `~/.config/see/key`, if it exists. Missing or unreadable is not an
 *  error — it is just one empty source in the chain. */
function fromKeyFile(): string[] {
  try {
    return readFileSync(keyFilePath(), "utf8").split(/[,\n]/);
  } catch {
    return [];
  }
}

/**
 * Collect API keys, most-specific first: `--key`, `SEE_API_KEYS` /
 * `GEMINI_API_KEYS` (comma-separated), `GEMINI_API_KEY`, `GOOGLE_API_KEY`, then
 * `~/.config/see/key`. No key ships with the source.
 */
export function resolveKeys(explicit?: string | string[]): string[] {
  const fromEnv = (name: string) => (process.env[name] ?? "").split(",");
  const all = [
    ...(Array.isArray(explicit) ? explicit : explicit ? explicit.split(",") : []),
    ...fromEnv("SEE_API_KEYS"),
    ...fromEnv("GEMINI_API_KEYS"),
    ...fromEnv("GEMINI_API_KEY"),
    ...fromEnv("GOOGLE_API_KEY"),
    ...fromKeyFile(),
  ].map((k) => k.trim()).filter(Boolean);
  return [...new Set(all)];
}

/** Guess a MIME type from magic bytes; Gemini rejects a wrong one outright. */
export function sniffMime(bytes: Uint8Array): string {
  const b = bytes;
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46)) return "image/gif";
  // "RIFF" .... "WEBP" — the size field sits between the two tags.
  if (starts(0x52, 0x49, 0x46, 0x46) &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "image/avif";
  if (starts(0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)) return "image/tiff";
  return "image/png";
}

export interface AskOptions {
  prompt?: string;
  model?: string;
  keys?: string | string[];
  /** Per-attempt timeout in ms. */
  timeoutMs?: number;
  /** Called before each key attempt, for progress reporting. */
  onAttempt?: (info: { index: number; total: number; model: string }) => void;
}

export interface AskResult {
  text: string;
  model: string;
  /** 0-based index of the key that worked. */
  keyIndex: number;
  /** Human-readable reason each earlier key was abandoned. */
  attempts: string[];
}

/** Ask a vision model about an image. Rotates keys until one answers. */
export async function ask(bytes: Uint8Array, opts: AskOptions = {}): Promise<AskResult> {
  const keys = resolveKeys(opts.keys);
  if (!keys.length) {
    throw new Error(
      `no API key. Set GEMINI_API_KEY, pass --key, or write one to ${keyFilePath()}\n` +
      "  Free keys: https://aistudio.google.com/apikey",
    );
  }
  const model = opts.model ?? DEFAULT_MODEL;
  const mime = sniffMime(bytes);
  const body = JSON.stringify({
    contents: [{
      role: "user",
      parts: [
        { inline_data: { mime_type: mime, data: Buffer.from(bytes).toString("base64") } },
        { text: opts.prompt ?? DEFAULT_PROMPT },
      ],
    }],
  });

  const attempts: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    opts.onAttempt?.({ index: i, total: keys.length, model });
    try {
      const res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": keys[i]! },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300).replace(/\s+/g, " ");
        attempts.push(`key ${i + 1}: HTTP ${res.status} ${detail}`);
        // 400 usually means a bad model name or malformed image — the next key
        // would fail identically, so stop rather than burn every key.
        if (res.status === 400 || res.status === 404) break;
        continue;
      }
      const json = await res.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
        promptFeedback?: { blockReason?: string };
      };
      const blocked = json.promptFeedback?.blockReason;
      if (blocked) {
        attempts.push(`key ${i + 1}: blocked (${blocked})`);
        continue;
      }
      const text = (json.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "").join("").trim();
      if (!text) {
        attempts.push(`key ${i + 1}: empty response (${json.candidates?.[0]?.finishReason ?? "no reason"})`);
        continue;
      }
      return { text, model, keyIndex: i, attempts };
    } catch (e) {
      attempts.push(`key ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`all ${keys.length} key(s) failed:\n  ${attempts.join("\n  ")}`);
}
