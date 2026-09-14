import type {
  Provider,
  ProviderMessage,
  ProviderRequestOptions,
  ProviderResponse,
  ProviderTokenUsageSample,
  ProviderUsageTags,
} from "./types.js";

/**
 * Run-wide provider-call accounting — counters only, never payloads, keys,
 * or headers. The accounting object is shared: the CLI seeds it as the
 * metrics object that the terminal report and compact artifacts print.
 */
export interface RunCallAccounting {
  /** Logical chat calls started (evaluation episodes + patch proposals). */
  logicalCalls: number;
  /** Actual HTTP requests sent, including transport retries. */
  httpAttempts: number;
  /** Transport-level retries spent across the whole run. */
  retryAttempts: number;
}

/**
 * Hard per-run caps. The HTTP-attempt ceiling is derived, not configured:
 * maxLogicalCalls + maxRetryAttempts. Current callers must supply both caps
 * from the stage's authorized envelope.
 */
export interface RunCallCaps {
  maxLogicalCalls: number;
  maxRetryAttempts: number;
}

// ── P0 Task 1: token telemetry ────────────────────────────────────

/**
 * Prompt/completion token totals sampled from provider responses. A `null`
 * total means at least one sampled response carried NO usage block — the
 * missing value is recorded as absent, never fabricated as zero.
 */
export interface TokenTelemetry {
  promptTokens: number | null;
  completionTokens: number | null;
  /** How many logical responses were sampled (with or without usage). */
  responses: number;
}

/**
 * Detailed provider usage totals. This is exposed separately from the legacy
 * {@link TokenTelemetry} view so existing strict evidence schemas keep their
 * exact three-field shape until their own versioned migration.
 */
export interface ProviderTokenTelemetry extends TokenTelemetry {
  promptCacheHitTokens: number | null;
  promptCacheMissTokens: number | null;
  responsesWithUsage: number;
  responsesMissingUsage: number;
}

/** One immutable stage + role + model aggregation bucket. */
export interface TaggedProviderTokenTelemetry {
  tags: Readonly<{
    stage: string | null;
    role: string | null;
    model: string | null;
  }>;
  telemetry: ProviderTokenTelemetry;
}

/**
 * Fatal budget violation. Desensitized by construction: the message carries
 * only the cap numbers (and, when known, the role that tripped the gate).
 * It is NOT an OpenAICompatibleProviderError, so the provider's transport
 * retry loop never retries it, and the evolution kernel's proposal fallback
 * never swallows it — the run aborts.
 */
export class ProviderBudgetError extends Error {
  readonly kind: "logical_calls" | "retry_attempts";
  /** The role whose call tripped the gate, when the caller tagged one. */
  readonly role?: string;
  /** Whether the RUN-wide cap or the ROLE-scoped retry reserve tripped. */
  readonly scope: "run" | "role";

  constructor(
    kind: "logical_calls" | "retry_attempts",
    caps: RunCallCaps,
    role?: string,
    scope: "run" | "role" = "run",
  ) {
    const scopeText =
      scope === "role" && role !== undefined
        ? `the retry reserve of role "${role}" is spent (reserve 0 or exhausted; the shared run cap of ${caps.maxRetryAttempts} may still have room)`
        : `the run cap of ${kind === "logical_calls" ? caps.maxLogicalCalls : caps.maxRetryAttempts} was reached${role !== undefined ? ` while role "${role}" was calling` : ""}`;
    super(
      `PROVIDER_BUDGET_EXCEEDED (${scope}): ${scopeText}; the run stops without Holdout or a ledger write.`,
    );
    this.name = "ProviderBudgetError";
    this.kind = kind;
    this.role = role;
    this.scope = scope;
  }
}

/**
 * Per-role transport-retry reserves (P1 任务 2). A role listed here may
 * spend at most its reserve across the run; roles without an entry are
 * bounded only by the shared global cap. Reserves never RAISE anything:
 * every retry still needs the global cap too, so the run-wide ceiling
 * (maxLogicalCalls + maxRetryAttempts HTTP attempts) is unchanged.
 */
export interface RoleRetryReserves {
  [role: string]: number;
}

/**
 * One run-wide budget shared by the metered CLI wrapper (logical calls) and
 * every OpenAICompatibleProvider retry loop (HTTP attempts + retries).
 */
export class RunCallBudget {
  readonly caps: RunCallCaps;
  readonly accounting: RunCallAccounting;
  readonly roleRetryReserves: RoleRetryReserves;

