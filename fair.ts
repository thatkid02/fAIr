#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  FAIR — Fast AI Relay
//  Single-file coding agent for Bun. Zero dependencies.
//  Read it. Hack it. Ship it.
// ═══════════════════════════════════════════════════════════════

import * as readline from "readline";

// ──────────────────────────────────────────────────────────────
//  CONFIG
//  Loads/saves API settings from .fair/config.json.
//  Normalizes malformed values (null, NaN) to defaults.
//  The configure() prompt only overwrites fields you change.
// ──────────────────────────────────────────────────────────────

interface Config {
  apiKey: string;
  apiBase: string;
  model: string;
  budget: number;
  contextLimit: number;
}

const DEFAULT_CONFIG: Config = {
  apiKey: "",
  apiBase: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  budget: 10,
  contextLimit: 128000,
};

let CONFIG: Config = { ...DEFAULT_CONFIG };
let CONFIG_FILE = ".fair/config.json";

export function setConfig(c: Config): void { CONFIG = c; }
export function getConfig(): Config { return CONFIG; }
export function getConfigFile(): string { return CONFIG_FILE; }
export function setConfigFile(path: string): void { CONFIG_FILE = path; }

export async function configExists(): Promise<boolean> {
  try {
    const parsed = JSON.parse(await Bun.file(CONFIG_FILE).text());
    return Object.keys(parsed).length > 0;
  } catch { return false; }
}

export async function loadConfig(): Promise<Config> {
  try {
    const parsed = JSON.parse(await Bun.file(CONFIG_FILE).text());
    return {
      apiKey: parsed.apiKey ?? DEFAULT_CONFIG.apiKey,
      apiBase: parsed.apiBase || DEFAULT_CONFIG.apiBase,
      model: parsed.model || DEFAULT_CONFIG.model,
      budget: typeof parsed.budget === "number" && !isNaN(parsed.budget) ? parsed.budget : DEFAULT_CONFIG.budget,
      contextLimit: typeof parsed.contextLimit === "number" && !isNaN(parsed.contextLimit) ? parsed.contextLimit : DEFAULT_CONFIG.contextLimit,
    };
  } catch { return { ...DEFAULT_CONFIG }; }
}

export async function saveConfig(c: Config): Promise<void> {
  await Bun.write(CONFIG_FILE, JSON.stringify(c, null, 2));
}

function isReasoningModel(model: string): boolean {
  const id = model.toLowerCase();
  return (
    id.startsWith("o1") ||
    id.startsWith("o3") ||
    id.startsWith("o4") ||
    id.includes("reasoning") ||
    id.includes("-think-")
  );
}

export async function configure(c: Config, rl: readline.Interface): Promise<Config> {
  console.log("\n── Configuration ──");
  const ask = (q: string, def: string): Promise<string> =>
    new Promise((resolve) => rl.question(`${q} [${def}]: `, (a) => resolve(a.trim())));

  const next: Config = { ...c };

  const key = await ask("API key", c.apiKey);
  if (key) next.apiKey = key;

  const base = await ask("API base URL", c.apiBase);
  if (base) next.apiBase = base;

  const model = await ask("Model", c.model);
  if (model) next.model = model;

  const budget = await ask("Budget (USD)", String(c.budget));
  if (budget) {
    const n = parseFloat(budget);
    if (!isNaN(n)) next.budget = n;
  }

  const limit = await ask("Context limit (tokens)", String(c.contextLimit));
  if (limit) {
    const n = parseInt(limit);
    if (!isNaN(n)) next.contextLimit = n;
  }

  const changed =
    next.apiKey !== c.apiKey ||
    next.apiBase !== c.apiBase ||
    next.model !== c.model ||
    next.budget !== c.budget ||
    next.contextLimit !== c.contextLimit;

  if (changed) {
    await saveConfig(next);
    console.log("Configuration saved.\n");
  } else {
    console.log("No changes.\n");
  }

  return next;
}

// ──────────────────────────────────────────────────────────────
//  TYPES
//  Core data structures: messages, tools, streaming chunks.
// ──────────────────────────────────────────────────────────────

