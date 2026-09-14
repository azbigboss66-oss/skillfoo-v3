import test from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider, OpenAICompatibleProviderError } from "./openaiCompatible.js";
import { RunCallBudget } from "./runBudget.js";
import type { LlmConfig } from "../config/llmConfig.js";

// ── P1 任务 1 Red→Green：Provider 安全诊断 ─────────────────────────
//
// T22 根因 1 的修复证据：2xx 空 content 不再是笼统可重试的
// "malformed"，而是携带稳定错误码与安全诊断字段的结构化失败；
// length 截断确定性失败不重试；失败响应的 usage 仍记账；任何错误
// 或诊断都不携带密钥、prompt、响应体、完整 baseUrl。

const FAKE_CONFIG: LlmConfig = {
  apiKey: "test-key",
  authMode: "bearer",
  baseUrl: "https://api.deepseek.com",
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-v4-flash",
  requestProfile: {
    preset: "deepseek",
    jsonMode: "json_object",
    reasoningMode: "thinking-disabled",
    maxTokensField: "max_tokens",
  },
};

const PROMPT_MARKER = "UNIQUE_PROMPT_MARKER_do_not_leak";

interface MockCalls {
  calls: Array<{ url: string; init?: RequestInit }>;
  respond: (n: number, status: number, body: string) => void;
}

/** Queue one response per HTTP attempt; records every request. */
function mockFetchQueue(responses: Array<{ status?: number; body: string }>): MockCalls {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const queue = [...responses];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const next = queue.shift() ?? { status: 500, body: "{}" };
    return Promise.resolve(
      new Response(next.body, { status: next.status ?? 200, headers: { "Content-Type": "application/json" } }),
    );
  }) as typeof fetch;
  (mockFetchQueue as unknown as { _restore?: () => void })._restore = () => {
    globalThis.fetch = originalFetch;
  };
  return { calls, respond: () => {} };
}

test.afterEach(() => {
  const restore = (mockFetchQueue as unknown as { _restore?: () => void })._restore;
  if (restore) restore();
});

function okBody(content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    ...extra,
  });
}

// ── 1. 正常 content：成功返回并携带安全诊断 ──────────────────────

test("normal content succeeds and carries safe diagnostics", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 1, maxRetryAttempts: 2 });
  const { calls } = mockFetchQueue([{
    body: okBody('{"type":"final"}', {
      usage: {
        prompt_tokens: 10,
        prompt_cache_hit_tokens: 7,
        prompt_cache_miss_tokens: 3,
        completion_tokens: 5,
      },
    }),
  }]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 8000, {
    budget,
    maxRetries: 2,
    role: "evaluator",
    usageTags: { stage: "bootstrap_slice" },
  });

  const response = await provider.chat(
    [{ role: "user", content: PROMPT_MARKER }],
    { usageTags: { stage: "full_public", role: "untrusted-override", model: "untrusted-model" } },
  );

  assert.equal(response.content, '{"type":"final"}');
  assert.equal(response.promptCacheHitTokens, 7);
  assert.equal(response.promptCacheMissTokens, 3);
  const d = response.diagnostics;
  assert.ok(d, "successful responses carry diagnostics");
  assert.equal(d.httpStatus, 200);
  assert.equal(d.choiceCount, 1);
  assert.equal(d.contentLength, 16);
  assert.equal(d.finishReason, "stop");
  assert.equal(d.usagePresent, true);
  assert.deepEqual(d.usage, {
    promptTokens: 10,
    promptCacheHitTokens: 7,
    promptCacheMissTokens: 3,
    completionTokens: 5,
  });
  assert.equal(d.reasoningContentPresent, false);
  assert.equal(
    Object.hasOwn(JSON.parse(String(calls[0]?.init?.body)), "usageTags"),
    false,
    "telemetry tags never enter the provider request body",
  );
  assert.deepEqual(budget.providerTokenTelemetry(), {
    promptTokens: 10,
    promptCacheHitTokens: 7,
    promptCacheMissTokens: 3,
    completionTokens: 5,
    responses: 1,
    responsesWithUsage: 1,
    responsesMissingUsage: 0,
  });
  assert.deepEqual(budget.providerTokenTelemetryByTags(), [{
    tags: { stage: "full_public", role: "evaluator", model: "deepseek-v4-flash" },
    telemetry: {
      promptTokens: 10,
      promptCacheHitTokens: 7,
      promptCacheMissTokens: 3,
      completionTokens: 5,
      responses: 1,
      responsesWithUsage: 1,
      responsesMissingUsage: 0,
    },
  }]);
});