  private tokenTelemetryState: ProviderTokenTelemetry = emptyProviderTokenTelemetry();
  private readonly taggedTokenTelemetryState = new Map<
    string,
    { tags: TaggedProviderTokenTelemetry["tags"]; telemetry: ProviderTokenTelemetry }
  >();
  private readonly roleAccountingState: Record<string, RunCallAccounting> = {};

  constructor(
    caps: RunCallCaps & { roleRetryReserves?: RoleRetryReserves },
    accounting: RunCallAccounting = { logicalCalls: 0, httpAttempts: 0, retryAttempts: 0 },
  ) {
    this.caps = {
      maxLogicalCalls: caps.maxLogicalCalls,
      maxRetryAttempts: caps.maxRetryAttempts,
    };
    this.accounting = accounting;
    this.roleRetryReserves = { ...(caps.roleRetryReserves ?? {}) };
  }

  /**
   * Copy of the per-role spend so far (P1 任务 2). Roles without traffic
   * are absent — a missing key means zero, the same as all-zero counters.
   */
  roleAccounting(): Record<string, RunCallAccounting> {
    const copy: Record<string, RunCallAccounting> = {};
    for (const [role, entry] of Object.entries(this.roleAccountingState)) {
      copy[role] = { ...entry };
    }
    return copy;
  }

  private bill(role: string | undefined, field: keyof RunCallAccounting): void {
    if (role === undefined) return;
    const entry = (this.roleAccountingState[role] ??= { logicalCalls: 0, httpAttempts: 0, retryAttempts: 0 });
    entry[field] += 1;
  }

  /** Gate BEFORE a logical call starts; throws instead of allowing call #cap+1. */
  enterLogicalCall(role?: string): void {
    if (this.accounting.logicalCalls >= this.caps.maxLogicalCalls) {
      throw new ProviderBudgetError("logical_calls", this.caps, role);
    }
    this.accounting.logicalCalls += 1;
    this.bill(role, "logicalCalls");
  }

  /** Count one actual HTTP request (called by the provider per attempt). */
  enterHttpAttempt(role?: string): void {
    this.accounting.httpAttempts += 1;
    this.bill(role, "httpAttempts");
  }

  /**
   * Gate BEFORE a transport retry; throws instead of spending retry #cap+1.
   * A role with a reserve entry must ALSO stay inside its own reserve —
   * this can only narrow, never widen, the shared global cap.
   */
  enterRetry(role?: string): void {
    if (this.accounting.retryAttempts >= this.caps.maxRetryAttempts) {
      throw new ProviderBudgetError("retry_attempts", this.caps, role);
    }
    if (role !== undefined && role in this.roleRetryReserves) {
      const spent = this.roleAccountingState[role]?.retryAttempts ?? 0;
      if (spent >= this.roleRetryReserves[role]) {
        throw new ProviderBudgetError("retry_attempts", this.caps, role, "role");
      }
    }
    this.accounting.retryAttempts += 1;
    this.bill(role, "retryAttempts");
  }

  /** Backward-compatible positional usage recorder. */
  recordTokenUsage(promptTokens?: number, completionTokens?: number): void;
  /** Detailed usage recorder with immutable per-call/provider identity. */
  recordTokenUsage(
    usage: ProviderTokenUsageSample,
    tags?: Readonly<ProviderUsageTags>,
  ): void;
  recordTokenUsage(
    usageOrPrompt?: ProviderTokenUsageSample | number,
    tagsOrCompletion?: Readonly<ProviderUsageTags> | number,
  ): void {
    const structured = typeof usageOrPrompt === "object" && usageOrPrompt !== null;
    const usage: ProviderTokenUsageSample = structured
      ? normalizeUsageSample(usageOrPrompt)
      : normalizeUsageSample({
          usagePresent: usageOrPrompt !== undefined || typeof tagsOrCompletion === "number",
          promptTokens: typeof usageOrPrompt === "number" ? usageOrPrompt : null,
          promptCacheHitTokens: null,
          promptCacheMissTokens: null,
          completionTokens: typeof tagsOrCompletion === "number" ? tagsOrCompletion : null,
        });
    const tags = structured && typeof tagsOrCompletion === "object"
      ? immutableUsageTags(tagsOrCompletion)
      : undefined;

    accumulateProviderTokenUsage(this.tokenTelemetryState, usage);
    if (tags !== undefined) {
      const key = JSON.stringify([tags.stage, tags.role, tags.model]);
      let bucket = this.taggedTokenTelemetryState.get(key);
      if (bucket === undefined) {
        bucket = { tags, telemetry: emptyProviderTokenTelemetry() };
        this.taggedTokenTelemetryState.set(key, bucket);
      }
      accumulateProviderTokenUsage(bucket.telemetry, usage);
    }
  }