type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface Message {
  role: Role;
  content?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  isError?: boolean;
  images?: string[];
  reasoning_content?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: object;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_calls"; calls: ToolCall[] };

// ──────────────────────────────────────────────────────────────
//  COMMANDS
//  Tab-completion for slash commands in the readline prompt.
// ──────────────────────────────────────────────────────────────

const COMMANDS = [
  "/configure", "/config", "/model ", "/budget ",
  "/clear", "/save", "/compact", "/image ", "/help", "/quit",
];

function completer(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const hits = COMMANDS.filter((c) => c.startsWith(line));
  return [hits.length ? hits : COMMANDS, line];
}

// ──────────────────────────────────────────────────────────────
//  DESIGN SYSTEM
//  256-color ANSI palette. All visual output goes through S.
// ──────────────────────────────────────────────────────────────

const S = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  accent: "\x1b[38;5;111m",   // soft blue
  success: "\x1b[38;5;114m",  // soft green
  error: "\x1b[38;5;203m",    // soft red
  warn: "\x1b[38;5;214m",     // amber
  text: "\x1b[38;5;253m",     // off-white
  muted: "\x1b[38;5;245m",    // gray
  border: "\x1b[38;5;240m",   // dark gray
};

function getTermWidth(): number { return process.stdout.columns || 80; }
function stripAnsi(text: string): string { return text.replace(/\x1b\[[0-9;]*m/g, ""); }

// ──────────────────────────────────────────────────────────────
//  STREAM RENDERER
//  Buffers text by newline. When a line completes, formats it:
//    # header      → accent + bold
//    ## subheader  → bold
//    - bullet      → • prefix
//    ```           → toggle code mode (dim everything)
//    **bold**      → ANSI bold
//    `code`        → ANSI dim
//  Trailing text without \n is flushed at stream end.
// ──────────────────────────────────────────────────────────────

function fmt(s: string): string {
  return S.text + s
    .replace(/\*\*(.+?)\*\*/g, `${S.bold}$1${S.reset}${S.text}`)
    .replace(/`(.+?)`/g, `${S.muted}$1${S.reset}${S.text}`)
    + S.reset;
}

export class StreamRenderer {
  private buf = "";
  private inCode = false;

  private emit(raw: string): void {
    const t = raw.trim();
    if (/^```/.test(t)) { this.inCode = !this.inCode; return; }
    if (this.inCode)  return process.stdout.write(`  ${S.dim}${raw}${S.reset}\n`);
    if (!t)           return process.stdout.write("\n");
    if (t[0] === '#') return process.stdout.write(`\n  ${S.accent}${S.bold}${t.replace(/^#+\s/, '')}${S.reset}\n`);
    if (/^[-*]\s/.test(t)) return process.stdout.write(`  ${S.muted}•${S.reset} ${fmt(t.slice(2).trim())}\n`);
    process.stdout.write(`  ${fmt(raw)}\n`);
  }

  write(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) !== -1) {
      this.emit(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 1);
    }
  }

  flush() {
    if (this.buf) { this.emit(this.buf); this.buf = ""; }
  }
}

// ──────────────────────────────────────────────────────────────
//  DISPLAY
//  One-off prints: welcome, tool call/result, error, help.
// ──────────────────────────────────────────────────────────────

function printWelcome() {
  console.log(`\n  ${S.accent}${S.bold}◆ FAIR${S.reset}  ${S.muted}Fast AI Relay${S.reset}\n  ${S.dim}Type /configure to get started${S.reset}\n`);
}

function printToolCall(name: string, args: Record<string, unknown>) {
  const argsStr = Object.entries(args)
    .map(([k, v]) => `${S.muted}${k}${S.reset}=${S.text}${JSON.stringify(v)}${S.reset}`)
    .join(" ");
  console.log(`\n  ${S.accent}${name}${S.reset}  ${argsStr}`);
}

function printToolResult(name: string, result: ToolResult) {
  const icon = result.isError ? `${S.error}✗${S.reset}` : `${S.success}✓${S.reset}`;
  const lines = result.content.split("\n");
  const shown = lines.slice(0, 8);
  if (lines.length > 8) shown.push(`${S.muted}… ${lines.length - 8} more lines${S.reset}`);
  for (const line of shown) console.log(`  ${S.dim}│${S.reset} ${line}`);
  console.log(`  ${icon}  ${result.isError ? S.error : S.muted}${result.isError ? "error" : "ok"}${S.reset}`);
}

function printError(msg: string) {
  console.log(`\n  ${S.error}✗ ${msg}${S.reset}\n`);
}

function printHelp() {
  console.log(`
  ${S.bold}Commands:${S.reset}
    ${S.accent}/configure${S.reset}       Set API key, model, budget, etc.
    ${S.accent}/config${S.reset}          Show current configuration
    ${S.accent}/model${S.reset} <name>    Quick-switch model
    ${S.accent}/budget${S.reset} <n>      Set budget alert
    ${S.accent}/clear${S.reset}           Clear conversation
    ${S.accent}/save${S.reset}            Save session to disk
    ${S.accent}/compact${S.reset}         Summarize old messages
    ${S.accent}/image${S.reset} <path>    Attach image to next prompt
    ${S.accent}/help${S.reset}            Show this help
    ${S.accent}/quit${S.reset}            Exit
`);
}

// ──────────────────────────────────────────────────────────────
//  STATUS BAR
//  Full-width bar with model, turns, tokens, cost.
//  Color-coded: green/yellow/red based on thresholds.
// ──────────────────────────────────────────────────────────────

function drawStatusBar(messages: Message[], totalCost: number): void {
  const cols = getTermWidth();

  const turns = messages.filter((m) => m.role === "user").length;
  const tokens = estimateTotalTokens(messages);
  const limit = getConfig().contextLimit;
  const budget = getConfig().budget;
  const model = getConfig().model;

  const tokColor = tokens > limit * 0.8 ? S.error : tokens > limit * 0.5 ? S.warn : S.success;
  const costColor = totalCost > budget * 0.8 ? S.error : S.muted;

  const left = `${S.muted}${model}${S.reset}`;
  const mid = `${turns}t  ${tokColor}${(tokens / 1000).toFixed(1)}K${S.reset}/${(limit / 1000).toFixed(0)}K`;
  const right = `${costColor}$${totalCost.toFixed(3)}${S.reset}`;

  const gaps = cols - stripAnsi(left).length - stripAnsi(mid).length - stripAnsi(right).length;
  const g1 = Math.max(Math.floor(gaps / 2), 1);
  const g2 = Math.max(gaps - g1, 1);

  const line = S.border + "─".repeat(cols) + S.reset;
  const text = left + " ".repeat(g1) + mid + " ".repeat(g2) + right;

  process.stdout.write("\n" + line + "\n" + text + "\n" + line + "\n");
}

// ──────────────────────────────────────────────────────────────
//  UTILS
//  Token estimation (chars / 4), cost calculation, pricing table.
// ──────────────────────────────────────────────────────────────

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(m: Message): number {
  let n = 4; // per-message overhead
  if (m.content) n += estimateTokens(m.content);
  if (m.toolCalls) n += m.toolCalls.length * 20;
  if (m.images) n += m.images.length * 1000;
  return n;
}

export function estimateTotalTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

const PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "o1-preview": { input: 15, output: 60 },
  "o1-mini": { input: 3, output: 12 },
};

export function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? { input: 0.15, output: 0.6 };
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

function isBackgroundCommand(cmd: string): boolean {
  return cmd.trimEnd().endsWith("&");
}

// ──────────────────────────────────────────────────────────────
//  TOOLS
//  Five built-in tools: read, write, edit, bash, fallow.
//  Each is a JSON Schema + async execute function.
//  Bash blocks rm -rf / and sudo rm for safety.
//  Background commands (ending with &) skip the kill timeout.
// ──────────────────────────────────────────────────────────────

export const TOOLS: Tool[] = [
  {
    name: "read",
    description: "Read file. Use before edit.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async execute(args) {
      try { return { content: await Bun.file(String(args.path)).text() }; }
      catch (e: any) { return { content: `Error: ${e.message}`, isError: true }; }
    },
  },
  {
    name: "write",
    description: "Write content to a file. Creates or overwrites.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    async execute(args) {
      const content = String(args.content);
      await Bun.write(String(args.path), content);
      return { content: `Wrote ${content.length} bytes to ${args.path}` };
    },
  },
  {
    name: "edit",
    description: "Replace exact text in a file (first occurrence only).",
    parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] },
    async execute(args) {
      const oldText = String(args.oldText);
      if (!oldText) return { content: "Error: oldText cannot be empty", isError: true };
      try {
        const text = await Bun.file(String(args.path)).text();
        if (!text.includes(oldText)) return { content: `Error: oldText not found`, isError: true };
        await Bun.write(String(args.path), text.replace(oldText, String(args.newText)));
        return { content: "Edited" };
      } catch (e: any) { return { content: `Error: ${e.message}`, isError: true }; }
    },
  },
  {
    name: "bash",
    description: "Execute a shell command. Be careful with destructive ops. " +
      "Commands ending with & run in the background (no timeout). " +
      "Default timeout is 60s for foreground commands.",
    parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } }, required: ["command"] },
    async execute(args) {
      const cmd = String(args.command);
      const isBackground = isBackgroundCommand(cmd);
      const timeout = isBackground ? 0 : Number(args.timeout ?? 60000);
      if (cmd.includes("rm -rf /") || cmd.includes("sudo rm")) {
        return { content: "Blocked: dangerous command", isError: true };
      }

      process.stdout.write(`${S.accent}[bash${isBackground ? " bg" : ""}]${S.reset} ${S.text}${cmd}${S.reset}\n`);
      const proc = Bun.spawn(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
      const timer = timeout > 0 ? setTimeout(() => proc.kill(), timeout) : null;

      let stdout = "";
      const reader = proc.stdout.getReader();

      if (isBackground) {
        // Background processes inherit pipes and keep them open.
        // Cancel the reader after a short grace period so we don't hang.
        const bgTimer = setTimeout(() => reader.cancel(), 800);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = new TextDecoder().decode(value);
            stdout += chunk;
            for (const line of chunk.split("\n").filter((l) => l.trim()).slice(0, 3)) {
              process.stdout.write(`${S.muted}  │ ${line}${S.reset}\n`);
            }
          }
        } catch {
          // Reader was cancelled — background process still running
        }
        clearTimeout(bgTimer);
        if (timer) clearTimeout(timer);
        process.stdout.write(`  ${S.success}✓${S.reset}  background started\n`);
        return { content: stdout.trim() || "(background process started)", isError: false };
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = new TextDecoder().decode(value);
        stdout += chunk;
        for (const line of chunk.split("\n").filter((l) => l.trim()).slice(0, 3)) {
          process.stdout.write(`${S.muted}  │ ${line}${S.reset}\n`);
        }
      }

      const stderr = await new Response(proc.stderr).text();
      if (timer) clearTimeout(timer);
      const exitCode = await proc.exited;
      const ok = exitCode === 0;

      process.stdout.write(`  ${ok ? `${S.success}✓` : `${S.error}✗`}${S.reset}  exit ${exitCode}\n`);
      return { content: [stdout, stderr].filter(Boolean).join("\n").trim() || "(no output)", isError: !ok };
    },
  },
  {
    name: "fallow",
    description:
      "Run fallow codebase intelligence on the current project. " +
      "Requires fallow to be installed (bun add -d fallow) or available via bunx. " +
      "Commands: summary (overview), dead-code, dupes, health, audit (changed files), fix (cleanup). " +
      "Always prefer --format json.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: ["summary", "dead-code", "dupes", "health", "audit", "fix"],
          description: "Fallow subcommand",
        },
        extra: {
          type: "string",
          description: "Additional flags, e.g. --dry-run",
        },
      },
      required: ["command"],
    },
    async execute(args) {
      const cmd = String(args.command);
      const extra = args.extra ? ` ${String(args.extra)}` : "";
      const proc = Bun.spawn(
        ["bash", "-c", `bunx fallow ${cmd} --format json${extra}`],
        { stdout: "pipe", stderr: "pipe" }
      );
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exit = await proc.exited;
      const out = stdout || stderr || "(no output)";
      return { content: out.slice(0, 8000), isError: exit !== 0 };
    },
  },
];