test("missing DeepSeek prompt-cache fields stay unknown and are never zero-filled", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 1, maxRetryAttempts: 0 });
  mockFetchQueue([{ body: okBody("ok") }]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 8000, { budget, maxRetries: 0 });

  const response = await provider.chat([{ role: "user", content: "q" }]);

  assert.equal(response.promptCacheHitTokens, null);
  assert.equal(response.promptCacheMissTokens, null);
  assert.deepEqual(response.diagnostics?.usage, {
    promptTokens: 10,
    promptCacheHitTokens: null,
    promptCacheMissTokens: null,
    completionTokens: 5,
  });
  const telemetry = budget.providerTokenTelemetry();
  assert.equal(telemetry.promptTokens, 10);
  assert.equal(telemetry.promptCacheHitTokens, null);
  assert.equal(telemetry.promptCacheMissTokens, null);
  assert.equal(telemetry.completionTokens, 5);
  assert.equal(telemetry.responsesWithUsage, 1);
  assert.equal(telemetry.responsesMissingUsage, 0);
});

test("a successful response without usage is counted as missing usage", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 1, maxRetryAttempts: 0 });
  mockFetchQueue([{
    body: JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
  }]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 8000, { budget, maxRetries: 0 });

  const response = await provider.chat([{ role: "user", content: "q" }]);

  assert.equal(response.diagnostics?.usagePresent, false);
  assert.equal(response.diagnostics?.usage, null);
  assert.equal(response.promptCacheHitTokens, null);
  assert.equal(response.promptCacheMissTokens, null);
  assert.deepEqual(budget.providerTokenTelemetry(), {
    promptTokens: null,
    promptCacheHitTokens: null,
    promptCacheMissTokens: null,
    completionTokens: null,
    responses: 1,
    responsesWithUsage: 0,
    responsesMissingUsage: 1,
  });
});

