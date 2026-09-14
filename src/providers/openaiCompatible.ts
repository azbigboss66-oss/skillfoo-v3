import type {
  Provider,
  ProviderMessage,
  ProviderResponse,
  ProviderRequestOptions,
  ProviderResponseDiagnostics,
  ProviderTokenUsageSample,
  ProviderUsageTags,
} from "./types.js";
import type { LlmConfig } from "../config/llmConfig.js";
import type { RunCallBudget } from "./runBudget.js";
import { sha256Hex } from "../runtime/capabilityAdapter.js";
import type { OpenAICompatibleProviderIdentity } from "../types.js";

/**
 * Stable provider failure codes (P1 任务 1). Every 2xx anomaly gets a
 * deterministic code; only transport-level failures (network, timeout,
 * HTTP 429/5xx) stay retryable.
 */
export type OpenAICompatibleErrorCode =
  | "PROVIDER_CONFIGURATION_INVALID"
  | "PROVIDER_NETWORK_ERROR"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_NON_JSON_BODY"
  | "PROVIDER_NO_CHOICES"
  | "PROVIDER_UNSUPPORTED_SCHEMA"
  | "PROVIDER_EMPTY_RESPONSE"
  | "PROVIDER_TRUNCATED_OUTPUT";

/**
 * Named error thrown by {@link OpenAICompatibleProvider}. The adapter never
 * silently switches to scripted mode: a missing key or an anomalous
 * response is surfaced as this error so callers can fail loudly.
 *
 * The message, the code and the diagnostics carry at most the HTTP status
 * code, the provider name, and safe counters/flags. They NEVER include
 * the API key, the Authorization header, the full request body, the
 * response body, reasoning content, or the full baseUrl.
 */
export class OpenAICompatibleProviderError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: OpenAICompatibleErrorCode;
  /**
   * Transport-level retryability: ONLY network failures, timeouts and
   * HTTP 429/5xx are retryable. Every 2xx anomaly (empty content, length
   * truncation, schema deviation, non-JSON body) is deterministic for the
   * identical request, so retrying would only waste spend.
   */
  readonly retryable: boolean;
  /** HTTP status when a response was received; undefined on network errors. */
  readonly httpStatus?: number;
  /** Safe response diagnostics when a body was parsed or a status read. */
  readonly diagnostics?: ProviderResponseDiagnostics;

  constructor(
    code: OpenAICompatibleErrorCode,
    message: string,
    options: { retryable?: boolean; httpStatus?: number; diagnostics?: ProviderResponseDiagnostics } = {},
  ) {
    super(message);
    this.name = "OpenAICompatibleProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus;
    this.diagnostics = options.diagnostics;
  }
}

/** Bounded transport-retry policy for one logical chat call. */
export interface ProviderRetryOptions {
  /** Retries after the first attempt (default 2 → at most 3 HTTP attempts). */
  maxRetries?: number;
  /** Sleep between attempts; injectable so tests never wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Shared run-wide accounting + caps. When present, every HTTP attempt is
   * counted and each retry must spend from the separately authorized
   * transport-retry budget. Current U1 supplies a dynamic logical H; legacy
   * callers retain their own explicit limits.
   */
  budget?: RunCallBudget;
  /**
   * Per-response output ceiling forwarded as the Chat Completions
   * configured max-token field. This is a per-response cap, NOT a total-run
   * token budget — the run-level total is observed via token telemetry.
   */
  maxOutputTokens?: number;
  /**
   * Billing role (P1 任务 2): every HTTP attempt and retry this provider
   * spends is tagged with it in the shared budget, so reports can tell
   * evaluator traffic apart from bootstrap/mutation/repair/direct-refine
   * traffic without splitting the ledger.
   */
  role?: string;
  /**
   * Provider-level telemetry identity. It is copied on construction and never
   * sent over the wire; per-call tags may refine it without shared mutation.
   * The configured model and explicit billing role remain authoritative.
   */
  usageTags?: Readonly<ProviderUsageTags>;
}

export interface OpenAICompatibleSafeIdentity {
  readonly name: "openai-compatible";
  readonly endpointIdentity: string;
  readonly model: string;
  readonly authMode: "bearer" | "none";
  readonly requestProfile: LlmConfig["requestProfile"];
  readonly role: string;
  readonly requestTimeoutMs: number;
  readonly maxOutputTokensBehavior: number | "provider-default";
  readonly configFingerprint: string;
}

