import test from "node:test";
import assert from "node:assert/strict";
import {
  createInstructionAdapter,
  INSTRUCTION_ADAPTER_ID,
  runInstructionScenario,
} from "../runtime/instructionAdapter.js";
import { ScriptedProvider } from "../providers/scriptedProvider.js";
import type { Provider, ProviderMessage, ProviderResponse } from "../providers/types.js";
import {
  getAdapterContract,
  resolveAdapterFactory,
  validateAdapterBinding,
} from "../runtime/adapterRegistry.js";
import type { CapabilityPolicy, RunTranscript } from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────

const ADAPTER = createInstructionAdapter({ policy: adapterPolicy() });

function adapterPolicy(): CapabilityPolicy {
  return {
    adapterId: INSTRUCTION_ADAPTER_ID,
    allowedTools: [],
    maxToolCalls: 2,
    networkMode: "fixture",
    lockedPaths: [],
  };
}

function fixtureCtx(mode: "fixture" | "replay" | "record" = "fixture") {
  return { mode, maxResponseBytes: 1024, timeoutMs: 1000, allowNetwork: false };
}

/** A provider that records every message list it is called with. */
class CaptureProvider implements Provider {
  readonly calls: ProviderMessage[][] = [];
  private readonly queue: string[];
  constructor(responses: string[]) {
    this.queue = [...responses];
  }
  async chat(messages: ProviderMessage[]): Promise<ProviderResponse> {
    this.calls.push(messages.map((m) => ({ ...m })));
    const content = this.queue.shift();
    if (content === undefined) throw new Error("CaptureProvider exhausted");
    return { content };
  }
}

const FINAL = JSON.stringify({
  type: "final",
  answer: { digest: "- bullet one\n- bullet two", limitations: "unknowns exist" },
});
const TOOL_CALL = JSON.stringify({
  type: "tool_call",
  tool: "fetch.data",
  args: { repo: "skillfoo-fixture-org/prompt-weaver-synthetic" },
});

async function runScripted(
  envelopes: string[],
  options: { maxToolCalls?: number; maxTurns?: number } = {},
): Promise<RunTranscript> {
  const scripts = new Map([[`d1:snap`, [...envelopes]]]);
  return runInstructionScenario({
    provider: new ScriptedProvider(scripts),
    skillMarkdown: "# Digest Skill\nWrite a short digest from provided context.",
    outputContract: "Answer with { digest, limitations }.",
    scenario: { id: "d1", userPrompt: "Summarize this week.", maxToolCalls: options.maxToolCalls ?? 2 },
    snapshotId: "snap",
    adapter: ADAPTER,
    adapterContext: fixtureCtx(),
    maxTurns: options.maxTurns,
  });
}

// ── Adapter: controlled refusal ──────────────────────────────────

test("the adapter declares an empty tool surface", () => {
  assert.deepEqual([...ADAPTER.allowedToolNames], []);
  assert.equal(ADAPTER.id, INSTRUCTION_ADAPTER_ID);
});

test("any tool call gets a controlled refusal with evidence, never a throw", async () => {
  const { result, evidence } = await ADAPTER.execute(
    { tool: "fetch.data", args: { repo: "x" } },
    fixtureCtx(),
  );
  const refusal = result as { denied: boolean; adapterId: string; tool: string; reason: string };
  assert.equal(refusal.denied, true);
  assert.equal(refusal.adapterId, INSTRUCTION_ADAPTER_ID);
  assert.equal(refusal.tool, "fetch.data");
  assert.ok(refusal.reason.length > 0);
  assert.ok(evidence.source.includes(INSTRUCTION_ADAPTER_ID));
  assert.ok(evidence.source.includes("fetch.data"));
  assert.match(evidence.replayKey, /^[0-9a-f]{16}$/);
  assert.match(evidence.contentSha256, /^[0-9a-f]{64}$/);
});

test("identical calls produce identical evidence (determinism)", async () => {
  const a = await ADAPTER.execute({ tool: "web.search", args: { q: "a" } }, fixtureCtx());
  const b = await ADAPTER.execute({ tool: "web.search", args: { q: "a" } }, fixtureCtx());
  assert.deepEqual(a, b);
});

test("fixture and replay modes return identical refusals", async () => {
  const fixture = await ADAPTER.execute({ tool: "fs.read", args: {} }, fixtureCtx("fixture"));
  const replay = await ADAPTER.execute({ tool: "fs.read", args: {} }, fixtureCtx("replay"));
  assert.deepEqual(fixture, replay);
});

test("record mode returns the SAME controlled refusal — no live execution, ever", async () => {
  const fixture = await ADAPTER.execute({ tool: "fetch.data", args: {} }, fixtureCtx("fixture"));
  const record = await ADAPTER.execute({ tool: "fetch.data", args: {} }, fixtureCtx("record"));
  assert.deepEqual(record, fixture);
  assert.equal((record.result as { denied?: boolean }).denied, true);
});

