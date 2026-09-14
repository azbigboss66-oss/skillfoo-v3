import test from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider, OpenAICompatibleProviderError } from "./openaiCompatible.js";
import { createCachingProvider, createInMemoryResponseCache } from "./cache.js";
import { createBudgetedProvider, ProviderBudgetError, RunCallBudget } from "./runBudget.js";
import type { DeepSeekConfig } from "../config/deepseekConfig.js";

// ── P1 任务 2 Red→Green：按角色保留预算，不放宽总预算 ─────────────
//
// T22 根因 2 的修复证据：evaluator 与 proposer 共用一个 RunCallBudget
// 总账本，但角色可区分；evaluator 不消耗 proposer 的 transport retry
// 储备（evaluator 储备 0，fail-fast）；bootstrap/mutation/repair/
// direct-refine 的失败报告带角色；总 HTTP = logical + retry 恒成立；
// 任何上限都没有被提高。

const FAKE_CONFIG: DeepSeekConfig = {
  apiKey: "test-key",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
};

const NO_SLEEP = async () => {};

function okBody(content: string): string {
  return JSON.stringify({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

interface QueuedMock {
  calls: Array<{ body: unknown }>;
}

/** Queue one response per HTTP attempt; records parsed request bodies. */
function mockFetchQueue(responses: Array<{ status?: number; body: string }>): QueuedMock {
  const calls: Array<{ body: unknown }> = [];
  const queue = [...responses];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ body: JSON.parse((init?.body as string) ?? "null") });
    const next = queue.shift() ?? { status: 500, body: "{}" };
    return Promise.resolve(
      new Response(next.body, { status: next.status ?? 200, headers: { "Content-Type": "application/json" } }),
    );
  }) as typeof fetch;
  (mockFetchQueue as unknown as { _restore?: () => void })._restore = () => {
    globalThis.fetch = originalFetch;
  };
  return { calls };
}

test.afterEach(() => {
  const restore = (mockFetchQueue as unknown as { _restore?: () => void })._restore;
  if (restore) restore();
});

// ── 1. evaluator 储备 0：传输错误立即失败，不烧 proposer 的 retry ──