// ──────────────────────────────────────────────────────────────
//  PROVIDER
//  formatMessagesForAPI: converts FAIR messages → OpenAI format.
//    Edge case: reasoning models need empty string content, not null.
//  parseSSE: reads SSE stream, reassembles fragmented tool_calls.
//  streamChat: POST to /chat/completions, yield chunks via parseSSE.
// ──────────────────────────────────────────────────────────────

export function formatMessagesForAPI(messages: Message[]): unknown[] {
  const reasoning = isReasoningModel(getConfig().model);
  return messages.map((m) => {
    // User with images → content array (text + image_url blocks)
    if (m.role === "user" && m.images?.length) {
      return {
        role: "user",
        content: [
          { type: "text", text: m.content || "" },
          ...m.images.map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      };
    }

    // Assistant → handle reasoning_content + tool_calls carefully
    if (m.role === "assistant") {
      const base: any = { role: "assistant" };

      // Never send null content — reasoning models and some providers reject it.
      // Empty string is the safe default for all cases.
      base.content = m.content ?? "";

      if (m.reasoning_content !== undefined) base.reasoning_content = m.reasoning_content;

      // Some reasoning-model providers require reasoning_content field to be present
      // even when empty (e.g. DeepSeek, some OpenAI-compatible proxies).
      if (reasoning && base.reasoning_content === undefined) {
        base.reasoning_content = "";
      }

      if (m.toolCalls?.length) {
        base.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        }));
      }
      return base;
    }

    // Tool result
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content || "" };
    }

    // System / plain user
    // Reasoning models (o1, o3, …) use "developer" instead of "system".
    const role = m.role === "system" && reasoning ? "developer" : m.role;
    return { role, content: m.content || "" };
  });
}