// ── Registry wiring ──────────────────────────────────────────────

test("instruction-v1 is registered and implemented in the current U1 registry", () => {
  const contract = getAdapterContract(INSTRUCTION_ADAPTER_ID);
  assert.ok(contract);
  assert.equal(contract.implemented, true);
  assert.deepEqual([...contract.tools], []);
  assert.deepEqual([...contract.capabilities], ["instruction"]);

  const factory = resolveAdapterFactory(INSTRUCTION_ADAPTER_ID);
  const instance = factory({ fixtureRoot: ".", policy: adapterPolicy() });
  assert.equal(instance.id, INSTRUCTION_ADAPTER_ID);
});

test("an instruction binding with no tools and the instruction capability passes the load gate", () => {
  const contract = validateAdapterBinding(adapterPolicy(), [], new Set(["instruction"]));
  assert.equal(contract.adapterId, INSTRUCTION_ADAPTER_ID);
});

// ── Runner: normal instruction skill ─────────────────────────────

test("a normal instruction skill run terminates with a parsed final answer", async () => {
  const result = await runScripted([FINAL]);
  assert.equal(result.terminalReason, "final");
  assert.equal(result.scenarioId, "d1");
  assert.deepEqual(result.toolEvents, []);
  assert.deepEqual(result.parsedFinalAnswer, {
    digest: "- bullet one\n- bullet two",
    limitations: "unknowns exist",
  });
});

test("the system message carries the skill, contract and the no-tool declaration", async () => {
  const provider = new CaptureProvider([FINAL]);
  await runInstructionScenario({
    provider,
    skillMarkdown: "# My Skill\nunique-skill-marker-42",
    outputContract: "unique-contract-marker-43",
    scenario: { id: "d1", userPrompt: "unique-prompt-marker-44", maxToolCalls: 1 },
    snapshotId: "snap",
    adapter: ADAPTER,
    adapterContext: fixtureCtx(),
  });
  const first = provider.calls[0];
  const system = first.find((m) => m.role === "system");
  assert.ok(system);
  assert.ok(system.content.includes("unique-skill-marker-42"));
  assert.ok(system.content.includes("unique-contract-marker-43"));
  assert.ok(system.content.includes("no tools"));
  const user = first.find((m) => m.role === "user");
  assert.ok(user);
  assert.ok(user.content.includes("unique-prompt-marker-44"));
});

// ── Runner: unauthorized tool calls ──────────────────────────────

test("an unauthorized tool call is refused, evidenced, and the run continues to a final", async () => {
  const provider = new CaptureProvider([TOOL_CALL, FINAL]);
  const result = await runInstructionScenario({
    provider,
    skillMarkdown: "# S",
    outputContract: "c",
    scenario: { id: "d1", userPrompt: "p", maxToolCalls: 2 },
    snapshotId: "snap",
    adapter: ADAPTER,
    adapterContext: fixtureCtx(),
  });

  assert.equal(result.terminalReason, "final");
  assert.equal(result.toolEvents.length, 1);
  const event = result.toolEvents[0];
  assert.equal(event.success, false);
  assert.match(event.error ?? "", /controlled refusal/);
  assert.ok((event.resultRef ?? "").includes(INSTRUCTION_ADAPTER_ID));
  // The refusal was fed back to the model as ordinary conversation context.
  assert.equal(provider.calls.length, 2);
  const second = provider.calls[1];
  const lastUser = second[second.length - 1];
  assert.ok(lastUser.content.includes("fetch.data"));
  assert.ok(lastUser.content.includes("denied"));
});

// ── Runner: structured-output failures ───────────────────────────

test("a non-JSON response terminates with invalid_json", async () => {
  const result = await runScripted(["this is not json"]);
  assert.equal(result.terminalReason, "invalid_json");
});

test("an unsupported envelope type terminates with unsupported_type", async () => {
  const result = await runScripted([JSON.stringify({ type: "guess" })]);
  assert.equal(result.terminalReason, "unsupported_type");
});

// ── Runner: budgets ──────────────────────────────────────────────

test("exceeding the tool-call budget terminates with too_many_tool_calls", async () => {
  const result = await runScripted([TOOL_CALL, TOOL_CALL, FINAL], { maxToolCalls: 1 });
  assert.equal(result.terminalReason, "too_many_tool_calls");
  assert.ok(result.toolEvents.length >= 1);
});

test("exceeding the turn budget terminates with too_many_turns", async () => {
  const result = await runScripted([TOOL_CALL, TOOL_CALL], { maxToolCalls: 5, maxTurns: 2 });
  assert.equal(result.terminalReason, "too_many_turns");
});
