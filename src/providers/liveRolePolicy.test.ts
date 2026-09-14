import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLiveRunPolicy,
  roleGroupOf,
  LIVE_CONFIRM_PHRASE,
  LIVE_ROLE_RANGES,
  type LiveRunPolicyInput,
} from "./liveRunPolicy.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import { RunCallBudget } from "./runBudget.js";
import { parseAdaptivePolicy } from "../evolution/adaptivePolicy.js";
import { calculateCallEnvelope, calculateScenarioCallAuthorization } from "./stageBudgets.js";
import { createOpenAICompatibleRepairProposer } from "../evolution/repairProposerProvider.js";
import { RepairFrontierError } from "../evolution/repairFrontier.js";
import type { FrontierTicket } from "../types.js";
import type { LlmConfig } from "../config/llmConfig.js";

// ── V3.1 P2 任务 A/B：输出预算分角色化（Red→Green）─────────────────
//
// T22-R2 的已证事实：一个全局 maxOutputTokens=3000 同时套在评测与生成两类
// 请求上，把 live repair proposer 的 strict 全量替换 JSON 截断在
// finishReason=length。修复契约：evaluator 与 proposer 两组显式、可审计、
// 可越界拒绝的 maxOutputTokens/requestTimeoutMs；live 模式禁止静默默认；
// legacy 全局参数走显式兼容路径并被如实声明。全部测试零网络（mock fetch /
// preflight 不 --execute）。

const FAKE_CONFIG: LlmConfig = {
  apiKey: "test-key",
  authMode: "bearer",
  baseUrl: "https://api.deepseek.test.invalid",
  endpoint: "https://api.deepseek.test.invalid/chat/completions",
  model: "deepseek-v4-flash",
  requestProfile: {
    preset: "deepseek",
    jsonMode: "json_object",
    reasoningMode: "thinking-disabled",
    maxTokensField: "max_tokens",
  },
};

const EXPLICIT_ROLES = {
  evaluatorMaxOutputTokens: 2_048,
  evaluatorRequestTimeoutMs: 8_000,
  proposerMaxOutputTokens: 8_192,
  proposerRequestTimeoutMs: 30_000,
} as const;

function roleInput(overrides: Partial<LiveRunPolicyInput> = {}): LiveRunPolicyInput {
  return {
    provider: "deepseek",
    allowNetwork: true,
    confirmRealProvider: LIVE_CONFIRM_PHRASE,
    noRelease: true,
    u1DynamicAuthorizedLogicalCalls: 60,
    maxRetryAttempts: 1,
    ...EXPLICIT_ROLES,
    ...overrides,
  };
}

// ── 1. 显式角色参数：解析、冻结与来源声明 ───────────────────────

test("explicit role params parse into frozen per-role groups", () => {
  const policy = parseLiveRunPolicy(roleInput());
  assert.deepEqual(policy.evaluator, { maxOutputTokens: 2_048, requestTimeoutMs: 8_000 });
  assert.deepEqual(policy.proposer, { maxOutputTokens: 8_192, requestTimeoutMs: 30_000 });
  assert.equal(policy.roleOutputSource, "explicit-role-params");
  assert.equal(Object.isFrozen(policy.evaluator), true);
  assert.equal(Object.isFrozen(policy.proposer), true);
});

test("role ranges retain token bounds and allow long explicit timeouts within the JavaScript timer limit", () => {
  assert.deepEqual(LIVE_ROLE_RANGES.evaluator.maxOutputTokens, { min: 512, max: 4_096 });
  assert.deepEqual(LIVE_ROLE_RANGES.proposer.maxOutputTokens, { min: 1_024, max: 16_384 });
  assert.deepEqual(LIVE_ROLE_RANGES.evaluator.requestTimeoutMs, { min: 1_000, max: 2_147_483_647 });
  assert.deepEqual(LIVE_ROLE_RANGES.proposer.requestTimeoutMs, { min: 1_000, max: 2_147_483_647 });
});

test("semantic-judge is an explicit runtime role that reuses the evaluator output group", () => {
  const policy = parseLiveRunPolicy(roleInput({
    evaluatorMaxOutputTokens: 4_096,
    evaluatorRequestTimeoutMs: 30_000,
    proposerMaxOutputTokens: 16_384,
    proposerRequestTimeoutMs: 30_000,
  }));
  assert.deepEqual(
    roleGroupOf(policy, "semantic-judge" as never),
    { maxOutputTokens: 4_096, requestTimeoutMs: 30_000 },
    "batch semantic review scores completed answers and must use the short evaluator budget while retaining its own role label",
  );
  assert.deepEqual(roleGroupOf(policy, "evaluator"), { maxOutputTokens: 4_096, requestTimeoutMs: 30_000 });
});

// ── 2. 语义矩阵：部分给 / 越界 ─────────────────

