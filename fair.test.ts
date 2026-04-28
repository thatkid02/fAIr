import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync } from "node:fs";
import * as fair from "./fair.ts";
import type { Message } from "./fair.ts";

// ── Helpers ──────────────────────────────────────────────────

function mockReadline(inputs: string[]) {
  let i = 0;
  return {
    question: (_q: string, cb: (a: string) => void) => cb(inputs[i++] ?? ""),
    close: () => {},
  } as any;
}

function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(line));
      controller.close();
    },
  });
}

let originalFetch: typeof fetch;
let stdoutChunks: string[] = [];
let originalStdoutWrite: typeof process.stdout.write;

function captureStdout() {
  stdoutChunks = [];
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...args: any[]) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as any;
}

function restoreStdout() {
  process.stdout.write = originalStdoutWrite;
}

function getOutput(): string {
  return stdoutChunks.join("");
}

// ── Setup / Teardown ─────────────────────────────────────────

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fair.setConfigFile(".fair/test-config.json");
  fair.setConfig({
    apiKey: "test-key",
    apiBase: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    budget: 10,
    contextLimit: 128000,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  fair.setConfigFile(".fair/config.json");
  fair.setConfig({
    apiKey: "test-key",
    apiBase: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    budget: 10,
    contextLimit: 128000,
  });
  try { unlinkSync(".fair/test-config.json") } catch {}
  try { unlinkSync(".fair/sessions/test-session.jsonl") } catch {}
  try { unlinkSync(".fair/history") } catch {}
  restoreStdout();
});

// ── StreamRenderer Tests ─────────────────────────────────────

describe("StreamRenderer", () => {
  test("buffers until newline", () => {
    const r = new fair.StreamRenderer();
    captureStdout();
    r.write("Hello");
    expect(getOutput()).toBe("");
    r.write(" world\n");
    expect(getOutput()).toContain("Hello world");
    restoreStdout();
  });

  test("formats header", () => {
    const r = new fair.StreamRenderer();
    captureStdout();
    r.write("# Title\n");
    expect(getOutput()).toContain("Title");
    restoreStdout();
  });

  test("formats subtitle", () => {
    const r = new fair.StreamRenderer();
    captureStdout();
    r.write("## Subtitle\n");
    expect(getOutput()).toContain("Subtitle");
    restoreStdout();
  });

  test("formats bullet", () => {
    const r = new fair.StreamRenderer();
    captureStdout();
    r.write("- item one\n");
    expect(getOutput()).toContain("item one");
    restoreStdout();
  });

  test("``` starts code block", () => {
    const r = new fair.StreamRenderer();
    captureStdout();
    r.write("```\n");
    r.write("const x = 1;\n");
    expect(getOutput()).toContain("const x = 1");
    restoreStdout();
  });

  test("``` ends code block", () => {
    const r = new fair.StreamRenderer();
    captureStdout();
    r.write("```\n");
    r.write("const x = 1;\n");
    r.write("```\n");
    r.write("done\n");
    const out = getOutput();
    expect(out).toContain("const x = 1");
    expect(out).toContain("done");
    restoreStdout();
  });

  test("code with language", () => {
    const r = new fair.StreamRenderer();
    captureStdout();
    r.write("```js\n");
    r.write("return 42;\n");
    r.write("```\n");
    expect(getOutput()).toContain("return 42");
    restoreStdout();
  });

  test("flush renders trailing text", () => {
    const r = new fair.StreamRenderer();
    captureStdout();
    r.write("no newline");
    r.flush();
    expect(getOutput()).toContain("no newline");
    restoreStdout();
  });

  test("inline bold", () => {
    const r = new fair.StreamRenderer();
    captureStdout();
    r.write("**bold** text\n");
    const out = getOutput();
    expect(out).toContain("bold");
    expect(out).not.toContain("**");
    restoreStdout();
  });

  test("inline code", () => {
    const r = new fair.StreamRenderer();
    captureStdout();
    r.write("`code` here\n");
    expect(getOutput()).toContain("code");
    restoreStdout();
  });

  test("multi-chunk line", () => {
    const r = new fair.StreamRenderer();
    captureStdout();
    r.write("Hel");
    r.write("lo\n");
    expect(getOutput()).toContain("Hello");
    restoreStdout();
  });
});