export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const acc: Record<number, { id: string; name: string; args: string }> = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split("\n");
    buf = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") return;

      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta;
        const finish = json.choices?.[0]?.finish_reason;

        if (delta?.content) yield { type: "text", text: delta.content };
        if (delta?.reasoning_content) yield { type: "reasoning", text: delta.reasoning_content };

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!acc[tc.index]) acc[tc.index] = { id: "", name: "", args: "" };
            if (tc.id) acc[tc.index].id = tc.id;
            if (tc.function?.name) acc[tc.index].name = tc.function.name;
            if (tc.function?.arguments) acc[tc.index].args += tc.function.arguments;
          }
        }

        if (finish === "tool_calls") {
          yield { type: "tool_calls", calls: Object.values(acc).map((tc: any) => ({ id: tc.id, name: tc.name, args: JSON.parse(tc.args || "{}") })) };
          return;
        }
      } catch {
        // Malformed SSE line — skip
      }
    }
  }
}

export async function* streamChat(messages: Message[], tools: Tool[], signal?: AbortSignal): AsyncGenerator<StreamChunk> {
  const cfg = getConfig();
  const res = await fetch(`${cfg.apiBase}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      messages: formatMessagesForAPI(messages),
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      stream: true,
    }),
    signal,
  });

  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  yield* parseSSE(res.body!);
}

// ──────────────────────────────────────────────────────────────
//  COMPACTOR
//  When context exceeds 80%, summarize old messages into one
//  context block. Keeps the last 4 messages intact.
// ──────────────────────────────────────────────────────────────

export async function compactSession(messages: Message[]): Promise<Message[]> {
  const keep = 4;
  if (messages.length <= keep) return messages;

  const toSummarize = messages.slice(0, -keep);
  const recent = messages.slice(-keep);

  const summaryPrompt: Message = {
    role: "user",
    content:
      "Summarize the following conversation into a brief context paragraph. " +
      "Include all important decisions, code changes, and current state.\n\n" +
      toSummarize.map((m) => {
        if (m.role === "user") return `User: ${m.content}`;
        if (m.role === "assistant") return `Assistant: ${m.content}`;
        if (m.role === "tool") return `[Tool ${m.toolCallId}]: ${m.content?.slice(0, 200)}`;
        return "";
      }).join("\n"),
  };

  const cfg = getConfig();
  const body: any = { model: cfg.model, messages: formatMessagesForAPI([summaryPrompt]) };
  // Reasoning models use max_completion_tokens instead of max_tokens
  if (isReasoningModel(cfg.model)) {
    body.max_completion_tokens = 500;
  } else {
    body.max_tokens = 500;
  }
  const res = await fetch(`${cfg.apiBase}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const summary = (await res.json()).choices?.[0]?.message?.content || "Previous conversation context.";
  return [{ role: "user", content: `[Context]: ${summary}` }, ...recent];
}

// ──────────────────────────────────────────────────────────────
//  SESSION
//  Persist conversations as JSONL (one JSON object per line).
//  Resume with --resume <session-id>.
// ──────────────────────────────────────────────────────────────

export async function saveSession(id: string, messages: Message[]): Promise<void> {
  await Bun.write(`.fair/sessions/${id}.jsonl`, messages.map((m) => JSON.stringify(m)).join("\n"));
}

export async function loadSession(id: string): Promise<Message[]> {
  try {
    return (await Bun.file(`.fair/sessions/${id}.jsonl`).text())
      .trim().split("\n").map((line) => JSON.parse(line));
  } catch { return []; }
}

// ──────────────────────────────────────────────────────────────
//  HISTORY
//  Persist readline input history to .fair/history.
//  Loaded on startup so ↑/↓ arrows recall previous prompts.
// ──────────────────────────────────────────────────────────────

const HISTORY_FILE = ".fair/history";
const MAX_HISTORY = 1000;

export async function loadHistory(): Promise<string[]> {
  try {
    return (await Bun.file(HISTORY_FILE).text())
      .trim().split("\n").filter((l) => l.trim()).slice(-MAX_HISTORY);
  } catch { return []; }
}

export async function saveHistory(history: string[]): Promise<void> {
  const trimmed = history.slice(-MAX_HISTORY);
  await Bun.write(HISTORY_FILE, trimmed.join("\n") + (trimmed.length ? "\n" : ""));
}

// ──────────────────────────────────────────────────────────────
//  AGENT
//  The core loop:
//    1. Stream LLM response (text → renderer, reasoning → buffer)
//    2. If tool calls: execute them in parallel, append results
//    3. Repeat from 1 with tool results in context
//    4. If no tool calls: flush renderer, append assistant msg, done
// ──────────────────────────────────────────────────────────────

async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
  try { return await tool.execute(args); }
  catch (e: any) { return { content: `Error: ${e.message}`, isError: true }; }
}

