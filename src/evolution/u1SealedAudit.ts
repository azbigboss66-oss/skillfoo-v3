import { sha256Hex } from "../runtime/capabilityAdapter.js";
import { z } from "zod";
import type { SealedInstructionBatchScorer } from "../runtime/instructionAdapter.js";
import { stableStringify } from "../intake/taskCard.js";
import type { RunCallBudget } from "../providers/runBudget.js";
import {
  EvaluationContractV3Schema,
  FrozenContractManifestSchema,
  HoldoutFileSchema,
  OpenAICompatibleProviderIdentitySchema,
  U1ScoringIdentitySchema,
  U1BDraftItemSchema,
  type DraftItem,
  EvaluationContractV3,
  EvaluationReviewConfirmation,
  FrozenContractManifest,
  TaskCardConfirmation,
  type U1ApplicationRecoverySummary,
  type OpenAICompatibleProviderIdentity,
  type U1ScoringIdentity,
} from "../types.js";
import {
  assertStageBudgetsFunded,
  calculateStageBudgets,
  StageFundingError,
  type AuthorizedStageBudgets,
  type CallEnvelope,
  type StageBudgetInputs,
} from "../providers/stageBudgets.js";
import {
  runLabelledAuditCompare,
  type LabelledAuditCandidateEvaluation,
} from "./auditCompare.js";
import type { FunnelEvalItem, FunnelEvent, FunnelScenarioRunner } from "./funnel.js";
import {
  aggregateU1DimensionScores,
  assertSameScoringIdentity,
  evaluateU1CandidateEligibility,
  evaluateU1TerminalCandidateAgainstStartingReference,
  scoringIdentityOfContract,
} from "../evaluation/u1Rubric.js";
import {
  ApplicationRecoverySummarySchema,
  CallEnvelopeEvidenceSchema,
  DynamicEnvelopeExhaustionEvidenceSchema,
  ProviderTokenTelemetryEvidenceSchema,
  StageBudgetAssumptionsEvidenceSchema,
  dynamicEnvelopeExhaustionMatches,
} from "./publicSelectionResume.js";

/** The U1 B5 method labels are deliberately separate from the legacy V3.1 two-way audit labels. */
export type U1SealedCandidateLabel = "starting_reference" | "adaptive" | "direct";

export type U1SealedCandidateState =
  | {
      label: U1SealedCandidateLabel;
      status: "frozen";
      candidateSource: string;
      skillSha256: string;
    }
  | {
      label: U1SealedCandidateLabel;
      status: "unavailable";
      reason: string;
    };

export type U1B0B4Completion = Record<"b0" | "b1" | "b2" | "b3" | "b4", boolean>;

export type U1PublicDecision =
  | "clear_improvement"
  | "start_reference_retained"
  | "candidate_rejected"
  | "not_comparable";

export interface U1SealedAuditArguments {
  /** Public executions use live-formal. test-fixture is temp-only and must be kept behind a zero-network CLI harness. */
  verificationMode?: "live-formal" | "test-fixture";
  contract: EvaluationContractV3;
  manifest: FrozenContractManifest;
  taskCardConfirmation: TaskCardConfirmation;
  evaluationReviewConfirmation: EvaluationReviewConfirmation;
  formalEvidence: boolean;
  noRelease: boolean;
  b0B4: U1B0B4Completion;
  publicDecision: U1PublicDecision;
  /** Required by new scoring-profile contracts; binds sealed to terminal public-select evidence. */
  publicScoringIdentity?: U1ScoringIdentity;
  startingReferenceSha256: string;
  finalPublicChampionSha256: string;
  candidates: U1SealedCandidateState[];
  readCandidateSkill: (label: U1SealedCandidateLabel) => Promise<string>;
  readHoldoutBody: () => Promise<unknown>;
  claimSealedExecution: () => Promise<boolean>;
  stageBudgetAssumptions: StageBudgetInputs;
  authorizedStageBudgets: AuthorizedStageBudgets;
  budget: RunCallBudget;
  runner: FunnelScenarioRunner;
  scoreRuns?: SealedInstructionBatchScorer;
  /** Required only for a real sealed Provider execution; never contains credentials. */
  providerIdentity?: OpenAICompatibleProviderIdentity;
  now?: () => string;
}

