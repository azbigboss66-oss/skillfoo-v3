import test from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider, OpenAICompatibleProviderError } from "./openaiCompatible.js";
import { RunCallBudget, ProviderBudgetError } from "./runBudget.js";
import type { LlmConfig } from "../config/llmConfig.js";

// ── Helpers ─────────────────────────────────────────────────────

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

/** Capture the fetch arguments and return a controlled response. */
function mockFetch(
  response: { status?: number; body?: unknown; text?: string },
): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const status = response.status ?? 200;
  const originalFetch = globalThis.fetch;
  const responseBody: string =
    typeof response.body === "string"
      ? response.body
      : response.text ?? "";

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return Promise.resolve(
      new Response(responseBody, {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;

  // Restore helper
  (mockFetch as unknown as { _restore?: () => void })._restore = () => {
    globalThis.fetch = originalFetch;
  };

  return { calls };
}

/** Restore the original fetch after a mockFetch call. */
function restoreFetch(): void {
  const restore = (mockFetch as unknown as { _restore?: () => void })._restore;
  if (restore) restore();
}

// ── Tests ───────────────────────────────────────────────────────

test.afterEach(() => {
  restoreFetch();
});

// ── Test 1: URL is exactly https://api.deepseek.com/chat/completions ──

test("request URL is exactly https://api.deepseek.com/chat/completions without double slashes", async () => {
  const { calls } = mockFetch({
    body: JSON.stringify({
      choices: [{ message: { content: '{"type":"final"}' } }],
    }),
  });

  const provider = new OpenAICompatibleProvider(FAKE_CONFIG);
  await provider.chat([{ role: "user", content: "test" }]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  // No double slash in the path portion (after https://)
  const pathPart = calls[0].url.replace(/^https?:\/\//, "");
  assert.doesNotMatch(pathPart, /\/{2,}/);
});

// ── Test 2: Request headers include Authorization and Content-Type ──

test("request headers include Authorization Bearer and JSON Content-Type", async () => {
  const { calls } = mockFetch({
    body: JSON.stringify({
      choices: [{ message: { content: '{"type":"final"}' } }],
    }),
  });

  const provider = new OpenAICompatibleProvider(FAKE_CONFIG);
  await provider.chat([{ role: "user", content: "test" }]);

  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer test-key");
  assert.equal(headers["Content-Type"], "application/json");
});

// ── Test 3: Body contains model, messages, and response_format ──

test("body contains model, messages, and response_format when requested", async () => {
  const { calls } = mockFetch({
    body: JSON.stringify({
      choices: [{ message: { content: '{"type":"final"}' } }],
    }),
  });

  const provider = new OpenAICompatibleProvider(FAKE_CONFIG);
  const messages = [
    { role: "system" as const, content: "Return JSON." },
    { role: "user" as const, content: "Find repos." },
  ];
  await provider.chat(messages, { responseFormat: "json_object" });

  const body = JSON.parse(calls[0].init?.body as string);
  assert.equal(body.model, "deepseek-v4-flash");
  assert.deepEqual(body.messages, messages);
  assert.deepEqual(body.response_format, { type: "json_object" });
});

// ── Test 3b: Without responseFormat, body does not include response_format ──

test("body does not include response_format when not requested", async () => {
  const { calls } = mockFetch({
    body: JSON.stringify({
      choices: [{ message: { content: '{"type":"final"}' } }],
    }),
  });

  const provider = new OpenAICompatibleProvider(FAKE_CONFIG);
  await provider.chat([{ role: "user", content: "test" }]);

  const body = JSON.parse(calls[0].init?.body as string);
  assert.equal(body.model, "deepseek-v4-flash");
  assert.ok(!("response_format" in body));
  assert.ok(!("temperature" in body), "omitted temperature must preserve the provider default");
});

test("temperature is sent only when the caller explicitly supplies it", async () => {
  const { calls } = mockFetch({
    body: JSON.stringify({ choices: [{ message: { content: '{"type":"final"}' } }] }),
  });
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG);
  await provider.chat([{ role: "user", content: "test" }], { temperature: 0 });
  const body = JSON.parse(calls[0].init?.body as string) as Record<string, unknown>;
  assert.equal(body.temperature, 0);
});

test("request-profile reasoning mode is sent and partitions the provider cache fingerprint", async () => {
  const { calls } = mockFetch({
    body: JSON.stringify({
      choices: [{ message: { content: '{"type":"final"}' } }],
    }),
  });

  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 30_000, { maxRetries: 0 });
  const defaultThinkingProvider = new OpenAICompatibleProvider({
    ...FAKE_CONFIG,
    requestProfile: { ...FAKE_CONFIG.requestProfile, reasoningMode: "provider-default" },
  }, 30_000, { maxRetries: 0 });
  await provider.chat([{ role: "user", content: "test" }], { responseFormat: "json_object" });

  const body = JSON.parse(calls[0].init?.body as string) as Record<string, unknown>;
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.notEqual(
    provider.configFingerprint(),
    defaultThinkingProvider.configFingerprint(),
    "thinking mode changes provider behavior and therefore must partition the response cache",
  );
});

// ── Test 4: Success reads choices[0].message.content ──

test("success reads choices[0].message.content", async () => {
  mockFetch({
    body: JSON.stringify({
      choices: [{ message: { content: '{"type":"final","answer":{"projects":[],"limitations":"none"}}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  });

  const provider = new OpenAICompatibleProvider(FAKE_CONFIG);
  const response = await provider.chat([{ role: "user", content: "test" }]);

  assert.equal(response.content, '{"type":"final","answer":{"projects":[],"limitations":"none"}}');
  assert.equal(response.promptTokens, 10);
  assert.equal(response.completionTokens, 5);
});

// ── Test 5: Error cases produce categorized errors ──

test("empty content throws categorized error", async () => {
  mockFetch({
    body: JSON.stringify({
      choices: [{ message: { content: "" } }],
    }),
  });

  const provider = new OpenAICompatibleProvider(FAKE_CONFIG);
  await assert.rejects(
    () => provider.chat([{ role: "user", content: "test" }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.ok(!err.message.includes("test-key"));
      return true;
    },
  );
});

test("no choices throws categorized error", async () => {
  mockFetch({
    body: JSON.stringify({}),
  });

  const provider = new OpenAICompatibleProvider(FAKE_CONFIG);
  await assert.rejects(
    () => provider.chat([{ role: "user", content: "test" }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.ok(!err.message.includes("test-key"));
      return true;
    },
  );
});

test("non-JSON HTTP response throws categorized error", async () => {
  mockFetch({
    text: "This is not JSON at all.",
  });

  const provider = new OpenAICompatibleProvider(FAKE_CONFIG);
  await assert.rejects(
    () => provider.chat([{ role: "user", content: "test" }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.ok(!err.message.includes("test-key"));
      return true;
    },
  );
});

test("HTTP 429 throws categorized error with status", async () => {
  mockFetch({
    status: 429,
    body: JSON.stringify({ error: "rate limited" }),
  });

  const provider = new OpenAICompatibleProvider(FAKE_CONFIG);
  await assert.rejects(
    () => provider.chat([{ role: "user", content: "test" }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.ok(err.message.includes("429"));
      assert.ok(!err.message.includes("test-key"));
      return true;
    },
  );
});

test("HTTP 5xx throws categorized error with status", async () => {
  mockFetch({
    status: 503,
    body: JSON.stringify({ error: "service unavailable" }),
  });

  const provider = new OpenAICompatibleProvider(FAKE_CONFIG);
  await assert.rejects(
    () => provider.chat([{ role: "user", content: "test" }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.ok(err.message.includes("503"));
      assert.ok(!err.message.includes("test-key"));
      return true;
    },
  );
});

test("HTTP 4xx throws categorized error with status", async () => {
  mockFetch({
    status: 401,
    body: JSON.stringify({ error: "unauthorized" }),
  });

  const provider = new OpenAICompatibleProvider(FAKE_CONFIG);
  await assert.rejects(
    () => provider.chat([{ role: "user", content: "test" }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.ok(err.message.includes("401"));
      assert.ok(!err.message.includes("test-key"));
      return true;
    },
  );
});

// ── Test 6: Network error throws categorized error ──

test("network error throws categorized error without key", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    return Promise.reject(new Error("ECONNREFUSED"));
  }) as typeof fetch;

  try {
    const provider = new OpenAICompatibleProvider(FAKE_CONFIG);
    await assert.rejects(
      () => provider.chat([{ role: "user", content: "test" }]),
      (err: unknown) => {
        assert.ok(err instanceof OpenAICompatibleProviderError);
        assert.ok(!err.message.includes("test-key"));
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request timeout aborts pending fetch without exposing the key", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    assert.ok(signal, "provider request must include an AbortSignal");
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;

  try {
    const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 5);
    await assert.rejects(
      () => provider.chat([{ role: "user", content: "test" }]),
      (err: unknown) => {
        assert.ok(err instanceof OpenAICompatibleProviderError);
        assert.match(err.message, /Request timed out after 5ms/);
        assert.ok(!err.message.includes("test-key"));
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request timeout fails closed when fetch ignores AbortSignal", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    assert.ok(init?.signal, "provider request must include an AbortSignal");
    // Reproduce the live proxy behavior observed in Case A v4: cancellation
    // is signalled but the fetch promise itself does not settle.
    return new Promise<Response>(() => {});
  }) as typeof fetch;

  try {
    const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 5, { maxRetries: 0 });
    await assert.rejects(
      () => provider.chat([{ role: "user", content: "test" }]),
      (err: unknown) => err instanceof OpenAICompatibleProviderError && err.code === "PROVIDER_TIMEOUT",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request timeout also aborts a response body that stalls after headers arrive", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    assert.ok(signal, "provider request must include an AbortSignal");
    let delayedWrite: ReturnType<typeof setTimeout> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener("abort", () => {
          if (delayedWrite) clearTimeout(delayedWrite);
          controller.error(signal.reason);
        }, { once: true });
        delayedWrite = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: '{"type":"final"}' } }] })));
          controller.close();
        }, 30);
      },
    });
    return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }));
  }) as typeof fetch;

  try {
    const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 5, { maxRetries: 0 });
    await assert.rejects(
      () => provider.chat([{ role: "user", content: "test" }]),
      (err: unknown) => err instanceof OpenAICompatibleProviderError && err.code === "PROVIDER_TIMEOUT",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Test 7: Constructor requires explicit config, uses provided key ──

test("constructor uses the explicit config apiKey, not any environment variable", async () => {
  const { calls } = mockFetch({
    body: JSON.stringify({
      choices: [{ message: { content: '{"type":"final"}' } }],
    }),
  });

  const config: LlmConfig = {
    apiKey: "explicit-key",
    authMode: "bearer",
    baseUrl: "https://api.deepseek.com",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash",
    requestProfile: FAKE_CONFIG.requestProfile,
  };

  const provider = new OpenAICompatibleProvider(config);
  await provider.chat([{ role: "user", content: "test" }]);

  // Verify the request used the explicit key, not any env fallback
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer explicit-key");
});

// ── Test 8: baseUrl with trailing slash does not produce double slash ──

test("baseUrl with trailing slash produces correct URL without double slash", async () => {
  const { calls } = mockFetch({
    body: JSON.stringify({
      choices: [{ message: { content: '{"type":"final"}' } }],
    }),
  });

  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    authMode: "bearer",
    baseUrl: "https://api.deepseek.com/",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash",
    requestProfile: FAKE_CONFIG.requestProfile,
  });
  await provider.chat([{ role: "user", content: "test" }]);

  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  // No double slash in the path portion (after https://)
  const pathPart = calls[0].url.replace(/^https?:\/\//, "");
  assert.doesNotMatch(pathPart, /\/{2,}/);
});

// ── Test 9: bounded transport-level retry ────────────────────────
//
// A single empty-content / 5xx / network blip must not abort a whole run.
// Retries re-send the SAME request (max 2 retries → 3 attempts) with
// exponential backoff; 4xx other than 429 is never retried. The injected
// sleep keeps these tests in fake time.

const NO_SLEEP = () => Promise.resolve();

/** Mock fetch serving each queued response once, then repeating the last. */
function mockFetchSequence(
  responses: Array<{ status?: number; body?: string; reject?: Error }>,
): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const item = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (item.reject) return Promise.reject(item.reject);
    return Promise.resolve(
      new Response(item.body ?? "", {
        status: item.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
  (mockFetch as unknown as { _restore?: () => void })._restore = () => {
    globalThis.fetch = originalFetch;
  };
  return { calls };
}

const EMPTY_CONTENT = JSON.stringify({ choices: [{ message: { content: "" } }] });
const VALID_CONTENT = JSON.stringify({
  choices: [{ message: { content: '{"type":"final"}' } }],
});

test("empty content is a deterministic EMPTY failure and is never retried (P1 contract)", async () => {
  const { calls } = mockFetchSequence([{ body: EMPTY_CONTENT }, { body: VALID_CONTENT }]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 60_000, { sleep: NO_SLEEP });

  await assert.rejects(
    () => provider.chat([{ role: "user", content: "test" }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.equal(err.code, "PROVIDER_EMPTY_RESPONSE");
      return true;
    },
  );
  assert.equal(calls.length, 1, "a valid second response is NOT fetched: empty content is deterministic");
});

test("retry gives up after maxRetries and rethrows the last retryable error", async () => {
  const { calls } = mockFetchSequence([
    { status: 503, body: JSON.stringify({ error: "unavailable" }) },
    { status: 503, body: JSON.stringify({ error: "unavailable" }) },
    { status: 503, body: JSON.stringify({ error: "unavailable" }) },
  ]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 60_000, { sleep: NO_SLEEP });

  await assert.rejects(
    () => provider.chat([{ role: "user", content: "test" }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.equal(err.code, "PROVIDER_HTTP_ERROR");
      assert.match(err.message, /HTTP 503/);
      assert.ok(!err.message.includes("test-key"));
      return true;
    },
  );
  assert.equal(calls.length, 3, "first attempt + 2 retries, then give up");
});

test("retry recovers from HTTP 503", async () => {
  const { calls } = mockFetchSequence([
    { status: 503, body: JSON.stringify({ error: "service unavailable" }) },
    { body: VALID_CONTENT },
  ]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 60_000, { sleep: NO_SLEEP });

  const response = await provider.chat([{ role: "user", content: "test" }]);

  assert.equal(response.content, '{"type":"final"}');
  assert.equal(calls.length, 2);
});

test("HTTP 401 is never retried", async () => {
  const { calls } = mockFetchSequence([{ status: 401, body: JSON.stringify({ error: "unauthorized" }) }]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 60_000, { sleep: NO_SLEEP });

  await assert.rejects(
    () => provider.chat([{ role: "user", content: "test" }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.ok(err.message.includes("401"));
      return true;
    },
  );
  assert.equal(calls.length, 1, "deterministic auth failures fail immediately");
});

test("network error is retried and recovers", async () => {
  const { calls } = mockFetchSequence([{ reject: new Error("ECONNRESET") }, { body: VALID_CONTENT }]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 60_000, { sleep: NO_SLEEP });

  const response = await provider.chat([{ role: "user", content: "test" }]);

  assert.equal(response.content, '{"type":"final"}');
  assert.equal(calls.length, 2);
});

test("maxRetries: 0 disables transport retry", async () => {
  const { calls } = mockFetchSequence([{ body: EMPTY_CONTENT }]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 60_000, { maxRetries: 0, sleep: NO_SLEEP });

  await assert.rejects(() => provider.chat([{ role: "user", content: "test" }]));
  assert.equal(calls.length, 1);
});

test("retry backoff sleeps 500ms then 1000ms between attempts", async () => {
  mockFetchSequence([
    { status: 503, body: JSON.stringify({ error: "unavailable" }) },
    { status: 503, body: JSON.stringify({ error: "unavailable" }) },
    { status: 503, body: JSON.stringify({ error: "unavailable" }) },
  ]);
  const sleeps: number[] = [];
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 60_000, {
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

  await assert.rejects(() => provider.chat([{ role: "user", content: "test" }]));
  assert.deepEqual(sleeps, [500, 1000]);
});

// ── Test 10: run-wide call budget (P0 closure) ───────────────────
//
// Run limits come from an explicit stage authorization. The shared
// RunCallBudget enforces the retry half inside the provider: once the
// configured retries are spent across the WHOLE run, the next retry refuses
// with a fatal ProviderBudgetError
// BEFORE another HTTP request leaves the machine. Deterministic,
// fake-time, mock fetch.

test("HTTP 403 is never retried", async () => {
  const { calls } = mockFetchSequence([{ status: 403, body: JSON.stringify({ error: "forbidden" }) }]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 60_000, { sleep: NO_SLEEP });

  await assert.rejects(
    () => provider.chat([{ role: "user", content: "test" }]),
    (err: unknown) => {
      assert.ok(err instanceof OpenAICompatibleProviderError);
      assert.ok(err.message.includes("403"));
      assert.ok(!err.message.includes("test-key"));
      return true;
    },
  );
  assert.equal(calls.length, 1, "deterministic permission failures fail immediately");
});

test("HTTP 429 recovers via retry", async () => {
  const { calls } = mockFetchSequence([
    { status: 429, body: JSON.stringify({ error: "rate limited" }) },
    { body: VALID_CONTENT },
  ]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 60_000, { sleep: NO_SLEEP });

  const response = await provider.chat([{ role: "user", content: "test" }]);

  assert.equal(response.content, '{"type":"final"}');
  assert.equal(calls.length, 2);
});

test("the configured run-wide retry budget stops retries at its explicit cap", async () => {
  const { calls } = mockFetchSequence([{ status: 503, body: JSON.stringify({ error: "unavailable" }) }]);
  const budget = new RunCallBudget({ maxLogicalCalls: 5, maxRetryAttempts: 8 });
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 60_000, { sleep: NO_SLEEP, budget });

  // Each logical call spends 1 initial attempt + up to 2 retries. After
  // four failed calls the budget holds 4×2 = 8 retries; the fifth call's
  // first retry refuses BEFORE any further HTTP request is sent.
  for (let i = 0; i < 4; i++) {
    await assert.rejects(
      () => provider.chat([{ role: "user", content: "test" }]),
      (err: unknown) => err instanceof OpenAICompatibleProviderError,
    );
  }
  await assert.rejects(
    () => provider.chat([{ role: "user", content: "test" }]),
    (err: unknown) => {
      assert.ok(err instanceof ProviderBudgetError);
      assert.equal((err as ProviderBudgetError).kind, "retry_attempts");
      return true;
    },
  );
  assert.equal(calls.length, 13, "4×3 failed attempts + 1 attempt whose retry is refused");
  assert.equal(budget.accounting.retryAttempts, 8, "exactly the retry cap, never more");
  assert.equal(budget.accounting.httpAttempts, 13, "httpAttempts match the mock fetch count exactly");
});

test("httpAttempts and retryAttempts match the mock fetch count exactly", async () => {
  const { calls } = mockFetchSequence([
    { status: 503, body: JSON.stringify({ error: "unavailable" }) },
    { body: VALID_CONTENT },
    { status: 503, body: JSON.stringify({ error: "unavailable" }) },
    { status: 503, body: JSON.stringify({ error: "unavailable" }) },
    { status: 503, body: JSON.stringify({ error: "unavailable" }) },
  ]);
  const budget = new RunCallBudget({ maxLogicalCalls: 2, maxRetryAttempts: 3 });
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 60_000, { sleep: NO_SLEEP, budget });

  await provider.chat([{ role: "user", content: "a" }]); // 503 → ok: 2 attempts, 1 retry
  await assert.rejects(() => provider.chat([{ role: "user", content: "b" }])); // 3×503: 3 attempts, 2 retries

  assert.equal(calls.length, 5);
  assert.equal(budget.accounting.httpAttempts, calls.length, "every HTTP request is counted");
  assert.equal(budget.accounting.retryAttempts, calls.length - 2, "attempts minus the two logical calls");
});
