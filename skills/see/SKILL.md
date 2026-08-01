---
name: see
description: Read an image when you have no vision, or bulk-caption an image set — a screenshot, diagram, photo, chart, PDF page, or an image URL. `see ocr` extracts text locally with the OS recogniser (free, offline, sub-second); `see ask` sends it to a vision model for meaning; `see <img>` renders an ASCII layout map. `see caption` bulk-captions a folder into stem-keyed JSON for LoRA training. Use when the user references an image/screenshot/diagram/mockup by path or URL, asks to caption a dataset or training set, pastes a share link (share.safzan.dev, CleanShot, imgur, a CDN), asks "what does this say/show", asks you to transcribe or OCR an image, compare a UI against a design, debug from a screenshot of an error, or when a tool hands back an image path you must act on. Also use instead of writing any ad-hoc pixel-decoding, ASCII-art, or image-parsing script yourself.
---

# see

`see` is a global CLI (`~/Development/see`, on PATH via `bun link`) that turns an image
into something a text-only model can act on. Local path, http(s) URL, or `-` for stdin.

**The rule: `see ocr` for words, `see ask` for meaning, `see` for layout.** Never try to
read content off the ASCII render — it carries layout and nothing else.

## Quick start

```sh
see ocr shot.png                                # the text — local, free, offline, <1s
see ask shot.png                                # description + full text transcript
see ask shot.png "what's the error in the terminal?"
see ask https://share.safzan.dev/slQAA8YB.webp  # URLs work directly
see shot.png -w 100 --grid                      # local layout map, free, instant
see info shot.png                               # dimensions/format only
see caption ./dataset --trigger "ohwx woman" --txt   # bulk-caption a training set
```

Try `see ocr` first when you only need the text — it costs nothing and takes under a
second. Reach for `see ask` when you need understanding, or when OCR comes back empty
or garbled (a photo, a handwritten note, heavy stylisation).

OCR uses whatever the OS ships: Vision on macOS, Windows.Media.Ocr on Windows, Tesseract
on Linux. `see ocr --backends` shows what this machine has.

## Choosing

| you need | command |
| --- | --- |
| the words: logs, code, stack traces, error dialogs, docs | `see ocr <src>` |
| meaning: what a photo shows, which button is disabled, what a chart implies | `see ask <src> [question]` |
| where blocks sit, rough proportions, is it a wide screenshot or a phone shot | `see <src> -w 100` |
| coordinates to crop into next | `see <src> --grid` then `see ask <src>` |
| just the pixel dimensions | `see info <src>` |
| captions for a folder of training images | `see caption <dir> --trigger "<token>"` |

## Bulk captioning

Past a handful of images, never caption inline and never hand it back to the user —
`see caption <dir> --trigger "<tok>" --txt` does the whole set concurrently into one
stem-keyed JSON plus `.txt` sidecars.

- **It resumes.** Stems already in `--out` are skipped and the file is flushed after every
  image, so a crash or a later batch of additions costs only the missing captions. Just
  re-run the same command — that is also how you retry failures.
- **Check the shot-type histogram it prints.** Under ~20 full-body/wide frames, full-body
  identity does not train; say so before anyone spends a GPU hour.
- **The default brief deliberately omits face/hair/build/age/ethnicity** — those are
  constant across a character set and belong in the trigger token. Do not "improve" the
  brief by adding them. Use `--extra` for wardrobe/era context, `--prompt-file` to replace
  it wholesale, and `--dry-run` to see the brief and the file list before spending.
- Backgrounded runs: grep the last line for `CAPTIONS_WRITTEN [0-9]+` (digits required —
  the brief text itself contains the bare marker), and check the exit code.

## Do not

- **Do not use `-m braille`.** Each braille glyph is one opaque codepoint to you; the
  eight dots inside it are invisible in the token stream. It is for humans at a terminal.
  It will look like detail and read like noise, and you will waste a turn trying to
  decode it.
- **Do not try to read text off an ASCII render.** Any glyph smaller than one character
  cell was averaged away. If you find yourself squinting at `:::` guessing letters, stop
  and run `see ocr` (or `see ask`).
- **Do not write your own decoder.** No `PIL`/`sharp`/base64/pixel-forensics script, no
  hand-rolled braille or ASCII converter. That loop is exactly what `see` exists to end.
- **Do not paste a full-size render into your reply.** It is hundreds of lines and the
  user can already see the image.

## Asking well

The question shapes the answer, so be specific about what you need back:

```sh
see ask err.png "transcribe the stack trace verbatim, no commentary"
see ask ui.png "list every button label, top to bottom, with its colour"
see ask chart.png "give the axis labels and the value at each data point"
see ask design.png "describe spacing, font sizes and colours precisely enough to rebuild in CSS"
```

With no question you get the default: a full description plus every visible string
transcribed in reading order. That is usually the right first move on an unknown image.

## Large or dense images

Two passes beat one huge render. `see <src> --grid` labels columns and rows, so you can
name a region, convert it to source pixels via `see info`, then aim at it:

```sh
see info big.png                                   # 3840x2160
see big.png -w 120 --grid                          # find the region that matters
see ask big.png "transcribe the panel in the lower right"
```

`--crop L,T,W,H` (source pixels) narrows the *render*; for `ask`, just say where to look.

## Keys

Vision calls need a Gemini key, resolved in order:

```
--key K1,K2 → $SEE_API_KEYS → $GEMINI_API_KEYS → $GEMINI_API_KEY → $GOOGLE_API_KEY → ~/.config/see/key
```

The user's key is already in `~/.config/see/key`, so `see ask` works with no setup. Keys
rotate automatically past any that rate-limit, die, or get safety-blocked. A "no API key"
error means that file is missing — free keys at <https://aistudio.google.com/apikey>.

## MCP

Same actions as tools, for MCP clients: `see_ocr`, `see_ocr_backends`, `see_caption`,
`see_ask`, `see_render`, `see_info`.

```sh
claude mcp add see -- bun run ~/Development/see/src/mcp.ts
```

## OCR flags

`--backends` list engines, best first · `--backend vision|windows|tesseract|tesseract.js`
force one · `--lang en-US` (Vision/Windows) or `--lang eng` (Tesseract) · `--json` for
`{backend, ms, lines}`. Empty output means the recogniser found nothing — switch to
`see ask` rather than retrying with another backend.

## Render flags (layout only)

`-w N` columns · `--grid [N]` coordinate ruler · `--edges` Sobel glyphs for boxes/borders
· `--crop L,T,W,H` · `-c ascii|dense|simple|blocks|binary` · `--invert`/`--no-invert`
polarity (auto-detected) · `--color` truecolor · `-o FILE` · `-q` no stderr header ·
`--json` `{text, info, answer}`.

Art goes to stdout, diagnostics to stderr — `see x.png > art.txt` stays clean. A decode
failure (unsupported format, PDF) falls back to the vision model automatically.
Repo: <https://github.com/safzanpirani/see>.
