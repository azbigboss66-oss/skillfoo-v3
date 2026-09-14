import { createHash } from "node:crypto";
import type { Provider, ProviderMessage, ProviderResponse } from "../providers/types.js";
import { ProviderBudgetError } from "../providers/runBudget.js";
import type { InstructionGateInput, SemanticJudgement } from "../runtime/instructionAdapter.js";
import {
  bindApplicationAttemptProvider,
  recoveryDiagnosticOf,
  type U1RecoveryAttempt,
  type U1RecoveryContext,
} from "../evolution/structureRecovery.js";
import {
  SEMANTIC_RESPONSE_BINDING_VERSION,
  type U1SemanticDimensionEvidence,
} from "../types.js";

export const semanticResponseBindingVersion = SEMANTIC_RESPONSE_BINDING_VERSION;

export interface SemanticJudgeSafeDiagnostics {
  entity: "item" | "dimension";
  mismatch: "count" | "missing" | "duplicate" | "unknown" | "invalid-id";
  expectedCount: number;
  actualCount: number;
  /** A contract-owned, already-validated item id; never copied from an unknown response identity. */
  itemId?: string;
}

export class SemanticJudgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly safeDiagnostics?: SemanticJudgeSafeDiagnostics,
  ) {
    super(`${code}: ${message}`);
    this.name = "SemanticJudgeError";
  }
}

export type SemanticBatchJudge = (
  runs: readonly InstructionGateInput[],
) => Promise<SemanticJudgement[]>;

/** Public scoring and sealed audit scoring have explicit, non-interchangeable scopes. */
type SemanticJudgeScope = "public" | "sealed-audit";

interface SemanticJudgeCommonArgs {
  provider: Provider;
  /** Keep each same-model review compact; this is a score envelope, not a Skill-writing prompt. */
  maxItemsPerRequest?: number;
}

/** Every non-sealed semantic batch owns exactly one content-free schema repair. */
export function createPublicSemanticBatchJudge(
  args: SemanticJudgeCommonArgs & { recovery: U1RecoveryContext },
): SemanticBatchJudge {
  return createScopedSemanticBatchJudge({ ...args, scope: "public" });
}

/** Sealed scoring is one-shot and cannot accept an application-recovery context. */
export function createSealedSemanticBatchJudge(args: SemanticJudgeCommonArgs): SemanticBatchJudge {
  return createScopedSemanticBatchJudge({ ...args, scope: "sealed-audit" });
}

/**
 * Evaluation-only batch review. The candidate task agent never receives this
 * judging context; the same-model limitation is reported by the caller.
 */
function createScopedSemanticBatchJudge(args: SemanticJudgeCommonArgs & {
  scope: SemanticJudgeScope;
  recovery?: U1RecoveryContext;
}): SemanticBatchJudge {
  return async (runs) => {
    const expectedSplit = args.scope === "sealed-audit" ? "holdout" : "public";
    const wrongSplit = runs.find((run) => run.item.split !== expectedSplit);
    if (wrongSplit) {
      throw new SemanticJudgeError(
        "SEMANTIC_JUDGE_SPLIT_VIOLATION",
        `${args.scope === "sealed-audit" ? "sealed audit" : "public phase"} only accepts ${expectedSplit} items; got ${wrongSplit.item.itemId} on ${wrongSplit.item.split}`,
      );
    }
    if (runs.some((run) => !run.item.input || !run.item.judgingRule || !run.item.rubric)) {
      throw new SemanticJudgeError(
        "SEMANTIC_JUDGE_CONTEXT_MISSING",
        "each reviewed item needs frozen input, judgingRule, and rubric",
      );
    }
    const maxItemsPerRequest = args.maxItemsPerRequest ?? 3;
    if (!Number.isInteger(maxItemsPerRequest) || maxItemsPerRequest < 1) {
      throw new SemanticJudgeError("SEMANTIC_JUDGE_BATCH_SIZE_INVALID", "maxItemsPerRequest must be a positive integer");
    }

    const recovery = args.scope === "sealed-audit" ? undefined : args.recovery;
    const judgementByRun = new Map<InstructionGateInput, SemanticJudgement>();
    const reviewableRuns: InstructionGateInput[] = [];
    for (const run of runs) {
      if (semanticReviewable(run)) reviewableRuns.push(run);
      else judgementByRun.set(run, skippedSemanticJudgement(run));
    }
    for (let start = 0; start < reviewableRuns.length; start += maxItemsPerRequest) {
      const chunk = reviewableRuns.slice(start, start + maxItemsPerRequest);
      const chunkJudgements = await judgeChunk(args.provider, chunk, recovery);
      chunk.forEach((run, index) => judgementByRun.set(run, chunkJudgements[index]));
    }
    return runs.map((run) => judgementByRun.get(run) as SemanticJudgement);
  };
}