test("any missing role field is rejected by name — no silent defaults in live mode", () => {
  for (const field of Object.keys(EXPLICIT_ROLES) as Array<keyof typeof EXPLICIT_ROLES>) {
    const { [field]: _removed, ...rest } = EXPLICIT_ROLES;
    const input = roleInput(rest);
    delete (input as unknown as Record<string, unknown>)[field];
    assert.throws(
      () => parseLiveRunPolicy(input),
      /LIVE_ROLE_PARAMS_PARTIAL/,
    );
  }
});

test("role values outside their role range fail with the range spelled out", () => {
  const cases: Array<[keyof typeof EXPLICIT_ROLES, number, string]> = [
    ["evaluatorMaxOutputTokens", 511, "512"],
    ["evaluatorMaxOutputTokens", 4_097, "4096"],
    ["proposerMaxOutputTokens", 1_023, "1024"],
    ["proposerMaxOutputTokens", 16_385, "16384"],
    ["evaluatorRequestTimeoutMs", 999, "1000"],
    ["evaluatorRequestTimeoutMs", 2_147_483_648, "2147483647"],
    ["proposerRequestTimeoutMs", 999, "1000"],
    ["proposerRequestTimeoutMs", 2_147_483_648, "2147483647"],
  ];
  for (const [field, value, bound] of cases) {
    assert.throws(
      () => parseLiveRunPolicy(roleInput({ [field]: value } as Partial<LiveRunPolicyInput>)),
      (e: unknown) =>
        e instanceof Error && /LIVE_ROLE_OUT_OF_RANGE/.test(e.message) && e.message.includes(field) && e.message.includes(bound),
      `${field}=${value} must fail with LIVE_ROLE_OUT_OF_RANGE naming ${bound}`,
    );
  }
  // 边界值合法
  assert.equal(parseLiveRunPolicy(roleInput({ evaluatorMaxOutputTokens: 512, proposerMaxOutputTokens: 16_384 })).proposer.maxOutputTokens, 16_384);
});


// ── 3. 角色接线：每个角色实例的请求体拿到各自的 max_tokens/超时 ────

function mockFetchCapture(responses: Array<Record<string, unknown>>): { requests: Array<Record<string, unknown>>; restore: () => void } {
  const requests: Array<Record<string, unknown>> = [];
  const queue = [...responses];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = queue.shift() ?? { choices: [{ message: { content: '{"type":"final"}', }, }, { finish_reason: "stop" }] };
    return Promise.resolve(
      new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  }) as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = originalFetch; } };
}

test.afterEach(() => {
  // each mock restores itself in finally blocks
});

function okCompletion(content: string): Record<string, unknown> {
  return { choices: [{ message: { content }, finish_reason: "stop" }] };
}

test("evaluator and proposer instances send their own max_tokens from their role group", async () => {
  const policy = parseLiveRunPolicy(roleInput());
  const { requests, restore } = mockFetchCapture([okCompletion('{"type":"final","answer":{"k":"v"}}'), okCompletion('{"type":"final","answer":{"k2":"v2"}}')]);
  try {
    const budget = new RunCallBudget({ maxLogicalCalls: 10, maxRetryAttempts: 1 });
    const evaluator = new OpenAICompatibleProvider(FAKE_CONFIG, policy.evaluator.requestTimeoutMs, {
      maxRetries: 0, budget, role: "evaluator", maxOutputTokens: policy.evaluator.maxOutputTokens,
    });
    const repair = new OpenAICompatibleProvider(FAKE_CONFIG, policy.proposer.requestTimeoutMs, {
      maxRetries: 0, budget, role: "repair", maxOutputTokens: policy.proposer.maxOutputTokens,
    });
    await evaluator.chat([{ role: "user", content: "eval" }]);
    await repair.chat([{ role: "user", content: "propose" }]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].max_tokens, 2_048, "evaluator request carries the evaluator ceiling");
    assert.equal(requests[1].max_tokens, 8_192, "proposer request carries the proposer ceiling");
    assert.deepEqual(requests[0].thinking, { type: "disabled" }, "evaluator explicitly disables reasoning-only output");
    assert.deepEqual(requests[1].thinking, { type: "disabled" }, "repair explicitly disables thinking");
  } finally {
    restore();
  }
});