  /** Copy of the sampled token totals so far. */
  tokenTelemetry(): TokenTelemetry {
    return {
      promptTokens: this.tokenTelemetryState.promptTokens,
      completionTokens: this.tokenTelemetryState.completionTokens,
      responses: this.tokenTelemetryState.responses,
    };
  }

  /** Detailed prompt/cache/completion totals and explicit usage coverage. */
  providerTokenTelemetry(): ProviderTokenTelemetry {
    return { ...this.tokenTelemetryState };
  }

  /** Defensive, deterministically ordered copies grouped by stage + role + model. */
  providerTokenTelemetryByTags(): TaggedProviderTokenTelemetry[] {
    return [...this.taggedTokenTelemetryState.values()]
      .map((entry) => ({
        tags: Object.freeze({ ...entry.tags }),
        telemetry: { ...entry.telemetry },
      }))
      .sort((left, right) =>
        JSON.stringify([left.tags.stage, left.tags.role, left.tags.model]).localeCompare(
          JSON.stringify([right.tags.stage, right.tags.role, right.tags.model]),
        ));
  }
}

function emptyProviderTokenTelemetry(): ProviderTokenTelemetry {
  return {
    promptTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    completionTokens: 0,
    responses: 0,
    responsesWithUsage: 0,
    responsesMissingUsage: 0,
  };
}

function tokenCountOrNull(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function normalizeUsageSample(usage: ProviderTokenUsageSample): ProviderTokenUsageSample {
  if (!usage.usagePresent) {
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
    promptTokens: tokenCountOrNull(usage.promptTokens),
    promptCacheHitTokens: tokenCountOrNull(usage.promptCacheHitTokens),
    promptCacheMissTokens: tokenCountOrNull(usage.promptCacheMissTokens),
    completionTokens: tokenCountOrNull(usage.completionTokens),
  };
}

function immutableUsageTags(tags: Readonly<ProviderUsageTags>): TaggedProviderTokenTelemetry["tags"] {
  return Object.freeze({
    stage: tags.stage ?? null,
    role: tags.role ?? null,
    model: tags.model ?? null,
  });
}

function addKnownTokenCount(current: number | null, next: number | null): number | null {
  return current === null || next === null ? null : current + next;
}

function accumulateProviderTokenUsage(
  telemetry: ProviderTokenTelemetry,
  usage: ProviderTokenUsageSample,
): void {
  telemetry.responses += 1;
  if (usage.usagePresent) {
    telemetry.responsesWithUsage += 1;
  } else {
    telemetry.responsesMissingUsage += 1;
  }
  telemetry.promptTokens = addKnownTokenCount(telemetry.promptTokens, usage.promptTokens);
  telemetry.promptCacheHitTokens = addKnownTokenCount(
    telemetry.promptCacheHitTokens,
    usage.promptCacheHitTokens,
  );
  telemetry.promptCacheMissTokens = addKnownTokenCount(
    telemetry.promptCacheMissTokens,
    usage.promptCacheMissTokens,
  );
  telemetry.completionTokens = addKnownTokenCount(telemetry.completionTokens, usage.completionTokens);
}

/**
 * Wrap a provider with the run-level logical-call gate. The runner discovers
 * scenario context via an optional setContext method, which is forwarded.
 * An optional billing role tags each logical call in the shared budget
 * (P1 任务 2) — the ledger stays shared, only the labels differ.
 */
export function createBudgetedProvider(inner: Provider, budget: RunCallBudget, role?: string): Provider {
  const wrapped: Provider = {
    chat: async (
      messages: ProviderMessage[],
      options?: ProviderRequestOptions,
    ): Promise<ProviderResponse> => {
      budget.enterLogicalCall(role);
      return inner.chat(messages, options);
    },
  };
  const contextAware = inner as Partial<{ setContext: (s: string, snap: string) => void }>;
  if (typeof contextAware.setContext === "function") {
    (wrapped as { setContext?: unknown }).setContext = (s: string, snap: string) =>
      contextAware.setContext!(s, snap);
  }
  return wrapped;
}