function semanticReviewable(run: InstructionGateInput): boolean {
  const answer = run.transcript.parsedFinalAnswer;
  return run.transcript.terminalReason === "final" && answer !== undefined && answer !== null;
}

function skippedSemanticJudgement(run: InstructionGateInput): SemanticJudgement {
  if (!run.item.rubric) {
    throw new SemanticJudgeError(
      "SEMANTIC_JUDGE_CONTEXT_MISSING",
      "each reviewed item needs frozen input, judgingRule, and rubric",
    );
  }
  const noParsedAnswer = run.transcript.parsedFinalAnswer === undefined || run.transcript.parsedFinalAnswer === null;
  const reason = noParsedAnswer
    ? `semantic review skipped: no parsed final answer (${run.transcript.terminalReason})`
    : `semantic review skipped: terminal reason ${run.transcript.terminalReason}`;
  const dimensions: U1SemanticDimensionEvidence[] = run.item.rubric.dimensions.map((dimension) => ({
    id: dimension.id,
    score: 0,
    reason,
  }));
  return {
    itemId: run.item.itemId,
    score: 0,
    reason,
    semanticStatus: "skipped_non_final",
    dimensions,
    weightedScore: 0,
    overallReason: reason,
  };
}

const RECOVERABLE_SEMANTIC_CONTRACT_ERRORS = new Set([
  "SEMANTIC_JUDGE_INVALID_JSON",
  "SEMANTIC_JUDGE_INVALID",
  "SEMANTIC_JUDGE_ITEM_MISMATCH",
  "SEMANTIC_JUDGE_DIMENSION_MISMATCH",
  "SEMANTIC_JUDGE_OVERALL_REASON_INVALID",
]);

interface SemanticRequest {
  messages: ProviderMessage[];
  requestFingerprint: string;
}

function semanticRequestOf(runs: readonly InstructionGateInput[]): SemanticRequest {
  const requiredItemIds = runs.map((run) => run.item.itemId);
  if (runs.some((run) => !run.item.rubric)) {
    throw new SemanticJudgeError(
      "SEMANTIC_JUDGE_CONTEXT_MISSING",
      "each reviewed item needs a frozen rubric",
    );
  }
  const payload = runs.map((run) => ({
    itemId: run.item.itemId,
    userInput: run.item.input,
    judgingRule: run.item.judgingRule,
    candidateAnswer: run.transcript.parsedFinalAnswer,
    terminalReason: run.transcript.terminalReason,
    rubric: run.item.rubric,
  }));
  const messages: ProviderMessage[] = [
    {
      role: "system" as const,
      content: "You are an evaluation-only reviewer. Score each completed answer against its frozen rubric. Return JSON only: {items:[{itemId:string,dimensions:[{id:string,score:number 0..100,reason:string}],overallReason:string}]}. Return every rubric dimension exactly once in the frozen order. The caller computes all aggregation. Keep each reason and overallReason to one concise sentence. Copy each required itemId verbatim and preserve the required order. Do not omit, duplicate, translate, normalize, or invent an itemId or dimension id. Before sending, verify items.length equals requiredItemCount. Do not infer tool execution; judge only the supplied answer and rubric.",
    },
    { role: "user" as const, content: JSON.stringify({ requiredItemIds, requiredItemCount: requiredItemIds.length, items: payload }) },
  ];
  const requestFingerprint = createHash("sha256")
    .update(JSON.stringify({ semanticResponseBindingVersion, messages, responseFormat: "json_object" }), "utf8")
    .digest("hex");
  return { messages, requestFingerprint };
}

async function requestSemanticResponse(provider: Provider, messages: ProviderMessage[]): Promise<ProviderResponse> {
  try {
    return await provider.chat(messages, { responseFormat: "json_object" });
  } catch (error) {
    if (error instanceof ProviderBudgetError) {
      throw error;
    }
    throw new SemanticJudgeError(
      "SEMANTIC_JUDGE_PROVIDER_FAILED",
      error instanceof Error ? error.message : "semantic provider request failed",
    );
  }
}