export interface U1SealedNotEnteredResult {
  status: "holdout_not_entered";
  reason: "no_novel_public_champion";
  contractSha256: string;
  bodyReads: 0;
  feedbackToEvolution: false;
  generationTriggered: false;
  repairTriggered: false;
  releaseAllowed: false;
  scoringIdentity?: U1ScoringIdentity;
}

export interface U1SealedCompletedResult {
  status: "sealed_confirmed" | "sealed_rejected";
  contractSha256: string;
  bodyReads: 1;
  candidates: Array<LabelledAuditCandidateEvaluation<U1SealedCandidateLabel>>;
  winner: U1SealedCandidateLabel | "tie";
  accounting: { logicalCalls: number; httpAttempts: number; retryAttempts: number };
  wallTimeMs: number;
  events: FunnelEvent[];
  feedbackToEvolution: false;
  generationTriggered: false;
  repairTriggered: false;
  secondSealedAllowed: false;
  applicationRetryAllowed: false;
  releaseAllowed: false;
  budget: {
    minimum: number;
    authorized: number;
    independent: true;
    assumptions: StageBudgetInputs;
    envelope: CallEnvelope;
  };
  /** Content-free candidate-item attempt evidence for the current one-shot envelope. */
  applicationRecovery: U1ApplicationRecoverySummary[];
  providerTokenTelemetry: z.infer<typeof ProviderTokenTelemetryEvidenceSchema>;
  provider?: OpenAICompatibleProviderIdentity;
  scoringIdentity?: U1ScoringIdentity;
}

export type U1SealedAuditResult = U1SealedNotEnteredResult | U1SealedCompletedResult;

export interface AdaptiveCandidateSkillBytes {
  candidateId: string;
  skillMd: string;
}

/**
 * Resolve stage-local Adaptive candidate bytes from the frozen public hash.
 * Public candidate ids are reporting labels and need not match Adaptive ids.
 */
export function resolveAdaptiveCandidateBySkillSha256(args: {
  candidates: AdaptiveCandidateSkillBytes[];
  expectedSkillSha256: string;
  preferredCandidateId?: string | null;
}): AdaptiveCandidateSkillBytes | null {
  const matches = args.candidates.filter(
    (candidate) => sha256Hex(candidate.skillMd) === args.expectedSkillSha256,
  );
  const exact = args.preferredCandidateId
    ? matches.find((candidate) => candidate.candidateId === args.preferredCandidateId)
    : undefined;
  if (exact) return { candidateId: exact.candidateId, skillMd: exact.skillMd };
  matches.sort((left, right) => left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0);
  const first = matches[0];
  return first ? { candidateId: first.candidateId, skillMd: first.skillMd } : null;
}

export class U1SealedAuditError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "U1SealedAuditError";
  }
}

const U1_SEALED_LABELS = ["starting_reference", "adaptive", "direct"] as const;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Current-U1 sealed application evidence reuses the shared summary schema and
 * narrows it to the one-shot contract. It never admits an application retry.
 */
export const U1SealedApplicationRecoverySummarySchema =
  ApplicationRecoverySummarySchema.superRefine((value, ctx) => {
    if (
      value.role !== "sealed" ||
      value.outcome !== "no_retry_needed" ||
      value.attempts.length !== 1 ||
      value.attempts[0].attempt !== 1 ||
      value.retryTriggered ||
      value.maxApplicationAttempts !== 1 ||
      value.scenarioRetryReserve !== 0 ||
      value.unusedRetryReserve !== 0 ||
      value.classification !== null
    ) {
      ctx.addIssue({
        code: "custom",
        message: "sealed application evidence permits one primary attempt and zero application retry reserve",
      });
    }
  });

export const U1SealedBudgetEvidenceSchema = z.object({
  minimum: z.number().int().min(1),
  authorized: z.number().int().min(1),
  independent: z.literal(true),
  assumptions: StageBudgetAssumptionsEvidenceSchema,
  envelope: CallEnvelopeEvidenceSchema,
}).strict().superRefine((value, ctx) => {
  let expected: CallEnvelope | undefined;
  try {
    expected = calculateStageBudgets(value.assumptions).envelope.sealed;
  } catch {
    expected = undefined;
  }
  if (
    !expected ||
    stableStringify(expected) !== stableStringify(value.envelope) ||
    value.minimum !== expected.baselineEstimate ||
    value.authorized !== expected.authorizedLogicalCalls
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "sealed B/M/H evidence must reproduce the shared stage-budget calculation",
      path: ["envelope"],
    });
  }
});

