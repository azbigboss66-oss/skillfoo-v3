/** A single chat message exchanged with a model provider. */
export interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** The response returned by a provider for one chat call. */
export interface ProviderResponse {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
  /** DeepSeek prompt-cache tokens; null means the provider omitted the field. */
  promptCacheHitTokens?: number | null;
  /** DeepSeek uncached prompt tokens; null means the provider omitted the field. */
  promptCacheMissTokens?: number | null;
  /**
   * Safe, desensitized response diagnostics (P1 任务 1). Counters and
   * flags ONLY — never the prompt, the response body, reasoning content,
   * the API key, or the full baseUrl.
   */
  diagnostics?: ProviderResponseDiagnostics;
}

/**
 * Structured metadata about one provider HTTP response. Every field is
 * safe to print in reports and error messages.
 */
export interface ProviderResponseDiagnostics {
  /** HTTP status code of the response (2xx on the parse path). */
  httpStatus: number;
  /** Number of entries in the `choices` array (0 when absent). */
  choiceCount: number;
  /** Character length of `choices[0].message.content` (0 when absent). */
  contentLength: number;
  /** `choices[0].finish_reason` when present as a string, else null. */
  finishReason: string | null;
  /** Whether the response carried a usage block at all. */
  usagePresent: boolean;
  /** Usage numbers when present; absent fields are null, never zero-filled. */
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    /** Optional in the type so historical diagnostics fixtures remain source-compatible. */
    promptCacheHitTokens?: number | null;
    /** Optional in the type so historical diagnostics fixtures remain source-compatible. */
    promptCacheMissTokens?: number | null;
  } | null;
  /** Whether a separate reasoning_content field existed (never the answer). */
  reasoningContentPresent: boolean;
}

/**
 * Optional request parameters that a caller may pass to `Provider.chat`.
 *
 * - `responseFormat: "json_object"` requests structured JSON output from the
 *   model. The provider should include `response_format: { type: "json_object" }`
 *   in the request body when supported. Scripted providers accept this option
 *   but ignore it (their responses are preloaded).
 */
export interface ProviderRequestOptions {
  responseFormat?: "json_object";
  /** Sent only when explicitly supplied; omission preserves provider default behavior. */
  temperature?: number;
  /**
   * Immutable accounting identity for this call. It is telemetry-only and is
   * never forwarded to the provider request body or included in response-cache
   * identity. A per-call stage avoids concurrent calls sharing mutable stage
   * state; fixed provider role/model identities still take precedence.
   */
  usageTags?: Readonly<ProviderUsageTags>;
}

/** Safe, content-free identity used to aggregate provider token telemetry. */
export interface ProviderUsageTags {
  readonly stage?: string;
  readonly role?: string;
  readonly model?: string;
}

/** One provider response's usage sample. Missing fields remain unknown. */
export interface ProviderTokenUsageSample {
  readonly usagePresent: boolean;
  readonly promptTokens: number | null;
  readonly promptCacheHitTokens: number | null;
  readonly promptCacheMissTokens: number | null;
  readonly completionTokens: number | null;
}

/**
 * A model provider abstraction. The Reference Runner is agnostic to whether
 * the provider is a deterministic script or a real OpenAI-compatible endpoint.
 */
export interface Provider {
  chat(messages: ProviderMessage[], options?: ProviderRequestOptions): Promise<ProviderResponse>;
}
