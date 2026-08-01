/**
 * Bulk captioning. Point it at a folder of images and it writes a stem-keyed
 * JSON file (and optionally the `.txt` sidecars that LoRA trainers expect).
 *
 * Everything here assumes the run will be interrupted at some point: results
 * are flushed after every image, and `resume` skips stems that already have a
 * caption. Re-running the same command after a crash, a rate limit, or a batch
 * of new images costs only the missing ones.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { ask } from "./vlm.ts";
import { readSource } from "./image.ts";

/** Extensions we will hand to the model. Matches what sharp/Gemini accept. */
export const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"];

export interface Target {
  /** Key in the output map — the filename without its extension. */
  stem: string;
  path: string;
}

export interface CaptionOptions {
  /** Token the trained model should learn, e.g. "ohwx woman". */
  trigger?: string;
  /** Replaces the built-in caption brief entirely. */
  prompt?: string;
  /** Extra guidance appended to the built-in brief (wardrobe notes, era, …). */
  extra?: string;
  /** Captions already written, keyed by stem. Those stems are skipped. */
  existing?: Record<string, string>;
  /** How many images in flight at once. */
  concurrency?: number;
  /** Attempts per image before giving up. */
  retries?: number;
  model?: string;
  keys?: string | string[];
  /** Called after every image, for progress reporting and incremental saving. */
  onResult?: (r: CaptionRecord, done: number, total: number) => void | Promise<void>;
}

export interface CaptionRecord {
  stem: string;
  path: string;
  caption?: string;
  error?: string;
  ms: number;
  /** True when the stem was already captioned and we skipped the call. */
  skipped?: boolean;
}

export interface CaptionRun {
  captions: Record<string, string>;
  records: CaptionRecord[];
  failed: CaptionRecord[];
  skipped: number;
  ms: number;
}

/**
 * The default brief. It encodes the one rule that makes character-LoRA captions
 * work: describe only what VARIES between images. Anything constant (face,
 * hair, build, ethnicity) must live in the trigger token, not in words — spell
 * it out in the caption and the model learns the words instead of the subject.
 */
export function captionPrompt(opts: { trigger?: string; extra?: string } = {}): string {
  const trigger = opts.trigger?.trim();
  return [
    "Write a single-line training caption for this image.",
    trigger
      ? `Begin the caption with exactly: "${trigger}, "`
      : "Begin with the subject in two or three words.",
    "",
    "Format: <trigger>, wearing <clothing>, <pose and gaze>, <shot type> in <scene>.",
    "",
    "Rules:",
    "- Describe ONLY what varies between photos: clothing, pose, gaze, expression,",
    "  shot type, lighting, setting, props.",
    "- Never describe the subject's face, hair colour, hair length, body build, age or",
    "  ethnicity. Those are constant and belong to the trigger token, not the caption.",
    "- Name the shot type explicitly, using one of: close-up, portrait, upper body,",
    "  cowboy shot, full body, wide shot.",
    "- One line, lower case, comma-separated clauses, no trailing commentary, no markdown,",
    "  no quotes around the caption.",
    "- If the image shows no person, describe the subject matter with the same brevity.",
    opts.extra ? `\nAdditional context:\n${opts.extra}` : "",
  ].filter(Boolean).join("\n");
}

/** Shot-type vocabulary, ordered most specific first so "full body" wins over "body". */
const SHOT_TYPES = [
  "close-up", "closeup", "portrait", "upper body", "cowboy shot",
  "full body", "full-body", "wide shot",
] as const;

/**
 * Count shot types across captions. This is the cheap byproduct that decides
 * whether a full-body LoRA is trainable at all — under roughly 20 full-body
 * frames, full-body identity tends to collapse.
 */
export function shotTypeHistogram(captions: Record<string, string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const caption of Object.values(captions)) {
    const lower = caption.toLowerCase();
    const hit = SHOT_TYPES.find((s) => lower.includes(s));
    const key = hit ? hit.replace("closeup", "close-up").replace("full-body", "full body") : "unlabelled";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Expand files, directories and a targets JSON into a de-duplicated target list. */
export function collectTargets(inputs: string[]): Target[] {
  const out: Target[] = [];
  const seen = new Set<string>();
  const push = (path: string, stem?: string) => {
    const abs = resolve(path);
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push({ stem: stem ?? basename(abs, extname(abs)), path: abs });
  };

  for (const input of inputs) {
    let st;
    try {
      st = statSync(input);
    } catch {
      throw new Error(`no such file or directory: ${input}`);
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(input).sort()) {
        if (IMAGE_EXTS.includes(extname(name).toLowerCase())) push(join(input, name));
      }
    } else if (extname(input).toLowerCase() === ".json") {
      // A targets file: {stem: path} or [{stem, path}] — the shape the existing
      // Codex captioning workflow already produces.
      const raw = JSON.parse(readFileSync(input, "utf8"));
      const entries: Array<[string, string]> = Array.isArray(raw)
        ? raw.map((e: Target) => [e.stem, e.path])
        : Object.entries(raw as Record<string, string>);
      for (const [stem, path] of entries) push(path, stem);
    } else {
      push(input);
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Caption every target, `concurrency` at a time, flushing as it goes. */
export async function captionAll(targets: Target[], opts: CaptionOptions = {}): Promise<CaptionRun> {
  const t0 = Date.now();
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const retries = Math.max(1, opts.retries ?? 3);
  const prompt = opts.prompt ?? captionPrompt({ trigger: opts.trigger, extra: opts.extra });
  const captions: Record<string, string> = { ...(opts.existing ?? {}) };
  const records: CaptionRecord[] = [];

  let next = 0;
  let done = 0;
  const total = targets.length;

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= total) return;
      const target = targets[i]!;
      const started = Date.now();

      if (opts.existing && target.stem in opts.existing) {
        const rec: CaptionRecord = { ...target, caption: opts.existing[target.stem], ms: 0, skipped: true };
        records.push(rec);
        await opts.onResult?.(rec, ++done, total);
        continue;
      }

      let rec: CaptionRecord | undefined;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const bytes = await readSource(target.path);
          const r = await ask(bytes, { prompt, model: opts.model, keys: opts.keys });
          const caption = tidy(r.text);
          if (!caption) throw new Error("model returned an empty caption");
          captions[target.stem] = caption;
          rec = { ...target, caption, ms: Date.now() - started };
          break;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (attempt === retries) {
            rec = { ...target, error: message, ms: Date.now() - started };
          } else {
            // Rate limits are the common failure in a long run; back off rather
            // than burning the remaining attempts in the same second.
            await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500));
          }
        }
      }
      records.push(rec!);
      await opts.onResult?.(rec!, ++done, total);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, total || 1) }, worker));

  records.sort((a, b) => a.stem.localeCompare(b.stem));
  return {
    captions,
    records,
    failed: records.filter((r) => r.error),
    skipped: records.filter((r) => r.skipped).length,
    ms: Date.now() - t0,
  };
}

/** Models like to wrap captions in quotes, prefixes and markdown. Strip that. */
export function tidy(text: string): string {
  // Fences come off FIRST: when a model wraps the caption in ```…```, the first
  // non-empty line is the fence itself, and picking that line first yields "".
  const body = text.trim()
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/, "");
  let s = body.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
  const unquote = (v: string) => v.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  // Quotes can sit either side of a "Caption:" prefix, so unquote around it.
  s = unquote(s).replace(/^(caption|answer)\s*[:\-]\s*/i, "");
  return unquote(s);
}
