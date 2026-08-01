/**
 * OCR without a language model. Each platform ships a competent text
 * recogniser; we prefer that, because it needs no install and no download:
 *
 *   macOS    Vision.framework   (VNRecognizeTextRequest, via a tiny cached Swift binary)
 *   Windows  Windows.Media.Ocr  (WinRT, via PowerShell)
 *   Linux    —                  (no system OCR, so Tesseract)
 *
 * Then, everywhere: a `tesseract` binary if the user has one, and finally
 * tesseract.js — WASM, no system dependency at all, and the only backend
 * guaranteed to exist on a fresh clone.
 *
 * OCR returns strings, not meaning. For "which button is disabled" or "what is
 * this a photo of", the vision model in `vlm.ts` is still the answer.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readSource } from "./image.ts";

export type BackendName = "vision" | "windows" | "tesseract" | "tesseract.js";
export const BACKENDS: BackendName[] = ["vision", "windows", "tesseract", "tesseract.js"];

export interface OcrResult {
  text: string;
  lines: string[];
  backend: BackendName;
  ms: number;
}

/** Where we cache the compiled Vision helper. */
const cacheDir = () =>
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "see");

/** Run a command, capturing stdout/stderr. Never throws on a non-zero exit. */
function run(
  cmd: string, args: string[], opts: { input?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

const onPath = async (bin: string) =>
  (await run(process.platform === "win32" ? "where" : "which", [bin], { timeoutMs: 5000 })).code === 0;

// ── macOS: Vision.framework ──────────────────────────────────────────────────

/** Swift source for the helper. ImageIO rather than AppKit so it loads every
 *  format the OS knows, and prints one recognised line per output line. */
const VISION_SWIFT = `import Foundation
import Vision
import ImageIO

let args = CommandLine.arguments
guard args.count > 1,
      let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    FileHandle.standardError.write("cannot read image\\n".data(using: .utf8)!)
    exit(2)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
if args.count > 2 { request.recognitionLanguages = Array(args[2...]) }
do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
    FileHandle.standardError.write("vision failed: \\(error)\\n".data(using: .utf8)!)
    exit(3)
}
for observation in request.results ?? [] {
    if let best = observation.topCandidates(1).first { print(best.string) }
}
`;

/**
 * Compile the Vision helper on first use and cache the binary. Costs a few
 * seconds once; every later call is a plain exec.
 */
export async function ensureVisionBinary(): Promise<string> {
  const dir = cacheDir();
  const bin = join(dir, "vision-ocr");
  const src = join(dir, "vision-ocr.swift");
  mkdirSync(dir, { recursive: true });
  // Recompile if the source changed (a `see` upgrade) or the binary is missing.
  const stale = !existsSync(bin) ||
    (existsSync(src) && statSync(src).mtimeMs > statSync(bin).mtimeMs);
  if (!existsSync(src) || stale) writeFileSync(src, VISION_SWIFT);
  if (existsSync(bin) && !stale) return bin;
  const r = await run("swiftc", ["-O", "-o", bin, src], { timeoutMs: 180_000 });
  if (r.code !== 0 || !existsSync(bin)) {
    throw new Error(`could not build the Vision helper (needs Xcode command line tools): ${r.stderr.trim()}`);
  }
  return bin;
}

// ── Windows: Windows.Media.Ocr via PowerShell ────────────────────────────────

/** WinRT from PowerShell needs the async-to-sync shim; there is no nicer way. */
const WINDOWS_PS = `param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $asTask.MakeGenericMethod($type).Invoke($null, @($op)).GetAwaiter().GetResult() }

[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime] | Out-Null

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { Write-Error 'no OCR language pack installed'; exit 3 }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
foreach ($line in $result.Lines) { [Console]::Out.WriteLine($line.Text) }
`;

/** Windows.Media.Ocr only exists on PowerShell 5.1 (Desktop CLR), not pwsh 7. */
async function runWindowsOcr(path: string): Promise<string> {
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "windows-ocr.ps1");
  writeFileSync(script, WINDOWS_PS);
  const r = await run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", script, "-Path", path,
  ]);
  if (r.code !== 0) throw new Error(`Windows OCR failed: ${r.stderr.trim().split("\n")[0] ?? r.code}`);
  return r.stdout;
}