test("evaluator (maxRetries 0, reserve 0) fails fast and leaves the retry budget untouched", async () => {
  const budget = new RunCallBudget(
    { maxLogicalCalls: 10, maxRetryAttempts: 2, roleRetryReserves: { evaluator: 0, mutation: 2 } },
  );
  mockFetchQueue([{ status: 500, body: "{}" }]);
  const evaluator = createBudgetedProvider(
    new OpenAICompatibleProvider(FAKE_CONFIG, 8000, {
      budget,
      role: "evaluator",
      maxRetries: 0, // the CLI wiring: evaluator transport failures are never retried
      sleep: NO_SLEEP,
    }),
    budget,
    "evaluator",
  );

  await assert.rejects(
    () => evaluator.chat([{ role: "user", content: "q" }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.equal(err.code, "PROVIDER_HTTP_ERROR");
      return true;
    },
  );

  assert.equal(budget.accounting.httpAttempts, 1, "exactly one HTTP attempt — no retry spent");
  assert.equal(budget.accounting.retryAttempts, 0);
  assert.equal(budget.accounting.logicalCalls, 1);
  const byRole = budget.roleAccounting();
  assert.equal(byRole.evaluator.httpAttempts, 1);
  assert.equal(byRole.evaluator.retryAttempts, 0);
  assert.equal(budget.accounting.httpAttempts, budget.accounting.logicalCalls + budget.accounting.retryAttempts);
});

test("even with maxRetries configured, a reserve of 0 gates the retry before any HTTP", async () => {
  const budget = new RunCallBudget(
    { maxLogicalCalls: 10, maxRetryAttempts: 2, roleRetryReserves: { evaluator: 0 } },
  );
  mockFetchQueue([{ status: 500, body: "{}" }, { status: 500, body: "{}" }]);
  const evaluator = new OpenAICompatibleProvider(FAKE_CONFIG, 8000, {
    budget, role: "evaluator", maxRetries: 2, sleep: NO_SLEEP,
  });

  await assert.rejects(
    () => evaluator.chat([{ role: "user", content: "q" }]),
    (err: unknown) => {
      assert.ok(err instanceof ProviderBudgetError);
      assert.equal(err.scope, "role", "the ROLE reserve tripped, not the run cap");
      assert.equal(err.role, "evaluator");
      assert.match(err.message, /evaluator/);
      return true;
    },
  );
  assert.equal(budget.accounting.httpAttempts, 1, "the blocked retry never reached the wire");
  assert.equal(budget.accounting.retryAttempts, 0);
});

test("the proposer keeps its retry reserve after an evaluator transport failure", async () => {
  const budget = new RunCallBudget(
    { maxLogicalCalls: 10, maxRetryAttempts: 2, roleRetryReserves: { evaluator: 0, mutation: 2 } },
  );
  mockFetchQueue([
    { status: 500, body: "{}" }, // evaluator — fails fast, no retry
    { status: 429, body: "{}" }, // mutation — first attempt throttled
    { body: okBody('{"hypothesis":"h","skillMd":"# new"}') }, // mutation — retry succeeds
  ]);
  const evaluator = createBudgetedProvider(
    new OpenAICompatibleProvider(FAKE_CONFIG, 8000, {
      budget, role: "evaluator", maxRetries: 0, sleep: NO_SLEEP,
    }),
    budget,
    "evaluator",
  );
  const mutation = createBudgetedProvider(
    new OpenAICompatibleProvider(FAKE_CONFIG, 8000, {
      budget, role: "mutation", maxRetries: 2, sleep: NO_SLEEP,
    }),
    budget,
    "mutation",
  );

  await assert.rejects(() => evaluator.chat([{ role: "user", content: "eval" }]));
  const response = await mutation.chat([{ role: "user", content: "propose" }], { responseFormat: "json_object" });
  assert.equal(response.content, '{"hypothesis":"h","skillMd":"# new"}');

  assert.equal(budget.accounting.logicalCalls, 2, "one evaluator call + one proposer call");
  assert.equal(budget.accounting.retryAttempts, 1, "only the proposer spent a retry");
  const byRole = budget.roleAccounting();
  assert.equal(byRole.evaluator.retryAttempts, 0);
  assert.equal(byRole.mutation.retryAttempts, 1);
  assert.equal(budget.accounting.httpAttempts, 3);
  assert.equal(budget.accounting.httpAttempts, budget.accounting.logicalCalls + budget.accounting.retryAttempts);
});

// ── 2. proposer retry 耗尽：fail-closed，错误带角色，不再多花 HTTP ──

test("proposer retry exhaustion throws ProviderBudgetError carrying the role", async () => {
  const budget = new RunCallBudget(
    { maxLogicalCalls: 10, maxRetryAttempts: 1, roleRetryReserves: { evaluator: 0, mutation: 1 } },
  );
  mockFetchQueue([
    { status: 429, body: "{}" }, // mutation attempt 1
    { status: 429, body: "{}" }, // mutation retry (spends the global 1)
    { status: 429, body: "{}" }, // must never be fetched
  ]);
  const mutation = new OpenAICompatibleProvider(FAKE_CONFIG, 8000, {
    budget, role: "mutation", maxRetries: 2, sleep: NO_SLEEP,
  });

  await assert.rejects(
    () => mutation.chat([{ role: "user", content: "propose" }]),
    (err: unknown) => {
      assert.ok(err instanceof ProviderBudgetError);
      assert.equal(err.role, "mutation");
      assert.match(err.message, /mutation/);
      return true;
    },
  );
  const byRole = budget.roleAccounting();
  assert.equal(byRole.mutation.httpAttempts, 2, "attempt + exactly one retry");
  assert.equal(budget.accounting.httpAttempts, 2, "no further HTTP after the budget gate");
});

// ── 3. 无储备配置（V2 语义）：仅全局上限，行为不变 ────────────────

test("without role reserves the global retry cap alone applies (V2 semantics)", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 10, maxRetryAttempts: 1 });
  mockFetchQueue([
    { status: 500, body: "{}" },
    { status: 500, body: "{}" },
  ]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 8000, {
    budget, maxRetries: 2, sleep: NO_SLEEP, // provider may try twice…
  });
  await assert.rejects(
    () => provider.chat([{ role: "user", content: "q" }]),
    (err: unknown) => err instanceof ProviderBudgetError, // …but the run-wide cap of 1 stops it
  );
  assert.equal(budget.accounting.retryAttempts, 1);
  assert.equal(budget.accounting.httpAttempts, 2);
});