const IDENTITY_ROLE_KEYS = {
  evaluator: "evaluator",
  mutation: "mutation",
  repair: "repair",
  "direct-refine": "directRefine",
  "semantic-judge": "semanticJudge",
} as const;

/** Compose one strict, credential-free identity from the providers a stage actually uses. */
export function openAICompatibleProviderIdentityOf(
  providers: readonly OpenAICompatibleProvider[],
): OpenAICompatibleProviderIdentity {
  if (providers.length === 0) throw new Error("PROVIDER_IDENTITY_EMPTY: at least one live role is required");
  const identities = providers.map((provider) => provider.safeIdentity());
  const first = identities[0];
  const common = (identity: OpenAICompatibleSafeIdentity): boolean =>
    identity.endpointIdentity === first.endpointIdentity &&
    identity.model === first.model &&
    identity.authMode === first.authMode &&
    JSON.stringify(identity.requestProfile) === JSON.stringify(first.requestProfile);
  if (!identities.every(common)) {
    throw new Error("PROVIDER_IDENTITY_MIXED: one stage cannot combine different endpoint/model/request profiles");
  }
  const roles: OpenAICompatibleProviderIdentity["roles"] = {};
  for (const identity of identities) {
    const key = IDENTITY_ROLE_KEYS[identity.role as keyof typeof IDENTITY_ROLE_KEYS];
    if (!key) throw new Error(`PROVIDER_IDENTITY_ROLE_INVALID: unsupported live role ${identity.role}`);
    if (roles[key]) throw new Error(`PROVIDER_IDENTITY_ROLE_DUPLICATE: duplicate live role ${identity.role}`);
    roles[key] = {
      requestTimeoutMs: identity.requestTimeoutMs,
      maxOutputTokensBehavior: identity.maxOutputTokensBehavior,
      configFingerprint: identity.configFingerprint,
    };
  }
  return Object.freeze({
    adapterVersion: "openai-chat-completions-v1",
    name: "openai-compatible",
    endpointIdentity: first.endpointIdentity,
    model: first.model,
    authMode: first.authMode,
    requestProfile: Object.freeze({ ...first.requestProfile }),
    roles: Object.freeze(roles),
  });
}

/**
 * Cross-stage compatibility for one endpoint/model/wire profile. Stages may
 * use different role subsets, but any role present in both identities must
 * retain exactly the same runtime parameters.
 */
export function openAICompatibleProviderIdentitiesCompatible(
  left: OpenAICompatibleProviderIdentity,
  right: OpenAICompatibleProviderIdentity,
): boolean {
  if (
    left.adapterVersion !== right.adapterVersion ||
    left.name !== right.name ||
    left.endpointIdentity !== right.endpointIdentity ||
    left.model !== right.model ||
    left.authMode !== right.authMode ||
    JSON.stringify(left.requestProfile) !== JSON.stringify(right.requestProfile)
  ) return false;
  for (const role of ["evaluator", "mutation", "repair", "directRefine", "semanticJudge"] as const) {
    const leftRole = left.roles[role];
    const rightRole = right.roles[role];
    if (leftRole && rightRole && JSON.stringify(leftRole) !== JSON.stringify(rightRole)) return false;
  }
  return true;
}

/** Minimal subset of a Chat Completions response that this adapter reads. */
interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: unknown; reasoning_content?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: {
    prompt_tokens?: unknown;
    prompt_cache_hit_tokens?: unknown;
    prompt_cache_miss_tokens?: unknown;
    completion_tokens?: unknown;
  };
}

function tokenCountOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function usageOf(data: ChatCompletionResponse): ProviderTokenUsageSample {
  const usagePresent =
    data.usage !== undefined &&
    data.usage !== null &&
    typeof data.usage === "object" &&
    !Array.isArray(data.usage);
  if (!usagePresent) {
    return {
      usagePresent: false,
      promptTokens: null,
      promptCacheHitTokens: null,
      promptCacheMissTokens: null,
      completionTokens: null,
    };
  }
  return {
    usagePresent: true,
    promptTokens: tokenCountOrNull(data.usage?.prompt_tokens),
    promptCacheHitTokens: tokenCountOrNull(data.usage?.prompt_cache_hit_tokens),
    promptCacheMissTokens: tokenCountOrNull(data.usage?.prompt_cache_miss_tokens),
    completionTokens: tokenCountOrNull(data.usage?.completion_tokens),
  };
}