// ── Backend availability ─────────────────────────────────────────────────────

/** Which backends could run here, best first. Cheap probes only. */
export async function availableBackends(): Promise<BackendName[]> {
  const out: BackendName[] = [];
  if (process.platform === "darwin" && await onPath("swiftc")) out.push("vision");
  if (process.platform === "win32") out.push("windows");
  if (await onPath("tesseract")) out.push("tesseract");
  if (await hasTesseractJs()) out.push("tesseract.js");
  return out;
}

/** tesseract.js is deliberately NOT a dependency — it is ~50 MB and pointless on
 *  a Mac or a Windows box that already has a system recogniser. The specifier is
 *  held in a variable so the optional import does not become a hard type
 *  dependency for anyone who never installs it. */
const TESSERACT_JS = "tesseract.js";

async function loadTesseractJs(): Promise<{ createWorker: (lang: string) => Promise<{
  recognize: (path: string) => Promise<{ data: { text: string } }>;
  terminate: () => Promise<unknown>;
}> }> {
  return await import(TESSERACT_JS);
}

async function hasTesseractJs(): Promise<boolean> {
  try {
    await loadTesseractJs();
    return true;
  } catch {
    return false;
  }
}

// ── The public entry point ───────────────────────────────────────────────────

export interface OcrOptions {
  /** Force one backend instead of taking the best available. */
  backend?: BackendName;
  /** BCP-47 / Tesseract language codes, e.g. ["en-US"] or ["eng"]. */
  languages?: string[];
}

/** Recognise text in an image. Accepts a path, an http(s) URL, or `-`. */
export async function ocrImage(src: string, opts: OcrOptions = {}): Promise<OcrResult> {
  const path = await materialise(src);
  const available = await availableBackends();
  if (opts.backend && !available.includes(opts.backend)) {
    throw new Error(
      `backend '${opts.backend}' is not available here (have: ${available.join(", ") || "none"})`,
    );
  }
  const order = opts.backend ? [opts.backend] : available;
  if (!order.length) {
    throw new Error(
      "no OCR backend available. Install tesseract (brew/apt/choco install tesseract), " +
      "or add the WASM fallback with `bun add tesseract.js`.",
    );
  }

  const failures: string[] = [];
  for (const backend of order) {
    const t0 = Date.now();
    try {
      const text = await runBackend(backend, path, opts.languages);
      const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
      return { text: lines.join("\n"), lines, backend, ms: Date.now() - t0 };
    } catch (e) {
      failures.push(`${backend}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`every OCR backend failed:\n  ${failures.join("\n  ")}`);
}

async function runBackend(backend: BackendName, path: string, languages?: string[]): Promise<string> {
  switch (backend) {
    case "vision": {
      const bin = await ensureVisionBinary();
      const r = await run(bin, [path, ...(languages ?? [])]);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      return r.stdout;
    }
    case "windows":
      return runWindowsOcr(path);
    case "tesseract": {
      const langs = languages?.length ? ["-l", languages.join("+")] : [];
      const r = await run("tesseract", [path, "-", ...langs]);
      if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`);
      return r.stdout;
    }
    case "tesseract.js": {
      const { createWorker } = await loadTesseractJs();
      const worker = await createWorker(languages?.length ? languages.join("+") : "eng");
      try {
        const { data } = await worker.recognize(path);
        return data.text;
      } finally {
        await worker.terminate();
      }
    }
  }
}

/** Every backend wants a real file, so URLs and stdin get spilled to one. */
async function materialise(src: string): Promise<string> {
  if (src !== "-" && !/^https?:\/\//.test(src)) {
    // Let readSource produce the "no such file" error rather than the backend.
    await readSource(src);
    return src;
  }
  const bytes = await readSource(src);
  const path = join(tmpdir(), `see-ocr-${process.pid}-${bytes.length}.img`);
  writeFileSync(path, bytes);
  return path;
}