// ── Config ───────────────────────────────────────────────────

describe("config", () => {
  test("loadConfig returns defaults when file missing", async () => {
    const c = await fair.loadConfig();
    expect(c.apiBase).toBe("https://api.openai.com/v1");
    expect(c.model).toBe("gpt-4o-mini");
    expect(c.apiKey).toBe("");
  });

  test("saveConfig and loadConfig round-trip", async () => {
    const c = { ...fair.getConfig(), apiKey: "sk-secret", model: "gpt-4o" };
    await fair.saveConfig(c);
    const loaded = await fair.loadConfig();
    expect(loaded.apiKey).toBe("sk-secret");
    expect(loaded.model).toBe("gpt-4o");
  });

  test("configure updates all fields", async () => {
    const rl = mockReadline(["sk-new", "https://local.com/v1", "gpt-4", "5", "64000"]);
    const result = await fair.configure({ ...fair.getConfig() }, rl);
    expect(result.apiKey).toBe("sk-new");
    expect(result.apiBase).toBe("https://local.com/v1");
    expect(result.model).toBe("gpt-4");
    expect(result.budget).toBe(5);
    expect(result.contextLimit).toBe(64000);
  });

  test("configure keeps defaults on empty input", async () => {
    const base = { ...fair.getConfig(), apiKey: "sk-existing" };
    const rl = mockReadline(["", "", "", "", ""]);
    const result = await fair.configure(base, rl);
    expect(result.apiKey).toBe("sk-existing");
    expect(result.apiBase).toBe(base.apiBase);
    expect(result.model).toBe(base.model);
  });

  test("configure does not mutate input object", async () => {
    const base = { ...fair.getConfig(), apiKey: "sk-original", model: "gpt-4o" };
    const rl = mockReadline(["", "gpt-4o-mini", "", "", ""]);
    await fair.configure(base, rl);
    expect(base.apiKey).toBe("sk-original");
    expect(base.model).toBe("gpt-4o");
  });

  test("loadConfig normalizes null budget to default", async () => {
    await Bun.write(fair.getConfigFile(), JSON.stringify({ apiKey: "sk-test", budget: null }));
    const loaded = await fair.loadConfig();
    expect(loaded.apiKey).toBe("sk-test");
    expect(loaded.budget).toBe(10);
  });

  test("loadConfig normalizes NaN contextLimit to default", async () => {
    await Bun.write(fair.getConfigFile(), JSON.stringify({ apiKey: "sk-test", contextLimit: NaN }));
    const loaded = await fair.loadConfig();
    expect(loaded.apiKey).toBe("sk-test");
    expect(loaded.contextLimit).toBe(128000);
  });
});

// ── Tokenizer ────────────────────────────────────────────────

describe("tokenizer", () => {
  test("estimateTokens approximates", () => {
    expect(fair.estimateTokens("hello world")).toBeGreaterThan(0);
    expect(fair.estimateTokens("")).toBe(0);
    expect(fair.estimateTokens("a".repeat(400))).toBe(100);
  });

  test("estimateMessageTokens includes overhead", () => {
    const m: Message = { role: "user", content: "hello" };
    expect(fair.estimateMessageTokens(m)).toBeGreaterThan(4);
  });

  test("estimateMessageTokens counts images", () => {
    const m: Message = { role: "user", content: "hi", images: ["data:..."] };
    expect(fair.estimateMessageTokens(m)).toBeGreaterThan(1000);
  });

  test("estimateMessageTokens counts tool calls", () => {
    const m: Message = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "read", args: {} }],
    };
    expect(fair.estimateMessageTokens(m)).toBeGreaterThan(20);
  });

  test("estimateTotalTokens sums messages", () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    expect(fair.estimateTotalTokens(messages)).toBe(
      fair.estimateMessageTokens(messages[0]) + fair.estimateMessageTokens(messages[1])
    );
  });
});

