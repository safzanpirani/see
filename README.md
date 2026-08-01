# see

Look at an image without eyes.

`see` gives a text-only model two things: a cheap local ASCII render for
**layout**, and a real vision model for **content**. Ask it what an image *says*
and it uses eyes; ask where things *sit* and it uses the ramp.

```bash
see shot.png                                  # ASCII layout, sized to your terminal
see ask shot.png                              # what it actually says (vision model)
see diagram.png --edges --grid                # structure + citable coordinates
see https://share.safzan.dev/slQAA8YB.webp    # URLs work directly
see ask photo.jpg "what model is the laptop?" # ask a vision model instead
cat shot.png | see - -q > shot.txt            # stdin → file
```

## Install

```bash
bun install
bun link                  # puts `see` on your PATH
# or: bun run build:local # → dist/see, a standalone binary
```

Requires [Bun](https://bun.sh). Decoding is [sharp](https://sharp.pixelplumbing.com)
(PNG, JPEG, WebP, AVIF, GIF, TIFF, SVG).

## What ASCII can and cannot do for a model

An ASCII render carries **layout**: where the panels, columns, boxes and blocks
of text are, and roughly how big. It does not carry **text** — any glyph smaller
than one character cell is averaged into a `:` and is gone for good.

**Braille is worse, not better.** It looks like eight times the detail because a
human eye resolves the dots inside each glyph. A language model does not: `⣿` is
one opaque codepoint, and nothing in the token stream says which of its eight
dots are set. Handing braille to a text model reliably sends it off to write a
decoder and render a PNG — the exact pixel-forensics loop this tool exists to
avoid. `-m braille` is kept for humans looking at a terminal, and `see` warns
when you use it.

So the workflow is:

1. `see info shot.png` — real dimensions.
2. `see shot.png -w 100 --grid` — one cheap pass for layout, with a coordinate
   ruler you can cite ("the button at column 40, row 12").
3. `see ask shot.png` — read it. With no question you get a description plus a
   verbatim transcript of every visible string.
4. `see ask shot.png "transcribe the terminal in the lower right"` — or aim it at
   the region step 2 told you about.

## Modes

| mode | cell | good for |
| --- | --- | --- |
| `ascii` | 1 sample | layout, diagrams, big shapes — safe for models |
| `braille` | 2×4 samples | human eyes on a terminal; **unreadable to a model** |

Character ramps (`--charset`, or `see charsets`): `ascii`, `dense`, `simple`,
`blocks`, `binary` — or pass your own literal ramp, darkest character first.

Polarity is auto-detected: a dark screenshot with light text is inverted so ink
always renders as dense characters. Override with `--invert` / `--no-invert`.

## Vision-model fallback

This is the part that actually reads an image. `see ask <src> [question]` sends
the bytes to Gemini (`gemini-3.5-flash-lite` by default) and prints prose. With
no question you get a full description plus a verbatim transcript of every
visible string.

`--describe` prints the art *and* the description. A local decode failure falls
back to the model automatically — `--no-fallback` turns that off.

Keys are tried in order and rotated past any that 429s, dies, or gets blocked:

```
--key K1,K2  →  $SEE_API_KEYS  →  $GEMINI_API_KEYS  →  $GEMINI_API_KEY
             →  $GOOGLE_API_KEY  →  ~/.config/see/key
```

No key ships with the source. Get a free one at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey) and either
export it or drop it in the config file:

```bash
mkdir -p ~/.config/see && printf '%s\n' "$YOUR_KEY" > ~/.config/see/key
chmod 600 ~/.config/see/key
```

That file takes a comma- or newline-separated list, so it doubles as your
rotation pool.

## Agent skill

`skills/see/SKILL.md` is an [Agent Skill](https://docs.claude.com/en/docs/agents-and-tools/agent-skills)
that teaches a coding agent when to reach for `see` — and, importantly, when not to
(no braille, no reading text off the ramp, no home-grown pixel decoders). Install it by
copying the folder into `~/.claude/skills/`.

## MCP server

Expose the whole thing to an agent as tools — `see_render`, `see_ask`, `see_info`:

```bash
claude mcp add see -- bun run /path/to/see/src/mcp.ts
```

## Flags

```
render
  -w, --width N        output columns (default: terminal width, capped at 200)
  -m, --mode M         ascii | braille
  -c, --charset C      ramp name or a literal ramp
      --invert         force light-on-dark handling
      --no-invert      disable the auto polarity guess
      --color          ANSI truecolor output
      --edges [N]      Sobel edge glyphs above threshold N
      --grid [N]       coordinate ruler every N cells (default 10)
      --crop L,T,W,H   crop in source pixels before scaling
      --aspect R       cell height:width ratio (default 2.1)
      --threshold N    braille ink cutoff 0-255 (default: Otsu)
      --no-normalize   skip contrast stretching
      --bg COLOR       matte behind transparency (default #ffffff)

vision model
  -a, --ask "Q"        also answer a question about the image
      --describe       also print a full description + transcript
      --no-fallback    fail instead of falling back on a decode error
      --model NAME     vision model
      --key K[,K2]     API key(s); see the key chain above

output
  -o, --out FILE       write to a file instead of stdout
  -q, --quiet          no stderr info header
      --json           emit {text, info, answer} as JSON
```

Art goes to stdout, diagnostics to stderr — `see x.png > art.txt` stays clean.

## Development

```bash
bun test          # unit tests, no network
bun run check     # typecheck + tests
```

MIT licensed.

`render.ts` is pure (samples → lines) and holds every pixel decision.
`image.ts` is the only file that knows about sharp. `core.ts` joins them, and
`cli.ts` / `mcp.ts` are thin frontends over that one `view()` call.