const SealedAccountingSchema = z.object({
  logicalCalls: z.number().int().min(0),
  httpAttempts: z.number().int().min(0),
  retryAttempts: z.number().int().min(0),
}).strict();

export const U1SealedCompletedArtifactSchema = z.object({
  schemaVersion: z.literal(2),
  createdAt: z.string().datetime(),
  status: z.enum(["sealed_confirmed", "sealed_rejected"]),
  contractSha256: z.string().regex(SHA256),
  bodyReads: z.literal(1),
  candidates: z.array(z.unknown()).length(3),
  winner: z.enum(["starting_reference", "adaptive", "direct", "tie"]),
  accounting: SealedAccountingSchema,
  wallTimeMs: z.number().min(0),
  events: z.array(z.unknown()),
  feedbackToEvolution: z.literal(false),
  generationTriggered: z.literal(false),
  repairTriggered: z.literal(false),
  secondSealedAllowed: z.literal(false),
  applicationRetryAllowed: z.literal(false),
  releaseAllowed: z.literal(false),
  budget: U1SealedBudgetEvidenceSchema,
  applicationRecovery: z.array(U1SealedApplicationRecoverySummarySchema),
  providerTokenTelemetry: ProviderTokenTelemetryEvidenceSchema,
  provider: OpenAICompatibleProviderIdentitySchema.optional(),
  scoringIdentity: U1ScoringIdentitySchema.optional(),
  verificationMode: z.enum(["live-formal", "test-fixture"]),
  formalEvidence: z.boolean(),
  holdout: z.literal("sealed_once_no_feedback"),
  release: z.string().regex(/withheld/i),
}).strict().superRefine((value, ctx) => {
  const accountingMatchesLane = value.verificationMode === "test-fixture"
    ? value.accounting.httpAttempts === 0 && value.accounting.retryAttempts === 0
    : value.accounting.httpAttempts === value.accounting.logicalCalls + value.accounting.retryAttempts;
  if (
    value.accounting.logicalCalls > value.budget.authorized ||
    !accountingMatchesLane
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "sealed accounting must stay within H and preserve HTTP=logical+transport-retry",
      path: ["accounting"],
    });
  }
  if (!value.providerTokenTelemetry.byStageRoleModel) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "current sealed evidence requires detailed stage/role/model token telemetry",
      path: ["providerTokenTelemetry"],
    });
  }
  if (
    (value.verificationMode === "live-formal" && !value.provider) ||
    (value.verificationMode === "test-fixture" && value.provider)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "live sealed evidence requires a safe Provider identity; zero-network fixtures must not claim one",
      path: ["provider"],
    });
  }
  if (value.applicationRecovery.length !== value.budget.assumptions.holdoutItems * 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "sealed application evidence must cover all three candidates and every holdout item exactly once",
      path: ["applicationRecovery"],
    });
  }
});