/**
 * Build the safe diagnostics block for one parsed 2xx response. Counters
 * and flags only — safe to print anywhere.
 */
function diagnosticsOf(
  data: ChatCompletionResponse,
  usage: ProviderTokenUsageSample,
): ProviderResponseDiagnostics {
  const first = Array.isArray(data.choices) ? data.choices[0] : undefined;
  const content = first?.message?.content;
  return {
    httpStatus: 200,
    choiceCount: Array.isArray(data.choices) ? data.choices.length : 0,
    contentLength: typeof content === "string" ? content.length : 0,
    finishReason: typeof first?.finish_reason === "string" ? first.finish_reason : null,
    usagePresent: usage.usagePresent,
    usage: usage.usagePresent
      ? {
          promptTokens: usage.promptTokens,
          promptCacheHitTokens: usage.promptCacheHitTokens,
          promptCacheMissTokens: usage.promptCacheMissTokens,
          completionTokens: usage.completionTokens,
        }
      : null,
    reasoningContentPresent: typeof first?.message?.reasoning_content === "string",
  };
}

/**
 * An OpenAI-compatible provider adapter that talks to one explicit
 * `/chat/completions` endpoint.
 *
 * - Receives an explicit {@link LlmConfig} — does NOT read any environment
 *   variable directly.
 * - Posts to the normalized `/chat/completions` endpoint.
 * - When `options.responseFormat === "json_object"`, includes
 *   `response_format: { type: "json_object" }` in the request body.
 * - Returns `choices[0].message.content`.
 * - Throws {@link OpenAICompatibleProviderError} for a network failure, a
 *   non-2xx status, or a malformed response body. Error messages never include
 *   the API key.
 */
export class OpenAICompatibleProvider implements Provider {
  private readonly apiKey?: string;
  private readonly authMode: "bearer" | "none";
  private readonly endpoint: string;
  private readonly model: string;
  private readonly requestProfile: LlmConfig["requestProfile"];
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly budget?: RunCallBudget;
  private readonly maxOutputTokens?: number;
  private readonly role?: string;
  private readonly usageTags: Readonly<ProviderUsageTags>;

  constructor(config: LlmConfig, requestTimeoutMs = 60_000, retry: ProviderRetryOptions = {}) {
    if (config.authMode === "bearer" && !config.apiKey?.trim()) {
      throw new OpenAICompatibleProviderError(
        "PROVIDER_CONFIGURATION_INVALID",
        "PROVIDER_AUTH_CONFIGURATION_INVALID: bearer auth requires a configured credential.",
      );
    }
    this.apiKey = config.apiKey;
    this.authMode = config.authMode;
    this.endpoint = config.endpoint;
    this.model = config.model;
    this.requestProfile = config.requestProfile;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxRetries = retry.maxRetries ?? 2;
    this.sleep = retry.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.budget = retry.budget;
    this.maxOutputTokens = retry.maxOutputTokens;
    this.role = retry.role;
    this.usageTags = Object.freeze({
      ...retry.usageTags,
      role: retry.role ?? retry.usageTags?.role,
      model: config.model,
    });
  }

  /**
   * Desensitized provider-configuration fingerprint for cache keys: a hash
   * of the actual endpoint, model, auth mode, request profile, role, timeout
   * and max-output behavior. The API key NEVER participates —
   * rotating a credential must not invalidate cached answers, and the
   * fingerprint must never leak the secret.
   */
  configFingerprint(): string {
    return sha256Hex(
      JSON.stringify({
        protocol: "openai-chat-completions-v1",
        endpoint: this.endpoint,
        model: this.model,
        authMode: this.authMode,
        requestProfile: this.requestProfile,
        role: this.role ?? "unspecified",
        requestTimeoutMs: this.requestTimeoutMs,
        maxOutputTokensBehavior: this.maxOutputTokens ?? "provider-default",
      }),
    ).slice(0, 24);
  }

  /** Safe base-URL identity for request/cache evidence; the URL itself is never returned. */
  endpointIdentity(): string {
    return sha256Hex(this.endpoint).slice(0, 24);
  }

