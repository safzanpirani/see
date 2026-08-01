#!/usr/bin/env bun
/**
 * see-mcp — the renderer as a Model Context Protocol server over stdio,
 * so a model with no vision can call it directly instead of shelling out.
 *
 * Run:   bun run src/mcp.ts
 * Register with Claude Code:
 *        claude mcp add see -- bun run /path/to/see/src/mcp.ts
 *
 * stdio rule: nothing but JSON-RPC may touch stdout — diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MODES, VIEW_DEFAULTS, view } from "./core.ts";
import type { Mode } from "./core.ts";
import { probe, readSource } from "./image.ts";
import { RAMP_NAMES } from "./render.ts";
import { ask, DEFAULT_MODEL, DEFAULT_PROMPT } from "./vlm.ts";
import { availableBackends, BACKENDS, ocrImage } from "./ocr.ts";
import { captionAll, collectTargets, shotTypeHistogram } from "./caption.ts";
import type { BackendName } from "./ocr.ts";

const text = (t: string, isError = false) =>
  ({ content: [{ type: "text" as const, text: t || "(no output)" }], isError });

export function buildServer(): McpServer {
  const server = new McpServer({ name: "see", version: "0.1.0" });

  server.registerTool("see_render", {
    title: "Render an image as readable text",
    description:
      "Convert a local image file or http(s) URL into ASCII art. Good for LAYOUT ONLY: where the " +
      "panels, boxes, columns and blocks of text sit, and roughly how big they are. It CANNOT give " +
      "you the text — any glyph smaller than a character cell is gone, and braille mode is worse " +
      "than useless to you (each braille glyph is one opaque codepoint, not eight readable dots). " +
      "To read words, transcribe UI, or identify anything, call see_ask. Tips: edges=true sharpens " +
      "boxes and borders; grid adds a coordinate ruler so you can cite positions and then crop into " +
      "one region on a second pass.",
    inputSchema: {
      source: z.string().describe("Path to an image file, or an http(s) URL."),
      width: z.number().int().min(4).max(400).optional()
        .describe(`Output columns (default ${VIEW_DEFAULTS.width}). More = more detail = more tokens.`),
      mode: z.enum(MODES as [Mode, ...Mode[]]).optional()
        .describe("'ascii' (default). 'braille' renders for a human terminal and is unreadable to you."),
      charset: z.string().optional()
        .describe(`ASCII ramp: ${RAMP_NAMES.join(", ")}, or a literal ramp string (darkest first).`),
      invert: z.boolean().optional()
        .describe("Force ink polarity. Omit to auto-detect light-on-dark sources."),
      edges: z.boolean().optional().describe("Overlay Sobel edge glyphs — sharpens boxes and borders."),
      grid: z.number().int().min(2).max(50).optional()
        .describe("Draw a coordinate ruler every N cells, for citing positions."),
      crop: z.string().optional()
        .describe("Crop before scaling: 'left,top,width,height' in SOURCE pixels."),
      threshold: z.number().int().min(0).max(255).optional()
        .describe("Braille ink cutoff. Omit for automatic (Otsu) thresholding."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ source, width, mode, charset, invert, edges, grid, crop, threshold }) => {
    let cropRect;
    if (crop) {
      const parts = crop.split(",").map((p) => Number(p.trim()));
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        return text(`crop must be 'left,top,width,height' in source pixels (got '${crop}')`, true);
      }
      const [left, top, w, h] = parts as [number, number, number, number];
      cropRect = { left, top, width: w, height: h };
    }
    try {
      const r = await view(source, {
        width: width ?? VIEW_DEFAULTS.width,
        mode: mode ?? "ascii",
        charset: charset ?? VIEW_DEFAULTS.charset,
        invert: invert ?? "auto",
        edges: edges ?? false,
        grid: grid ?? false,
        crop: cropRect,
        threshold: threshold ?? "auto",
      });
      const i = r.info;
      const header = `${i.format} ${i.srcWidth}x${i.srcHeight} → ${i.cols}x${i.rows} ${i.mode}` +
        `${i.inverted ? " (auto-inverted: light-on-dark source)" : ""}`;
      return text(`${header}\n\n${r.text}`);
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), true);
    }
  });

  server.registerTool("see_info", {
    title: "Inspect image dimensions",
    description: "Report an image's pixel dimensions, format, alpha and page count without rendering it. " +
      "Use this first to pick a sensible width, or to compute crop coordinates.",
    inputSchema: {
      source: z.string().describe("Path to an image file, or an http(s) URL."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ source }) => {
    try {
      const m = await probe(await readSource(source));
      return text(`${source}\n  ${m.width}x${m.height}  ${m.format}` +
        `${m.hasAlpha ? "  alpha" : ""}${m.pages > 1 ? `  ${m.pages} pages` : ""}` +
        `\n  aspect ${(m.width / (m.height || 1)).toFixed(2)}`);
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), true);
    }
  });

  server.registerTool("see_ocr", {
    title: "Extract text from an image (local, no model)",
    description:
      "Run the operating system's own text recogniser over an image and return the text: " +
      "Vision.framework on macOS, Windows.Media.Ocr on Windows, Tesseract on Linux. Local, " +
      "offline, no API call, typically under a second. Use this FIRST whenever you only need the " +
      "words — logs, code, stack traces, error dialogs, documents, dense UI labels. It returns " +
      "strings with no understanding: for what an image MEANS, which element is highlighted, or " +
      "what a photo depicts, use see_ask instead.",
    inputSchema: {
      source: z.string().describe("Path to an image file, or an http(s) URL."),
      backend: z.enum(BACKENDS as [BackendName, ...BackendName[]]).optional()
        .describe("Force a backend. Omit to use the best one this machine has."),
      languages: z.string().optional()
        .describe("Comma-separated language codes, e.g. 'en-US' (Vision/Windows) or 'eng' (Tesseract)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ source, backend, languages }) => {
    try {
      const r = await ocrImage(source, {
        backend,
        languages: languages?.split(",").map((l) => l.trim()).filter(Boolean),
      });
      if (!r.lines.length) {
        return text(`${r.backend} found no text in ${source}. If the image is a photo, a diagram, ` +
          "or the text is very small, call see_ask instead.");
      }
      return text(`${r.backend} · ${r.lines.length} lines · ${r.ms}ms\n\n${r.text}`);
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), true);
    }
  });

  server.registerTool("see_ocr_backends", {
    title: "List available OCR backends",
    description: "Report which local OCR engines this machine can use, best first. Useful when " +
      "see_ocr fails and you need to know whether anything is installed at all.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const have = await availableBackends();
    return text(have.length
      ? have.map((b, i) => `${i === 0 ? "→" : " "} ${b}`).join("\n")
      : "none — install tesseract (brew/apt/choco install tesseract) or run `bun add tesseract.js`");
  });

  server.registerTool("see_caption", {
    title: "Bulk-caption an image set",
    description:
      "Caption a whole folder of images into a stem-keyed JSON file, for LoRA/training datasets. " +
      "Use this INSTEAD of captioning image-by-image yourself once there is more than a handful — " +
      "it runs concurrently, retries rate limits, resumes (stems already in the output file are " +
      "skipped, so new images cost only themselves), and reports a shot-type histogram. The default " +
      "brief describes only what VARIES between photos and never the subject's face/hair/build, " +
      "which is what keeps identity in the trigger token instead of leaking into words.",
    inputSchema: {
      inputs: z.array(z.string()).min(1)
        .describe("Directories, image files, or a targets .json ({stem: path} or [{stem, path}])."),
      out: z.string().describe("Output JSON path, keyed by file stem."),
      trigger: z.string().optional().describe("LoRA trigger token to begin every caption with."),
      extra: z.string().optional().describe("Extra context appended to the brief (era, wardrobe, notes)."),
      prompt: z.string().optional().describe("Replace the built-in caption brief entirely."),
      concurrency: z.number().int().min(1).max(16).optional().describe("Images in flight (default 4)."),
      txt: z.boolean().optional().describe("Also write <stem>.txt beside each image (kohya/diffusers)."),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, async ({ inputs, out, trigger, extra, prompt, concurrency, txt }) => {
    try {
      const targets = collectTargets(inputs);
      if (!targets.length) return text(`no images found in: ${inputs.join(", ")}`, true);
      const existing = await Bun.file(out).exists()
        ? await Bun.file(out).json() as Record<string, string>
        : undefined;
      const acc: Record<string, string> = { ...(existing ?? {}) };
      const flush = async () => Bun.write(out, JSON.stringify(
        Object.fromEntries(Object.keys(acc).sort().map((k) => [k, acc[k]!])), null, 2) + "\n");
      const run = await captionAll(targets, {
        trigger, extra, prompt, existing, concurrency,
        onResult: async (r) => {
          if (r.caption && !r.skipped) { acc[r.stem] = r.caption; await flush(); }
        },
      });
      Object.assign(acc, run.captions);
      await flush();
      if (txt) {
        for (const r of run.records) {
          if (r.caption) await Bun.write(r.path.replace(/\.[^.]+$/, "") + ".txt", r.caption + "\n");
        }
      }
      const shots = Object.entries(shotTypeHistogram(run.captions))
        .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ");
      const failed = run.failed.length
        ? `\n${run.failed.length} failed (re-run to retry only those): ` +
          run.failed.map((f) => `${f.stem} — ${f.error}`).join("; ")
        : "";
      return text(
        `wrote ${Object.keys(run.captions).length} captions to ${out} ` +
        `(${run.skipped} already done, ${run.ms}ms)\nshot types: ${shots}${failed}`);
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), true);
    }
  });

  server.registerTool("see_ask", {
    title: "Ask a vision model about an image",
    description:
      "Send the image to a real vision model and get prose back. Use it when you need UNDERSTANDING: " +
      "what a photo shows, which control is disabled, what a chart implies, how a layout should be " +
      "rebuilt. For plain text extraction prefer see_ocr, which is local, free and faster — fall back " +
      "here when OCR returns nothing, mangles the text, or the question is not answerable from " +
      "strings alone.",
    inputSchema: {
      source: z.string().describe("Path to an image file, or an http(s) URL."),
      question: z.string().optional()
        .describe("What to ask. Omit for a full description plus a verbatim text transcript."),
      model: z.string().optional().describe(`Vision model (default ${DEFAULT_MODEL}).`),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ source, question, model }) => {
    try {
      const bytes = await readSource(source);
      const r = await ask(bytes, { prompt: question ?? DEFAULT_PROMPT, model });
      return text(r.text);
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), true);
    }
  });

  return server;
}

if (import.meta.main) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error("see-mcp (stdio) ready");
}