export const U1SealedFailureArtifactSchema = z.object({
  schemaVersion: z.literal(2),
  createdAt: z.string().datetime(),
  status: z.literal("failed"),
  phase: z.literal("sealed-audit"),
  contractSha256: z.string().regex(SHA256),
  publicSelectionResultSha256: z.string().regex(SHA256),
  safeError: z.object({
    code: z.string().min(1),
    message: z.literal("Sealed audit failed; sensitive request and response content were not persisted."),
  }).strict(),
  budget: U1SealedBudgetEvidenceSchema,
  accounting: SealedAccountingSchema,
  providerTokenTelemetry: ProviderTokenTelemetryEvidenceSchema,
  provider: OpenAICompatibleProviderIdentitySchema.optional(),
  dynamicEnvelopeExhaustion: DynamicEnvelopeExhaustionEvidenceSchema.optional(),
  scoringIdentity: U1ScoringIdentitySchema.optional(),
  bodyReads: z.literal(1),
  sealedClaimConsumed: z.literal(true),
  feedbackToEvolution: z.literal(false),
  generationTriggered: z.literal(false),
  repairTriggered: z.literal(false),
  secondSealedAllowed: z.literal(false),
  applicationRetryAllowed: z.literal(false),
  releaseAllowed: z.literal(false),
  verificationMode: z.enum(["live-formal", "test-fixture"]),
  formalEvidence: z.boolean(),
  holdout: z.literal("sealed_once_no_feedback"),
  release: z.string().regex(/withheld/i),
}).strict().superRefine((value, ctx) => {
  const accountingMatchesLane = value.verificationMode === "test-fixture"
    ? value.accounting.httpAttempts === 0 && value.accounting.retryAttempts === 0
    : value.accounting.httpAttempts === value.accounting.logicalCalls + value.accounting.retryAttempts;
  if (
    value.accounting.logicalCalls > value.budget.authorized ||
    !accountingMatchesLane ||
    !value.providerTokenTelemetry.byStageRoleModel
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "sealed failure must preserve bounded accounting and detailed token telemetry",
      path: ["accounting"],
    });
  }
  if (
    (value.verificationMode === "live-formal" && !value.provider) ||
    (value.verificationMode === "test-fixture" && value.provider)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "live sealed failure requires a safe Provider identity; zero-network fixtures must not claim one",
      path: ["provider"],
    });
  }
  if (value.safeError.code === "DYNAMIC_ENVELOPE_EXHAUSTED") {
    if (
      !value.dynamicEnvelopeExhaustion ||
      !dynamicEnvelopeExhaustionMatches(
        value.dynamicEnvelopeExhaustion,
        value.budget.envelope,
        value.accounting.logicalCalls,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "dynamic sealed exhaustion requires exact sanitized B/M/H evidence",
        path: ["dynamicEnvelopeExhaustion"],
      });
    }
  } else if (value.dynamicEnvelopeExhaustion) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "non-dynamic sealed failure cannot carry dynamic exhaustion evidence",
      path: ["dynamicEnvelopeExhaustion"],
    });
  }
});