test("a proposer at 8192 still fails closed on length truncation — deterministic, zero retries", async () => {
  const policy = parseLiveRunPolicy(roleInput());
  const { requests, restore } = mockFetchCapture([
    { choices: [{ message: { content: '{"hypothesis":"x","skillMd":"# partial' }, finish_reason: "length" }], usage: { prompt_tokens: 900, completion_tokens: 8_192 } },
  ]);
  try {
    const budget = new RunCallBudget({ maxLogicalCalls: 10, maxRetryAttempts: 2, roleRetryReserves: { repair: 2 } });
    const provider = new OpenAICompatibleProvider(FAKE_CONFIG, policy.proposer.requestTimeoutMs, {
      maxRetries: 2, budget, role: "repair", maxOutputTokens: 8_192, sleep: async () => {},
    });
    const proposer = createOpenAICompatibleRepairProposer({ provider });
    const ticket: FrontierTicket = {
      schemaVersion: 3, candidateId: "c1", split: "public",
      minimalFailureReason: "items missed the required keys", editableFiles: ["SKILL.md"],
      repairBudget: 1, repairsUsed: 0,
    };
    await assert.rejects(
      () => proposer.proposeTargetedRepair({ ticket, skillMd: "# Parent\n\nAnswer with one JSON object." }),
      (e: unknown) => e instanceof RepairFrontierError && /PROVIDER_TRUNCATED_OUTPUT/.test(e.message) && /\[role=repair\]/.test(e.message),
    );
    assert.equal(requests.length, 1, "truncation must not consume a retry even under the raised 8192 ceiling");
  } finally {
    restore();
  }
});

test("a bounded U1 edit within 8192 applies to a long parent without truncation", async () => {
  const policy = parseLiveRunPolicy(roleInput());
  const section = (n: number) =>
    `## Section ${n}\n\nRestate the goal. Produce one JSON object. Keep every sentence plain text with no tools, links, or commands.\n\n`;
  const anchor = "Answer with one JSON object.";
  const replacement = "Answer with one JSON object and include every required key.";
  const parentSkill = `# Parent skill\n\n${Array.from({ length: 120 }, (_, i) => section(i + 1)).join("")}## Repair target\n\n${anchor}\n`;
  const expectedSkill = parentSkill.replace(anchor, replacement);
  assert.ok(parentSkill.length > 12_000, "the parent sample must be genuinely long (byte length > 12k)");
  const { requests, restore } = mockFetchCapture([
    okCompletion(JSON.stringify({
      hypothesis: "spell out the answer keys",
      decision: "edit",
      edits: [{ op: "replace_exact", oldText: anchor, newText: replacement }],
    })),
  ]);
  try {
    const budget = new RunCallBudget({ maxLogicalCalls: 10, maxRetryAttempts: 1, roleRetryReserves: { repair: 1 } });
    const provider = new OpenAICompatibleProvider(FAKE_CONFIG, policy.proposer.requestTimeoutMs, {
      maxRetries: 1, budget, role: "repair", maxOutputTokens: 8_192, sleep: async () => {},
    });
    const proposer = createOpenAICompatibleRepairProposer({ provider });
    const ticket: FrontierTicket = {
      schemaVersion: 3, candidateId: "c1", split: "public",
      minimalFailureReason: "items missed the required keys", editableFiles: ["SKILL.md"],
      repairBudget: 1, repairsUsed: 0,
    };
    const proposal = await proposer.proposeTargetedRepair({ ticket, skillMd: parentSkill });
    assert.equal(proposal.skillMd, expectedSkill, "the one bounded edit applies without rewriting the long parent");
    assert.equal(proposal.decision, "edit");
    assert.equal(proposal.appliedEdits, 1);
    assert.equal(requests[0].max_tokens, 8_192);
  } finally {
    restore();
  }
});

// ── 4. adaptivePolicy：proposer 组范围 ─────────────────────────────

test("adaptivePolicy validates output/timeout against the proposer role range", () => {
  const envelope = calculateCallEnvelope({
    rawStageEstimate: 60,
    stagePrimaryAuthorization: 60,
    stageLoopRetryReserve: 0,
    existingRecoveryReserve: 0,
    scenarioAuthorization: calculateScenarioCallAuthorization(1, 0, 1, 1),
  });
  const base = {
    formalHumanU1B: true as const,
    maxGenerations: 2, maxRefinementsPerCandidate: 1, minRepairProgress: 2, stagnationPatience: 1,
    mode: "standard" as const, earlyRepair: "auto" as const, maxRetryAttempts: 1,
    u1CallEnvelope: envelope,
  };
  assert.equal(parseAdaptivePolicy({ ...base, requestTimeoutMs: 30_000, maxOutputTokens: 8_192 }).maxOutputTokens, 8_192);
  assert.equal(parseAdaptivePolicy({ ...base, requestTimeoutMs: 30_000, maxOutputTokens: 16_384 }).maxOutputTokens, 16_384);
  for (const bad of [1_023, 16_385]) {
    assert.throws(
      () => parseAdaptivePolicy({ ...base, requestTimeoutMs: 30_000, maxOutputTokens: bad }),
      (e: unknown) => e instanceof Error && /ADAPTIVE_POLICY_BUDGET_OUT_OF_RANGE/.test(e.message) && e.message.includes("1024") && e.message.includes("16384"),
      `proposer maxOutputTokens=${bad} must be rejected with the proposer range`,
    );
  }
});
