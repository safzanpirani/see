---
name: see
description: Read an image when you have no vision, or bulk-caption an image set — a screenshot, diagram, photo, chart, PDF page, or an image URL. `see ocr` extracts text locally with the OS recogniser (free, offline, sub-second); `see ask` sends it to a vision model for meaning; `see <img>` renders an ASCII layout map. `see caption` bulk-captions a folder into stem-keyed JSON for LoRA training. Use when the user references an image/screenshot/diagram/mockup by path or URL, asks to caption a dataset or training set, pastes a share link (share.safzan.dev, CleanShot, imgur, a CDN), asks "what does this say/show", asks you to transcribe or OCR an image, compare a UI against a design, debug from a screenshot of an error, or when a tool hands back an image path you must act on. Also use instead of writing any ad-hoc pixel-decoding, ASCII-art, or image-parsing script yourself.
---

# see

Global CLI (`~/Development/see`, on PATH). Takes a path, an http(s) URL, or `-` for stdin.
Full flags: `see --help`. MCP tools mirror it: `see_ocr`, `see_ask`, `see_caption`,
`see_render`, `see_info`, `see_ocr_backends`.

| you need | command |
| --- | --- |
| the words — logs, code, errors, docs, UI labels | `see ocr <src>` |
| meaning — what a photo shows, which button is disabled, what a chart implies | `see ask <src> [question]` |
| layout — where blocks sit, page proportions | `see <src> -w 100 --grid` |
| pixel dimensions | `see info <src>` |
| captions for a folder of training images | `see caption <dir> --trigger "<tok>" --txt` |

`see ocr` is local, free and sub-second (Vision on macOS, Windows.Media.Ocr on Windows,
Tesseract on Linux) — try it first for plain text. `see ask` costs an API call and is the
only thing that understands what it is looking at; it needs no setup, and a "no API key"
error means `~/.config/see/key` is missing.

## Do not

- **Never `-m braille`.** Each glyph is one opaque codepoint to you — the eight dots
  inside it are invisible in the token stream. It is for humans at a terminal.
- **Never read text off an ASCII render.** Glyphs smaller than a cell were averaged away.
  Squinting at `:::` guessing letters means you want `see ocr` or `see ask`.
- **Never write your own decoder** — no PIL/sharp/base64/pixel-forensics script, no
  hand-rolled braille or ASCII converter. That loop is what `see` exists to end.
- **Never paste a full render into your reply.** Hundreds of lines, and the user can
  already see the image.

## Asking well

Say what you want back: `see ask err.png "transcribe the stack trace verbatim"`,
`see ask ui.png "list every button label top to bottom with its colour"`. With no
question you get a description plus every visible string in reading order — the right
first move on an unknown image.

On a big image, `see <src> --grid` labels columns and rows so you can name a region, then
aim `see ask` at it ("transcribe the panel in the lower right").

## Bulk captioning

Past a handful of images, never caption inline and never hand it back to the user.

- **It resumes.** Stems already in `--out` are skipped and the file is flushed after every
  image, so a crash or a later batch costs only the missing captions. Re-running the same
  command is also how you retry failures.
- **Report the shot-type histogram it prints.** Under ~20 full-body/wide frames, full-body
  identity does not train — say so before anyone spends a GPU hour.
- **The brief omits face/hair/build/age/ethnicity on purpose.** Those are constant across a
  character set and belong in the trigger token; naming them teaches the model the words
  instead of the subject. Do not "improve" it by adding them. `--extra` adds wardrobe/era
  context, `--prompt-file` replaces it, `--dry-run` shows both before spending.
- Backgrounded runs: grep the last line for `CAPTIONS_WRITTEN [0-9]+` — digits required,
  since the brief itself contains the bare marker — and check the exit code.

Repo: <https://github.com/safzanpirani/see>.