export async function runTurn(messages: Message[]): Promise<{ inputTokens: number; outputTokens: number; cost: number }> {
  let totalOutputTokens = 0;

  while (true) {
    const inputTokens = estimateTotalTokens(messages);
    let assistantText = "";
    let outputTokens = 0;
    let gotToolCalls = false;

    const abort = new AbortController();
    const onSig = () => abort.abort();
    process.on("SIGINT", onSig);

    const renderer = new StreamRenderer();
    let reasoningText = "";

    try {
      for await (const chunk of streamChat(messages, TOOLS, abort.signal)) {
        if (chunk.type === "text") {
          assistantText += chunk.text;
          renderer.write(chunk.text);
          outputTokens += estimateTokens(chunk.text);
        } else if (chunk.type === "reasoning") {
          reasoningText += chunk.text;
        } else if (chunk.type === "tool_calls") {
          renderer.flush();
          gotToolCalls = true;

          const assistantMsg: Message = { role: "assistant", content: assistantText, toolCalls: chunk.calls };
          if (reasoningText) assistantMsg.reasoning_content = reasoningText;
          messages.push(assistantMsg);
          outputTokens += chunk.calls.length * 20;

          const results = await Promise.all(
            chunk.calls.map(async (call) => {
              printToolCall(call.name, call.args);
              const result = await executeTool(call.name, call.args);
              printToolResult(call.name, result);
              return { toolCallId: call.id, content: result.content, isError: result.isError };
            })
          );

          for (const r of results) {
            messages.push({ role: "tool", toolCallId: r.toolCallId, content: r.content, isError: r.isError });
          }

          totalOutputTokens += outputTokens;
          break;
        }
      }

      if (!gotToolCalls) {
        renderer.flush();
        const assistantMsg: Message = { role: "assistant", content: assistantText };
        if (reasoningText) assistantMsg.reasoning_content = reasoningText;
        messages.push(assistantMsg);
        totalOutputTokens += outputTokens;
        return { inputTokens, outputTokens: totalOutputTokens, cost: calcCost(getConfig().model, inputTokens, totalOutputTokens) };
      }
    } finally {
      process.off("SIGINT", onSig);
    }
  }
}

