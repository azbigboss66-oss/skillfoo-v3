import test from "node:test";
import assert from "node:assert/strict";
import { parseLiveRunPolicy, maxHttpAttemptsOf, LIVE_CONFIRM_PHRASE, type LiveRunPolicyInput } from "./liveRunPolicy.js";
import { OpenAICompatibleProvider, OpenAICompatibleProviderError } from "./openaiCompatible.js";
import { RunCallBudget } from "./runBudget.js";
import type { LlmConfig } from "../config/llmConfig.js";

// ── P0 Task 1: live-run authorization and budget policy ──────────
// Default stays fixture/offline. Real (live) mode exists ONLY for the
// OpenAI-compatible `deepseek` provider, and only when the operator passes
// EVERY gate: --allow-network, the exact confirmation phrase, --no-release,
// and centralized current-U1 authorization. Errors are desensitized by construction:
// they carry field names and ranges, never keys, prompts, or URLs with
// credentials.

const FAKE_CONFIG: LlmConfig = {
  apiKey: "sk-test-not-a-real-key",
  authMode: "bearer",
  baseUrl: "https://unit.test.invalid",
  endpoint: "https://unit.test.invalid/chat/completions",
  model: "deepseek-test",
  requestProfile: {
    preset: "deepseek",
    jsonMode: "json_object",
    reasoningMode: "thinking-disabled",
    maxTokensField: "max_tokens",
  },
};

function fullInput(overrides: Partial<LiveRunPolicyInput> = {}): LiveRunPolicyInput {
  return {
    provider: "deepseek",
    allowNetwork: true,
    confirmRealProvider: LIVE_CONFIRM_PHRASE,
    noRelease: true,
    u1DynamicAuthorizedLogicalCalls: 40,
    maxRetryAttempts: 2,
    evaluatorRequestTimeoutMs: 30_000,
    proposerRequestTimeoutMs: 30_000,
    ...overrides,
  };
}

test("fixture stays the default: a scripted provider never reaches the live policy", () => {
  assert.throws(
    () => parseLiveRunPolicy(fullInput({ provider: "scripted" })),
    /LIVE_PROVIDER_UNSUPPORTED/,
  );
});

test("deepseek without --allow-network fails before any config read or fetch", () => {
  assert.throws(
    () => parseLiveRunPolicy(fullInput({ allowNetwork: false })),
    /LIVE_NETWORK_NOT_ALLOWED/,
  );
});

test("a wrong or missing confirmation phrase fails with the exact required phrase", () => {
  for (const bad of [undefined, "i understand", "I_UNDERSTAND_REAL_PROVIDER_COSTS "]) {
    assert.throws(
      () => parseLiveRunPolicy(fullInput({ confirmRealProvider: bad })),
      /LIVE_CONFIRM_PHRASE_REQUIRED[\s\S]*I_UNDERSTAND_REAL_PROVIDER_COSTS/,
    );
  }
});

test("a live run must explicitly withhold release", () => {
  assert.throws(
    () => parseLiveRunPolicy(fullInput({ noRelease: false })),
    /LIVE_RELEASE_MUST_BE_WITHHELD/,
  );
});

test("every current authorization field is mandatory — each missing one fails closed", () => {
  for (const field of ["u1DynamicAuthorizedLogicalCalls", "maxRetryAttempts", "evaluatorRequestTimeoutMs", "proposerRequestTimeoutMs"] as const) {
    const { [field]: _removed, ...input } = fullInput();
    assert.throws(
      () => parseLiveRunPolicy(input as LiveRunPolicyInput),
      field === "u1DynamicAuthorizedLogicalCalls" ? /LIVE_DYNAMIC_ENVELOPE_INVALID/ : /LIVE_BUDGET_REQUIRED|LIVE_ROLE_PARAMS_PARTIAL/,
    );
  }
});

test("dynamic logical authorization and transport budget fail outside current bounds", () => {
  const outOfRange: Array<[keyof LiveRunPolicyInput, number]> = [
    ["u1DynamicAuthorizedLogicalCalls", 0],
    ["u1DynamicAuthorizedLogicalCalls", Number.MAX_SAFE_INTEGER + 1],
    ["maxRetryAttempts", 9],
  ];
  for (const [field, value] of outOfRange) {
    assert.throws(
      () => parseLiveRunPolicy(fullInput({ [field]: value } as Partial<LiveRunPolicyInput>)),
      /LIVE_DYNAMIC_ENVELOPE_INVALID|LIVE_BUDGET_OUT_OF_RANGE/,
      `${field}=${value} must be rejected`,
    );
  }
  const boundary = parseLiveRunPolicy(fullInput({ u1DynamicAuthorizedLogicalCalls: 1, maxRetryAttempts: 0 }));
  assert.equal(boundary.maxRetryAttempts, 0);
  const aboveHistoricalLimit = parseLiveRunPolicy(fullInput({ u1DynamicAuthorizedLogicalCalls: 830, maxRetryAttempts: 8 }));
  assert.equal(aboveHistoricalLimit.maxLogicalCalls, 830);
});

test("a fully authorized input returns a frozen live policy", () => {
  const policy = parseLiveRunPolicy(fullInput());
  assert.equal(policy.mode, "live");
  assert.equal(policy.noRelease, true);
  assert.equal(policy.providerName, "openai-compatible");
  assert.equal(policy.requestPreset, "deepseek");
  assert.equal(Object.isFrozen(policy), true);
});

