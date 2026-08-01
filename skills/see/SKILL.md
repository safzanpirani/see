---
name: see
description: Read an image when you have no vision — a screenshot, diagram, photo, chart, PDF page, or an image URL. `see ask` sends it to a vision model and returns a description plus a verbatim transcript of every visible string; `see <img>` renders a local ASCII layout map for free. Use when the user references an image/screenshot/diagram/mockup by path or URL, pastes a share link (share.safzan.dev, CleanShot, imgur, a CDN), asks "what does this say/show", asks you to transcribe or OCR an image, compare a UI against a design, debug from a screenshot of an error, or when a tool hands back an image path you must act on. Also use instead of writing any ad-hoc pixel-decoding, ASCII-art, or image-parsing script yourself.
---

# see

`see` is a global CLI (`~/Development/see`, on PATH via `bun link`) that turns an image
into something a text-only model can act on. Local path, http(s) URL, or `-` for stdin.

**The one rule: `see ask` reads, `see` renders.** Content — words, numbers, code, labels,
what a photo is of — only ever comes from `see ask`. The ASCII render gives you layout
and nothing else.

## Quick start

```sh
see ask shot.png                                # description + full text transcript
see ask shot.png "what's the error in the terminal?"
see ask https://share.safzan.dev/slQAA8YB.webp  # URLs work directly
see shot.png -w 100 --grid                      # local layout map, free, instant
see info shot.png                               # dimensions/format only
```

Default to `see ask`. It is one API call and answers almost every real question.

## Choosing

| you need | command |
| --- | --- |
| what it says / shows / which button is red | `see ask <src> [question]` |
| where blocks sit, rough proportions, is it a wide screenshot or a phone shot | `see <src> -w 100` |
| coordinates to crop into next | `see <src> --grid` then `see ask <src>` |
| just the pixel dimensions | `see info <src>` |

## Do not

- **Do not use `-m braille`.** Each braille glyph is one opaque codepoint to you; the
  eight dots inside it are invisible in the token stream. It is for humans at a terminal.
  It will look like detail and read like noise, and you will waste a turn trying to
  decode it.
- **Do not try to read text off an ASCII render.** Any glyph smaller than one character
  cell was averaged away. If you find yourself squinting at `:::` guessing letters, stop
  and run `see ask`.
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

Same three actions as tools, for MCP clients: `see_render`, `see_ask`, `see_info`.

```sh
claude mcp add see -- bun run ~/Development/see/src/mcp.ts
```

## Render flags (layout only)

`-w N` columns · `--grid [N]` coordinate ruler · `--edges` Sobel glyphs for boxes/borders
· `--crop L,T,W,H` · `-c ascii|dense|simple|blocks|binary` · `--invert`/`--no-invert`
polarity (auto-detected) · `--color` truecolor · `-o FILE` · `-q` no stderr header ·
`--json` `{text, info, answer}`.

Art goes to stdout, diagnostics to stderr — `see x.png > art.txt` stays clean. A decode
failure (unsupported format, PDF) falls back to the vision model automatically.
Repo: <https://github.com/safzanpirani/see>.