// ──────────────────────────────────────────────────────────────
//  MAIN
//  CLI entry point. Sets up readline, handles commands,
//  routes user input to the agent loop, persists on exit.
// ──────────────────────────────────────────────────────────────

async function main() {
  await Bun.write(".fair/sessions/.gitkeep", "");

  const history = await loadHistory();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer, history: [...history] });

  const args = process.argv.slice(2);
  const forceConfigure = args.includes("--configure");

  const hasConfig = await configExists();
  setConfig(await loadConfig());

  if (forceConfigure || !hasConfig) {
    if (!hasConfig) printWelcome();
    setConfig(await configure(getConfig(), rl));
  } else if (!getConfig().apiKey) {
    console.log(`\n${S.warn}⚠  No API key set. Run /configure or start with --configure${S.reset}\n`);
  }

  let sessionId = crypto.randomUUID().slice(0, 8);
  let messages: Message[] = [
    {
      role: "system",
      content: `cwd: ${process.cwd()}\ntools: read write edit bash fallow\n\nRules:\n- Be concise. Skip grammar.\n- Format in markdown.\n- Code blocks with \`\`\`.\n- Bold with **text**.\n- Inline code with \`code\`.\n- Bullets with - item.\n- Sections with # / ##.\n- Use fallow before large refactors to understand dead code, duplication, and complexity.\n- Use fallow audit after changes to catch regressions.`,
    },
  ];
  let pendingImages: string[] = [];
  let totalCost = 0;

  if (args[0] === "--resume" && args[1]) {
    sessionId = args[1];
    const loaded = await loadSession(sessionId);
    if (loaded.length) {
      messages = loaded;
      console.log(`Resumed session ${sessionId} (${loaded.length} messages)\n`);
    }
  }

  let shuttingDown = false;
  process.on("SIGINT", async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write("\nSaving… ");
    await saveSession(sessionId, messages);
    await saveHistory(rl.history);
    console.log("done.");
    rl.close();
    process.exit(0);
  });

  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

  drawStatusBar(messages, totalCost);
  console.log("");

  while (true) {
    const input = (await ask(`  ${S.accent}▸${S.reset}  `)).trim();
    if (!input) continue;

    if (input === "/quit" || input === "/q") break;

    if (input === "/help") { printHelp(); continue; }

    if (input === "/configure") {
      setConfig(await configure(getConfig(), rl));
      continue;
    }

    if (input === "/config") {
      const cfg = getConfig();
      console.log(`\n  ${S.bold}Config${S.reset}`);
      console.log(`  ${S.muted}api base${S.reset}  ${cfg.apiBase}`);
      console.log(`  ${S.muted}model${S.reset}     ${cfg.model}`);
      console.log(`  ${S.muted}budget${S.reset}    $${cfg.budget}`);
      console.log(`  ${S.muted}context${S.reset}   ${cfg.contextLimit.toLocaleString()}`);
      console.log(`  ${S.muted}api key${S.reset}   ${cfg.apiKey ? "••••" + cfg.apiKey.slice(-4) : S.error + "not set" + S.reset}\n`);
      continue;
    }

    if (input.startsWith("/model ")) {
      const cfg: Config = { ...getConfig(), model: input.slice(7).trim() };
      setConfig(cfg); await saveConfig(cfg);
      console.log(`Model set to ${cfg.model}\n`);
      continue;
    }

    if (input.startsWith("/budget ")) {
      const n = parseFloat(input.slice(8).trim());
      if (isNaN(n)) { console.log(`${S.error}Invalid budget${S.reset}\n`); continue; }
      const cfg: Config = { ...getConfig(), budget: n };
      setConfig(cfg); await saveConfig(cfg);
      console.log(`Budget set to $${cfg.budget}\n`);
      continue;
    }

    if (input === "/clear") {
      messages = [messages[0]];
      console.log("Cleared.\n");
      drawStatusBar(messages, totalCost);
      continue;
    }

    if (input === "/save") {
      await saveSession(sessionId, messages);
      console.log(`Saved to ${sessionId}\n`);
      continue;
    }

    if (input === "/compact") {
      messages = await compactSession(messages);
      console.log("Compacted.\n");
      drawStatusBar(messages, totalCost);
      continue;
    }

    if (input.startsWith("/image ")) {
      pendingImages.push(input.slice(7).trim());
      console.log(`Image attached: ${pendingImages[pendingImages.length - 1]}\n`);
      continue;
    }

    const userMsg: Message = { role: "user", content: input };
    if (pendingImages.length) {
      userMsg.images = await Promise.all(
        pendingImages.map(async (path) => {
          const b64 = Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64");
          const ext = path.split(".").pop()?.toLowerCase();
          const mime = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
          return `data:${mime};base64,${b64}`;
        })
      );
      pendingImages = [];
    }
    messages.push(userMsg);

    const tokens = estimateTotalTokens(messages);
    if (tokens > getConfig().contextLimit * 0.8) {
      console.log(`\n${S.warn}⚠  Compacting session…${S.reset}\n`);
      messages = await compactSession(messages);
    }

    try {
      const result = await runTurn(messages);
      totalCost += result.cost;
      process.stdout.write("\n");
    } catch (e: any) {
      printError(e.message);
    }

    drawStatusBar(messages, totalCost);
  }

  rl.close();
  await saveSession(sessionId, messages);
  await saveHistory(rl.history);
  console.log("Goodbye.");
}

if (import.meta.main) {
  main();
}