  /** Complete safe identity for cache, artifact and resume bindings. */
  safeIdentity(): OpenAICompatibleSafeIdentity {
    return Object.freeze({
      name: "openai-compatible",
      endpointIdentity: this.endpointIdentity(),
      model: this.model,
      authMode: this.authMode,
      requestProfile: Object.freeze({ ...this.requestProfile }),
      role: this.role ?? "unspecified",
      requestTimeoutMs: this.requestTimeoutMs,
      maxOutputTokensBehavior: this.maxOutputTokens ?? "provider-default",
      configFingerprint: this.configFingerprint(),
    });
  }

  /**
   * One logical chat call with bounded transport-level retries (429/5xx,
   * network, timeout, malformed body). A retry re-sends the SAME request; it
   * never alters prompts, gates, or evolution semantics. Non-retryable errors
   * (4xx other than 429) fail immediately. The last error is rethrown
   * unchanged so callers and messages stay exactly as before.
   */
  async chat(
    messages: ProviderMessage[],
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        // Global run budget gate: throws ProviderBudgetError when the shared
        // retry budget is spent — before any further HTTP request is sent.
        this.budget?.enterRetry(this.role);
        await this.sleep(500 * 2 ** (attempt - 1));
      }
      this.budget?.enterHttpAttempt(this.role);
      try {
        return await this.attemptChat(messages, options);
      } catch (e) {
        // Budget violations and unexpected errors are fatal, never retried.
        if (!(e instanceof OpenAICompatibleProviderError)) throw e;
        if (!e.retryable) throw e;
        lastError = e;
      }
    }
    throw lastError;
  }

  /**
   * A single HTTP attempt of {@link chat}.
   */
  private async attemptChat(
    messages: ProviderMessage[],
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const usageTags: Readonly<ProviderUsageTags> = Object.freeze({
      ...this.usageTags,
      ...options?.usageTags,
      role: this.role ?? options?.usageTags?.role ?? this.usageTags.role,
      model: this.model,
    });
    const fail = (
      code: OpenAICompatibleErrorCode,
      message: string,
      errorOptions: { retryable?: boolean; httpStatus?: number; diagnostics?: ProviderResponseDiagnostics } = {},
    ): OpenAICompatibleProviderError =>
      new OpenAICompatibleProviderError(
        code,
        `${code}: ${message}${this.role === undefined ? "" : ` [role=${this.role}]`}`,
        errorOptions,
      );
    const url = this.endpoint;

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
    };

    if (options?.responseFormat === "json_object" && this.requestProfile.jsonMode === "json_object") {
      body.response_format = { type: "json_object" };
    }
    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (this.maxOutputTokens !== undefined) {
      body[this.requestProfile.maxTokensField] = this.maxOutputTokens;
    }
    if (this.requestProfile.reasoningMode === "thinking-enabled") {
      body.thinking = { type: "enabled" };
    } else if (this.requestProfile.reasoningMode === "thinking-disabled") {
      body.thinking = { type: "disabled" };
    } else if (this.requestProfile.reasoningMode.startsWith("effort-")) {
      body.reasoning_effort = this.requestProfile.reasoningMode.slice("effort-".length);
    }

    const controller = new AbortController();
    const timeoutFailure = (): OpenAICompatibleProviderError =>
      fail(
        "PROVIDER_TIMEOUT",
        `Request timed out after ${this.requestTimeoutMs}ms calling the OpenAI-compatible provider.`,
        { retryable: true },
      );
    let rejectTimeout!: (reason?: unknown) => void;
    // AbortSignal is advisory at the transport boundary: some proxies can
    // leave fetch pending after it is aborted. Race every awaited response
    // phase against an independent rejection so the configured cap is an
    // actual caller-visible deadline, not merely a cancellation request.
    const timeoutPromise: Promise<never> = new Promise((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      rejectTimeout(timeoutFailure());
      controller.abort();
    }, this.requestTimeoutMs);
    const withinTimeout = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, timeoutPromise]);
    try {
      let res: Response;
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (this.authMode === "bearer") headers.Authorization = `Bearer ${this.apiKey!}`;
        res = await withinTimeout(fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        }));
      } catch (e) {
        if (e instanceof OpenAICompatibleProviderError) throw e;
        if (controller.signal.aborted) {
          throw timeoutFailure();
        }
        throw fail(
          "PROVIDER_NETWORK_ERROR",
          "Network error calling the OpenAI-compatible provider; transport details were withheld.",
          { retryable: true },
        );
      }

      if (!res.ok) {
        const safeSummary = await withinTimeout(safeResponseSummary(res));
        if (controller.signal.aborted) {
          throw timeoutFailure();
        }
        const retryable = res.status === 429 || res.status >= 500;
        throw fail(
          "PROVIDER_HTTP_ERROR",
          `HTTP ${res.status} from the OpenAI-compatible provider: ${safeSummary}`,
          { retryable, httpStatus: res.status },
        );
      }

      let data: ChatCompletionResponse;
      try {
        data = (await withinTimeout(res.json() as Promise<ChatCompletionResponse>)) as ChatCompletionResponse;
      } catch (e) {
        if (e instanceof OpenAICompatibleProviderError) throw e;
        if (controller.signal.aborted) {
          throw timeoutFailure();
        }
        throw fail(
          "PROVIDER_NON_JSON_BODY",
          "The OpenAI-compatible provider returned HTTP 200 but the body is not valid JSON; refusing to guess a response.",
          { httpStatus: res.status },
        );
      }

      const usage = usageOf(data);
      const diagnostics = diagnosticsOf(data, usage);
      // A failing parsed response is billable only when the provider actually
      // supplied a usage block. Successful responses without usage are still
      // sampled below as explicitly missing/unknown.
      if (usage.usagePresent) {
        this.budget?.recordTokenUsage(usage, usageTags);
      }
      const first = Array.isArray(data.choices) ? data.choices[0] : undefined;

      if (!Array.isArray(data.choices) || data.choices.length === 0) {
        throw fail(
          "PROVIDER_NO_CHOICES",
          `The OpenAI-compatible provider returned HTTP 200 with no choices (choiceCount=${diagnostics.choiceCount}, finishReason=${diagnostics.finishReason ?? "absent"}, usagePresent=${diagnostics.usagePresent}).`,
          { httpStatus: res.status, diagnostics },
        );
      }

      const content = first?.message?.content;
      if (typeof content !== "string") {
        throw fail(
          "PROVIDER_UNSUPPORTED_SCHEMA",
          `The OpenAI-compatible provider returned HTTP 200 but choices[0].message.content is ${content === undefined ? "absent" : `of type ${typeof content}`}; the adapter only reads string content and never substitutes reasoning_content.`,
          { httpStatus: res.status, diagnostics },
        );
      }

      if (diagnostics.finishReason === "length") {
      // A length-finished response is truncated: even non-empty content is
      // an unusable partial document (strict JSON cannot parse). This is
      // deterministic for the identical request — no retry.
        throw fail(
        "PROVIDER_TRUNCATED_OUTPUT",
        `The OpenAI-compatible provider truncated the response at the configured output-token ceiling (finishReason=length, contentLength=${diagnostics.contentLength}); the strict full-replacement JSON contract cannot be satisfied by a truncated answer, so the call fails deterministically without retry. Raise the explicitly authorized max output tokens if the operator approves.`,
        { httpStatus: res.status, diagnostics },
      );
      }

      if (content.length === 0) {
        throw fail(
        "PROVIDER_EMPTY_RESPONSE",
        `The OpenAI-compatible provider returned HTTP 200 with empty content (finishReason=${diagnostics.finishReason ?? "absent"}, choiceCount=${diagnostics.choiceCount}, usagePresent=${diagnostics.usagePresent}, reasoningContentPresent=${diagnostics.reasoningContentPresent}); reasoning_content is never substituted for the answer.`,
        { httpStatus: res.status, diagnostics },
      );
      }

      if (!usage.usagePresent) {
        this.budget?.recordTokenUsage(usage, usageTags);
      }

      return {
        content,
        promptTokens: usage.promptTokens ?? undefined,
        completionTokens: usage.completionTokens ?? undefined,
        promptCacheHitTokens: usage.promptCacheHitTokens,
        promptCacheMissTokens: usage.promptCacheMissTokens,
        diagnostics,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Size-only summary of a non-OK HTTP response body. The body TEXT is
 * never surfaced — not even truncated — because an error body may echo
 * request material; only its byte length is reported.
 */
async function safeResponseSummary(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return text.length === 0 ? "(empty response body)" : `(response body: ${text.length} bytes, content withheld)`;
}