// ── 4. 缓存包装器按角色计费；命中免费 ─────────────────────────────

test("the caching wrapper bills logical calls under the role and cache hits stay free", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 10, maxRetryAttempts: 1, roleRetryReserves: { evaluator: 1 } });
  mockFetchQueue([{
    body: JSON.stringify({
      choices: [{ message: { content: "A" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        prompt_cache_hit_tokens: 6,
        prompt_cache_miss_tokens: 4,
        completion_tokens: 5,
      },
    }),
  }]);
  const raw = new OpenAICompatibleProvider(FAKE_CONFIG, 8000, { budget, role: "evaluator", maxRetries: 1 });
  const cache = createInMemoryResponseCache();
  const provider = createCachingProvider(raw, {
    cache,
    budget,
    role: "evaluator",
    baseMaterial: {
      model: "deepseek-v4-flash",
      providerConfigFingerprint: "fp",
      baseUrlIdentity: raw.endpointIdentity(),
      skillSnapshotSha256: "-",
      mode: "live",
      maxOutputTokensBehavior: "provider-default",
      thinkingMode: "provider-default",
      temperatureBehavior: "provider-default",
      frozenEvidenceSha256: "-",
      stage: "not-applicable",
    },
  });

  const first = await provider.chat([{ role: "user", content: "q" }]);
  const second = await provider.chat([{ role: "user", content: "q" }]);
  assert.equal(first.content, "A");
  assert.equal(second.content, "A");
  const byRole = budget.roleAccounting();
  assert.equal(byRole.evaluator.logicalCalls, 1, "the hit is free — only the miss is billed");
  assert.equal(budget.accounting.httpAttempts, 1);
  assert.deepEqual(provider.cacheStats(), { hits: 1, misses: 1, stores: 1 });
  const tokens = budget.providerTokenTelemetry();
  assert.equal(tokens.responsesWithUsage, 1, "a SkillFoo response-cache hit does not replay provider usage");
  assert.equal(tokens.promptCacheHitTokens, 6, "provider prompt-cache tokens are not doubled by a local hit");
  assert.equal(tokens.promptCacheMissTokens, 4);
});