describe("cost", () => {
  test("calcCost for gpt-4o-mini", () => {
    const cost = fair.calcCost("gpt-4o-mini", 1000, 500);
    expect(cost).toBeCloseTo((1000 * 0.15 + 500 * 0.6) / 1_000_000, 10);
  });

  test("calcCost for gpt-4o", () => {
    const cost = fair.calcCost("gpt-4o", 2000, 1000);
    expect(cost).toBeCloseTo((2000 * 2.5 + 1000 * 10) / 1_000_000, 10);
  });

  test("calcCost falls back for unknown model", () => {
    const cost = fair.calcCost("unknown-model", 1000, 500);
    expect(cost).toBeCloseTo((1000 * 0.15 + 500 * 0.6) / 1_000_000, 10);
  });
});

// ── Tools ────────────────────────────────────────────────────

describe("tools", () => {
  test("read tool reads file", async () => {
    await Bun.write("test-file.txt", "hello world");
    const tool = fair.TOOLS.find((t) => t.name === "read")!;
    const result = await tool.execute({ path: "test-file.txt" });
    expect(result.content).toBe("hello world");
    expect(result.isError).toBeUndefined();
  });

  test("read tool errors on missing file", async () => {
    const tool = fair.TOOLS.find((t) => t.name === "read")!;
    const result = await tool.execute({ path: "nonexistent.txt" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error");
  });

  test("write tool creates file", async () => {
    const tool = fair.TOOLS.find((t) => t.name === "write")!;
    const result = await tool.execute({ path: "test-new.txt", content: "new content" });
    expect(result.isError).toBeUndefined();
    const text = await Bun.file("test-new.txt").text();
    expect(text).toBe("new content");
  });

  test("edit tool replaces first occurrence", async () => {
    await Bun.write("test-edit.txt", "hello old world old");
    const tool = fair.TOOLS.find((t) => t.name === "edit")!;
    const result = await tool.execute({ path: "test-edit.txt", oldText: "old", newText: "new" });
    expect(result.isError).toBeUndefined();
    const text = await Bun.file("test-edit.txt").text();
    expect(text).toBe("hello new world old");
  });

  test("edit tool errors when oldText not found", async () => {
    await Bun.write("test-edit.txt", "hello world");
    const tool = fair.TOOLS.find((t) => t.name === "edit")!;
    const result = await tool.execute({ path: "test-edit.txt", oldText: "missing", newText: "x" });
    expect(result.isError).toBe(true);
  });

  test("edit tool errors on empty oldText", async () => {
    const tool = fair.TOOLS.find((t) => t.name === "edit")!;
    const result = await tool.execute({ path: "test-edit.txt", oldText: "", newText: "x" });
    expect(result.isError).toBe(true);
  });

  test("bash tool executes command", async () => {
    const tool = fair.TOOLS.find((t) => t.name === "bash")!;
    const result = await tool.execute({ command: "echo hello-from-test" });
    expect(result.content).toContain("hello-from-test");
    expect(result.isError).toBe(false);
  });

  test("bash tool errors on bad exit code", async () => {
    const tool = fair.TOOLS.find((t) => t.name === "bash")!;
    const result = await tool.execute({ command: "exit 1" });
    expect(result.isError).toBe(true);
  });

  test("bash tool blocks rm -rf /", async () => {
    const tool = fair.TOOLS.find((t) => t.name === "bash")!;
    const result = await tool.execute({ command: "rm -rf /" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Blocked");
  });

  test("bash tool blocks sudo rm", async () => {
    const tool = fair.TOOLS.find((t) => t.name === "bash")!;
    const result = await tool.execute({ command: "sudo rm -rf /" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Blocked");
  });

  test("bash tool respects timeout", async () => {
    const tool = fair.TOOLS.find((t) => t.name === "bash")!;
    const start = Date.now();
    const result = await tool.execute({ command: "sleep 10", timeout: 100 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    expect(result.isError).toBe(true);
  });
});

// ── Provider ─────────────────────────────────────────────────

describe("formatMessagesForAPI", () => {
  test("formats simple messages", () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const formatted = fair.formatMessagesForAPI(messages);
    expect(formatted).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  test("formats user message with images", () => {
    const messages: Message[] = [
      { role: "user", content: "look", images: ["data:image/png;base64,abc"] },
    ];
    const formatted = fair.formatMessagesForAPI(messages);
    expect(formatted[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    });
  });

  test("formats assistant with tool calls", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "I'll read that",
        toolCalls: [{ id: "call_1", name: "read", args: { path: "x" } }],
      },
    ];
    const formatted = fair.formatMessagesForAPI(messages);
    expect(formatted[0].role).toBe("assistant");
    expect(formatted[0].content).toBe("I'll read that");
    expect(formatted[0].tool_calls).toHaveLength(1);
    expect(formatted[0].tool_calls[0].id).toBe("call_1");
    expect(formatted[0].tool_calls[0].function.name).toBe("read");
    expect(formatted[0].tool_calls[0].function.arguments).toBe('{"path":"x"}');
  });

  test("formats assistant with reasoning_content", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "The answer is 42",
        reasoning_content: "Let me think step by step...",
      },
    ];
    const formatted = fair.formatMessagesForAPI(messages);
    expect(formatted[0].role).toBe("assistant");
    expect(formatted[0].content).toBe("The answer is 42");
    expect(formatted[0].reasoning_content).toBe("Let me think step by step...");
  });

  test("formats assistant with null content and tool calls", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read", args: {} }],
      },
    ];
    const formatted = fair.formatMessagesForAPI(messages);
    expect(formatted[0].content).toBeNull();
  });

  test("formats tool result", () => {
    const messages: Message[] = [
      { role: "tool", toolCallId: "call_1", content: "file contents" },
    ];
    const formatted = fair.formatMessagesForAPI(messages);
    expect(formatted[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "file contents",
    });
  });

  test("formats empty content as empty string", () => {
    const messages: Message[] = [{ role: "user", content: "" }];
    const formatted = fair.formatMessagesForAPI(messages);
    expect(formatted[0].content).toBe("");
  });
});