function parseAndValidateSemanticResponse(args: {
  content: string;
  runs: readonly InstructionGateInput[];
  requestFingerprint: string;
}): SemanticJudgement[] {
  const requiredItemIds = args.runs.map((run) => run.item.itemId);
  let parsed: unknown;
  try { parsed = JSON.parse(args.content); } catch {
    throw new SemanticJudgeError("SEMANTIC_JUDGE_INVALID_JSON", "reviewer did not return JSON");
  }
  const entries = parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)
    ? (parsed as { items: unknown[] }).items : null;
  if (!entries) throw new SemanticJudgeError("SEMANTIC_JUDGE_INVALID", "reviewer JSON lacks items array");
  const orderedEntries = restoreExactIdentityOrder({
    entries,
    expectedIds: requiredItemIds,
    identityKey: "itemId",
    errorCode: "SEMANTIC_JUDGE_ITEM_MISMATCH",
    entity: "item",
  });
  const runByItemId = new Map(args.runs.map((run) => [run.item.itemId, run]));
  const judgements: SemanticJudgement[] = orderedEntries.map((entry) => {
    const value = entry as {
      itemId?: unknown;
      score?: unknown;
      reason?: unknown;
      dimensions?: unknown;
      weightedScore?: unknown;
      overallReason?: unknown;
    };
    const itemId = value.itemId as string;
    const rubric = runByItemId.get(itemId)?.item.rubric;
    if (!rubric) {
      throw new SemanticJudgeError("SEMANTIC_JUDGE_CONTEXT_MISSING", `item ${itemId} lacks a frozen rubric`);
    }
    if (!Array.isArray(value.dimensions)) {
      throw new SemanticJudgeError(
        "SEMANTIC_JUDGE_DIMENSION_MISMATCH",
        `item ${itemId} lacks dimensions`,
        {
          entity: "dimension",
          mismatch: "missing",
          expectedCount: rubric.dimensions.length,
          actualCount: 0,
          itemId,
        },
      );
    }
    const expectedDimensions = rubric.dimensions.map((dimension) => dimension.id);
    const orderedDimensions = restoreExactIdentityOrder({
      entries: value.dimensions,
      expectedIds: expectedDimensions,
      identityKey: "id",
      errorCode: "SEMANTIC_JUDGE_DIMENSION_MISMATCH",
      entity: "dimension",
      itemId,
    });
    const dimensions: U1SemanticDimensionEvidence[] = orderedDimensions.map((dimension) => {
      const d = dimension as { id?: unknown; score?: unknown; reason?: unknown };
      if (
        typeof d.score !== "number" || !Number.isFinite(d.score) || d.score < 0 || d.score > 100 ||
        typeof d.reason !== "string" || !d.reason.trim()
      ) {
        throw new SemanticJudgeError("SEMANTIC_JUDGE_INVALID", `item ${itemId} has an invalid dimension score or reason`);
      }
      return { id: d.id as U1SemanticDimensionEvidence["id"], score: d.score, reason: d.reason };
    });
    const dimensionById = new Map(dimensions.map((dimension) => [dimension.id, dimension]));
    const computedWeightedScore = Math.round(
      rubric.dimensions.reduce(
        (sum, dimension) => sum + dimension.weight * (dimensionById.get(dimension.id) as U1SemanticDimensionEvidence).score,
        0,
      ) * 100,
    ) / 100;
    if (typeof value.overallReason !== "string" || !value.overallReason.trim()) {
      throw new SemanticJudgeError(
        "SEMANTIC_JUDGE_OVERALL_REASON_INVALID",
        `item ${itemId} overallReason is missing or invalid`,
      );
    }
    return {
      itemId,
      score: computedWeightedScore,
      reason: value.overallReason,
      dimensions,
      weightedScore: computedWeightedScore,
      overallReason: value.overallReason,
      requestFingerprint: args.requestFingerprint,
      semanticStatus: "evaluated",
    };
  });
  return judgements;
}

function isRecoverableSemanticContractError(error: unknown): error is SemanticJudgeError {
  return error instanceof SemanticJudgeError && RECOVERABLE_SEMANTIC_CONTRACT_ERRORS.has(error.code);
}