test("token usage aggregates by copied stage + role + model tags without changing the legacy view", () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 1, maxRetryAttempts: 0 });
  const mutableTags = { stage: "full_public", role: "evaluator", model: "deepseek-v4-flash" };
  budget.recordTokenUsage({
    usagePresent: true,
    promptTokens: 10,
    promptCacheHitTokens: 6,
    promptCacheMissTokens: 4,
    completionTokens: 5,
  }, mutableTags);
  mutableTags.stage = "holdout";
  budget.recordTokenUsage({
    usagePresent: true,
    promptTokens: 20,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 20,
    completionTokens: 8,
  }, { stage: "holdout", role: "evaluator", model: "deepseek-v4-flash" });
  budget.recordTokenUsage({
    usagePresent: false,
    promptTokens: null,
    promptCacheHitTokens: null,
    promptCacheMissTokens: null,
    completionTokens: null,
  }, { stage: "holdout", role: "mutation", model: "deepseek-v4-flash" });

  assert.deepEqual(budget.tokenTelemetry(), {
    promptTokens: null,
    completionTokens: null,
    responses: 3,
  }, "the historical three-field API remains exact and source/schema compatible");
  assert.deepEqual(budget.providerTokenTelemetry(), {
    promptTokens: null,
    promptCacheHitTokens: null,
    promptCacheMissTokens: null,
    completionTokens: null,
    responses: 3,
    responsesWithUsage: 2,
    responsesMissingUsage: 1,
  });
  assert.deepEqual(budget.providerTokenTelemetryByTags(), [
    {
      tags: { stage: "full_public", role: "evaluator", model: "deepseek-v4-flash" },
      telemetry: {
        promptTokens: 10,
        promptCacheHitTokens: 6,
        promptCacheMissTokens: 4,
        completionTokens: 5,
        responses: 1,
        responsesWithUsage: 1,
        responsesMissingUsage: 0,
      },
    },
    {
      tags: { stage: "holdout", role: "evaluator", model: "deepseek-v4-flash" },
      telemetry: {
        promptTokens: 20,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 20,
        completionTokens: 8,
        responses: 1,
        responsesWithUsage: 1,
        responsesMissingUsage: 0,
      },
    },
    {
      tags: { stage: "holdout", role: "mutation", model: "deepseek-v4-flash" },
      telemetry: {
        promptTokens: null,
        promptCacheHitTokens: null,
        promptCacheMissTokens: null,
        completionTokens: null,
        responses: 1,
        responsesWithUsage: 0,
        responsesMissingUsage: 1,
      },
    },
  ]);
});

// ── 5. 角色化不提高总上限：全局 logical cap 仍先拦截 ──────────────

test("role accounting never raises the global logical cap", async () => {
  const budget = new RunCallBudget(
    { maxLogicalCalls: 2, maxRetryAttempts: 0, roleRetryReserves: { evaluator: 0, mutation: 0 } },
  );
  mockFetchQueue([{ body: okBody("A") }, { body: okBody("B") }, { body: okBody("C") }]);
  const evaluator = createBudgetedProvider(
    new OpenAICompatibleProvider(FAKE_CONFIG, 8000, { budget, role: "evaluator", maxRetries: 0 }),
    budget,
    "evaluator",
  );
  const mutation = createBudgetedProvider(
    new OpenAICompatibleProvider(FAKE_CONFIG, 8000, { budget, role: "mutation", maxRetries: 0 }),
    budget,
    "mutation",
  );

  await evaluator.chat([{ role: "user", content: "1" }]);
  await mutation.chat([{ role: "user", content: "2" }]);
  await assert.rejects(
    () => mutation.chat([{ role: "user", content: "3" }]),
    (err: unknown) => {
      assert.ok(err instanceof ProviderBudgetError);
      assert.equal(err.kind, "logical_calls");
      assert.equal(err.scope, "run");
      return true;
    },
  );
  assert.equal(budget.accounting.logicalCalls, 2);
  assert.equal(budget.accounting.httpAttempts, 2);
});

// ── 6. 角色出现在失败报告里（proposer 失败可归因） ─────────────────

test("a role-scoped provider failure report carries the role tag", async () => {
  const budget = new RunCallBudget(
    { maxLogicalCalls: 10, maxRetryAttempts: 1, roleRetryReserves: { evaluator: 0, repair: 1 } },
  );
  mockFetchQueue([
    {
      body: JSON.stringify({
        choices: [{ message: { content: "" }, finish_reason: "length" }],
        usage: { prompt_tokens: 9, completion_tokens: 3000 },
      }),
    },
  ]);
  const repair = createBudgetedProvider(
    new OpenAICompatibleProvider(FAKE_CONFIG, 8000, { budget, role: "repair", maxRetries: 1 }),
    budget,
    "repair",
  );

  await assert.rejects(
    () => repair.chat([{ role: "user", content: "propose repair" }], { responseFormat: "json_object" }),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.equal(err.code, "PROVIDER_TRUNCATED_OUTPUT");
      assert.match(err.message, /\[role=repair\]/, "the failure report names the proposer role");
      return true;
    },
  );
});
