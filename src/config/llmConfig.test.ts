import test from "node:test";
import assert from "node:assert/strict";
import {
  getLlmConfig,
  LlmConfigError,
  normalizeChatCompletionsEndpoint,
} from "./llmConfig.js";
import { OpenAICompatibleProvider } from "../providers/openaiCompatible.js";

const okResponse = (): Response => new Response(
  JSON.stringify({ choices: [{ message: { content: '{"status":"ok"}' }, finish_reason: "stop" }] }),
  { status: 200, headers: { "Content-Type": "application/json" } },
);

test("bearer auth requires a key and sends Authorization without putting the key in identity", async () => {
  const config = getLlmConfig({
    env: {
      LLM_BASE_URL: "https://cloud.example.test/v1/",
      LLM_MODEL: "cloud-model",
      LLM_AUTH_MODE: "bearer",
      LLM_API_KEY: "test-secret-key",
    },
    preset: "portable",
  });
  const calls: RequestInit[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    return okResponse();
  }) as typeof fetch;
  try {
    const provider = new OpenAICompatibleProvider(config, 5_000, { maxRetries: 0, role: "evaluator" });
    await provider.chat([{ role: "user", content: "return JSON" }], { responseFormat: "json_object" });
    const headers = calls[0]?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer test-secret-key");
    assert.doesNotMatch(JSON.stringify(provider.safeIdentity()), /test-secret-key/);
    assert.doesNotMatch(provider.configFingerprint(), /test-secret-key/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("none auth needs no key and sends no Authorization header", async () => {
  const config = getLlmConfig({
    env: {
      LLM_BASE_URL: "http://127.0.0.1:11434/v1",
      LLM_MODEL: "qwen3:8b",
      LLM_AUTH_MODE: "none",
    },
    preset: "portable",
  });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return okResponse();
  }) as typeof fetch;
  try {
    const provider = new OpenAICompatibleProvider(config, 5_000, { maxRetries: 0, role: "evaluator" });
    await provider.chat([{ role: "user", content: "return JSON" }], { responseFormat: "json_object" });
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal("Authorization" in headers, false);
    assert.equal(calls[0]?.url, "http://127.0.0.1:11434/v1/chat/completions");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bearer auth without a key fails closed", () => {
  assert.throws(
    () => getLlmConfig({
      env: {
        LLM_BASE_URL: "https://cloud.example.test/v1",
        LLM_MODEL: "cloud-model",
        LLM_AUTH_MODE: "bearer",
      },
      preset: "portable",
    }),
    (error: unknown) => error instanceof LlmConfigError && error.code === "LLM_API_KEY_MISSING",
  );
});

test("base URL normalization appends chat/completions exactly once", () => {
  assert.deepEqual(
    normalizeChatCompletionsEndpoint("https://provider.example/v1/"),
    {
      baseUrl: "https://provider.example/v1",
      endpoint: "https://provider.example/v1/chat/completions",
    },
  );
  assert.deepEqual(
    normalizeChatCompletionsEndpoint("https://provider.example/v1/chat/completions/"),
    {
      baseUrl: "https://provider.example/v1/chat/completions",
      endpoint: "https://provider.example/v1/chat/completions",
    },
  );
});

test("base URL rejects credentials, query strings, fragments and non-HTTP schemes", () => {
  for (const value of [
    "https://user:secret@provider.example/v1",
    "https://provider.example/v1?tenant=private",
    "https://provider.example/v1#private",
    "file:///tmp/provider",
  ]) {
    assert.throws(() => normalizeChatCompletionsEndpoint(value), LlmConfigError);
  }
});

test("portable and deepseek presets freeze distinct explicit wire profiles", () => {
  const env = {
    LLM_BASE_URL: "https://provider.example/v1",
    LLM_MODEL: "model-a",
    LLM_AUTH_MODE: "none",
  };
  assert.deepEqual(getLlmConfig({ env, preset: "portable" }).requestProfile, {
    preset: "portable",
    jsonMode: "omitted",
    reasoningMode: "provider-default",
    maxTokensField: "max_tokens",
  });
  assert.deepEqual(getLlmConfig({ env, preset: "deepseek" }).requestProfile, {
    preset: "deepseek",
    jsonMode: "json_object",
    reasoningMode: "thinking-disabled",
    maxTokensField: "max_tokens",
  });
});

test("wire-profile overrides are explicit and legacy DEEPSEEK variables never fall back", () => {
  const configured = getLlmConfig({
    env: {
      LLM_BASE_URL: "https://provider.example/v1",
      LLM_MODEL: "model-a",
      LLM_AUTH_MODE: "none",
      LLM_JSON_MODE: "json_object",
      LLM_REASONING_MODE: "effort-medium",
      LLM_MAX_TOKENS_FIELD: "max_completion_tokens",
    },
  });
  assert.deepEqual(configured.requestProfile, {
    preset: "portable",
    jsonMode: "json_object",
    reasoningMode: "effort-medium",
    maxTokensField: "max_completion_tokens",
  });
  assert.throws(
    () => getLlmConfig({
      env: {
        DEEPSEEK_BASE_URL: "https://api.deepseek.com",
        DEEPSEEK_MODEL: "deepseek-model",
        DEEPSEEK_API_KEY: "legacy-secret",
      },
    }),
    (error: unknown) => error instanceof LlmConfigError && error.code === "LLM_LEGACY_ENV_UNSUPPORTED",
  );
});
