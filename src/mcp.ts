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

  server.registerTool("see_ask", {
    title: "Ask a vision model about an image",
    description:
      "Send the image to a real vision model and get prose back. This is the ONLY way to read text, " +
      "transcribe a UI, or identify the contents of a photo — see_render gives you layout, this gives " +
      "you the actual content. Use it directly when the question is about what the image SAYS or " +
      "SHOWS; use see_render first only when the question is about where things sit on the page.",
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