describe("parseSSE", () => {
  test("parses text chunks", async () => {
    const chunks: fair.StreamChunk[] = [];
    for await (const c of fair.parseSSE(
      sseStream(['data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n', 'data: [DONE]\n\n'])
    )) {
      chunks.push(c);
    }
    expect(chunks).toEqual([{ type: "text", text: "Hello" }]);
  });

  test("parses multiple text chunks", async () => {
    const chunks: fair.StreamChunk[] = [];
    for await (const c of fair.parseSSE(
      sseStream([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
    )) {
      chunks.push(c);
    }
    expect(chunks).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
    ]);
  });

  test("parses accumulated tool calls", async () => {
    const chunks: fair.StreamChunk[] = [];
    for await (const c of fair.parseSSE(
      sseStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"test.txt\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ])
    )) {
      chunks.push(c);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe("tool_calls");
    const tc = (chunks[0] as any).calls[0];
    expect(tc.id).toBe("call_1");
    expect(tc.name).toBe("read");
    expect(tc.args).toEqual({ path: "test.txt" });
  });

  test("parses reasoning_content chunks", async () => {
    const chunks: fair.StreamChunk[] = [];
    for await (const c of fair.parseSSE(
      sseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"Let me think"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"..."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Answer: 42"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
    )) {
      chunks.push(c);
    }
    expect(chunks).toEqual([
      { type: "reasoning", text: "Let me think" },
      { type: "reasoning", text: "..." },
      { type: "text", text: "Answer: 42" },
    ]);
  });

  test("ignores empty and comment lines", async () => {
    const chunks: fair.StreamChunk[] = [];
    for await (const c of fair.parseSSE(
      sseStream(["\n", ": comment\n", 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n'])
    )) {
      chunks.push(c);
    }
    expect(chunks).toEqual([{ type: "text", text: "x" }]);
  });
});

describe("streamChat", () => {
  test("streams text from API", async () => {
    globalThis.fetch = async () =>
      new Response(
        sseStream(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', 'data: [DONE]\n\n']),
        { status: 200 }
      );

    const chunks: fair.StreamChunk[] = [];
    for await (const c of fair.streamChat([{ role: "user", content: "hi" }], [])) {
      chunks.push(c);
    }
    expect(chunks).toEqual([{ type: "text", text: "Hi" }]);
  });

  test("throws on API error", async () => {
    globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
    let caught = false;
    try {
      for await (const _ of fair.streamChat([{ role: "user", content: "hi" }], [])) {}
    } catch (e: any) {
      caught = true;
      expect(e.message).toContain("401");
    }
    expect(caught).toBe(true);
  });
});

describe("runTurn", () => {
  test("streams assistant text and appends to messages", async () => {
    globalThis.fetch = async () =>
      new Response(
        sseStream([
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
        { status: 200 }
      );

    const messages: Message[] = [{ role: "user", content: "hi" }];
    const result = await fair.runTurn(messages);

    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.cost).toBeGreaterThan(0);
    expect(messages[messages.length - 1].role).toBe("assistant");
    expect(messages[messages.length - 1].content).toBe("Hello world");
  });
});

// ── Session ──────────────────────────────────────────────────

describe("session", () => {
  test("save and load round-trip", async () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    await fair.saveSession("test-session", messages);
    const loaded = await fair.loadSession("test-session");
    expect(loaded).toHaveLength(2);
    expect(loaded[0].content).toBe("hello");
    expect(loaded[1].content).toBe("world");
  });

  test("load missing session returns empty", async () => {
    const loaded = await fair.loadSession("nonexistent-session");
    expect(loaded).toEqual([]);
  });
});

// ── History ──────────────────────────────────────────────────

describe("history", () => {
  test("loadHistory returns empty when file missing", async () => {
    const h = await fair.loadHistory();
    expect(h).toEqual([]);
  });

  test("saveHistory and loadHistory round-trip", async () => {
    await fair.saveHistory(["hello world", "refactor this"]);
    const loaded = await fair.loadHistory();
    expect(loaded).toEqual(["hello world", "refactor this"]);
  });

  test("loadHistory filters empty lines", async () => {
    await fair.saveHistory(["line1", "", "  ", "line2"]);
    const loaded = await fair.loadHistory();
    expect(loaded).toEqual(["line1", "line2"]);
  });

  test("saveHistory trims to max", async () => {
    const large = Array.from({ length: 1005 }, (_, i) => `line${i}`);
    await fair.saveHistory(large);
    const loaded = await fair.loadHistory();
    expect(loaded).toHaveLength(1000);
    expect(loaded[0]).toBe("line5");
    expect(loaded[999]).toBe("line1004");
  });
});

// ── Compactor ────────────────────────────────────────────────

describe("compactSession", () => {
  test("returns original when too short", async () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const result = await fair.compactSession(messages);
    expect(result).toEqual(messages);
  });

  test("summarizes old messages and keeps recent", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Summary of chat." } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const messages: Message[] = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "resp1" },
      { role: "user", content: "msg2" },
      { role: "assistant", content: "resp2" },
      { role: "user", content: "msg3" },
      { role: "assistant", content: "resp3" },
      { role: "user", content: "msg4" },
      { role: "assistant", content: "resp4" },
      { role: "user", content: "msg5" },
      { role: "assistant", content: "resp5" },
    ];

    const result = await fair.compactSession(messages);
    expect(result).toHaveLength(5); // 1 summary + 4 kept
    expect(result[0].role).toBe("user");
    expect(result[0].content).toContain("Summary");
  });
});
