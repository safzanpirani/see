# Regenerate with:  vhs demo/demo.tape     (from the repo root)
# Requires: vhs (brew install vhs), and `see` on PATH (bun link).

Output demo/see-demo.gif

Set Shell zsh
Set FontSize 16
Set Width 1100
Set Height 680
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set PlaybackSpeed 1

# Start from a clean prompt with no user config bleeding in.
Hide
Type "PS1='%F{green}❯%f ' && clear" Enter
Show

Sleep 1s

# 1. ASCII layout — the default. No network, no model.
Type "see demo/sample.png -w 84"
Sleep 500ms
Enter
Sleep 5s

Type "clear" Enter
Sleep 500ms

# 2. The text, offline and free.
# Generous sleep: Apple's Vision framework can stall for seconds on a cold
# model load, and VHS types blind — a short sleep buffers keys into the
# still-running process instead of the shell.
Type "see ocr demo/sample.png"
Sleep 500ms
Enter
Sleep 6s

Type "clear" Enter
Sleep 500ms

# 3. Structure + citable coordinates for an agent to point at.
Type "see demo/sample.png -w 84 --edges --grid"
Sleep 500ms
Enter
Sleep 5s
