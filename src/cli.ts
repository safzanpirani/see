#!/usr/bin/env bun
/**
 * see — look at an image without eyes.
 *
 *   see <image|url|->  [flags]     render it as text (the default)
 *   see ask <src> [question…]      ask a real vision model instead
 *   see info <src>                 dimensions / format, no render
 *   see charsets                   list the built-in ramps
 *
 * The ASCII render is local, instant and free; the VLM is the fallback for
 * anything the ramp cannot carry (small text, photos, undecodable formats).
 */
import { view, VIEW_DEFAULTS, MODES } from "./core.ts";
import type { Mode, ViewOptions } from "./core.ts";
import { probe, readSource, SourceError } from "./image.ts";
import { RAMPS, RAMP_NAMES } from "./render.ts";
import { ask, DEFAULT_MODEL, DEFAULT_PROMPT, FALLBACK_MODEL, resolveKeys } from "./vlm.ts";
import { availableBackends, BACKENDS, ocrImage } from "./ocr.ts";
import { captionAll, captionPrompt, collectTargets, shotTypeHistogram } from "./caption.ts";
import type { BackendName } from "./ocr.ts";

const A = {
  g: (s: string) => `\x1b[32m${s}\x1b[0m`, r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`, d: (s: string) => `\x1b[90m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
function die(m: string): never {
  console.error(A.r("✗ " + m));
  process.exit(1);
}

const HELP = `${A.b("see")} — look at an image without eyes

  ${A.b("see")} <image|url|-> [flags]     render it as text (default)
  ${A.b("see")} caption <dir|imgs…>        bulk-caption a training set → JSON + .txt
  ${A.b("see")} ocr <src>                  extract text locally, no model, no network
  ${A.b("see")} ask <src> [question…]     ask a vision model (${DEFAULT_MODEL})
  ${A.b("see")} info <src>                source dimensions / format
  ${A.b("see")} charsets                  list built-in ramps

render flags
  -w, --width N          output columns (default: terminal width, capped at 200)
  -m, --mode M           ${MODES.join(" | ")}   (braille is for human eyes only — see below)
  -c, --charset C        ${RAMP_NAMES.join("|")}, or a literal ramp (darkest first)
      --invert           force light-on-dark handling
      --no-invert        disable the auto polarity guess
      --color            ANSI truecolor output
      --edges [N]        Sobel edge glyphs above threshold N (default ${VIEW_DEFAULTS.edgeThreshold})
      --grid [N]         coordinate ruler every N cells (default 10)
      --crop L,T,W,H     crop in source pixels before scaling
      --aspect R         cell height:width ratio (default ${VIEW_DEFAULTS.aspect})
      --threshold N      braille ink cutoff 0-255 (default: Otsu)
      --no-normalize     skip contrast stretching
      --bg COLOR         matte behind transparency (default #ffffff)

caption flags
      --out FILE         stem-keyed JSON output (default captions.json)
      --trigger TOK      LoRA trigger token to prefix every caption with
      --txt              also write <stem>.txt beside each image (kohya/diffusers)
      --resume           skip stems already present in --out (default; --no-resume to redo)
      --concurrency N    images in flight (default 4)
      --prompt-file F    replace the built-in caption brief
      --extra TEXT       append context to the brief (era, wardrobe, character notes)
      --dry-run          list what would be captioned, print the brief, call nothing

ocr flags
      --backend B        force ${BACKENDS.join("|")} (default: best available)
      --lang L[,L2]      recognition languages (e.g. en-US, or eng for tesseract)
      --backends         list which OCR backends this machine can use

vision-model flags
  -a, --ask "Q"          also answer a question about the image
      --describe         also print a full VLM description + text transcript
      --no-fallback      fail instead of falling back to the VLM on a decode error
      --model NAME       vision model (default ${DEFAULT_MODEL}; pinning it
                         disables the ${FALLBACK_MODEL} retry on quota)
      --key K[,K2]       API key(s); else $SEE_API_KEYS / $GEMINI_API_KEY / ~/.config/see/key

output flags
  -o, --out FILE         write to a file instead of stdout
  -q, --quiet            no stderr info header
      --json             emit {text, info, answer} as JSON

reading text? ${A.b("see ocr")} is local, free and offline — it uses the OS text
  recogniser (Vision on macOS, Windows.Media.Ocr on Windows, Tesseract on Linux).
  ${A.b("see ask")} costs an API call but understands what it is looking at. Never try
  to read text off the ASCII ramp, and never off braille — a language model
  cannot decode either one.

examples
  see shot.png -w 120                         # layout: panels, blocks, boxes
  see diagram.png --edges --grid              # structure + citable coordinates
  see https://share.safzan.dev/slQAA8YB.webp  # URLs work directly
  see ocr shot.png                            # just the text, offline
  see ask shot.png                            # full description + text transcript
  see ask photo.jpg "what model is the laptop?"
  cat shot.png | see - -q > shot.txt`;

/** Pull a boolean flag out of argv in place. */
function pullFlag(args: string[], ...names: string[]): boolean {
  let found = false;
  for (const n of names) {
    const i = args.indexOf(n);
    if (i >= 0) {
      args.splice(i, 1);
      found = true;
    }
  }
  return found;
}

/**
 * Pull `--flag value` (or `--flag=value`) out of argv in place. With
 * `optional`, a bare `--flag` yields `true` so `--grid` can mean "default step".
 */
function pullVal(args: string[], names: string[], optional = false): string | true | undefined {
  for (const n of names) {
    const i = args.findIndex((a) => a === n || a.startsWith(n + "="));
    if (i < 0) continue;
    const arg = args[i]!;
    if (arg.includes("=")) {
      args.splice(i, 1);
      return arg.slice(arg.indexOf("=") + 1);
    }
    const next = args[i + 1];
    if (next === undefined || (next.startsWith("-") && next !== "-")) {
      if (!optional) die(`${n} needs a value`);
      args.splice(i, 1);
      return true;
    }
    args.splice(i, 2);
    return next;
  }
  return undefined;
}

function num(v: string | true | undefined, flag: string, def: number, min = -Infinity): number {
  if (v === undefined) return def;
  if (v === true) die(`${flag} needs a value`);
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) {
    die(`${flag} needs a number${min > -Infinity ? ` ≥ ${min}` : ""} (got '${v}')`);
  }
  return n;
}

/** Terminal width when we have one, otherwise a size that reads well in a log. */
function defaultWidth(): number {
  const cols = process.stdout.columns;
  return Math.min(200, Math.max(40, cols && cols > 20 ? cols - 1 : 100));
}

function parseCrop(v: string | true | undefined): ViewOptions["crop"] {
  if (v === undefined) return undefined;
  if (v === true) die("--crop needs L,T,W,H");
  const parts = v.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    die(`--crop needs four numbers L,T,W,H (got '${v}')`);
  }
  const [left, top, width, height] = parts as [number, number, number, number];
  return { left, top, width, height };
}