test("provider aliases select request presets without creating a second adapter", () => {
  assert.equal(parseLiveRunPolicy(fullInput({ provider: "deepseek" })).requestPreset, "deepseek");
  assert.equal(parseLiveRunPolicy(fullInput({ provider: "openai-compatible" })).requestPreset, "portable");
  assert.equal(parseLiveRunPolicy(fullInput({ provider: "openai-compatible" })).providerName, "openai-compatible");
});

test("policy errors never echo keys or prompts", () => {
  const cases = Array.from({ length: 8 }, (_, i) => {
    const input = fullInput();
    if (i === 0) input.allowNetwork = false;
    if (i === 1) input.confirmRealProvider = undefined;
    if (i === 2) input.noRelease = false;
    if (i === 3) input.u1DynamicAuthorizedLogicalCalls = 0;
    if (i === 4) input.maxRetryAttempts = 99;
    if (i === 5) input.provider = "not-a-provider";
    if (i === 6) input.allowNetwork = undefined;
    if (i === 7) input.proposerRequestTimeoutMs = -5;
    return input;
  });
  for (const input of cases) {
    try {
      parseLiveRunPolicy(input);
      assert.fail("expected a policy error");
    } catch (e) {
      assert.ok(e instanceof Error);
      assert.ok(!e.message.includes("sk-"), `message leaks a key prefix: ${e.message}`);
      assert.ok(!e.message.includes("system text"), `message leaks prompt content: ${e.message}`);
    }
  }
});

// ── Provider wiring: maxOutputTokens + token telemetry (mocked fetch) ──

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
}

test("explicit role maxOutputTokens is sent as max_tokens and token usage is recorded on the budget", async () => {
  const bodies: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return jsonResponse({
      choices: [{ message: { content: '{"type":"final","answer":{}}' } }],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    });
  }) as typeof fetch;
  try {
    const budget = new RunCallBudget({ maxLogicalCalls: 5, maxRetryAttempts: 0 });
    const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 5_000, {
      maxRetries: 0,
      budget,
      maxOutputTokens: 512,
    });
    const response = await provider.chat([{ role: "user", content: "hello" }]);
    assert.equal(response.content, '{"type":"final","answer":{}}');
    assert.equal((bodies[0] as { max_tokens?: number }).max_tokens, 512);
    const telemetry = budget.tokenTelemetry();
    assert.equal(telemetry.responses, 1);
    assert.equal(telemetry.promptTokens, 120);
    assert.equal(telemetry.completionTokens, 30);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing usage is recorded as null, never fabricated", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse({ choices: [{ message: { content: '{"type":"final"}' } }] })) as typeof fetch;
  try {
    const budget = new RunCallBudget({ maxLogicalCalls: 5, maxRetryAttempts: 0 });
    const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 5_000, { maxRetries: 0, budget });
    await provider.chat([{ role: "user", content: "hello" }]);
    const telemetry = budget.tokenTelemetry();
    assert.equal(telemetry.promptTokens, null);
    assert.equal(telemetry.completionTokens, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a 429 is retried within the retry budget and never switches to scripted", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: "rate limited" }, { status: 429 });
    return jsonResponse({ choices: [{ message: { content: "ok" } }] });
  }) as typeof fetch;
  try {
    const budget = new RunCallBudget({ maxLogicalCalls: 5, maxRetryAttempts: 1 });
    const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 5_000, {
      maxRetries: 1,
      budget,
      sleep: async () => undefined,
    });
    const response = await provider.chat([{ role: "user", content: "hello" }]);
    assert.equal(response.content, "ok");
    assert.equal(budget.accounting.httpAttempts, 2);
    assert.equal(budget.accounting.retryAttempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── P0.1: the honest run-wide HTTP-attempt ceiling ────────────────
// RunCallBudget.enterRetry() caps retries ACROSS the whole run (see the
// exhausted-retry test above), never per logical call. The true ceiling
// is logical + retry — preflight must authorize against that number.

test("maxHttpAttemptsOf: 60 logical calls + 1 run-wide retry = 61, never 60 × (1+1)", () => {
  const policy = parseLiveRunPolicy(fullInput({ u1DynamicAuthorizedLogicalCalls: 60, maxRetryAttempts: 1 }));
  assert.equal(maxHttpAttemptsOf(policy), 61);
});

test("maxHttpAttemptsOf: zero retries keep the HTTP ceiling at the logical ceiling", () => {
  const policy = parseLiveRunPolicy(fullInput({ u1DynamicAuthorizedLogicalCalls: 60, maxRetryAttempts: 0 }));
  assert.equal(maxHttpAttemptsOf(policy), 60);
});

test("an exhausted retry budget aborts before the extra HTTP attempt", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse({ error: "rate limited" }, { status: 429 });
  }) as typeof fetch;
  try {
    const budget = new RunCallBudget({ maxLogicalCalls: 5, maxRetryAttempts: 0 });
    const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 5_000, {
      maxRetries: 2,
      budget,
      sleep: async () => undefined,
    });
    await assert.rejects(
      () => provider.chat([{ role: "user", content: "hello" }]),
      /PROVIDER_BUDGET_EXCEEDED/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a network failure surfaces as a provider error, never as a scripted fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 5_000, {
      maxRetries: 0,
      sleep: async () => undefined,
    });
    await assert.rejects(
      () => provider.chat([{ role: "user", content: "hello" }]),
      OpenAICompatibleProviderError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