test("concurrent calls keep immutable per-call stage usage tags isolated", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 2, maxRetryAttempts: 0 });
  mockFetchQueue([
    {
      body: JSON.stringify({
        choices: [{ message: { content: "one" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 11,
          prompt_cache_hit_tokens: 1,
          prompt_cache_miss_tokens: 10,
          completion_tokens: 2,
        },
      }),
    },
    {
      body: JSON.stringify({
        choices: [{ message: { content: "two" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 22,
          prompt_cache_hit_tokens: 2,
          prompt_cache_miss_tokens: 20,
          completion_tokens: 3,
        },
      }),
    },
  ]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 8000, {
    budget,
    maxRetries: 0,
    role: "evaluator",
    usageTags: { stage: "provider-default" },
  });

  await Promise.all([
    provider.chat([{ role: "user", content: "one" }], { usageTags: { stage: "full_public" } }),
    provider.chat([{ role: "user", content: "two" }], { usageTags: { stage: "holdout" } }),
  ]);

  const groups = budget.providerTokenTelemetryByTags();
  assert.deepEqual(groups.map((entry) => ({
    stage: entry.tags.stage,
    promptTokens: entry.telemetry.promptTokens,
  })), [
    { stage: "full_public", promptTokens: 11 },
    { stage: "holdout", promptTokens: 22 },
  ]);
  assert.ok(groups.every((entry) => entry.tags.role === "evaluator"));
  assert.ok(groups.every((entry) => entry.tags.model === "deepseek-v4-flash"));
});

test("diagnostics flags reasoning_content presence without ever using it", async () => {
  mockFetchQueue([
    {
      body: JSON.stringify({
        choices: [{ message: { content: '{"a":1}', reasoning_content: "chain of thought" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    },
  ]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG);
  const response = await provider.chat([{ role: "user", content: "q" }]);
  assert.equal(response.content, '{"a":1}');
  assert.equal(response.diagnostics?.reasoningContentPresent, true);
});

// ── 2. 空 content + finish_reason=length：截断确定性失败不重试 ──

test("empty content with finish_reason=length fails deterministically as TRUNCATED without retry", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 1, maxRetryAttempts: 2 });
  const { calls } = mockFetchQueue([
    {
      body: JSON.stringify({
        choices: [{ message: { content: "" }, finish_reason: "length" }],
        usage: { prompt_tokens: 500, completion_tokens: 1200 },
      }),
    },
  ]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 8000, { budget, maxRetries: 2 });

  await assert.rejects(
    () => provider.chat([{ role: "user", content: PROMPT_MARKER }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.equal(err.code, "PROVIDER_TRUNCATED_OUTPUT");
      assert.equal(err.retryable, false);
      const d = err.diagnostics;
      assert.ok(d);
      assert.equal(d.httpStatus, 200);
      assert.equal(d.finishReason, "length");
      assert.equal(d.contentLength, 0);
      assert.equal(d.usagePresent, true);
      assert.deepEqual(d.usage, {
        promptTokens: 500,
        promptCacheHitTokens: null,
        promptCacheMissTokens: null,
        completionTokens: 1200,
      });
      return true;
    },
  );
  assert.equal(calls.length, 1, "length truncation must NOT be retried");
  assert.equal(budget.accounting.httpAttempts, 1);
  assert.equal(budget.accounting.retryAttempts, 0);
  const telemetry = budget.tokenTelemetry();
  assert.equal(telemetry.responses, 1, "failed response usage still recorded");
  assert.equal(telemetry.promptTokens, 500);
  assert.equal(telemetry.completionTokens, 1200);
  const detailed = budget.providerTokenTelemetry();
  assert.equal(detailed.responsesWithUsage, 1);
  assert.equal(detailed.responsesMissingUsage, 0);
  assert.equal(detailed.promptCacheHitTokens, null);
  assert.equal(detailed.promptCacheMissTokens, null);
});

test("non-empty but length-finished content is still TRUNCATED (strict JSON would be cut)", async () => {
  const partial = '{"hypothesis":"x","skillMd":"# partial';
  const { calls } = mockFetchQueue([
    {
      body: JSON.stringify({
        choices: [{ message: { content: partial }, finish_reason: "length" }],
        usage: { prompt_tokens: 9, completion_tokens: 3000 },
      }),
    },
  ]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG);
  await assert.rejects(
    () => provider.chat([{ role: "user", content: "q" }], { responseFormat: "json_object" }),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.equal(err.code, "PROVIDER_TRUNCATED_OUTPUT");
      assert.equal(err.diagnostics?.contentLength, partial.length);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

// ── 3. 空 content + stop：EMPTY，确定性失败 ───────────────────────

test("empty content with finish_reason=stop fails as EMPTY without retry", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 1, maxRetryAttempts: 2 });
  const { calls } = mockFetchQueue([
    {
      body: JSON.stringify({
        choices: [{ message: { content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 700, completion_tokens: 0 },
      }),
    },
  ]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 8000, { budget, maxRetries: 2 });

  await assert.rejects(
    () => provider.chat([{ role: "user", content: PROMPT_MARKER }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.equal(err.code, "PROVIDER_EMPTY_RESPONSE");
      assert.equal(err.retryable, false);
      assert.equal(err.diagnostics?.finishReason, "stop");
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(budget.accounting.retryAttempts, 0);
  assert.equal(budget.tokenTelemetry().promptTokens, 700, "usage of the failing response is accounted");
});

// ── 4. 无 choices / schema 差异 ───────────────────────────────────

test("missing choices fails as NO_CHOICES deterministically", async () => {
  const { calls } = mockFetchQueue([{ body: JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 4 } }) }]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG);
  await assert.rejects(
    () => provider.chat([{ role: "user", content: "q" }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.equal(err.code, "PROVIDER_NO_CHOICES");
      assert.equal(err.retryable, false);
      assert.equal(err.diagnostics?.choiceCount, 0);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("choices with empty array fails as NO_CHOICES", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 1, maxRetryAttempts: 0 });
  mockFetchQueue([{ body: JSON.stringify({ choices: [] }) }]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 8000, { budget, maxRetries: 0 });
  await assert.rejects(
    () => provider.chat([{ role: "user", content: "q" }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.equal(err.code, "PROVIDER_NO_CHOICES");
      return true;
    },
  );
  assert.deepEqual(budget.providerTokenTelemetry(), {
    promptTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    completionTokens: 0,
    responses: 0,
    responsesWithUsage: 0,
    responsesMissingUsage: 0,
  }, "a failed response without an actual usage block is not sampled");
});

test("non-string content field fails as UNSUPPORTED_SCHEMA", async () => {
  mockFetchQueue([
    { body: JSON.stringify({ choices: [{ message: { content: 12345 }, finish_reason: "stop" }] }) },
  ]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG);
  await assert.rejects(
    () => provider.chat([{ role: "user", content: "q" }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.equal(err.code, "PROVIDER_UNSUPPORTED_SCHEMA");
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

// ── 5. 非 JSON body ───────────────────────────────────────────────

test("non-JSON 2xx body fails as NON_JSON_BODY and does not fabricate usage", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 1, maxRetryAttempts: 2 });
  mockFetchQueue([{ body: "This is not JSON." }]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 8000, { budget, maxRetries: 2 });
  await assert.rejects(
    () => provider.chat([{ role: "user", content: "q" }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.equal(err.code, "PROVIDER_NON_JSON_BODY");
      assert.equal(err.retryable, false);
      return true;
    },
  );
  const telemetry = budget.tokenTelemetry();
  assert.equal(telemetry.responses, 0, "no usage may be invented for an unparseable body");
});

// ── 6. 保留的重试面：网络/429/5xx 仍受预算限制重试 ────────────────

test("HTTP 429 stays retryable and a later attempt can succeed", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 1, maxRetryAttempts: 1 });
  const { calls } = mockFetchQueue([
    { status: 429, body: JSON.stringify({ error: "rate limited" }) },
    { body: okBody('{"type":"final"}') },
  ]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 8000, {
    budget,
    maxRetries: 1,
    sleep: async () => {},
  });
  const response = await provider.chat([{ role: "user", content: "q" }]);
  assert.equal(response.content, '{"type":"final"}');
  assert.equal(calls.length, 2);
  assert.equal(budget.accounting.retryAttempts, 1);
});

test("network error keeps code PROVIDER_NETWORK_ERROR and retryability", async () => {
  const originalFetch = globalThis.fetch;
  let attempt = 0;
  globalThis.fetch = (() => {
    attempt += 1;
    if (attempt === 1) return Promise.reject(new Error("ECONNREFUSED"));
    return Promise.resolve(new Response(okBody('{"ok":1}'), { status: 200 }));
  }) as typeof fetch;
  try {
    const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 8000, { maxRetries: 1, sleep: async () => {} });
    const response = await provider.chat([{ role: "user", content: "q" }]);
    assert.equal(response.content, '{"ok":1}');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP 401 is a deterministic PROVIDER_HTTP_ERROR (no retry)", async () => {
  const { calls } = mockFetchQueue([{ status: 401, body: JSON.stringify({ error: "unauthorized" }) }]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 8000, { maxRetries: 2, sleep: async () => {} });
  await assert.rejects(
    () => provider.chat([{ role: "user", content: "q" }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.equal(err.code, "PROVIDER_HTTP_ERROR");
      assert.equal(err.retryable, false);
      assert.equal(err.httpStatus, 401);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

// ── 7. 无泄漏：密钥 / prompt / baseUrl / 响应体 ───────────────────

test("no error or diagnostic ever leaks the key, prompt text, baseUrl or response body", async () => {
  const scenarios: Array<{ status?: number; body: string }> = [
    { body: JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }) },
    { body: JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }) },
    { body: JSON.stringify({ choices: [] }) },
    { body: "RAW_BODY_MARKER_not_json" },
    { status: 500, body: JSON.stringify({ error: "RAW_BODY_MARKER_boom" }) },
  ];
  for (const scenario of scenarios) {
    mockFetchQueue([scenario]);
    const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 8000, { maxRetries: 0 });
    await assert.rejects(
      () => provider.chat([{ role: "user", content: PROMPT_MARKER }]),
      (err: unknown) => {
        assert.ok(err instanceof OpenAICompatibleProviderError);
        const blob = `${err.message} ${JSON.stringify(err.diagnostics ?? {})}`;
        assert.ok(!blob.includes("test-key"), `key leaked: ${err.message}`);
        assert.ok(!blob.includes(PROMPT_MARKER), `prompt leaked: ${err.message}`);
        assert.ok(!blob.includes("https://api.deepseek.com"), `baseUrl leaked: ${err.message}`);
        assert.ok(!blob.includes("Authorization"), `auth header leaked: ${err.message}`);
        assert.ok(!blob.includes("RAW_BODY_MARKER"), `response body leaked: ${err.message}`);
        return true;
      },
    );
  }
});

// ── 8. reasoning_content 绝不当最终答案 ────────────────────────────

test("reasoning_content alone (empty content) is EMPTY, never substituted as the answer", async () => {
  mockFetchQueue([
    {
      body: JSON.stringify({
        choices: [{ message: { content: "", reasoning_content: "REASONING_MARKER_answer" }, finish_reason: "stop" }],
      }),
    },
  ]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG);
  await assert.rejects(
    () => provider.chat([{ role: "user", content: "q" }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.equal(err.code, "PROVIDER_EMPTY_RESPONSE");
      assert.ok(!err.message.includes("REASONING_MARKER"), "reasoning content must never surface");
      return true;
    },
  );
});