function fail(code: string, message: string): never {
  throw new U1SealedAuditError(code, message);
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function contentDigest(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

function noNovelResult(contractSha256: string, scoringIdentity?: U1ScoringIdentity): U1SealedNotEnteredResult {
  return {
    status: "holdout_not_entered",
    reason: "no_novel_public_champion",
    contractSha256,
    bodyReads: 0,
    feedbackToEvolution: false,
    generationTriggered: false,
    repairTriggered: false,
    releaseAllowed: false,
    ...(scoringIdentity ? { scoringIdentity } : {}),
  };
}

function requireFormalGate(args: U1SealedAuditArguments, manifest: FrozenContractManifest): void {
  const task = args.taskCardConfirmation;
  const review = args.evaluationReviewConfirmation;
  if (args.verificationMode === "test-fixture") {
    if (
      args.formalEvidence ||
      args.contract.confirmationMode !== "test-fixture" ||
      manifest.confirmationMode !== "test-fixture" ||
      task.status !== "confirmed" ||
      task.confirmationMode !== "test-fixture" ||
      task.confirmedContentSha256 !== args.contract.taskCardHash ||
      review.status !== "confirmed" ||
      review.confirmationMode !== "test-fixture" ||
      review.humanReviewed !== false ||
      review.confirmedContentSha256 !== args.contract.evaluationReviewHash
    ) {
      fail(
        "U1_SEALED_FIXTURE_CONFIRMATION_REQUIRED",
        "zero-network fixture reachability requires two hash-bound test-fixture confirmations and formalEvidence=false",
      );
    }
    if (!args.noRelease) {
      fail("U1_SEALED_NO_RELEASE_REQUIRED", "--no-release is mandatory for the U1 sealed audit");
    }
    const incomplete = Object.entries(args.b0B4)
      .filter(([, complete]) => !complete)
      .map(([stage]) => stage);
    if (incomplete.length > 0) {
      fail(
        "U1_SEALED_B0_B4_INCOMPLETE",
        `B0-B4 must be complete before sealed execution; incomplete: ${incomplete.join(", ")}`,
      );
    }
    return;
  }
  if (
    !args.formalEvidence ||
    args.contract.confirmationMode !== "human" ||
    manifest.confirmationMode !== "human" ||
    task.status !== "confirmed" ||
    task.confirmationMode !== "human" ||
    task.confirmedContentSha256 !== args.contract.taskCardHash ||
    review.status !== "confirmed" ||
    review.confirmationMode !== "human" ||
    review.humanReviewed !== true ||
    review.confirmedContentSha256 !== args.contract.evaluationReviewHash
  ) {
    fail(
      "U1_SEALED_FORMAL_CONFIRMATION_REQUIRED",
      "U1 sealed requires two separately bound real-human confirmations and formalEvidence=true",
    );
  }
  if (!args.providerIdentity) {
    fail(
      "U1_SEALED_PROVIDER_IDENTITY_REQUIRED",
      "live sealed execution requires a credential-free OpenAI-compatible Provider identity before the holdout opens",
    );
  }
  if (args.contract.explorationOnly) {
    fail("U1_SEALED_EXPLORATION_FORBIDDEN", "explorationOnly must be false before U1 sealed execution");
  }
  if (!args.noRelease) {
    fail("U1_SEALED_NO_RELEASE_REQUIRED", "--no-release is mandatory for the U1 sealed audit");
  }
  const incomplete = Object.entries(args.b0B4)
    .filter(([, complete]) => !complete)
    .map(([stage]) => stage);
  if (incomplete.length > 0) {
    fail(
      "U1_SEALED_B0_B4_INCOMPLETE",
      `B0-B4 must be complete before sealed execution; incomplete: ${incomplete.join(", ")}`,
    );
  }
}

function requireFrozenCandidates(args: U1SealedAuditArguments): Map<U1SealedCandidateLabel, Extract<U1SealedCandidateState, { status: "frozen" }>> {
  const byLabel = new Map(args.candidates.map((candidate) => [candidate.label, candidate]));
  if (
    args.candidates.length !== U1_SEALED_LABELS.length ||
    byLabel.size !== U1_SEALED_LABELS.length ||
    U1_SEALED_LABELS.some((label) => byLabel.get(label)?.status !== "frozen")
  ) {
    fail(
      "U1_SEALED_CANDIDATES_INVALID",
      "novel U1 sealed execution requires exactly Starting Reference, Adaptive Final Public Champion and Direct, all frozen",
    );
  }
  const frozen = byLabel as Map<U1SealedCandidateLabel, Extract<U1SealedCandidateState, { status: "frozen" }>>;
  if (
    frozen.get("starting_reference")!.skillSha256 !== args.startingReferenceSha256 ||
    frozen.get("adaptive")!.skillSha256 !== args.finalPublicChampionSha256
  ) {
    fail(
      "U1_SEALED_CANDIDATE_BINDING_INVALID",
      "the labelled Starting Reference or Adaptive candidate does not match the terminal public-selection hashes",
    );
  }
  return frozen;
}

function requireBudget(args: U1SealedAuditArguments, manifest: FrozenContractManifest): void {
  if (args.stageBudgetAssumptions.holdoutItems !== manifest.holdoutItemIds.length) {
    fail(
      "U1_SEALED_BUDGET_BINDING_INVALID",
      "the dynamic budget holdout count does not match the frozen manifest",
    );
  }
  let calculated;
  try {
    calculated = calculateStageBudgets(args.stageBudgetAssumptions);
    assertStageBudgetsFunded(calculated, args.authorizedStageBudgets);
  } catch (error) {
    if (error instanceof StageFundingError) {
      fail(
        "U1_SEALED_BUDGET_INSUFFICIENT",
        `${error.stage} authorized ${error.authorized}, below dynamic minimum ${error.minimum}`,
      );
    }
    fail(
      "U1_SEALED_BUDGET_BINDING_INVALID",
      error instanceof Error ? error.message : "invalid stage-budget assumptions",
    );
  }
  if (
    args.budget.caps.maxLogicalCalls !== args.authorizedStageBudgets.sealed ||
    args.authorizedStageBudgets.sealed < calculated.sealed
  ) {
    fail(
      "U1_SEALED_BUDGET_INSUFFICIENT",
      `the dedicated sealed budget must reserve its complete dynamic minimum ${calculated.sealed} before the body opens`,
    );
  }
  if (
    calculated.envelope &&
    args.authorizedStageBudgets.sealed !== calculated.envelope.sealed.authorizedLogicalCalls
  ) {
    fail(
      "U1_SEALED_BUDGET_BINDING_INVALID",
      "the one-shot sealed stage must use exactly the shared B/M/H authorization; surplus cannot authorize another audit",
    );
  }
  if (
    args.budget.accounting.logicalCalls !== 0 ||
    args.budget.accounting.httpAttempts !== 0 ||
    args.budget.accounting.retryAttempts !== 0
  ) {
    fail(
      "U1_SEALED_BUDGET_NOT_PRISTINE",
      "the sealed stage must start with a fresh independent accounting ledger",
    );
  }
}

function requireCurrentSealedApplicationEvidence(
  comparison: {
    candidates: Array<LabelledAuditCandidateEvaluation<U1SealedCandidateLabel>>;
    applicationRecovery: U1ApplicationRecoverySummary[];
  },
  auditItems: FunnelEvalItem[],
  callEnvelope: CallEnvelope,
): U1ApplicationRecoverySummary[] {
  const scenario = callEnvelope.scenarioAuthorization;
  const expectedItemIds = new Set(auditItems.map((item) => item.itemId));
  const seen = new Set<string>();
  let observed = 0;

  const allSummaries = comparison.applicationRecovery;
  for (const candidate of comparison.candidates) {
    const summaries = allSummaries.filter((summary) => summary.candidateId === candidate.label);
    if (summaries.length !== auditItems.length) {
      fail(
        "U1_SEALED_APPLICATION_RECOVERY_INVALID",
        `${candidate.label} must persist exactly one sanitized application-attempt record per sealed item`,
      );
    }
    for (const summary of summaries) {
      const parsed = U1SealedApplicationRecoverySummarySchema.safeParse(summary);
      const key = `${summary.candidateId}\u0000${summary.itemId}`;
      if (
        !parsed.success ||
        summary.candidateId !== candidate.label ||
        !expectedItemIds.has(summary.itemId) ||
        seen.has(key) ||
        summary.rawScenarioEstimate !== scenario.rawScenarioEstimate ||
        summary.callEnvelopeMultiplier !== scenario.callEnvelopeMultiplier ||
        summary.authorizedModelCallsPerAttempt !== scenario.authorizedModelCallsPerAttempt ||
        summary.maxApplicationAttempts !== scenario.maxApplicationAttempts ||
        summary.scenarioRetryReserve !== scenario.scenarioRetryReserve
      ) {
        fail(
          "U1_SEALED_APPLICATION_RECOVERY_INVALID",
          "sealed candidate-item attempt evidence is missing, duplicated, malformed, or drifted from its one-shot authorization",
        );
      }
      seen.add(key);
      observed += 1;
    }
  }

  if (observed !== comparison.candidates.length * auditItems.length) {
    fail(
      "U1_SEALED_APPLICATION_RECOVERY_INVALID",
      "sealed result does not cover every frozen candidate-item exactly once",
    );
  }
  return allSummaries;
}

function parseAndBindHoldout(
  raw: unknown,
  contract: EvaluationContractV3,
  manifest: FrozenContractManifest,
): DraftItem[] {
  const parsed = HoldoutFileSchema.safeParse(raw);
  if (!parsed.success || parsed.data.items.some((item) => !U1BDraftItemSchema.safeParse(item).success)) {
    fail("U1_SEALED_HOLDOUT_INVALID", "the opened body is not a complete U1 holdout file");
  }
  const body = parsed.data;
  const bodyContent = {
    schemaVersion: body.schemaVersion,
    producer: body.producer,
    contractSha256: body.contractSha256,
    items: body.items,
  };
  const drift: string[] = [];
  if (body.contractSha256 !== contract.contractSha256) drift.push("contract");
  if (contentDigest(bodyContent) !== manifest.holdoutSha256) drift.push("body_hash");
  if (contentDigest(body.items) !== manifest.holdoutItemsSha256) drift.push("items_hash");
  if (!sameOrderedStrings(body.items.map((item) => item.itemId), manifest.holdoutItemIds)) drift.push("item_ids");
  if (!sameOrderedStrings([...new Set(body.items.map((item) => item.scenarioId))], manifest.holdoutScenarioIds)) drift.push("scenarios");
  if (drift.length > 0) {
    fail(
      "U1_SEALED_HOLDOUT_BINDING_INVALID",
      `the one opened holdout body drifted from frozen metadata (${drift.join(", ")})`,
    );
  }
  return body.items;
}

/**
 * Execute the U1 B5 sealed path exactly once. Every authorization, frozen
 * candidate and full-budget check precedes the lazy holdout-body callback.
 */
export async function runU1SealedAudit(args: U1SealedAuditArguments): Promise<U1SealedAuditResult> {
  const contractParsed = EvaluationContractV3Schema.safeParse(args.contract);
  const manifestParsed = FrozenContractManifestSchema.safeParse(args.manifest);
  if (!contractParsed.success || !manifestParsed.success) {
    fail("U1_SEALED_MANIFEST_INVALID", "the public contract or manifest fails its frozen schema");
  }
  const contract = contractParsed.data;
  const manifest = manifestParsed.data;
  const scoringIdentity = scoringIdentityOfContract({
    contract,
  });
  assertSameScoringIdentity(scoringIdentity, args.publicScoringIdentity, "public-select to sealed");
  if (
    contract.contractSha256 !== manifest.contractSha256 ||
    contract.taskCardHash !== manifest.taskCardHash ||
    contract.evaluationReviewHash !== manifest.evaluationReviewHash ||
    contract.sourceHashes.evaluationReview !== contract.evaluationReviewHash ||
    !sameOrderedStrings(contract.holdoutScenarioIds, manifest.holdoutScenarioIds)
  ) {
    fail(
      "U1_SEALED_MANIFEST_BINDING_INVALID",
      "the manifest, contract, Task Card, evaluation review or holdout scenarios are not hash-bound to one formal lane",
    );
  }
  if (!SHA256.test(args.startingReferenceSha256) || !SHA256.test(args.finalPublicChampionSha256)) {
    fail("U1_SEALED_PUBLIC_DECISION_INVALID", "terminal public candidate hashes must be SHA-256 values");
  }

  if (args.publicDecision !== "clear_improvement") {
    if (args.finalPublicChampionSha256 !== args.startingReferenceSha256) {
      fail(
        "U1_SEALED_PUBLIC_DECISION_INVALID",
        "a retained/rejected/incomparable public decision must keep Starting Reference as Final Public Champion",
      );
    }
    return noNovelResult(contract.contractSha256, scoringIdentity);
  }
  if (args.finalPublicChampionSha256 === args.startingReferenceSha256) {
    fail(
      "U1_SEALED_PUBLIC_DECISION_INVALID",
      "clear_improvement cannot name Starting Reference as the Final Public Champion",
    );
  }

  requireFormalGate(args, manifest);
  const frozen = requireFrozenCandidates(args);
  requireBudget(args, manifest);

  const candidateSkills = new Map<U1SealedCandidateLabel, string>();
  for (const label of U1_SEALED_LABELS) {
    const skillMd = await args.readCandidateSkill(label);
    if (!skillMd.trim() || sha256Hex(skillMd) !== frozen.get(label)!.skillSha256) {
      fail(
        "U1_SEALED_CANDIDATE_HASH_DRIFT",
        `${label} content differs from its frozen candidate hash`,
      );
    }
    candidateSkills.set(label, skillMd);
  }

  if (!(await args.claimSealedExecution())) {
    fail("U1_SEALED_ALREADY_ENTERED", "the one permitted sealed execution was already claimed");
  }

  const holdoutItems = parseAndBindHoldout(await args.readHoldoutBody(), contract, manifest);
  const auditItems = holdoutItems.map((item) => ({
    itemId: item.itemId,
    scenarioId: item.scenarioId,
    split: "holdout" as const,
    itemType: item.itemType,
    input: item.input,
    judgingRule: item.judgingRule,
    ...(item.redlineRefs ? { redlineRefs: item.redlineRefs } : {}),
    ...(item.rubric ? { rubric: item.rubric } : {}),
    ...(item.taskVerifier ? { taskVerifier: item.taskVerifier } : {}),
  }));
  const comparison = await runLabelledAuditCompare({
    contract,
    auditItems,
    requiredLabels: U1_SEALED_LABELS,
    candidates: U1_SEALED_LABELS.map((label) => ({
      label,
      candidateSource: frozen.get(label)!.candidateSource,
      skillMd: candidateSkills.get(label)!,
    })),
    runner: args.runner,
    ...(args.scoreRuns ? { scoreRuns: args.scoreRuns } : {}),
    semanticBatchSize: args.stageBudgetAssumptions.semanticBatchSize,
    budget: args.budget,
    ...(args.now ? { now: args.now } : {}),
  });
  const stageBudgetPlan = calculateStageBudgets(args.stageBudgetAssumptions);
  const callEnvelope = stageBudgetPlan.envelope.sealed;
  const applicationRecovery = requireCurrentSealedApplicationEvidence(
    comparison,
    auditItems,
    callEnvelope,
  );
  const starting = comparison.candidates.find((candidate) => candidate.label === "starting_reference")!;
  const adaptive = comparison.candidates.find((candidate) => candidate.label === "adaptive")!;
  const currentScoringProfile = contract.scoringProfile;
  const currentProjection = evaluateU1TerminalCandidateAgainstStartingReference({
    profile: currentScoringProfile,
    starting: {
      itemScores: starting.itemScores,
      dimensionScores: aggregateU1DimensionScores(starting.itemScores, currentScoringProfile),
    },
    challenger: {
      itemScores: adaptive.itemScores,
      dimensionScores: aggregateU1DimensionScores(adaptive.itemScores, currentScoringProfile),
      eligibility: evaluateU1CandidateEligibility({
        expectedItemIds: auditItems.map((item) => item.itemId),
        itemScores: adaptive.itemScores,
        gateResults: adaptive.gateResults,
        criticalRegression: false,
      }),
    },
  });
  const startingDimensions = aggregateU1DimensionScores(starting.itemScores, currentScoringProfile);
  const candidates = comparison.candidates.map((candidate) => {
    const eligibility = evaluateU1CandidateEligibility({
      expectedItemIds: auditItems.map((item) => item.itemId),
      itemScores: candidate.itemScores,
      gateResults: candidate.gateResults,
      criticalRegression: false,
    });
    const championEligible = candidate.label === "starting_reference"
      ? eligibility.championEligible
      : evaluateU1TerminalCandidateAgainstStartingReference({
          profile: currentScoringProfile,
          starting: { itemScores: starting.itemScores, dimensionScores: startingDimensions },
          challenger: {
            itemScores: candidate.itemScores,
            dimensionScores: aggregateU1DimensionScores(candidate.itemScores, currentScoringProfile),
            eligibility,
          },
        }).championEligible;
    return { label: candidate.label, auditScore: candidate.auditScore, championEligible };
  });
  const eligible = candidates.filter((candidate) => candidate.championEligible);
  const bestScore = eligible.length > 0 ? Math.max(...eligible.map((candidate) => candidate.auditScore)) : null;
  const best = bestScore === null ? [] : eligible.filter((candidate) => candidate.auditScore === bestScore);
  const currentWinner = best.length === 1 ? best[0].label : "tie";
  const adaptiveGateEligible = currentProjection.championEligible;
  const regressed = !adaptiveGateEligible || adaptive.auditScore < starting.auditScore;

  return {
    status: regressed ? "sealed_rejected" : "sealed_confirmed",
    contractSha256: comparison.contractSha256,
    bodyReads: 1,
    candidates: comparison.candidates,
    winner: currentWinner,
    accounting: comparison.accounting,
    wallTimeMs: comparison.wallTimeMs,
    events: comparison.events,
    feedbackToEvolution: false,
    generationTriggered: false,
    repairTriggered: false,
    secondSealedAllowed: false,
    applicationRetryAllowed: false,
    releaseAllowed: false,
    budget: {
      minimum: callEnvelope.baselineEstimate,
      authorized: args.authorizedStageBudgets.sealed,
      independent: true as const,
      assumptions: stageBudgetPlan.assumptions,
      envelope: callEnvelope,
    },
    applicationRecovery,
    providerTokenTelemetry: {
      ...args.budget.providerTokenTelemetry(),
      byStageRoleModel: args.budget.providerTokenTelemetryByTags(),
    },
    ...(args.providerIdentity ? { provider: args.providerIdentity } : {}),
    scoringIdentity,
  };
}
