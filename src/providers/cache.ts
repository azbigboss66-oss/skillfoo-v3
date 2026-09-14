import { sha256Hex } from "../runtime/capabilityAdapter.js";
import type { RunCallBudget } from "./runBudget.js";
import type { Provider, ProviderMessage, ProviderRequestOptions, ProviderResponse } from "./types.js";

// ── T09: provider response cache ─────────────────────────────────
//
// A cache hit is FREE: it spends no logical-call budget and no stage
// budget. A miss is the only thing that costs. The key covers every
// input that can change a model's answer — model identity, provider
// configuration fingerprint (never the API key itself), prompt hash,
// skill snapshot, scenario, environment mode, role/stage, frozen evidence,
// response behavior and actual temperature behavior —
// so a stale answer can never be served under a new identity.

/** Everything a cache key must cover. None of it is secret. */
export interface ProviderCacheKeyMaterial {
  model: string;
  providerConfigFingerprint: string;
  /** Opaque identity of the normalized base URL; never the URL or credentials. */
  baseUrlIdentity: string;
  promptSha256: string;
  skillSnapshotSha256: string;
  scenarioId: string;
  mode: string;
  role: string;
  responseFormat: "json_object" | "provider-default" | "not-applicable";
  maxOutputTokensBehavior: number | "provider-default" | "not-applicable";
  reasoningMode:
    | "provider-default"
    | "thinking-enabled"
    | "thinking-disabled"
    | "effort-none"
    | "effort-minimal"
    | "effort-low"
    | "effort-medium"
    | "effort-high"
    | "effort-xhigh"
    | "not-applicable";
  temperatureBehavior: number | "provider-default" | "not-applicable";
  frozenEvidenceSha256: string;
  stage: string;
}

/** Deterministic hash of the ordered role+content pairs of a prompt. */
export function promptSha256Of(messages: ProviderMessage[]): string {
  return sha256Hex(messages.map((message) => `${message.role}\u0000${message.content}`).join("\u0001"));
}

/** Deterministic, opaque cache key. Every material field changes the key. */
export function providerCacheKeyOf(material: ProviderCacheKeyMaterial): string {
  const canonical = [
    material.model,
    material.providerConfigFingerprint,
    material.baseUrlIdentity,
    material.promptSha256,
    material.skillSnapshotSha256,
    material.scenarioId,
    material.mode,
    material.role,
    material.responseFormat,
    String(material.maxOutputTokensBehavior),
    material.reasoningMode,
    String(material.temperatureBehavior),
    material.frozenEvidenceSha256,
    material.stage,
  ].join("\u0000");
  return sha256Hex(canonical);
}

/** One cached response. Never embeds credentials — response data only. */
export interface CachedResponseEntry {
  model: string;
  cachedAt: string;
  response: ProviderResponse;
}

export interface ResponseCacheStats {
  hits: number;
  misses: number;
  stores: number;
}

export interface ResponseCache {
  get(key: string): CachedResponseEntry | undefined;
  set(key: string, entry: CachedResponseEntry): void;
  recordHit(): void;
  recordMiss(): void;
  stats(): ResponseCacheStats;
}

/** In-memory cache for one process; stat counters included. */
export function createInMemoryResponseCache(): ResponseCache {
  const entries = new Map<string, CachedResponseEntry>();
  const stats: ResponseCacheStats = { hits: 0, misses: 0, stores: 0 };
  return {
    get: (key) => entries.get(key),
    set: (key, entry) => {
      entries.set(key, entry);
      stats.stores += 1;
    },
    recordHit: () => {
      stats.hits += 1;
    },
    recordMiss: () => {
      stats.misses += 1;
    },
    stats: () => ({ ...stats }),
  };
}

type ContextAwareInner = Provider & {
  setContext?: (scenarioId: string, snapshotId: string) => void;
};

export interface CachingProviderOptions {
  cache: ResponseCache;
  /**
   * Identity material that does not change per call (model, config
   * fingerprint, mode, provider behavior and base snapshot). Per-call material
   * (prompt hash, scenario, snapshot from setContext) is merged on top.
   */
  baseMaterial: Omit<ProviderCacheKeyMaterial, "promptSha256" | "scenarioId" | "responseFormat" | "role">;
  /** Present → misses spend logical-call (and stage) budget; hits are free. */
  budget?: RunCallBudget;
  /**
   * Billing role (P1 任务 2): logical calls billed on a miss are tagged with
   * this role in the shared budget, mirroring the raw provider's role.
   */
  role?: string;
  /** Injectable clock for deterministic `cachedAt` timestamps. */
  now?: () => string;
}

