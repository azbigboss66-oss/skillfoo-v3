import test from "node:test";
import assert from "node:assert/strict";
import type { Provider, ProviderMessage, ProviderResponse } from "./types.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import { RunCallBudget } from "./runBudget.js";
import {
  createCachingProvider,
  createInMemoryResponseCache,
  promptSha256Of,
  providerCacheKeyOf,
  type ProviderCacheKeyMaterial,
} from "./cache.js";
import { normalizeChatCompletionsEndpoint, type LlmConfig } from "../config/llmConfig.js";

// ── T09: provider response cache ─────────────────────────────────
// The cache key must cover everything that can change a model's answer:
// model identity, provider configuration fingerprint (never the key),
// prompt/template hash, skill snapshot hash, scenario id, environment
// mode, role, stage, frozen evidence, request format, provider behavior and
// actual temperature behavior. A hit is visible in the stats and spends
// NO logical-call budget — a miss is the only thing that costs.

const BASE_MATERIAL: Omit<ProviderCacheKeyMaterial, "promptSha256" | "scenarioId" | "responseFormat" | "role"> = {
  model: "deepseek-chat",
  providerConfigFingerprint: "fingerprint-a",
  baseUrlIdentity: "endpoint-a",
  skillSnapshotSha256: "aa".repeat(32),
  mode: "fixture",
  maxOutputTokensBehavior: 4096,
  reasoningMode: "provider-default",
  temperatureBehavior: "provider-default",
  frozenEvidenceSha256: "ee".repeat(32),
  stage: "public-select",
};

function material(overrides: Partial<ProviderCacheKeyMaterial> = {}): ProviderCacheKeyMaterial {
  return {
    ...BASE_MATERIAL,
    promptSha256: "bb".repeat(32),
    scenarioId: "d1",
    role: "evaluator",
    responseFormat: "json_object",
    ...overrides,
  };
}

function countingProvider(responses: string[]): Provider & { calls: ProviderMessage[][] } {
  const calls: ProviderMessage[][] = [];
  let index = 0;
  return {
    calls,
    async chat(messages: ProviderMessage[]): Promise<ProviderResponse> {
      calls.push(messages.map((message) => ({ ...message })));
      const content = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return { content, promptTokens: 10, completionTokens: 5 };
    },
  };
}