function emitSemanticContractDiagnostic(args: {
  recovery: U1RecoveryContext;
  attempt: U1RecoveryAttempt;
  error: SemanticJudgeError;
  response: ProviderResponse;
}): void {
  args.recovery.hooks.onDiagnostic(recoveryDiagnosticOf({
    subject: args.recovery.subject,
    attempt: args.attempt,
    failureCode: args.error.code,
    response: args.response,
  }));
}

function semanticSchemaRepairMessages(
  originalMessages: readonly ProviderMessage[],
  failureCode: string,
): ProviderMessage[] {
  return [
    ...originalMessages,
    {
      role: "system",
      content: [
        "Schema repair only: answer the original scoring request again.",
        `The previous response violated the required response contract (${failureCode}).`,
        "Return JSON only in the exact schema already specified; include every required item and dimension exactly once.",
        "Do not discuss the failure, add commentary, change identities, or infer missing content.",
      ].join(" "),
    },
  ];
}

async function judgeChunk(
  provider: Provider,
  runs: readonly InstructionGateInput[],
  recovery?: U1RecoveryContext,
): Promise<SemanticJudgement[]> {
  const request = semanticRequestOf(runs);
  const primaryProvider = recovery
    ? bindApplicationAttemptProvider({
        provider,
        operation: "semantic-judge",
        originalRequestFingerprint: request.requestFingerprint,
        attempt: 1,
        mode: "primary",
      })
    : provider;
  const primaryResponse = await requestSemanticResponse(primaryProvider, request.messages);
  try {
    return parseAndValidateSemanticResponse({
      content: primaryResponse.content,
      runs,
      requestFingerprint: request.requestFingerprint,
    });
  } catch (error) {
    if (!recovery || !isRecoverableSemanticContractError(error)) throw error;
    emitSemanticContractDiagnostic({ recovery, attempt: 1, error, response: primaryResponse });
    recovery.hooks.onApplicationRecoveryAttempt({
      subject: recovery.subject,
      operation: "semantic-judge",
      attempt: 2,
      mode: "schema-repair",
      requestFingerprintSha256: request.requestFingerprint,
    });

    const recoveryMessages = semanticSchemaRepairMessages(request.messages, error.code);
    const recoveryProvider = bindApplicationAttemptProvider({
      provider,
      operation: "semantic-judge",
      originalRequestFingerprint: request.requestFingerprint,
      attempt: 2,
      mode: "schema-repair",
    });
    const recoveryResponse = await requestSemanticResponse(recoveryProvider, recoveryMessages);
    try {
      return parseAndValidateSemanticResponse({
        content: recoveryResponse.content,
        runs,
        requestFingerprint: request.requestFingerprint,
      });
    } catch (recoveryError) {
      if (isRecoverableSemanticContractError(recoveryError)) {
        emitSemanticContractDiagnostic({
          recovery,
          attempt: 2,
          error: recoveryError,
          response: recoveryResponse,
        });
      }
      throw recoveryError;
    }
  }
}

function restoreExactIdentityOrder(args: {
  entries: readonly unknown[];
  expectedIds: readonly string[];
  identityKey: "itemId" | "id";
  errorCode: "SEMANTIC_JUDGE_ITEM_MISMATCH" | "SEMANTIC_JUDGE_DIMENSION_MISMATCH";
  entity: "item" | "dimension";
  itemId?: string;
}): Record<string, unknown>[] {
  const diagnosticsBase = {
    entity: args.entity,
    expectedCount: args.expectedIds.length,
    actualCount: args.entries.length,
    ...(args.itemId ? { itemId: args.itemId } : {}),
  } as const;
  const fail = (mismatch: SemanticJudgeSafeDiagnostics["mismatch"]): never => {
    throw new SemanticJudgeError(
      args.errorCode,
      `${args.entity} identities must match the frozen exact set`,
      { ...diagnosticsBase, mismatch },
    );
  };
  if (args.entries.length !== args.expectedIds.length) fail("count");

  const expected = new Set(args.expectedIds);
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of args.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("invalid-id");
    const record = entry as Record<string, unknown>;
    const identity = record[args.identityKey];
    if (typeof identity !== "string") fail("invalid-id");
    const exactIdentity = identity as string;
    if (!expected.has(exactIdentity)) fail("unknown");
    if (byId.has(exactIdentity)) fail("duplicate");
    byId.set(exactIdentity, record);
  }
  if (byId.size !== expected.size) fail("missing");
  return args.expectedIds.map((identity) => byId.get(identity) as Record<string, unknown>);
}
