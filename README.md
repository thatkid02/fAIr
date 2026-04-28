# FAIR — Fast AI Relay

One file. Zero dependencies. A coding agent that fits in your head.

## Requirements

[Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`

## Run

```bash
bun fair.ts              # first run → auto-configure
bun fair.ts --configure  # force reconfigure
```

Config is saved to `.fair/config.json`. Once set, it persists across sessions. Use `--configure` to update or `/configure` inside a session.

## Commands

Type `/` then press **Tab** to see suggestions. Type `/c` + Tab to cycle through matching commands.

| Command | What it does |
|---------|-------------|
| `/configure` | Set API key, model, budget, context limit |
| `/config` | Show current config |
| `/model <name>` | Quick-switch model (saves to config) |
| `/budget <n>` | Set budget alert |
| `/clear` | Clear conversation history |
| `/save` | Save session to disk |
| `/compact` | Summarize old messages manually |
| `/image <path>` | Attach image to next prompt |
| `/help` | Show all commands |
| `/quit` | Exit and save |

## Resume a Session

```bash
bun fair.ts --resume <session-id>
```

Session files live in `.fair/sessions/`.

## Tests

```bash
bun test
```

Covers config, tokenizer, all 4 tools, provider SSE parsing, session save/load, auto-compaction, streaming markdown renderer, and reasoning_content handling.

## Files

```
fair.ts        # 907 lines — the entire harness
fair.test.ts   # 693 lines — 60 tests
package.json   # 9 lines
```

## Config File

`.fair/config.json`:
```json
{
  "apiKey": "sk-...",
  "apiBase": "https://api.openai.com/v1",
  "model": "gpt-4o-mini",
  "budget": 10,
  "contextLimit": 128000
}
```

## Features

- **Single file** — read the whole thing in 15 minutes
- **Zero dependencies** — only needs Bun
- **Native TypeScript** — no build step
- **Minimal TUI** — 256-color soft palette, clean indentation, no boxes
- **Streaming renderer** — plain-text formatting with inline bold, code, headers, lists, and code blocks
- **Streaming** — assistant text streams live; tools show minimal indented output
- **Auto-compaction** — summarizes old messages at 80% context
- **Cost tracking** — running total in the status bar with light border lines, color-coded by budget
- **Image support** — `/image path.png` attaches to next prompt
- **Session persistence** — JSONL format, resume anytime
- **Input history** — ↑/↓ arrows recall previous prompts, persisted to `.fair/history`
- **Tab completion** — `/` + Tab shows all commands
- **Safety** — blocks `rm -rf /` and `sudo rm`