const MESSAGES: ProviderMessage[] = [
  { role: "system", content: "system text" },
  { role: "user", content: "user prompt" },
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("a cache key covers every actual request and frozen-evidence behavior field", () => {
  const base = providerCacheKeyOf(material());
  for (const override of [
    { model: "deepseek-reasoner" },
    { providerConfigFingerprint: "fingerprint-b" },
    { baseUrlIdentity: "endpoint-b" },
    { promptSha256: "cc".repeat(32) },
    { skillSnapshotSha256: "dd".repeat(32) },
    { scenarioId: "d2" },
    { mode: "replay" as const },
    { role: "semantic-judge" },
    { responseFormat: "provider-default" as const },
    { maxOutputTokensBehavior: 16384 },
    { reasoningMode: "thinking-disabled" as const },
    { temperatureBehavior: 0.7 },
    { frozenEvidenceSha256: "ff".repeat(32) },
    { stage: "sealed" },
  ] as Array<Partial<ProviderCacheKeyMaterial>>) {
    assert.notEqual(
      providerCacheKeyOf(material(override)),
      base,
      `changing ${Object.keys(override)[0]} must change the cache key`,
    );
  }
  assert.equal(providerCacheKeyOf(material()), base);
});

test("promptSha256Of hashes the ordered role+content pairs deterministically", () => {
  assert.equal(promptSha256Of(MESSAGES), promptSha256Of(MESSAGES));
  assert.notEqual(promptSha256Of(MESSAGES), promptSha256Of([...MESSAGES].reverse()));
  assert.notEqual(
    promptSha256Of(MESSAGES),
    promptSha256Of([{ role: "user", content: "a different prompt" }]),
  );
});

test("the second identical call is served from the cache and the inner provider is called once", async () => {
  const inner = countingProvider(["{\"type\":\"final\"}"]);
  const cache = createInMemoryResponseCache();
  const provider = createCachingProvider(inner, { cache, baseMaterial: BASE_MATERIAL });

  const first = await provider.chat(MESSAGES, { responseFormat: "json_object" });
  const second = await provider.chat(MESSAGES, { responseFormat: "json_object" });

  assert.equal(first.content, "{\"type\":\"final\"}");
  assert.equal(second.content, first.content);
  assert.equal(second.promptTokens, 10);
  assert.equal(inner.calls.length, 1, "the inner provider must not be called on a cache hit");
  const stats = cache.stats();
  assert.equal(stats.stores, 1);
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
});

test("a cached entry records the model and a timestamp, never the API key", async () => {
  const inner = countingProvider(["answer"]);
  const cache = createInMemoryResponseCache();
  let clock = 1_000;
  const provider = createCachingProvider(inner, {
    cache,
    baseMaterial: BASE_MATERIAL,
    now: () => new Date(clock).toISOString(),
  });
  await provider.chat(MESSAGES);
  await provider.chat(MESSAGES); // hit
  clock += 5;
  assert.equal(cache.stats().hits, 1);

  const key = providerCacheKeyOf({
    ...BASE_MATERIAL,
    promptSha256: promptSha256Of(MESSAGES),
    scenarioId: "-",
    role: "not-applicable",
    responseFormat: "provider-default",
  });
  const entry = cache.get(key);
  assert.ok(entry, "the entry must exist under the computed key");
  assert.equal(entry.model, "deepseek-chat");
  assert.equal(entry.cachedAt, new Date(1_000).toISOString());
  const serialized = JSON.stringify(entry);
  assert.ok(!/"sk-|apiKey|Authorization/.test(serialized), "the entry must never embed credentials");
});

test("omitted temperature is keyed as provider-default and is never represented as numeric zero", async () => {
  const inner = countingProvider(["default", "explicit-zero"]);
  const cache = createInMemoryResponseCache();
  const provider = createCachingProvider(inner, { cache, baseMaterial: BASE_MATERIAL });

  await provider.chat(MESSAGES);
  await provider.chat(MESSAGES);
  await provider.chat(MESSAGES, { temperature: 0 });

  assert.equal(cache.stats().hits, 1, "the repeated provider-default request should hit");
  assert.equal(cache.stats().misses, 2, "explicit temperature zero is a distinct request");
  assert.equal(inner.calls.length, 2);
  const defaultKey = providerCacheKeyOf({
    ...BASE_MATERIAL,
    promptSha256: promptSha256Of(MESSAGES),
    scenarioId: "-",
    role: "not-applicable",
    responseFormat: "provider-default",
  });
  const explicitZeroKey = providerCacheKeyOf({
    ...BASE_MATERIAL,
    promptSha256: promptSha256Of(MESSAGES),
    scenarioId: "-",
    role: "not-applicable",
    responseFormat: "provider-default",
    temperatureBehavior: 0,
  });
  assert.ok(cache.get(defaultKey));
  assert.ok(cache.get(explicitZeroKey));
  assert.notEqual(defaultKey, explicitZeroKey);
});

test("response format and frozen item-rubric hash partition the cache", async () => {
  const inner = countingProvider(["plain", "json", "other-rubric"]);
  const cache = createInMemoryResponseCache();
  const provider = createCachingProvider(inner, { cache, baseMaterial: BASE_MATERIAL });

  await provider.chat(MESSAGES);
  await provider.chat(MESSAGES, { responseFormat: "json_object" });
  await provider.withContext({
    scenarioId: "d1",
    snapshotId: BASE_MATERIAL.skillSnapshotSha256,
    frozenEvidenceSha256: "99".repeat(32),
  }).chat(MESSAGES, { responseFormat: "json_object" });

  assert.equal(cache.stats().misses, 3);
  assert.equal(inner.calls.length, 3);
});

test("setContext captures scenario and snapshot identity into the key and forwards to the inner provider", async () => {
  const inner = countingProvider(["first", "second"]);
  const cache = createInMemoryResponseCache();
  const seen: Array<[string, string]> = [];
  const contextAwareInner: Provider & {
    setContext?: (scenarioId: string, snapshotId: string) => void;
  } = {
    ...inner,
    setContext(scenarioId: string, snapshotId: string) {
      seen.push([scenarioId, snapshotId]);
    },
  };
  const provider = createCachingProvider(contextAwareInner, { cache, baseMaterial: BASE_MATERIAL });
  provider.setContext!("d3", "snap-2");

  await provider.chat(MESSAGES);
  await provider.chat(MESSAGES);

  assert.deepEqual(seen, [["d3", "snap-2"]], "setContext must be forwarded exactly once");
  assert.equal(inner.calls.length, 1);
  assert.equal(cache.stats().hits, 1);

  // A different snapshot identity must be a MISS: a changed skill snapshot
  // can never reuse another snapshot's answer.
  provider.setContext!("d3", "snap-9");
  await provider.chat(MESSAGES);
  assert.equal(inner.calls.length, 2, "a new snapshot id must bypass the cache");
  assert.equal(cache.stats().misses, 2);
});

test("withContext keeps simultaneous scenario and snapshot keys isolated", async () => {
  const inner = countingProvider(["first", "second"]);
  const cache = createInMemoryResponseCache();
  const seen: Array<[string, string]> = [];
  const contextAwareInner: Provider & {
    setContext?: (scenarioId: string, snapshotId: string) => void;
  } = {
    ...inner,
    setContext(scenarioId: string, snapshotId: string) {
      seen.push([scenarioId, snapshotId]);
    },
  };
  const provider = createCachingProvider(contextAwareInner, { cache, baseMaterial: BASE_MATERIAL });
  const one = provider.withContext({ scenarioId: "A", snapshotId: "snap-A" });
  const two = provider.withContext({ scenarioId: "B", snapshotId: "snap-B" });

  await Promise.all([one.chat(MESSAGES), two.chat(MESSAGES)]);

  assert.deepEqual(seen.sort(), [["A", "snap-A"], ["B", "snap-B"]]);
  assert.equal(inner.calls.length, 2);
  assert.equal(cache.stats().stores, 2);
});

test("withContext serializes a legacy stateful inner provider instead of racing its context", async () => {
  let activeContext: [string, string] | null = null;
  const seenAtChat: Array<[string, string]> = [];
  const inner: Provider & { setContext(scenarioId: string, snapshotId: string): void } = {
    setContext(scenarioId: string, snapshotId: string) {
      activeContext = [scenarioId, snapshotId];
    },
    async chat(): Promise<ProviderResponse> {
      await delay(5);
      seenAtChat.push(activeContext!);
      return { content: "answer" };
    },
  };
  const provider = createCachingProvider(inner, { cache: createInMemoryResponseCache(), baseMaterial: BASE_MATERIAL });

  await Promise.all([
    provider.withContext({ scenarioId: "A", snapshotId: "snap-A" }).chat(MESSAGES),
    provider.withContext({ scenarioId: "B", snapshotId: "snap-B" }).chat(MESSAGES),
  ]);

  assert.deepEqual(seenAtChat, [["A", "snap-A"], ["B", "snap-B"]]);
});

test("a cache hit spends no logical-call budget; a miss spends one", async () => {
  const inner = countingProvider(["answer"]);
  const cache = createInMemoryResponseCache();
  const budget = new RunCallBudget({ maxLogicalCalls: 2, maxRetryAttempts: 0 });
  const provider = createCachingProvider(inner, { cache, baseMaterial: BASE_MATERIAL, budget });

  await provider.chat(MESSAGES); // miss: 1 logical call
  await provider.chat(MESSAGES); // hit: 0 logical calls
  await provider.chat(MESSAGES); // hit: 0 logical calls

  assert.equal(budget.accounting.logicalCalls, 1);
  assert.equal(cache.stats().hits, 2);
});

test("the same scenario rerun for full public is fully served from the cache", async () => {
  const inner = countingProvider(["{\"type\":\"final\"}"]);
  const cache = createInMemoryResponseCache();
  const provider = createCachingProvider(inner, { cache, baseMaterial: BASE_MATERIAL });

  provider.setContext!("d1", "snap-1");
  await provider.chat(MESSAGES);
  provider.setContext!("d2", "snap-1");
  await provider.chat(MESSAGES);

  // full_public reruns both slice items for the same snapshot
  provider.setContext!("d1", "snap-1");
  await provider.chat(MESSAGES);
  provider.setContext!("d2", "snap-1");
  await provider.chat(MESSAGES);

  assert.equal(inner.calls.length, 2, "slice reruns must all hit the cache");
  assert.equal(cache.stats().hits, 2);
});

test("OpenAICompatibleProvider.configFingerprint is deterministic, config-sensitive and key-free", () => {
  const config = (baseUrl: string, model: string): LlmConfig => ({
    apiKey: "sk-secret-value",
    authMode: "bearer",
    ...normalizeChatCompletionsEndpoint(baseUrl),
    model,
    requestProfile: {
      preset: "portable",
      jsonMode: "omitted",
      reasoningMode: "provider-default",
      maxTokensField: "max_tokens",
    },
  });
  const a = new OpenAICompatibleProvider(config("https://api.example.com/", "deepseek-chat"), 30_000);
  const aAgain = new OpenAICompatibleProvider(config("https://api.example.com", "deepseek-chat"), 30_000);
  const b = new OpenAICompatibleProvider(config("https://api.example.com", "deepseek-reasoner"), 30_000);
  const otherHost = new OpenAICompatibleProvider(config("https://other.example.com", "deepseek-chat"), 30_000);

  assert.equal(a.configFingerprint(), aAgain.configFingerprint(), "trailing slash is normalized");
  assert.equal(a.configFingerprint(), a.configFingerprint(), "deterministic");
  assert.notEqual(a.configFingerprint(), b.configFingerprint(), "model is part of the fingerprint");
  assert.notEqual(a.configFingerprint(), otherHost.configFingerprint(), "baseUrl is part of the fingerprint");

  const sameKeyDifferentSecret = new OpenAICompatibleProvider(
    config("https://api.example.com", "deepseek-chat"),
    30_000,
  );
  assert.equal(
    a.configFingerprint(),
    sameKeyDifferentSecret.configFingerprint(),
    "the api key never changes the fingerprint",
  );
  assert.ok(!a.configFingerprint().includes("sk-"));
  assert.match(a.configFingerprint(), /^[0-9a-f]{16,}$/);
});