/** Immutable request identity for a concurrent scenario invocation. */
export interface ProviderRequestContext {
  scenarioId: string;
  snapshotId: string;
  /** Hash of the frozen item plus rubric/rule context used by this request. */
  frozenEvidenceSha256?: string;
}

export type CachingProvider = Provider & {
  /**
   * Return a chat-only view with immutable cache-key identity. Live parallel
   * runners must use this instead of the legacy mutable setContext method.
   */
  withContext: (context: ProviderRequestContext) => Provider;
  /** Legacy serial compatibility for scripted/funnel callers. */
  setContext: (scenarioId: string, snapshotId: string) => void;
  setStage: (stage: string | null) => void;
  cacheStats: () => ResponseCacheStats;
};

/**
 * Wrap a provider with the response cache. The wrapper forwards
 * `setContext` to the inner provider (exactly once per call, so scripted
 * playback stays correct) and exposes `setStage` for funnel stage billing.
 */
export function createCachingProvider(inner: Provider, options: CachingProviderOptions): CachingProvider {
  const { cache, baseMaterial, budget, role, now = () => new Date().toISOString() } = options;
  let scenarioId: string | null = null;
  let snapshotId: string | null = null;
  let stage = baseMaterial.stage;
  // Some fixture/legacy providers store context mutably. Concurrent bound
  // views must serialize only that provider interaction; normal live HTTP
  // providers have no setContext and keep their full caller-level parallelism.
  let legacyContextTail: Promise<void> = Promise.resolve();

  const chatWithContext = async (
    messages: ProviderMessage[],
    requestOptions: ProviderRequestOptions | undefined,
    context: ProviderRequestContext | null,
  ): Promise<ProviderResponse> => {
    const material: ProviderCacheKeyMaterial = {
      ...baseMaterial,
      promptSha256: promptSha256Of(messages),
      scenarioId: context?.scenarioId ?? scenarioId ?? "-",
      skillSnapshotSha256: context?.snapshotId ?? snapshotId ?? baseMaterial.skillSnapshotSha256,
      role: role ?? "not-applicable",
      responseFormat: requestOptions?.responseFormat ?? "provider-default",
      temperatureBehavior: requestOptions?.temperature ?? baseMaterial.temperatureBehavior,
      frozenEvidenceSha256:
        context?.frozenEvidenceSha256 ?? baseMaterial.frozenEvidenceSha256,
      stage,
    };
    const key = providerCacheKeyOf(material);
    const cached = cache.get(key);
    if (cached) {
      cache.recordHit();
      return cached.response;
    }
    cache.recordMiss();
    budget?.enterLogicalCall(role);
    const contextAware = inner as ContextAwareInner;
    const invoke = async (): Promise<ProviderResponse> => {
      if (context !== null && typeof contextAware.setContext === "function") {
        contextAware.setContext(context.scenarioId, context.snapshotId);
      }
      return inner.chat(messages, requestOptions);
    };
    const response =
      context !== null && typeof contextAware.setContext === "function"
        ? await (() => {
            const scheduled = legacyContextTail.then(invoke);
            legacyContextTail = scheduled.then(
              () => undefined,
              () => undefined,
            );
            return scheduled;
          })()
        : await invoke();
    cache.set(key, { model: material.model, cachedAt: now(), response });
    return response;
  };

  const provider: CachingProvider = {
    async chat(messages: ProviderMessage[], requestOptions?: ProviderRequestOptions): Promise<ProviderResponse> {
      return chatWithContext(messages, requestOptions, null);
    },
    withContext(context: ProviderRequestContext): Provider {
      return {
        chat: (messages: ProviderMessage[], requestOptions?: ProviderRequestOptions) =>
          chatWithContext(messages, requestOptions, context),
      };
    },
    setContext(nextScenarioId: string, nextSnapshotId: string): void {
      scenarioId = nextScenarioId;
      snapshotId = nextSnapshotId;
      const contextAware = inner as ContextAwareInner;
      if (typeof contextAware.setContext === "function") {
        contextAware.setContext(nextScenarioId, nextSnapshotId);
      }
    },
    setStage(nextStage: string | null): void {
      stage = nextStage ?? "not-applicable";
    },
    cacheStats: () => cache.stats(),
  };
  return provider;
}