/** Run a VLM call with a spinner-free progress line on stderr. */
async function askVlm(
  src: string, question: string | undefined,
  o: { model?: string; key?: string; quiet: boolean },
): Promise<string> {
  const bytes = await readSource(src);
  const keys = resolveKeys(o.key);
  const r = await ask(bytes, {
    prompt: question,
    model: o.model,
    keys: o.key,
    onAttempt: ({ index, total, model }) => {
      if (!o.quiet && index > 0) console.error(A.y(`… key ${index + 1}/${total} (${model})`));
    },
  });
  if (!o.quiet) {
    console.error(A.d(`${r.model} · key ${r.keyIndex + 1}/${keys.length}` +
      (r.attempts.length ? ` · ${r.attempts.length} key(s) skipped` : "")));
  }
  return r.text;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || pullFlag(args, "-h", "--help", "help")) {
    console.log(HELP);
    return;
  }
  if (pullFlag(args, "-v", "--version")) {
    console.log((await Bun.file(new URL("../package.json", import.meta.url)).json()).version);
    return;
  }

  if (args[0] === "charsets") {
    for (const name of RAMP_NAMES) console.log(`${A.b(name.padEnd(8))} ${RAMPS[name]}`);
    console.log(A.d("\nramps run darkest → lightest; pass any literal string to --charset"));
    return;
  }

  if (args[0] === "info") {
    const src = args[1] ?? die("info needs an image");
    const meta = await probe(await readSource(src));
    console.log(`${A.b(src)}\n  ${meta.width}x${meta.height}  ${meta.format}` +
      `${meta.hasAlpha ? "  alpha" : ""}${meta.pages > 1 ? `  ${meta.pages} pages` : ""}`);
    return;
  }

  const quiet = pullFlag(args, "-q", "--quiet");
  const json = pullFlag(args, "--json");
  const out = pullVal(args, ["-o", "--out"]);
  const modelFlag = pullVal(args, ["--model"]);
  const keyFlag = pullVal(args, ["--key", "--keys"]);
  const model = modelFlag === true || modelFlag === undefined ? undefined : modelFlag;
  const key = keyFlag === true || keyFlag === undefined ? undefined : keyFlag;

  if (args[0] === "caption") {
    args.shift();
    const outPath = (() => {
      const v = pullVal(args, ["--out", "-o"]);
      return v === undefined || v === true ? "captions.json" : String(v);
    })();
    const triggerRaw = pullVal(args, ["--trigger"]);
    const trigger = triggerRaw === undefined || triggerRaw === true ? undefined : String(triggerRaw);
    const extraRaw = pullVal(args, ["--extra"]);
    const extra = extraRaw === undefined || extraRaw === true ? undefined : String(extraRaw);
    const promptFile = pullVal(args, ["--prompt-file"]);
    const wantTxt = pullFlag(args, "--txt");
    const noResume = pullFlag(args, "--no-resume");
    pullFlag(args, "--resume");   // the default; accepted for explicitness
    const dryRun = pullFlag(args, "--dry-run");
    const concurrency = num(pullVal(args, ["--concurrency", "-j"]), "--concurrency", 4, 1);
    const retries = num(pullVal(args, ["--retries"]), "--retries", 3, 1);

    const leftoverFlags = args.filter((a) => a.startsWith("-") && a !== "-");
    if (leftoverFlags.length) die(`unknown flag: ${leftoverFlags[0]}`);
    const inputs = args.filter((a) => !a.startsWith("-"));
    if (!inputs.length) die("caption needs a directory, image files, or a targets .json");

    const prompt = promptFile && promptFile !== true
      ? await Bun.file(String(promptFile)).text()
      : undefined;
    const targets = collectTargets(inputs);
    if (!targets.length) die(`no images found in: ${inputs.join(", ")}`);

    // Resume by default: a bulk run WILL be interrupted, and re-paying for
    // captions you already have is the expensive mistake.
    let existing: Record<string, string> | undefined;
    if (!noResume && await Bun.file(outPath).exists()) {
      try {
        existing = await Bun.file(outPath).json();
      } catch {
        die(`${outPath} exists but is not valid JSON — move it aside or pass --no-resume`);
      }
    }
    const todo = targets.filter((t) => !(existing && t.stem in existing));

    if (dryRun) {
      console.log(`${targets.length} image(s), ${todo.length} to caption, ` +
        `${targets.length - todo.length} already in ${outPath}`);
      for (const t of todo.slice(0, 20)) console.log(`  ${t.stem}  ${A.d(t.path)}`);
      if (todo.length > 20) console.log(A.d(`  … and ${todo.length - 20} more`));
      console.log(A.d("\n── brief ──\n") + (prompt ?? captionPrompt({ trigger, extra })));
      return;
    }

    if (!quiet) {
      console.error(A.d(`${todo.length} to caption (${targets.length - todo.length} already done) ` +
        `· ${concurrency} at a time · → ${outPath}`));
    }

    // Flush after every image so a crash, a rate limit or a Ctrl-C keeps the work.
    // The accumulator lives here rather than reading back from the run, which
    // does not exist yet while its own callbacks are firing.
    const acc: Record<string, string> = { ...(existing ?? {}) };
    // Sorted keys: this file is rewritten after every image, so stable ordering
    // keeps the diffs (and any git history of the dataset) readable.
    const flush = async () => Bun.write(outPath, JSON.stringify(
      Object.fromEntries(Object.keys(acc).sort().map((k) => [k, acc[k]!])), null, 2) + "\n");

    const run = await captionAll(targets, {
      trigger, extra, prompt, existing, concurrency, retries, model, keys: key,
      onResult: async (r, done, total) => {
        if (r.caption && !r.skipped) {
          acc[r.stem] = r.caption;
          await flush();
        }
        if (quiet) return;
        const label = r.error ? A.r("✗") : r.skipped ? A.d("·") : A.g("✓");
        const body = r.error ? A.r(r.error.split("\n")[0]!) : A.d((r.caption ?? "").slice(0, 90));
        console.error(`${label} ${String(done).padStart(String(total).length)}/${total} ${r.stem} ${body}`);
      },
    });
    Object.assign(acc, run.captions);
    await flush();

    if (wantTxt) {
      for (const r of run.records) {
        if (!r.caption) continue;
        await Bun.write(r.path.replace(/\.[^.]+$/, "") + ".txt", r.caption + "\n");
      }
    }

    const histogram = shotTypeHistogram(run.captions);
    if (json) {
      console.log(JSON.stringify({
        out: outPath, total: targets.length, captioned: Object.keys(run.captions).length,
        skipped: run.skipped, failed: run.failed.map((f) => ({ stem: f.stem, error: f.error })),
        shotTypes: histogram, ms: run.ms,
      }, null, 2));
    } else {
      const shots = Object.entries(histogram).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`).join(" · ");
      console.log(`shot types: ${shots}`);
      const fullBody = (histogram["full body"] ?? 0) + (histogram["wide shot"] ?? 0);
      if (fullBody < 20) {
        console.log(A.y(`only ${fullBody} full-body/wide frames — full-body identity usually ` +
          "collapses below ~20, so add more before training on them"));
      }
      if (run.failed.length) {
        console.log(A.r(`${run.failed.length} failed: ${run.failed.map((f) => f.stem).join(", ")}`));
        console.log(A.d("re-run the same command to retry only those"));
      }
    }
    // Sentinel for scripted/backgrounded runs to grep: `CAPTIONS_WRITTEN [0-9]+`.
    console.log(`CAPTIONS_WRITTEN ${Object.keys(run.captions).length}`);
    if (run.failed.length) process.exitCode = 1;
    return;
  }

  if (args[0] === "ocr" || pullFlag(args, "--backends")) {
    const listOnly = args[0] !== "ocr";
    if (!listOnly) args.shift();
    if (listOnly || pullFlag(args, "--backends")) {
      const have = await availableBackends();
      console.log(have.length
        ? have.map((b, i) => `${i === 0 ? A.g("→") : " "} ${b}`).join("\n")
        : A.y("none — install tesseract, or `bun add tesseract.js`"));
      if (!args.length) return;
    }
    const src = args.find((a) => !a.startsWith("-") || a === "-") ?? die("ocr needs an image");
    const backendRaw = pullVal(args, ["--backend"]);
    const backend = backendRaw === undefined || backendRaw === true
      ? undefined
      : backendRaw as BackendName;
    if (backend && !BACKENDS.includes(backend)) {
      die(`--backend must be one of ${BACKENDS.join(", ")} (got '${backend}')`);
    }
    const langRaw = pullVal(args, ["--lang", "--langs"]);
    const languages = langRaw === undefined || langRaw === true
      ? undefined
      : String(langRaw).split(",").map((l) => l.trim()).filter(Boolean);
    const r = await ocrImage(src, { backend, languages });
    const payload = json
      ? JSON.stringify({ source: src, backend: r.backend, ms: r.ms, lines: r.lines }, null, 2)
      : r.text;
    if (out && out !== true) await Bun.write(String(out), payload + "\n");
    else console.log(payload);
    if (!quiet && !json) console.error(A.d(`${r.backend} · ${r.lines.length} lines · ${r.ms}ms`));
    return;
  }

  // `see ask <src> [question…]` — everything after the source is the question.
  if (args[0] === "ask") {
    args.shift();
    const src = args.shift() ?? die("ask needs an image");
    const question = args.join(" ").trim() || DEFAULT_PROMPT;
    const answer = await askVlm(src, question, { model, key, quiet });
    const payload = json ? JSON.stringify({ source: src, question, answer }, null, 2) : answer;
    if (out && out !== true) await Bun.write(String(out), payload + "\n");
    else console.log(payload);
    return;
  }

  const width = num(pullVal(args, ["-w", "--width"]), "--width", defaultWidth(), 4);
  const modeRaw = pullVal(args, ["-m", "--mode"]);
  const mode = (modeRaw === undefined ? "ascii" : String(modeRaw)) as Mode;
  if (!MODES.includes(mode)) die(`--mode must be one of ${MODES.join(", ")} (got '${mode}')`);
  const charset = pullVal(args, ["-c", "--charset"]);
  const noInvert = pullFlag(args, "--no-invert");
  const forceInvert = pullFlag(args, "--invert");
  const color = pullFlag(args, "--color");
  const noNormalize = pullFlag(args, "--no-normalize");
  const noFallback = pullFlag(args, "--no-fallback");
  const describe = pullFlag(args, "--describe");
  const askRaw = pullVal(args, ["-a", "--ask"], true);
  const bg = pullVal(args, ["--bg", "--background"]);
  const aspect = num(pullVal(args, ["--aspect"]), "--aspect", VIEW_DEFAULTS.aspect, 0.1);
  const crop = parseCrop(pullVal(args, ["--crop"]));
  const thresholdRaw = pullVal(args, ["--threshold"]);
  const edgeRaw = pullVal(args, ["--edges", "--edge"], true);
  const gridRaw = pullVal(args, ["--grid"], true);

  const leftover = args.filter((a) => a.startsWith("-") && a !== "-");
  if (leftover.length) die(`unknown flag: ${leftover[0]}`);
  const src = args.find((a) => !a.startsWith("-") || a === "-");
  if (!src) die("need an image path, URL, or - for stdin");
  const extra = args.filter((a) => a !== src);
  if (extra.length) die(`unexpected argument: ${extra[0]} (see renders one image at a time)`);

  let result;
  try {
    result = await view(src, {
      width: Math.floor(width),
      mode,
      charset: charset === undefined ? VIEW_DEFAULTS.charset : String(charset),
      invert: forceInvert ? true : noInvert ? false : "auto",
      color,
      edges: edgeRaw !== undefined,
      edgeThreshold: edgeRaw === true || edgeRaw === undefined
        ? VIEW_DEFAULTS.edgeThreshold
        : num(edgeRaw, "--edges", VIEW_DEFAULTS.edgeThreshold, 0),
      grid: gridRaw === undefined ? false : gridRaw === true ? 10 : Math.floor(num(gridRaw, "--grid", 10, 2)),
      aspect,
      normalize: !noNormalize,
      background: bg === undefined ? VIEW_DEFAULTS.background : String(bg),
      crop,
      threshold: thresholdRaw === undefined ? "auto" : num(thresholdRaw, "--threshold", 128, 0),
    });
  } catch (e) {
    // A decode failure is exactly when eyes beat a character ramp. A source we
    // never got hold of is not — the VLM cannot fetch it either.
    if (noFallback || e instanceof SourceError) throw e;
    const why = e instanceof Error ? e.message : String(e);
    if (!quiet) console.error(A.y(`! cannot render locally (${why}) — falling back to the vision model`));
    const answer = await askVlm(src, askRaw === true || askRaw === undefined ? undefined : askRaw,
      { model, key, quiet });
    const payload = json ? JSON.stringify({ source: src, renderError: why, answer }, null, 2) : answer;
    if (out && out !== true) await Bun.write(String(out), payload + "\n");
    else console.log(payload);
    return;
  }

  const wantVlm = describe || askRaw !== undefined;
  const answer = wantVlm
    ? await askVlm(src, askRaw === true || askRaw === undefined ? undefined : askRaw, { model, key, quiet })
    : undefined;

  const payload = json
    ? JSON.stringify({ text: result.text, info: result.info, answer }, null, 2)
    : answer === undefined
      ? result.text
      : `${result.text}\n\n── ${model ?? DEFAULT_MODEL} ──\n${answer}`;

  if (out && out !== true) {
    await Bun.write(String(out), payload + "\n");
    if (!quiet) console.error(A.g(`✓ wrote ${result.info.cols}x${result.info.rows} to ${out}`));
  } else {
    console.log(payload);
  }
  // Info goes to stderr so a redirected stdout stays pure art.
  if (!quiet && !json) {
    const i = result.info;
    if (mode === "braille") {
      console.error(A.y("! braille is for human eyes — a model reads each glyph as one opaque "
        + "codepoint, not as dots. If a model is consuming this, use `see ask` instead."));
    }
    if (answer === undefined) {
      console.error(A.d(`· need the text? \`see ocr ${src}\` (offline) or \`see ask ${src}\` (understands it)`));
    }
    console.error(A.d(
      `${i.format} ${i.srcWidth}x${i.srcHeight} → ${i.cols}x${i.rows} ${i.mode}` +
      `${i.inverted ? " (inverted)" : ""} · mean luma ${i.meanLuminance}`,
    ));
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
