import { z } from "zod";
import { stableStringify } from "../intake/taskCard.js";
import { sha256Hex } from "../runtime/capabilityAdapter.js";
import {
  ProviderTokenTelemetryEvidenceSchema,
  SEMANTIC_RESPONSE_BINDING_VERSION,
  U1_SCORING_PROFILE_VERSION,
  U1ScoringIdentitySchema,
} from "../types.js";
export { ProviderTokenTelemetryEvidenceSchema } from "../types.js";
import {
  CANDIDATE_ITEM_ESTIMATION_VERSION,
  callEnvelopesEqual,
  calculateStageBudgets,
} from "../providers/stageBudgets.js";
import type { AdaptiveRunResult, AdaptiveStopReason } from "./adaptiveRun.js";
import { selectBootstrapSlice, type FunnelEvalItem } from "./funnel.js";
import type { TerminalPublicSelectionResult } from "./publicSelection.js";
import {
  calculateAdaptiveClosureBudget,
} from "./adaptiveClosureProtocol.js";
import { projectU1ChampionEligibility } from "../evaluation/u1Rubric.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ProviderFingerprintSchema = z.string().regex(/^[a-f0-9]{24}$/);

export const ADAPTIVE_STOP_DISPOSITIONS = Object.freeze({
  public_goal_met: "comparison",
  generations_completed: "comparison",
  stagnation_stop: "comparison",
  no_valid_child: "comparison",
  proposer_failure: "failure",
  safety_kill: "failure",
  budget_exhausted: "failure",
  root_rebuild: "failure",
} as const satisfies Record<AdaptiveStopReason, "comparison" | "failure">);

export type AdaptiveStopDisposition = "comparison" | "failure";
export type AdaptiveFailureStopReason = {
  [Reason in AdaptiveStopReason]: typeof ADAPTIVE_STOP_DISPOSITIONS[Reason] extends "failure" ? Reason : never;
}[AdaptiveStopReason];

function adaptiveStopReasonsWith(
  disposition: AdaptiveStopDisposition,
): [AdaptiveStopReason, ...AdaptiveStopReason[]] {
  const reasons = (Object.keys(ADAPTIVE_STOP_DISPOSITIONS) as AdaptiveStopReason[])
    .filter((reason) => ADAPTIVE_STOP_DISPOSITIONS[reason] === disposition);
  if (reasons.length === 0) throw new Error(`Adaptive stop disposition ${disposition} has no reasons`);
  return reasons as [AdaptiveStopReason, ...AdaptiveStopReason[]];
}

export const AdaptiveComparisonStopReasonSchema = z.enum(adaptiveStopReasonsWith("comparison"));
const AdaptiveFailureStopReasonSchema = z.enum(adaptiveStopReasonsWith("failure"));

export function adaptiveStopDispositionOf(reason: AdaptiveStopReason): AdaptiveStopDisposition {
  return ADAPTIVE_STOP_DISPOSITIONS[reason];
}

export function isAdaptiveFailureStopReason(reason: AdaptiveStopReason): reason is AdaptiveFailureStopReason {
  return adaptiveStopDispositionOf(reason) === "failure";
}

export const ADAPTIVE_FAILURE_CODES = Object.freeze({
  proposer_failure: "ADAPTIVE_PROPOSER_FAILURE",
  safety_kill: "ADAPTIVE_SAFETY_KILL",
  budget_exhausted: "ADAPTIVE_BUDGET_EXHAUSTED",
  root_rebuild: "ADAPTIVE_ROOT_REBUILD",
} as const satisfies Record<AdaptiveFailureStopReason, string>);

export function adaptiveFailureCodeOf(reason: AdaptiveFailureStopReason): string {
  return ADAPTIVE_FAILURE_CODES[reason];
}

const RecoverySubjectEvidenceSchema = z.union([
  z.object({
    kind: z.literal("candidate"),
    generation: z.number().int().min(0),
    lane: z.enum(["anchor", "seed", "exploit", "diversify"]),
  }).strict(),
  z.object({ kind: z.literal("stage"), stage: z.literal("calibration"), pass: z.union([z.literal(1), z.literal(2)]) }).strict(),
  z.object({ kind: z.literal("stage"), stage: z.enum(["public-select", "direct"]) }).strict(),
]);

/** Shared content-free projection for one rejected semantic response. */
export const StructureRecoveryDiagnosticEvidenceSchema = z.object({
  subject: RecoverySubjectEvidenceSchema,
  attempt: z.union([z.literal(1), z.literal(2)]),
  failureCode: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  findingCodes: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/)),
  responseLength: z.number().int().min(0),
  finishReason: z.enum(["stop", "length", "content_filter", "tool_calls", "other"]).nullable(),
  responseSha256: Sha256Schema,
}).strict();

const PublicSelectionStructureRecoveryDiagnosticEvidenceSchema =
  StructureRecoveryDiagnosticEvidenceSchema.refine(
    (value) => value.subject.kind === "stage" && value.subject.stage === "public-select",
    "public-select recovery diagnostics must carry the public-select stage subject",
  );

const AdaptiveStructureRecoveryDiagnosticEvidenceSchema =
  StructureRecoveryDiagnosticEvidenceSchema.refine(
    (value) => value.subject.kind === "candidate",
    "Adaptive recovery diagnostics must carry a candidate generation/lane subject",
  );

function rejectRetiredProtocolFields(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  for (const field of ["adaptiveProtocolBinding", "adaptiveProtocol", "executionProtocol"] as const) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `current artifacts cannot carry retired ${field} envelopes`,
        path: [field],
      });
    }
  }
}

function validateAdaptiveSemanticRecovery(
  value: {
    actualApplicationRecoveryAttempts: number;
    structureRecoveryDiagnostics: Array<z.infer<typeof StructureRecoveryDiagnosticEvidenceSchema>>;
    adaptiveBudget: { recoveryReserve: number };
  },
  ctx: z.RefinementCtx,
): void {
  const primaryBySubject = new Map<string, number>();
  const repairBySubject = new Map<string, number>();
  let rejectedPrimary = 0;
  for (const entry of value.structureRecoveryDiagnostics) {
    if (entry.subject.kind !== "candidate") continue;
    const key = `${entry.subject.generation}:${entry.subject.lane}`;
    const target = entry.attempt === 1 ? primaryBySubject : repairBySubject;
    target.set(key, (target.get(key) ?? 0) + 1);
    if (entry.attempt === 1) rejectedPrimary += 1;
  }
  if (
    value.actualApplicationRecoveryAttempts !== rejectedPrimary ||
    value.actualApplicationRecoveryAttempts > value.adaptiveBudget.recoveryReserve
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Adaptive recovery count must equal rejected primaries and stay within its recovery reserve",
      path: ["actualApplicationRecoveryAttempts"],
    });
  }
  if ([...repairBySubject].some(([key, repairs]) => repairs > (primaryBySubject.get(key) ?? 0))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Adaptive repair diagnostics cannot exceed rejected primaries for the same generation/lane",
      path: ["structureRecoveryDiagnostics"],
    });
  }
}

function validatePublicSelectionSemanticRecovery(
  value: {
    actualApplicationRecoveryAttempts: number;
    structureRecoveryDiagnostics: Array<z.infer<typeof StructureRecoveryDiagnosticEvidenceSchema>>;
    accounting: { logicalCalls: number };
  },
  existingRecoveryReserve: number,
  completed: boolean,
  ctx: z.RefinementCtx,
): void {
  const rejectedPrimary = value.structureRecoveryDiagnostics.filter((entry) => entry.attempt === 1).length;
  const rejectedRepair = value.structureRecoveryDiagnostics.filter((entry) => entry.attempt === 2).length;
  if (
    value.actualApplicationRecoveryAttempts !== rejectedPrimary ||
    rejectedPrimary > 1 ||
    value.actualApplicationRecoveryAttempts > existingRecoveryReserve ||
    value.actualApplicationRecoveryAttempts > value.accounting.logicalCalls
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "public-select recovery count must equal rejected primaries and stay within its persisted reserve",
      path: ["actualApplicationRecoveryAttempts"],
    });
  }
  if (
    rejectedRepair > rejectedPrimary ||
    (completed && rejectedRepair !== 0) ||
    (!completed && rejectedRepair > 1)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "public-select completion cannot contain a rejected repair and failure may contain only the terminal rejected repair",
      path: ["structureRecoveryDiagnostics"],
    });
  }
}

/** Current-U1 content-free evidence recomputed against the shared stage-budget calculator. */
export const StageBudgetAssumptionsEvidenceSchema = z.object({
  shortlistCandidates: z.number().int().min(1),
  selectItems: z.number().int().min(1),
  holdoutItems: z.number().int().min(1),
  semanticBatchSize: z.number().int().min(1),
  directProposerCalls: z.number().int().min(1),
  maxModelTurns: z.number().int().min(1),
  maxToolCalls: z.number().int().min(0),
  budgetMultiplier: z.number().finite().min(1),
}).strict();

export const ScenarioCallAuthorizationEvidenceSchema = z.object({
  rawScenarioEstimate: z.number().int().min(1),
  callEnvelopeMultiplier: z.number().finite().min(1),
  authorizedModelCallsPerAttempt: z.number().int().min(1),
  authorizedMaxTurns: z.number().int().min(1),
  authorizedMaxToolCalls: z.number().int().min(0),
  maxApplicationAttempts: z.union([z.literal(1), z.literal(2)]),
  scenarioRetryReserve: z.number().int().min(0),
}).strict().superRefine((value, ctx) => {
  const authorizedModelCallsPerAttempt = Math.ceil(
    value.rawScenarioEstimate * value.callEnvelopeMultiplier,
  );
  if (
    value.authorizedModelCallsPerAttempt !== authorizedModelCallsPerAttempt ||
    value.authorizedMaxTurns !== authorizedModelCallsPerAttempt ||
    value.authorizedMaxToolCalls !== Math.max(0, authorizedModelCallsPerAttempt - 1) ||
    value.scenarioRetryReserve !==
      authorizedModelCallsPerAttempt * (value.maxApplicationAttempts - 1)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "scenario authorization must preserve p=ceil(r*M), runtime bounds, and retry reserve",
      path: ["authorizedModelCallsPerAttempt"],
    });
  }
});

export const CallEnvelopeEvidenceSchema = z.object({
  estimationVersion: z.literal(CANDIDATE_ITEM_ESTIMATION_VERSION),
  baselineEstimate: z.number().int().min(1),
  rawStageEstimate: z.number().int().min(1),
  callEnvelopeMultiplier: z.number().finite().min(1),
  stagePrimaryAuthorization: z.number().int().min(1),
  stageLoopRetryReserve: z.number().int().min(0),
  existingRecoveryReserve: z.number().int().min(0),
  headroom: z.number().int().min(0),
  authorizedLogicalCalls: z.number().int().min(1),
  scenarioAuthorization: ScenarioCallAuthorizationEvidenceSchema,
}).strict().superRefine((value, ctx) => {
  const expectedTotal =
    value.stagePrimaryAuthorization +
    value.stageLoopRetryReserve +
    value.existingRecoveryReserve;
  const minimumPrimary = Math.ceil(
    value.rawStageEstimate * value.callEnvelopeMultiplier,
  );
  if (
    value.baselineEstimate !== value.rawStageEstimate ||
    value.callEnvelopeMultiplier !== value.scenarioAuthorization.callEnvelopeMultiplier ||
    value.stagePrimaryAuthorization < minimumPrimary ||
    value.authorizedLogicalCalls !== expectedTotal ||
    value.headroom !== expectedTotal - value.rawStageEstimate ||
    (value.scenarioAuthorization.maxApplicationAttempts === 1 && value.stageLoopRetryReserve !== 0)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "call envelope must preserve raw/primary/retry/recovery/total B/M/H accounting",
      path: ["authorizedLogicalCalls"],
    });
  }
});

const AdaptiveBudgetAssumptionsEvidenceSchema = z.object({
  rootCandidates: z.number().int().min(1),
  publicTrainItems: z.number().int().min(1),
  pinnedItems: z.number().int().min(0),
  semanticBatchSize: z.number().int().min(1),
  minChildGenerations: z.number().int().min(1),
  lanesPerGeneration: z.literal(2),
  childCandidates: z.number().int().min(0),
  totalCandidates: z.number().int().min(1),
  evaluatorCallsPerCandidate: z.number().int().min(1),
  pinnedSemanticCallsPerCandidate: z.number().int().min(0),
  fullSemanticCallsPerCandidate: z.number().int().min(1),
  semanticCallsPerCandidate: z.number().int().min(1),
  mutationCalls: z.number().int().min(0),
  maxModelTurns: z.number().int().min(1),
  maxToolCalls: z.number().int().min(0),
  maxRefinements: z.number().int().min(0),
  budgetMultiplier: z.number().finite().min(1),
  rawCandidateItemCallsPerCandidate: z.number().int().min(1),
  candidateItemCallsPerCandidate: z.number().int().min(1),
}).strict();

export const AdaptiveBudgetPlanEvidenceSchema = z.object({
  minimum: z.number().int().min(1),
  assumptions: AdaptiveBudgetAssumptionsEvidenceSchema,
  primaryMinimum: z.number().int().min(1),
  proposerRecoverySlots: z.number().int().min(0),
  semanticRecoveryBatches: z.number().int().min(0),
  recoveryReserve: z.number().int().min(0),
  loopRetryReserve: z.number().int().min(0),
  envelope: CallEnvelopeEvidenceSchema,
}).strict().superRefine((value, ctx) => {
  const assumptions = value.assumptions;
  const expected = calculateAdaptiveClosureBudget({
    rootCandidates: assumptions.rootCandidates,
    publicTrainItems: assumptions.publicTrainItems,
    pinnedItems: assumptions.pinnedItems,
    semanticBatchSize: assumptions.semanticBatchSize,
    minChildGenerations: assumptions.minChildGenerations,
    maxModelTurns: assumptions.maxModelTurns,
    maxToolCalls: assumptions.maxToolCalls,
    maxRefinements: assumptions.maxRefinements,
    budgetMultiplier: assumptions.budgetMultiplier,
  });
  if (stableStringify(value) !== stableStringify(expected)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Adaptive budget evidence must be exactly reproducible by the shared calculator",
      path: ["minimum"],
    });
  }
});

export const ApplicationRecoveryAttemptEvidenceSchema = z.object({
  attempt: z.union([z.literal(1), z.literal(2)]),
  attemptIdentitySha256: Sha256Schema,
  terminalReason: z.enum([
    "final",
    "tool_denied",
    "invalid_json",
    "unsupported_type",
    "too_many_tool_calls",
    "too_many_turns",
    "no_final",
  ]),
  modelCalls: z.number().int().min(1),
  transcriptSha256: Sha256Schema,
  successfulToolCalls: z.number().int().min(0),
  failedToolCalls: z.number().int().min(0),
  uniqueSuccessfulToolRequests: z.number().int().min(0),
  repeatedSuccessfulToolRequests: z.number().int().min(0),
  trajectorySha256: Sha256Schema,
}).strict().superRefine((value, ctx) => {
  if (
    value.successfulToolCalls !==
      value.uniqueSuccessfulToolRequests + value.repeatedSuccessfulToolRequests
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "sanitized attempt trajectory counts must satisfy successful=unique+repeated",
      path: ["successfulToolCalls"],
    });
  }
});

const ApplicationRecoveryEvidenceFields = {
  outcome: z.enum([
    "no_retry_needed",
    "recovered_after_single_retry",
    "persistent_candidate_loop",
    "retry_completed_non_final",
    "scenario_envelope_exhausted",
  ]),
  attempts: z.union([
    z.tuple([ApplicationRecoveryAttemptEvidenceSchema]),
    z.tuple([
      ApplicationRecoveryAttemptEvidenceSchema,
      ApplicationRecoveryAttemptEvidenceSchema,
    ]),
  ]),
  retryTriggered: z.boolean(),
  rawScenarioEstimate: z.number().int().min(1),
  callEnvelopeMultiplier: z.number().finite().min(1),
  authorizedModelCallsPerAttempt: z.number().int().min(1),
  maxApplicationAttempts: z.union([z.literal(1), z.literal(2)]),
  scenarioRetryReserve: z.number().int().min(0),
  unusedRetryReserve: z.number().int().min(0),
  classification: z.enum([
    "persistent_candidate_loop",
    "scenario_envelope_underestimated",
    "scenario_envelope_exhausted_unclassified",
  ]).nullable(),
} as const;

const ApplicationRecoveryEvidenceBaseSchema = z.object(
  ApplicationRecoveryEvidenceFields,
).strict();

type ApplicationRecoveryEvidence = z.infer<typeof ApplicationRecoveryEvidenceBaseSchema>;

function validateApplicationRecoveryEvidence(
  value: ApplicationRecoveryEvidence,
  ctx: z.RefinementCtx,
): void {
  if (value.attempts[0].attempt !== 1 || (value.attempts.length === 2 && value.attempts[1].attempt !== 2)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "application attempt evidence must start at attempt 1 and may contain only one attempt 2",
      path: ["attempts"],
    });
  }
  if (
    value.attempts.length === 2 &&
    value.attempts[0].attemptIdentitySha256 === value.attempts[1].attemptIdentitySha256
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "application retry must use a fresh attempt identity",
      path: ["attempts", 1, "attemptIdentitySha256"],
    });
  }
  const isLoopReason = (reason: ApplicationRecoveryEvidence["attempts"][number]["terminalReason"]): boolean =>
    reason === "too_many_turns" || reason === "too_many_tool_calls";
  if (value.attempts.length === 2 && !isLoopReason(value.attempts[0].terminalReason)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "application recovery attempt 1 must be a bounded candidate loop",
      path: ["attempts", 0, "terminalReason"],
    });
  }
  const finalReason = value.attempts[value.attempts.length - 1].terminalReason;
  if (
    (value.outcome === "no_retry_needed" && value.attempts.length !== 1) ||
    (value.outcome !== "no_retry_needed" && value.attempts.length !== 2) ||
    (value.outcome === "recovered_after_single_retry" &&
      (value.attempts.length !== 2 || finalReason !== "final")) ||
    (value.outcome === "persistent_candidate_loop" &&
      (value.attempts.length !== 2 || !isLoopReason(finalReason))) ||
    (value.outcome === "scenario_envelope_exhausted" &&
      (value.attempts.length !== 2 || !isLoopReason(finalReason))) ||
    (value.outcome === "retry_completed_non_final" &&
      (value.attempts.length !== 2 || finalReason === "final" || isLoopReason(finalReason)))
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "application recovery outcome must match attempt 2 terminalReason",
      path: ["outcome"],
    });
  }
  const authorizedModelCallsPerAttempt = Math.ceil(
    value.rawScenarioEstimate * value.callEnvelopeMultiplier,
  );
  const retryAttempt = value.attempts.length === 2 ? value.attempts[1] : undefined;
  const expectedRetryReserve =
    authorizedModelCallsPerAttempt * (value.maxApplicationAttempts - 1);
  const expectedUnusedRetryReserve = retryAttempt
    ? expectedRetryReserve - retryAttempt.modelCalls
    : expectedRetryReserve;
  if (
    value.authorizedModelCallsPerAttempt !== authorizedModelCallsPerAttempt ||
    value.maxApplicationAttempts < value.attempts.length ||
    value.retryTriggered !== (value.attempts.length === 2) ||
    value.scenarioRetryReserve !== expectedRetryReserve ||
    value.unusedRetryReserve !== expectedUnusedRetryReserve ||
    value.attempts.some((attempt) =>
      attempt.modelCalls > authorizedModelCallsPerAttempt ||
      attempt.successfulToolCalls > Math.max(0, authorizedModelCallsPerAttempt - 1) ||
      (isLoopReason(attempt.terminalReason) &&
        attempt.modelCalls !== authorizedModelCallsPerAttempt))
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "application attempts drifted from p=ceil(r*M) or their exact retry reserve",
      path: ["attempts"],
    });
  }
  const repeatedSuccessfulToolRequests = value.attempts.reduce(
    (sum, attempt) => sum + attempt.repeatedSuccessfulToolRequests,
    0,
  );
  const failedToolCalls = value.attempts.reduce(
    (sum, attempt) => sum + attempt.failedToolCalls,
    0,
  );
  if (
    (value.outcome === "persistent_candidate_loop" &&
      (value.classification !== "persistent_candidate_loop" || repeatedSuccessfulToolRequests === 0)) ||
    (value.outcome === "scenario_envelope_exhausted" &&
      (value.classification !== "scenario_envelope_underestimated" &&
        value.classification !== "scenario_envelope_exhausted_unclassified" ||
        repeatedSuccessfulToolRequests !== 0 ||
        (value.classification === "scenario_envelope_underestimated" && failedToolCalls !== 0))) ||
    ((value.outcome === "no_retry_needed" ||
      value.outcome === "recovered_after_single_retry" ||
      value.outcome === "retry_completed_non_final") && value.classification !== null)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "application outcome, classification, and sanitized trajectory must agree",
      path: ["classification"],
    });
  }
}

/** Error-only runner evidence; never a scoreable artifact outcome. */
export const ApplicationRecoverySafeEvidenceSchema =
  ApplicationRecoveryEvidenceBaseSchema.superRefine(validateApplicationRecoveryEvidence);

const ApplicationRecoverySafeSummarySchemaBase = z.object({
  candidateId: z.string().min(1),
  itemId: z.string().min(1),
  role: z.enum(["starting-reference", "adaptive", "public-select", "direct", "sealed"]),
  ...ApplicationRecoveryEvidenceFields,
}).strict().superRefine((value, ctx) => {
  validateApplicationRecoveryEvidence(value, ctx);
  if (
    (value.role === "sealed") !== (value.maxApplicationAttempts === 1) ||
    (value.maxApplicationAttempts === 1 &&
      (value.attempts.length !== 1 || value.retryTriggered || value.scenarioRetryReserve !== 0))
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "sealed evidence permits exactly one application attempt and no retry reserve",
      path: ["role"],
    });
  }
});

/** Error-only stage evidence with candidate/item identity and no private body. */
export const ApplicationRecoverySafeSummarySchema = ApplicationRecoverySafeSummarySchemaBase;

export const ApplicationRecoverySummarySchema = ApplicationRecoverySafeSummarySchemaBase.superRefine((value, ctx) => {
  if (
    value.outcome === "scenario_envelope_exhausted" ||
    value.classification === "scenario_envelope_underestimated" ||
    value.classification === "scenario_envelope_exhausted_unclassified"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "completed scoreable artifacts may only retain persistent_candidate_loop exhaustion",
      path: ["classification"],
    });
  }
});

const AdaptiveApplicationRecoverySchema = z.object({
  itemId: z.string().min(1),
  ...ApplicationRecoveryEvidenceFields,
}).strict().superRefine((value, ctx) => {
  validateApplicationRecoveryEvidence(value, ctx);
  if (
    value.outcome === "scenario_envelope_exhausted" ||
    value.classification === "scenario_envelope_underestimated" ||
    value.classification === "scenario_envelope_exhausted_unclassified"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "completed Adaptive artifacts cannot score an underestimated or unclassified scenario envelope",
      path: ["classification"],
    });
  }
});

function sameEnvelope(
  left: z.infer<typeof CallEnvelopeEvidenceSchema>,
  right: z.infer<typeof CallEnvelopeEvidenceSchema>,
): boolean {
  return stableStringify(left) === stableStringify(right);
}

export const DynamicEnvelopeExhaustionEvidenceSchema = z.object({
  status: z.literal("dynamic-envelope-exhausted"),
  classification: z.enum([
    "legitimate_workload_exceeded_estimate",
    "contract_or_adapter_drift",
    "persistent_candidate_loop",
    "envelope_calculator_omission",
    "unknown_bounded_exhaustion",
  ]),
  estimationVersion: z.literal(CANDIDATE_ITEM_ESTIMATION_VERSION),
  baselineEstimate: z.number().int().min(1),
  rawStageEstimate: z.number().int().min(1),
  callEnvelopeMultiplier: z.number().finite().min(1),
  stagePrimaryAuthorization: z.number().int().min(1),
  stageLoopRetryReserve: z.number().int().min(0),
  existingRecoveryReserve: z.number().int().min(0),
  headroom: z.number().int().min(0),
  stageAuthorizedLogicalCalls: z.number().int().min(1),
  actualLogicalCalls: z.number().int().min(1),
  nextCallStarted: z.literal(false),
  multiplierChangedDuringRun: z.literal(false),
}).strict().superRefine((value, ctx) => {
  const total =
    value.stagePrimaryAuthorization +
    value.stageLoopRetryReserve +
    value.existingRecoveryReserve;
  if (
    value.baselineEstimate !== value.rawStageEstimate ||
    value.stageAuthorizedLogicalCalls !== total ||
    value.headroom !== total - value.rawStageEstimate ||
    value.actualLogicalCalls !== total
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "dynamic envelope exhaustion must stop exactly at H and preserve B/M/H accounting",
      path: ["actualLogicalCalls"],
    });
  }
});

export type DynamicEnvelopeExhaustionEvidence = z.infer<
  typeof DynamicEnvelopeExhaustionEvidenceSchema
>;

export function dynamicEnvelopeExhaustionMatches(
  evidence: DynamicEnvelopeExhaustionEvidence,
  envelope: z.infer<typeof CallEnvelopeEvidenceSchema>,
  logicalCalls: number,
): boolean {
  return (
    evidence.estimationVersion === envelope.estimationVersion &&
    evidence.baselineEstimate === envelope.baselineEstimate &&
    evidence.rawStageEstimate === envelope.rawStageEstimate &&
    evidence.callEnvelopeMultiplier === envelope.callEnvelopeMultiplier &&
    evidence.stagePrimaryAuthorization === envelope.stagePrimaryAuthorization &&
    evidence.stageLoopRetryReserve === envelope.stageLoopRetryReserve &&
    evidence.existingRecoveryReserve === envelope.existingRecoveryReserve &&
    evidence.headroom === envelope.headroom &&
    evidence.stageAuthorizedLogicalCalls === envelope.authorizedLogicalCalls &&
    evidence.actualLogicalCalls === logicalCalls &&
    logicalCalls === envelope.authorizedLogicalCalls
  );
}

const ResumeCandidateSchema = z.object({
  candidateId: z.string().min(1),
  originRoot: z.enum(["b0", "s0"]),
  generation: z.number().int().min(0),
  parentCandidateId: z.string().min(1).nullable(),
  childKind: z.enum(["exploit", "diversify"]).nullable(),
  skillMd: z.string().min(1),
  evaluation: z.object({
    publicScore: z.number().finite(),
    solvedItemIds: z.array(z.string().min(1)),
    evaluatedItemIds: z.array(z.string().min(1)),
    applicationRecoveries: z.array(AdaptiveApplicationRecoverySchema),
    gateResults: z.array(z.unknown()),
    safetyFailures: z.number().int().min(0),
    qualityFailures: z.number().int().min(0),
    outcome: z.enum(["elite", "safe_non_elite", "killed"]),
  }).passthrough().nullable(),
}).passthrough();

const AdaptiveResumeArtifactSchema = z.object({
  semanticResponseBindingVersion: z.literal(SEMANTIC_RESPONSE_BINDING_VERSION),
  // no_valid_child is a current conservative terminal state; the proof below
  // recomputes its bounded generation evidence before resume is authorized.
  stopReason: AdaptiveComparisonStopReasonSchema,
  stopDetail: z.string(),
  candidates: z.array(ResumeCandidateSchema).min(2),
  population: z.object({
    anchorCandidateId: z.string().min(1),
    eliteId: z.string().min(1).nullable(),
    diversityId: z.string().min(1).nullable(),
    eliteReason: z.string(),
    diversityReason: z.string(),
  }).passthrough(),
  generations: z.array(z.unknown()),
  finalElite: ResumeCandidateSchema.nullable(),
  explorationOnly: z.literal(false),
  accounting: z.object({
    logicalCalls: z.number().int().min(0),
    httpAttempts: z.number().int().min(0),
    retryAttempts: z.number().int().min(0),
  }).passthrough(),
  events: z.array(z.object({ type: z.string().min(1) }).passthrough()),
  pinnedItemIds: z.array(z.string().min(1)).min(1),
  totalWallTimeMs: z.number().min(0),
  serialEquivalentMs: z.number().min(0),
  maxObservedInFlight: z.number().int().min(0),
  actualApplicationRecoveryAttempts: z.number().int().min(0),
  structureRecoveryDiagnostics: z.array(AdaptiveStructureRecoveryDiagnosticEvidenceSchema),
  u1Intake: z.object({ b0EvidenceSha256: Sha256Schema }).passthrough(),
  publicContract: z.object({ version: z.literal("v3") }).passthrough(),
  adaptiveBudget: AdaptiveBudgetPlanEvidenceSchema,
  liveRun: z.object({
    provider: z.object({
      name: z.literal("deepseek"),
      model: z.string().min(1),
      configFingerprint: ProviderFingerprintSchema,
    }).passthrough(),
    authorizedBudget: z.object({
      maxLogicalCalls: z.number().int().min(1),
    }).passthrough(),
    callEnvelope: CallEnvelopeEvidenceSchema,
    providerTokenTelemetry: ProviderTokenTelemetryEvidenceSchema,
  }).passthrough(),
  evidence: z.object({
    confirmationMode: z.literal("human"),
    explorationOnly: z.literal(false),
    humanConfirmationBypassed: z.literal(false),
  }).passthrough(),
  confirmationMode: z.literal("human"),
  humanConfirmationBypassed: z.literal(false),
  formalEvidence: z.literal(true),
  releaseAllowed: z.literal(false),
  sealedAllowed: z.literal(false),
  scoringIdentity: U1ScoringIdentitySchema,
}).passthrough().superRefine((value, ctx) => {
  rejectRetiredProtocolFields(value, ctx);
  const adaptiveBudget = value.adaptiveBudget;
  const liveEnvelope = value.liveRun.callEnvelope;
  if (!sameEnvelope(adaptiveBudget.envelope, liveEnvelope)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "current Adaptive evidence must bind one identical, reproducible B/M/H envelope",
      path: ["adaptiveBudget"],
    });
    return;
  }
  if (
    value.liveRun.authorizedBudget?.maxLogicalCalls !== adaptiveBudget.envelope.authorizedLogicalCalls ||
    value.accounting.logicalCalls > adaptiveBudget.envelope.authorizedLogicalCalls ||
    value.accounting.httpAttempts !== value.accounting.logicalCalls + value.accounting.retryAttempts
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "current Adaptive accounting must stay within H and bind HTTP=logical+transport-retry",
      path: ["accounting"],
    });
  }
  if (!value.liveRun.providerTokenTelemetry.byStageRoleModel) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "current Adaptive evidence requires detailed stage/role/model token telemetry",
      path: ["liveRun", "providerTokenTelemetry"],
    });
  }
  validateAdaptiveSemanticRecovery(value, ctx);
  const scenario = adaptiveBudget.envelope.scenarioAuthorization;
  for (const [candidateIndex, candidate] of value.candidates.entries()) {
    const evaluation = candidate.evaluation;
    if (!evaluation) continue;
    const evaluatedItemIds = evaluation.evaluatedItemIds;
    const recoveries = evaluation.applicationRecoveries;
    if (!evaluatedItemIds || !recoveries) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "current Adaptive evaluated candidates require exact candidate-item application evidence",
        path: ["candidates", candidateIndex, "evaluation"],
      });
      continue;
    }
    const expected = new Set(evaluatedItemIds);
    const actual = new Set(recoveries.map((entry) => entry.itemId));
    if (
      expected.size !== evaluatedItemIds.length ||
      actual.size !== recoveries.length ||
      expected.size !== actual.size ||
      [...expected].some((itemId) => !actual.has(itemId))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Adaptive candidate-item application evidence must exactly cover evaluatedItemIds",
        path: ["candidates", candidateIndex, "evaluation", "applicationRecoveries"],
      });
    }
    for (const [recoveryIndex, recovery] of recoveries.entries()) {
      if (
        recovery.rawScenarioEstimate !== scenario.rawScenarioEstimate ||
        recovery.callEnvelopeMultiplier !== scenario.callEnvelopeMultiplier ||
        recovery.authorizedModelCallsPerAttempt !== scenario.authorizedModelCallsPerAttempt ||
        recovery.maxApplicationAttempts !== scenario.maxApplicationAttempts ||
        recovery.scenarioRetryReserve !== scenario.scenarioRetryReserve
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Adaptive candidate-item application evidence drifted from the stage scenario authorization",
          path: ["candidates", candidateIndex, "evaluation", "applicationRecoveries", recoveryIndex],
        });
      }
    }
  }
});

export function parseAdaptiveResultArtifact(value: unknown): AdaptiveRunResult & Record<string, unknown> {
  return AdaptiveResumeArtifactSchema.parse(value) as unknown as AdaptiveRunResult & Record<string, unknown>;
}

const ScenarioEnvelopeExhaustionArtifactSchema = z.object({
  code: z.enum(["SCENARIO_ENVELOPE_UNDERESTIMATED", "SCENARIO_ENVELOPE_EXHAUSTED_UNCLASSIFIED"]),
  classification: z.enum(["scenario_envelope_underestimated", "scenario_envelope_exhausted_unclassified"]),
  role: z.enum(["starting-reference", "adaptive", "public-select", "direct", "sealed"]),
  itemId: z.string().min(1),
  skillSha256: Sha256Schema,
  applicationRecovery: ApplicationRecoverySafeEvidenceSchema,
  thirdAttemptAllowed: z.literal(false),
  requestOrResponseContentPersisted: z.literal(false),
}).strict().superRefine((value, ctx) => {
  const expectedCode = value.classification === "scenario_envelope_underestimated"
    ? "SCENARIO_ENVELOPE_UNDERESTIMATED"
    : "SCENARIO_ENVELOPE_EXHAUSTED_UNCLASSIFIED";
  if (
    value.code !== expectedCode ||
    value.applicationRecovery.classification !== value.classification ||
    value.applicationRecovery.outcome !== "scenario_envelope_exhausted"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "scenario envelope failure code, classification, and safe recovery evidence must agree",
      path: ["classification"],
    });
  }
});

export const AdaptiveFailureArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  semanticResponseBindingVersion: z.literal(SEMANTIC_RESPONSE_BINDING_VERSION),
  status: z.literal("failed"),
  phase: z.literal("adaptive-run"),
  contractSha256: Sha256Schema,
  stopReason: AdaptiveFailureStopReasonSchema.optional(),
  safeError: z.object({ code: z.string().min(1), message: z.string().min(1) }).passthrough(),
  events: z.array(z.object({
    at: z.string().datetime(),
    type: z.string().regex(/^[A-Za-z0-9_-]{1,96}$/),
  }).strict()),
  totalWallTimeMs: z.number().int().min(0).optional(),
  cache: z.object({
    hits: z.number().int().min(0),
    misses: z.number().int().min(0),
  }).strict(),
  scoringIdentity: U1ScoringIdentitySchema,
  scenarioEnvelopeExhaustion: ScenarioEnvelopeExhaustionArtifactSchema.optional(),
  dynamicEnvelopeExhaustion: DynamicEnvelopeExhaustionEvidenceSchema.optional(),
  adaptiveBudget: AdaptiveBudgetPlanEvidenceSchema,
  accounting: z.object({
    logicalCalls: z.number().int().min(0),
    httpAttempts: z.number().int().min(0),
    retryAttempts: z.number().int().min(0),
  }).passthrough(),
  providerTokenTelemetry: ProviderTokenTelemetryEvidenceSchema,
  actualApplicationRecoveryAttempts: z.number().int().min(0),
  structureRecoveryDiagnostics: z.array(AdaptiveStructureRecoveryDiagnosticEvidenceSchema),
  liveRun: z.object({
    authorizedBudget: z.object({ maxLogicalCalls: z.number().int().min(1) }).passthrough(),
    callEnvelope: CallEnvelopeEvidenceSchema,
    providerTokenTelemetry: ProviderTokenTelemetryEvidenceSchema,
  }).passthrough(),
  confirmationMode: z.literal("human"),
  explorationOnly: z.literal(false),
  humanConfirmationBypassed: z.literal(false),
  formalEvidence: z.literal(true),
  releaseAllowed: z.literal(false),
  sealedAllowed: z.literal(false),
  holdout: z.literal("sealed"),
  release: z.string().regex(/withheld/i),
}).passthrough().superRefine((value, ctx) => {
  rejectRetiredProtocolFields(value, ctx);
  if (
    value.stopReason &&
    isAdaptiveFailureStopReason(value.stopReason) &&
    value.safeError.code !== adaptiveFailureCodeOf(value.stopReason)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "structured Adaptive failure stop and safe error code must agree",
      path: ["safeError", "code"],
    });
  }
  if (value.contractSha256 !== value.scoringIdentity.contractSha256) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Adaptive failure contract and scoring identity must agree",
      path: ["contractSha256"],
    });
  }
  if (
    !sameEnvelope(value.adaptiveBudget.envelope, value.liveRun.callEnvelope)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "current Adaptive failure must preserve the exact reproducible B/M/H envelope",
      path: ["adaptiveBudget"],
    });
    return;
  }
  const authorized = value.adaptiveBudget.envelope.authorizedLogicalCalls;
  if (
    value.liveRun.authorizedBudget?.maxLogicalCalls !== authorized ||
    value.accounting.logicalCalls > authorized ||
    value.accounting.httpAttempts !== value.accounting.logicalCalls + value.accounting.retryAttempts
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "current Adaptive failure accounting must stay within H and preserve HTTP=logical+transport-retry",
      path: ["accounting"],
    });
  }
  if (!value.providerTokenTelemetry.byStageRoleModel || !value.liveRun.providerTokenTelemetry.byStageRoleModel) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "current Adaptive failure requires detailed stage/role/model token telemetry",
      path: ["providerTokenTelemetry"],
    });
  }
  validateAdaptiveSemanticRecovery(value, ctx);
  if (value.safeError.code === "DYNAMIC_ENVELOPE_EXHAUSTED") {
    if (
      !value.dynamicEnvelopeExhaustion ||
      !dynamicEnvelopeExhaustionMatches(
        value.dynamicEnvelopeExhaustion,
        value.adaptiveBudget.envelope,
        value.accounting.logicalCalls,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "dynamic Adaptive exhaustion requires exact sanitized B/M/H evidence",
        path: ["dynamicEnvelopeExhaustion"],
      });
    }
  } else if (value.dynamicEnvelopeExhaustion) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "non-dynamic Adaptive failure cannot carry dynamic exhaustion evidence",
      path: ["dynamicEnvelopeExhaustion"],
    });
  }
  if (
    value.safeError.code === "SCENARIO_ENVELOPE_UNDERESTIMATED" ||
    value.safeError.code === "SCENARIO_ENVELOPE_EXHAUSTED_UNCLASSIFIED"
  ) {
    if (!value.scenarioEnvelopeExhaustion || value.scenarioEnvelopeExhaustion.code !== value.safeError.code) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "scenario envelope Adaptive failures require matching sanitized attempt evidence",
        path: ["scenarioEnvelopeExhaustion"],
      });
    }
  } else if (value.scenarioEnvelopeExhaustion) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "non-envelope Adaptive failures must not carry scenario exhaustion evidence",
      path: ["scenarioEnvelopeExhaustion"],
    });
  }
});

export class PublicSelectionResumeError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "PublicSelectionResumeError";
  }
}

export interface PublicSelectionResumeBindings {
  expectedAdaptiveResultSha256: string;
  contractSha256: string;
  currentTrainItemIds: readonly string[];
  /** Current frozen public inputs used to recompute the pinned safety slice. */
  currentTrainItems: readonly FunnelEvalItem[];
  b0SkillMd: string;
  s0SkillMd: string;
  publicContract: { version: "v3"; sha256?: string };
  confirmationMode: "human";
  providerModel: string;
  acceptedEvaluatorConfigFingerprints: readonly string[];
  expectedU1Intake: {
    track: "b0-repair" | "s0-rebuild";
    b0EvidenceSha256: string;
    s0SkillSha256?: string;
  };
}

function resumeFail(code: string, message: string): never {
  throw new PublicSelectionResumeError(code, message);
}

/**
 * Validate the immutable Adaptive evidence before a public-select-only retry.
 * The caller passes the exact byte hash explicitly; no network work is needed
 * or permitted at this boundary.
 */
export function validateAdaptiveResultForPublicSelectResume(
  raw: string,
  bindings: PublicSelectionResumeBindings,
): {
  adaptiveResultSha256: string;
  result: AdaptiveRunResult;
} {
  const expectedHash = Sha256Schema.safeParse(bindings.expectedAdaptiveResultSha256);
  if (!expectedHash.success) {
    resumeFail("RESUME_ADAPTIVE_HASH_INVALID", "--resume-public-select must be an exact lowercase SHA-256");
  }
  const actualHash = sha256Hex(raw);
  if (actualHash !== expectedHash.data) {
    resumeFail("RESUME_ADAPTIVE_HASH_MISMATCH", "the current adaptive-result.json bytes do not match the explicitly pinned SHA-256");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    resumeFail("RESUME_ADAPTIVE_RESULT_INVALID", "adaptive-result.json is not valid JSON");
  }
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    Array.isArray(decoded) ||
    (decoded as Record<string, unknown>).semanticResponseBindingVersion !== SEMANTIC_RESPONSE_BINDING_VERSION
  ) {
    resumeFail(
      "RESUME_ADAPTIVE_SEMANTIC_BINDING_DRIFT",
      `adaptive-result.json must use semantic response binding ${SEMANTIC_RESPONSE_BINDING_VERSION}`,
    );
  }
  const parsed = AdaptiveResumeArtifactSchema.safeParse(decoded);
  if (!parsed.success) {
    resumeFail("RESUME_ADAPTIVE_RESULT_INVALID", "adaptive-result.json does not satisfy the resumable evidence contract");
  }
  const artifact = parsed.data;
  const decodedRecord = decoded as Record<string, unknown>;
  if ("publicSelection" in decodedRecord || "publicSelectionMeta" in decodedRecord) {
    resumeFail("RESUME_PUBLIC_SELECTION_ALREADY_PRESENT", "the Adaptive artifact already carries terminal public-selection evidence");
  }

  const ids = artifact.candidates.map((candidate) => candidate.candidateId);
  if (new Set(ids).size !== ids.length) {
    resumeFail("RESUME_ADAPTIVE_CANDIDATE_DUPLICATE", "candidate ids in the Adaptive artifact must be unique");
  }
  const idSet = new Set(ids);
  for (const [seat, candidateId] of Object.entries({
    anchor: artifact.population.anchorCandidateId,
    elite: artifact.population.eliteId,
    diversity: artifact.population.diversityId,
  })) {
    if (candidateId !== null && !idSet.has(candidateId)) {
      resumeFail("RESUME_ADAPTIVE_POPULATION_DANGLING", `${seat} points to a candidate absent from the Adaptive artifact`);
    }
  }
  if (artifact.finalElite !== null) {
    const canonical = artifact.candidates.find((candidate) => candidate.candidateId === artifact.finalElite?.candidateId);
    if (!canonical || sha256Hex(canonical.skillMd) !== sha256Hex(artifact.finalElite.skillMd)) {
      resumeFail("RESUME_ADAPTIVE_FINAL_ELITE_INVALID", "finalElite is not bound to the canonical candidate table");
    }
  }

  const expectedB0Hash = sha256Hex(bindings.b0SkillMd);
  const expectedS0Hash = sha256Hex(bindings.s0SkillMd);
  const b0Roots = artifact.candidates.filter((candidate) => candidate.generation === 0 && candidate.originRoot === "b0");
  const s0Roots = artifact.candidates.filter((candidate) => candidate.generation === 0 && candidate.originRoot === "s0");
  const intakeTrack = (artifact.u1Intake as Record<string, unknown>).track;
  const intakeS0SkillSha256 = (artifact.u1Intake as Record<string, unknown>).s0SkillSha256;
  if (
    (intakeTrack !== "b0-repair" && intakeTrack !== "s0-rebuild") ||
    bindings.expectedU1Intake.track !== intakeTrack
  ) {
    resumeFail("RESUME_ADAPTIVE_B0_DRIFT", "the frozen U1 intake track differs from the current routed input");
  }
  const b0CandidateMatches = intakeTrack === "s0-rebuild"
    ? b0Roots.length === 0
    : b0Roots.length === 1 && sha256Hex(b0Roots[0].skillMd) === expectedB0Hash;
  if (
    !b0CandidateMatches ||
    artifact.u1Intake.b0EvidenceSha256 !== expectedB0Hash ||
    (
      bindings.expectedU1Intake.b0EvidenceSha256 !== artifact.u1Intake.b0EvidenceSha256
    )
  ) {
    resumeFail("RESUME_ADAPTIVE_B0_DRIFT", "the frozen B0, U1 intake, and generation-zero B0 candidate are not byte-identical");
  }
  if (
    (intakeTrack === "s0-rebuild" && intakeS0SkillSha256 !== expectedS0Hash) ||
    (
      bindings.expectedU1Intake.s0SkillSha256 !== undefined &&
      (
        bindings.expectedU1Intake.s0SkillSha256 !== expectedS0Hash ||
        intakeS0SkillSha256 !== bindings.expectedU1Intake.s0SkillSha256
      )
    )
  ) {
    resumeFail("RESUME_ADAPTIVE_S0_DRIFT", "the frozen U1 intake S0 hash differs from the current bootstrap S0");
  }
  const s0CandidateMatches = intakeTrack === "s0-rebuild"
    ? s0Roots.length === 2 && s0Roots.every((candidate) => sha256Hex(candidate.skillMd) === expectedS0Hash)
    : s0Roots.length === 1 && sha256Hex(s0Roots[0].skillMd) === expectedS0Hash;
  if (!s0CandidateMatches) {
    resumeFail("RESUME_ADAPTIVE_S0_DRIFT", "the current bootstrap S0 differs from the generation-zero S0 candidate");
  }

  const runStarts = artifact.events.filter((event) => event.type === "run_start") as Array<Record<string, unknown>>;
  if (runStarts.length !== 1 || runStarts[0].contractSha256 !== bindings.contractSha256) {
    resumeFail("RESUME_ADAPTIVE_CONTRACT_DRIFT", "the Adaptive run_start event is missing, ambiguous, or bound to another contract");
  }
  const currentPublicItemIds = bindings.currentTrainItems.map((item) => item.itemId);
  if (
    currentPublicItemIds.length !== bindings.currentTrainItemIds.length ||
    currentPublicItemIds.some((itemId, index) => itemId !== bindings.currentTrainItemIds[index])
  ) {
    resumeFail("RESUME_ADAPTIVE_TRAIN_DRIFT", "the current frozen public objects and item-id binding disagree");
  }
  const expectedPinnedItemIds = selectBootstrapSlice([...bindings.currentTrainItems]).map((item) => item.itemId);
  const pinsUnique = new Set(artifact.pinnedItemIds);
  const currentTrainIds = new Set(currentPublicItemIds);
  if (
    pinsUnique.size !== artifact.pinnedItemIds.length ||
    artifact.pinnedItemIds.some((itemId) => !currentTrainIds.has(itemId))
  ) {
    resumeFail("RESUME_ADAPTIVE_TRAIN_DRIFT", "the pinned Adaptive items are not a unique subset of the current public-train contract");
  }
  if (
    artifact.pinnedItemIds.length !== expectedPinnedItemIds.length ||
    artifact.pinnedItemIds.some((itemId, index) => itemId !== expectedPinnedItemIds[index])
  ) {
    resumeFail(
      "RESUME_ADAPTIVE_TRAIN_DRIFT",
      "the Adaptive pinned items do not exactly match the slice recomputed from the current frozen public inputs",
    );
  }
  if (stableStringify(artifact.publicContract) !== stableStringify(bindings.publicContract)) {
    resumeFail("RESUME_ADAPTIVE_PUBLIC_CONTRACT_DRIFT", "the Adaptive public-train metadata differs from the current frozen inputs");
  }

  const evidenceMatches =
    artifact.confirmationMode === bindings.confirmationMode &&
    artifact.evidence.confirmationMode === bindings.confirmationMode &&
    artifact.evidence.explorationOnly === artifact.explorationOnly &&
    artifact.evidence.humanConfirmationBypassed === artifact.humanConfirmationBypassed &&
    artifact.formalEvidence === true &&
    artifact.humanConfirmationBypassed === false;
  if (!evidenceMatches) {
    resumeFail("RESUME_ADAPTIVE_EVIDENCE_DRIFT", "the Adaptive evidence mode is inconsistent with the current human-confirmation gate mode");
  }
  if (
    artifact.liveRun.provider.model !== bindings.providerModel ||
    !bindings.acceptedEvaluatorConfigFingerprints.includes(artifact.liveRun.provider.configFingerprint)
  ) {
    resumeFail("RESUME_ADAPTIVE_PROVIDER_DRIFT", "the current evaluator provider configuration differs from the Adaptive evidence");
  }

  return {
    adaptiveResultSha256: actualHash,
    result: decoded as AdaptiveRunResult,
  };
}

export const PublicSelectionFailureArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  semanticResponseBindingVersion: z.literal(SEMANTIC_RESPONSE_BINDING_VERSION),
  status: z.literal("failed"),
  phase: z.literal("public-select"),
  feedbackToEvolution: z.literal(false),
  adaptiveResultSha256: Sha256Schema,
  contractSha256: Sha256Schema,
  selectItemsSha256: Sha256Schema,
  safeError: z.object({ code: z.string().min(1), message: z.string().min(1).optional() }).passthrough(),
  scenarioEnvelopeExhaustion: ScenarioEnvelopeExhaustionArtifactSchema.optional(),
  dynamicEnvelopeExhaustion: DynamicEnvelopeExhaustionEvidenceSchema.optional(),
  budget: z.object({
    minimum: z.number().int().min(1),
    authorized: z.number().int().min(1),
    assumptions: StageBudgetAssumptionsEvidenceSchema,
    envelope: CallEnvelopeEvidenceSchema,
  }).passthrough(),
  accounting: z.object({
    logicalCalls: z.number().int().min(0),
    httpAttempts: z.number().int().min(0),
    retryAttempts: z.number().int().min(0),
  }).passthrough(),
  providerTokenTelemetry: ProviderTokenTelemetryEvidenceSchema,
  actualApplicationRecoveryAttempts: z.number().int().min(0),
  structureRecoveryDiagnostics: z.array(PublicSelectionStructureRecoveryDiagnosticEvidenceSchema),
  provider: z.object({
    name: z.literal("deepseek"),
    model: z.string().min(1),
    evaluatorConfigFingerprint: ProviderFingerprintSchema,
    semanticJudgeConfigFingerprint: ProviderFingerprintSchema,
  }).strict(),
  confirmationMode: z.literal("human"),
  explorationOnly: z.literal(false),
  humanConfirmationBypassed: z.literal(false),
  formalEvidence: z.literal(true),
  releaseAllowed: z.literal(false),
  sealedAllowed: z.literal(false),
  holdout: z.literal("sealed"),
  release: z.string().regex(/withheld/i),
}).passthrough().superRefine((value, ctx) => {
  rejectRetiredProtocolFields(value, ctx);
  if (
    !value.providerTokenTelemetry?.byStageRoleModel ||
    value.releaseAllowed !== false ||
    value.sealedAllowed !== false
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "current public-select failure requires complete identity, B/M/H, telemetry, and evidence bindings",
      path: ["budget"],
    });
    return;
  }
  const plan = calculateStageBudgets(value.budget.assumptions);
  const expectedEnvelope = plan.envelope.publicSelect;
  const persistedEnvelope = value.budget.envelope;
  if (
    !callEnvelopesEqual(persistedEnvelope, expectedEnvelope) ||
    value.budget.minimum !== persistedEnvelope.baselineEstimate ||
    value.budget.authorized !== persistedEnvelope.authorizedLogicalCalls ||
    value.accounting.logicalCalls > persistedEnvelope.authorizedLogicalCalls ||
    value.accounting.httpAttempts !== value.accounting.logicalCalls + value.accounting.retryAttempts
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "current public-select failure must reproduce its shared B/M/H plan and exact accounting",
      path: ["budget"],
    });
  }
  validatePublicSelectionSemanticRecovery(
    value,
    persistedEnvelope.existingRecoveryReserve,
    false,
    ctx,
  );
  if (value.safeError?.code === "DYNAMIC_ENVELOPE_EXHAUSTED") {
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
        message: "dynamic public-select exhaustion requires exact sanitized B/M/H evidence",
        path: ["dynamicEnvelopeExhaustion"],
      });
    }
  } else if (value.dynamicEnvelopeExhaustion) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "non-dynamic public-select failure cannot carry dynamic exhaustion evidence",
      path: ["dynamicEnvelopeExhaustion"],
    });
  }
  const safeCode = value.safeError?.code;
  if (safeCode === "SCENARIO_ENVELOPE_UNDERESTIMATED" || safeCode === "SCENARIO_ENVELOPE_EXHAUSTED_UNCLASSIFIED") {
    if (!value.scenarioEnvelopeExhaustion || value.scenarioEnvelopeExhaustion.code !== safeCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "public-select envelope failure requires matching sanitized attempt evidence",
        path: ["scenarioEnvelopeExhaustion"],
      });
    }
  } else if (value.scenarioEnvelopeExhaustion) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "non-envelope public-select failure must not carry scenario exhaustion evidence",
      path: ["scenarioEnvelopeExhaustion"],
    });
  }
});

/** Accept only a current, feedback-free failure bound to this Adaptive run. */
export function validatePublicSelectionFailureForResume(
  raw: string,
  adaptiveResultSha256: string,
  expected: {
    contractSha256: string;
    selectItemsSha256: string;
    providerModel: string;
    confirmationMode: "human";
  },
): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    resumeFail("RESUME_PUBLIC_SELECTION_FAILURE_INVALID", "public-selection-failure.json is not valid JSON");
  }
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    Array.isArray(decoded) ||
    (decoded as Record<string, unknown>).semanticResponseBindingVersion !== SEMANTIC_RESPONSE_BINDING_VERSION
  ) {
    resumeFail(
      "RESUME_PUBLIC_SELECTION_SEMANTIC_BINDING_DRIFT",
      `public-selection-failure.json must use semantic response binding ${SEMANTIC_RESPONSE_BINDING_VERSION}`,
    );
  }
  const parsed = PublicSelectionFailureArtifactSchema.safeParse(decoded);
  if (!parsed.success) {
    resumeFail("RESUME_PUBLIC_SELECTION_FAILURE_INVALID", "the prior failure is not a terminal public-select failure with feedback disabled");
  }
  if (
    parsed.data.adaptiveResultSha256 !== adaptiveResultSha256
  ) {
    resumeFail("RESUME_PUBLIC_SELECTION_FAILURE_DRIFT", "the prior public-select failure is bound to another Adaptive artifact");
  }
  if (
    parsed.data.contractSha256 !== expected.contractSha256 ||
    parsed.data.selectItemsSha256 !== expected.selectItemsSha256 ||
    parsed.data.provider?.model !== expected.providerModel ||
    parsed.data.confirmationMode !== expected.confirmationMode
  ) {
    resumeFail(
      "RESUME_PUBLIC_SELECTION_FAILURE_IDENTITY_DRIFT",
      "public-selection failure contract, split, model, or confirmation identity drifted",
    );
  }
}

const SafeGateResultSchema = z.object({
  gateId: z.string().min(1),
  category: z.enum(["safety", "quality"]),
  passed: z.boolean(),
}).strict();

const SafeItemScoreSchema = z.object({
  itemId: z.string().min(1),
  score: z.number().min(0).max(100),
  passed: z.boolean(),
  criticalFailure: z.boolean(),
}).strict();

const SafeCandidateEvaluationSchema = z.object({
  candidateId: z.string().min(1),
  rootKind: z.enum(["b0", "s0", "evolved"]),
  skillSha256: Sha256Schema,
  weightedMean: z.number().min(0).max(100),
  comparisonEligible: z.boolean(),
  championEligible: z.boolean(),
  releaseEligible: z.literal(false),
  everyGatePassed: z.boolean(),
  criticalRegression: z.boolean(),
  criticalRegressionItemIds: z.array(z.string().min(1)),
  gateResults: z.array(SafeGateResultSchema),
  itemScores: z.array(SafeItemScoreSchema),
  answerHashes: z.array(z.object({
    itemId: z.string().min(1),
    answerSha256: Sha256Schema,
  }).strict()),
  dimensionScores: z.object({
    task_correctness: z.number().min(0).max(100),
    evidence_boundary: z.number().min(0).max(100),
    capability_boundary: z.number().min(0).max(100),
    output_structure: z.number().min(0).max(100),
    actionability: z.number().min(0).max(100),
  }).strict(),
  protectedDimensionRegression: z.boolean(),
  protectedDimensionRegressions: z.array(z.enum([
    "task_correctness",
    "evidence_boundary",
    "capability_boundary",
    "output_structure",
    "actionability",
  ])),
}).strict();

const PublicSelectionDecisionSchema = z.object({
  startingReferenceId: z.string().min(1).nullable(),
  finalPublicChampionId: z.string().min(1).nullable(),
  verdict: z.enum(["clear_improvement", "candidate_rejected", "start_reference_retained", "not_comparable"]),
  reasonCode: z.enum(["no_safe_candidate", "no_comparison_baseline"]).optional(),
  comparisonEligible: z.boolean(),
  championEligible: z.boolean(),
  releaseEligible: z.literal(false),
  scoreDelta: z.number().finite(),
  criticalRegression: z.boolean(),
  protectedDimensionRegression: z.boolean(),
  protectedDimensionRegressions: z.array(z.enum([
    "task_correctness",
    "evidence_boundary",
    "capability_boundary",
    "output_structure",
    "actionability",
  ])),
  sameModelLimitation: z.string().min(1),
}).strict();

const SafeTerminalPublicSelectionBaseSchema = z.object({
  shortlistCandidateIds: z.array(z.string().min(1)),
  candidateEvaluations: z.array(SafeCandidateEvaluationSchema),
  decision: PublicSelectionDecisionSchema,
  scoringIdentity: U1ScoringIdentitySchema,
}).strict();

function exactStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length &&
    new Set(right).size === right.length && left.every((value) => right.includes(value));
}

export const SafeTerminalPublicSelectionSchema = SafeTerminalPublicSelectionBaseSchema.superRefine((value, ctx) => {
  const candidateIds = value.candidateEvaluations.map((candidate) => candidate.candidateId);
  if (value.shortlistCandidateIds.length === 0 || !exactStringSet(value.shortlistCandidateIds, candidateIds)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidateEvaluations"],
      message: "public-selection shortlist and candidate evaluations must be the same non-empty unique id set",
    });
  }
  for (const [index, candidate] of value.candidateEvaluations.entries()) {
    const gatePass = candidate.gateResults.every((gate) => gate.passed);
    if (candidate.everyGatePassed !== gatePass) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidateEvaluations", index, "everyGatePassed"],
        message: "candidate everyGatePassed must equal its persisted gate results",
      });
    }
    if (candidate.championEligible && (!candidate.comparisonEligible || !gatePass || candidate.criticalRegression)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidateEvaluations", index, "championEligible"],
        message: "champion eligibility requires comparison eligibility, every gate, and no critical regression",
      });
    }
    const itemIds = candidate.itemScores.map((item) => item.itemId);
    const answerIds = candidate.answerHashes.map((item) => item.itemId);
    if (!exactStringSet(itemIds, answerIds)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidateEvaluations", index, "answerHashes"],
        message: "candidate answer hashes must cover the exact scored item id set",
      });
    }
  }
  const decision = value.decision;
  if (decision.verdict === "not_comparable") {
    if (
      decision.startingReferenceId !== null || decision.finalPublicChampionId !== null ||
      decision.reasonCode !== "no_comparison_baseline"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision"],
        message: "not_comparable must name no fabricated baseline or champion",
      });
    }
    return;
  }
  const starting = value.candidateEvaluations.find((candidate) => candidate.candidateId === decision.startingReferenceId);
  const final = value.candidateEvaluations.find((candidate) => candidate.candidateId === decision.finalPublicChampionId);
  if (
    !starting || !final ||
    (starting.rootKind !== "b0" && starting.rootKind !== "s0") ||
    !starting.comparisonEligible
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["decision"],
      message: "public-selection decision ids must resolve to one comparison-eligible root baseline and one evaluated final candidate",
    });
  }
});
export type SafeTerminalPublicSelection = z.infer<typeof SafeTerminalPublicSelectionSchema>;

/** Remove task text, model answers, prompts, and every free-form judge reason. */
export function sanitizeTerminalPublicSelection(result: TerminalPublicSelectionResult): SafeTerminalPublicSelection {
  return SafeTerminalPublicSelectionSchema.parse({
    shortlistCandidateIds: result.shortlistCandidateIds,
    candidateEvaluations: result.candidateEvaluations.map((candidate) => ({
      candidateId: candidate.candidateId,
      rootKind: candidate.rootKind,
      skillSha256: candidate.skillSha256,
      weightedMean: candidate.weightedMean,
      comparisonEligible: candidate.comparisonEligible,
      championEligible: candidate.championEligible,
      releaseEligible: false,
      everyGatePassed: candidate.everyGatePassed,
      criticalRegression: candidate.criticalRegression,
      criticalRegressionItemIds: candidate.criticalRegressionItemIds,
      gateResults: candidate.gateResults.map((gate) => ({
        gateId: gate.gateId,
        category: gate.category,
        passed: gate.passed,
      })),
      itemScores: candidate.itemScores.map((item) => ({
        itemId: item.itemId,
        score: item.score,
        passed: item.passed as boolean,
        criticalFailure: item.criticalFailure as boolean,
      })),
      answerHashes: candidate.answerHashes,
      dimensionScores: candidate.dimensionScores,
      protectedDimensionRegression: candidate.protectedDimensionRegression,
      protectedDimensionRegressions: candidate.protectedDimensionRegressions,
    })),
    decision: result.decision,
    scoringIdentity: result.scoringIdentity,
  });
}

export const PublicSelectionResultArtifactSchema = z.object({
  schemaVersion: z.literal(2),
  semanticResponseBindingVersion: z.literal(SEMANTIC_RESPONSE_BINDING_VERSION),
  createdAt: z.string().datetime(),
  status: z.literal("completed"),
  phase: z.literal("public-select"),
  adaptiveResultSha256: Sha256Schema,
  contractSha256: Sha256Schema,
  selectItemsSha256: Sha256Schema,
  selection: SafeTerminalPublicSelectionSchema,
  budget: z.object({
    minimum: z.number().int().min(1),
    authorized: z.number().int().min(1),
    independent: z.literal(true),
    assumptions: StageBudgetAssumptionsEvidenceSchema,
    envelope: CallEnvelopeEvidenceSchema,
  }).passthrough(),
  accounting: z.object({
    logicalCalls: z.number().int().min(0),
    httpAttempts: z.number().int().min(0),
    retryAttempts: z.number().int().min(0),
  }).passthrough(),
  provider: z.object({
    name: z.literal("deepseek"),
    model: z.string().min(1),
    evaluatorConfigFingerprint: ProviderFingerprintSchema,
    semanticJudgeConfigFingerprint: ProviderFingerprintSchema,
  }),
  applicationRecovery: z.array(ApplicationRecoverySummarySchema),
  actualApplicationRecoveryAttempts: z.number().int().min(0),
  structureRecoveryDiagnostics: z.array(PublicSelectionStructureRecoveryDiagnosticEvidenceSchema),
  providerTokenTelemetry: ProviderTokenTelemetryEvidenceSchema,
  resumeEvidence: z.object({
    mode: z.enum(["public-select-only", "terminal-after-adaptive"]),
    adaptiveCalls: z.literal(0),
    adaptiveArtifactPreserved: z.literal(true),
  }),
  confirmationMode: z.literal("human"),
  explorationOnly: z.literal(false),
  humanConfirmationBypassed: z.literal(false),
  formalEvidence: z.literal(true),
  releaseAllowed: z.literal(false),
  sealedAllowed: z.literal(false),
  feedbackToEvolution: z.literal(false),
  holdout: z.literal("sealed"),
  release: z.string().regex(/withheld/i),
}).passthrough().superRefine((value, ctx) => {
  rejectRetiredProtocolFields(value, ctx);
  const expected = calculateStageBudgets(value.budget.assumptions).envelope.publicSelect;
  if (
    !callEnvelopesEqual(value.budget.envelope, expected) ||
    value.budget.minimum !== value.budget.envelope.baselineEstimate ||
    value.budget.authorized !== value.budget.envelope.authorizedLogicalCalls
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "public-select B/M/H evidence differs from the shared stage-budget calculation",
      path: ["budget"],
    });
  }
  if (
    value.accounting.logicalCalls < 1 ||
    value.accounting.logicalCalls > value.budget.envelope.authorizedLogicalCalls ||
    value.accounting.httpAttempts !== value.accounting.logicalCalls + value.accounting.retryAttempts
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "public-select observed accounting must stay within H and preserve HTTP/transport-retry accounting",
      path: ["accounting"],
    });
  }
  if (!value.providerTokenTelemetry.byStageRoleModel) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "current public-select evidence requires detailed stage/role/model token telemetry",
      path: ["providerTokenTelemetry"],
    });
  }
  if (value.applicationRecovery) {
    const identities = new Set<string>();
    for (const [index, recovery] of value.applicationRecovery.entries()) {
      const identity = `${recovery.candidateId}\u0000${recovery.itemId}`;
      if (identities.has(identity)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "public-select application recovery summaries must be unique by candidate and item",
          path: ["applicationRecovery", index],
        });
      }
      identities.add(identity);
    }
    if (value.budget.assumptions && value.budget.envelope) {
      const representativeCandidateIds: string[] = [];
      const seenSkillHashes = new Set<string>();
      for (const candidate of value.selection.candidateEvaluations) {
        if (!seenSkillHashes.has(candidate.skillSha256)) {
          seenSkillHashes.add(candidate.skillSha256);
          representativeCandidateIds.push(candidate.candidateId);
        }
      }
      const expectedItemIds =
        value.selection.candidateEvaluations[0]?.itemScores.map((item) => item.itemId) ?? [];
      const expectedRecoveryKeys = new Set(
        representativeCandidateIds.flatMap((candidateId) =>
          expectedItemIds.map((itemId) => `${candidateId}\u0000${itemId}`)
        ),
      );
      const scenario = value.budget.envelope.scenarioAuthorization;
      if (
        representativeCandidateIds.length !== value.budget.assumptions.shortlistCandidates ||
        expectedItemIds.length !== value.budget.assumptions.selectItems ||
        identities.size !== expectedRecoveryKeys.size ||
        [...identities].some((identity) => !expectedRecoveryKeys.has(identity))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "current public-select application evidence must cover every unique candidate/item scenario exactly once",
          path: ["applicationRecovery"],
        });
      }
      for (const [index, recovery] of value.applicationRecovery.entries()) {
        if (
          recovery.role !== "public-select" ||
          recovery.rawScenarioEstimate !== scenario.rawScenarioEstimate ||
          recovery.callEnvelopeMultiplier !== scenario.callEnvelopeMultiplier ||
          recovery.authorizedModelCallsPerAttempt !== scenario.authorizedModelCallsPerAttempt ||
          recovery.maxApplicationAttempts !== scenario.maxApplicationAttempts ||
          recovery.scenarioRetryReserve !== scenario.scenarioRetryReserve
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "public-select application summary drifted from the stage scenario authorization",
            path: ["applicationRecovery", index],
          });
        }
      }
    }
  }
  {
    const b0Roots = value.selection.candidateEvaluations.filter((candidate) => candidate.rootKind === "b0");
    const s0Roots = value.selection.candidateEvaluations.filter((candidate) => candidate.rootKind === "s0");
    if (b0Roots.length !== 1 || s0Roots.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "public-selection v2 requires exactly one B0 and one S0 root",
        path: ["selection", "candidateEvaluations"],
      });
    }
    const expectedItemIds = value.selection.candidateEvaluations[0]?.itemScores.map((item) => item.itemId) ?? [];
    if (expectedItemIds.length === 0 || new Set(expectedItemIds).size !== expectedItemIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "public-selection v2 requires a non-empty unique evaluated item set",
        path: ["selection", "candidateEvaluations", 0, "itemScores"],
      });
    }
    for (const [index, candidate] of value.selection.candidateEvaluations.entries()) {
      const gatePass = candidate.gateResults.every((gate) => gate.passed);
      const gateIds = candidate.gateResults.map((gate) => gate.gateId);
      if (gateIds.length === 0 || new Set(gateIds).size !== gateIds.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "public-selection v2 requires a non-empty unique gate result set",
          path: ["selection", "candidateEvaluations", index, "gateResults"],
        });
      }
      const safetyGates = candidate.gateResults.filter((gate) => gate.category === "safety");
      const safetyGatePass = safetyGates.length > 0 && safetyGates.every((gate) => gate.passed);
      if (candidate.comparisonEligible === true && safetyGates.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "public-selection v2 comparison eligibility requires explicit candidate safety-gate evidence",
          path: ["selection", "candidateEvaluations", index, "comparisonEligible"],
        });
      }
      if (candidate.comparisonEligible === true && !safetyGatePass) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "public-selection v2 comparison eligibility requires every candidate safety gate to pass",
          path: ["selection", "candidateEvaluations", index, "comparisonEligible"],
        });
      }
      const expectedChampionEligibility = projectU1ChampionEligibility({
        comparisonEligible: candidate.comparisonEligible === true,
        everyGatePassed: gatePass,
        itemScores: candidate.itemScores,
        criticalRegression: candidate.criticalRegression,
      });
      if (candidate.championEligible !== expectedChampionEligibility) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "public-selection v2 champion eligibility must equal comparison eligibility plus all gates, no critical item failure, and no critical regression",
          path: ["selection", "candidateEvaluations", index, "championEligible"],
        });
      }
      if (candidate.rootKind === "evolved") {
        const criticalIds = candidate.criticalRegressionItemIds;
        const protectedIds = candidate.protectedDimensionRegressions;
        const itemIds = candidate.itemScores.map((item) => item.itemId);
        if (
          new Set(criticalIds).size !== criticalIds.length ||
          criticalIds.some((itemId) => !itemIds.includes(itemId)) ||
          candidate.criticalRegression !== (criticalIds.length > 0)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "current critical-regression flag, ids, and evaluated items must agree",
            path: ["selection", "candidateEvaluations", index, "criticalRegressionItemIds"],
          });
        }
        if (
          new Set(protectedIds).size !== protectedIds.length ||
          candidate.protectedDimensionRegression !== (protectedIds.length > 0)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "current protected-dimension regression flag and ids must agree",
            path: ["selection", "candidateEvaluations", index, "protectedDimensionRegressions"],
          });
        }
      }
      if (!exactStringSet(candidate.itemScores.map((item) => item.itemId), expectedItemIds)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "public-selection v2 candidates must cover the same exact evaluated item set",
          path: ["selection", "candidateEvaluations", index, "itemScores"],
        });
      }
    }
    const decision = value.selection.decision;
    if (decision.verdict === "not_comparable") {
      if (decision.comparisonEligible !== false || decision.championEligible !== false) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "not_comparable cannot claim comparison or champion eligibility",
          path: ["selection", "decision"],
        });
      }
      if ([...b0Roots, ...s0Roots].some((candidate) => candidate.comparisonEligible === true)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "not_comparable requires both generation-zero roots to be comparison-ineligible",
          path: ["selection", "decision", "verdict"],
        });
      }
    } else {
      const starting = value.selection.candidateEvaluations.find(
        (candidate) => candidate.candidateId === decision.startingReferenceId,
      );
      const final = value.selection.candidateEvaluations.find(
        (candidate) => candidate.candidateId === decision.finalPublicChampionId,
      );
      if (
        !final ||
        decision.comparisonEligible !== final.comparisonEligible ||
        decision.championEligible !== final.championEligible
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "public-selection decision eligibility must match the resolved final candidate",
          path: ["selection", "decision"],
        });
      }
      const b0 = b0Roots[0];
      const s0 = s0Roots[0];
      const expectedStarting = b0 && s0
        ? b0.comparisonEligible === true && s0.comparisonEligible === true
          ? (s0.weightedMean > b0.weightedMean ? s0 : b0)
          : b0.comparisonEligible === true
            ? b0
            : s0.comparisonEligible === true
              ? s0
              : undefined
        : undefined;
      if (!starting || starting.comparisonEligible !== true || expectedStarting?.candidateId !== starting.candidateId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "public-selection v2 starting reference must be the higher comparison-eligible root, with exact ties retaining B0",
          path: ["selection", "decision", "startingReferenceId"],
        });
      }
      let eligibleChallenger: (typeof value.selection.candidateEvaluations)[number] | undefined;
      let challenger: (typeof value.selection.candidateEvaluations)[number] | undefined;
      if (starting) {
        const evolved = value.selection.candidateEvaluations.filter(
          (candidate) =>
            candidate.rootKind === "evolved" &&
            candidate.comparisonEligible === true &&
            candidate.skillSha256 !== starting.skillSha256,
        );
        const uniqueByHash = new Map<string, (typeof evolved)[number]>();
        for (const candidate of evolved) {
          const existing = uniqueByHash.get(candidate.skillSha256);
          if (
            !existing ||
            candidate.weightedMean > existing.weightedMean ||
            (
              candidate.weightedMean === existing.weightedMean &&
              candidate.skillSha256.localeCompare(existing.skillSha256) < 0
            )
          ) {
            uniqueByHash.set(candidate.skillSha256, candidate);
          }
        }
        const novel = [...uniqueByHash.values()];
        const eligible = novel.filter((candidate) => candidate.championEligible === true);
        eligibleChallenger = [...eligible].sort(
          (left, right) =>
            right.weightedMean - left.weightedMean ||
            left.skillSha256.localeCompare(right.skillSha256),
        )[0];
        challenger = eligibleChallenger ?? [...novel].sort(
          (left, right) =>
            right.weightedMean - left.weightedMean ||
            left.skillSha256.localeCompare(right.skillSha256),
        )[0];
        if (decision.criticalRegression !== (challenger?.criticalRegression ?? false)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "current public decision critical regression must match the selected challenger",
            path: ["selection", "decision", "criticalRegression"],
          });
        }
        const decisionProtected = decision.protectedDimensionRegressions;
        if (
          new Set(decisionProtected).size !== decisionProtected.length ||
          Boolean(decision.protectedDimensionRegression) !== (decisionProtected.length > 0)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "current public decision protected regression flag and ids must agree",
            path: ["selection", "decision", "protectedDimensionRegressions"],
          });
        }
        if (challenger && !exactStringSet(decisionProtected, challenger.protectedDimensionRegressions)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "current terminal decision must preserve the selected challenger's protected-dimension diagnostics",
            path: ["selection", "decision", "protectedDimensionRegressions"],
          });
        }
        for (const [candidateIndex, candidate] of value.selection.candidateEvaluations.entries()) {
          if (candidate.rootKind !== "evolved") continue;
          const expectedCriticalIds = candidate.itemScores
            .filter((item) => {
              const before = starting.itemScores.find((entry) => entry.itemId === item.itemId);
              return before?.criticalFailure !== true && item.criticalFailure === true;
            })
            .map((item) => item.itemId)
            .sort();
          if (!exactStringSet(candidate.criticalRegressionItemIds, expectedCriticalIds)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "current evolved candidate critical regression ids must be recomputable from item evidence",
              path: ["selection", "candidateEvaluations", candidateIndex, "criticalRegressionItemIds"],
            });
          }
          for (const dimension of candidate.protectedDimensionRegressions) {
            if (candidate.dimensionScores[dimension] >= starting.dimensionScores[dimension]) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "persisted protected-dimension diagnostics must identify an actual decline",
                path: ["selection", "candidateEvaluations", candidateIndex, "protectedDimensionRegressions"],
              });
            }
          }
        }
      }
      if (!eligibleChallenger && decision.championEligible === false && decision.reasonCode !== "no_safe_candidate") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a retained comparison baseline without a champion requires no_safe_candidate",
          path: ["selection", "decision", "reasonCode"],
        });
      }
      if ((eligibleChallenger || decision.championEligible === true) && decision.reasonCode !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a champion-eligible final candidate must not claim a no-candidate reason",
          path: ["selection", "decision", "reasonCode"],
        });
      }
      if (!challenger && decision.verdict !== "start_reference_retained") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "no novel challenger must retain the Starting Reference",
          path: ["selection", "decision", "verdict"],
        });
      }
      if (challenger && !eligibleChallenger) {
        const expectedVerdict = starting?.championEligible === true
          ? "candidate_rejected"
          : "start_reference_retained";
        if (decision.verdict !== expectedVerdict) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "an ineligible novel challenger must use the current rejection semantics",
            path: ["selection", "decision", "verdict"],
          });
        }
      }
      const expectedScoreDelta = starting && challenger
        ? Math.round((challenger.weightedMean - starting.weightedMean) * 100) / 100
        : 0;
      if (decision.scoreDelta !== expectedScoreDelta) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "public decision score delta must be recomputable from the selected challenger",
          path: ["selection", "decision", "scoreDelta"],
        });
      }
      const eligibleDelta = starting && eligibleChallenger
        ? Math.round((eligibleChallenger.weightedMean - starting.weightedMean) * 100) / 100
        : null;
      if (decision.verdict === "clear_improvement") {
        if (
          !starting || !final || !eligibleChallenger ||
          final.candidateId !== eligibleChallenger.candidateId ||
          final.candidateId === starting.candidateId || final.championEligible !== true ||
          eligibleDelta === null || eligibleDelta < 3 || decision.scoreDelta !== eligibleDelta
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "clear improvement requires the best distinct champion-eligible candidate and a score delta of at least 3",
            path: ["selection", "decision", "verdict"],
          });
        }
      } else if (starting && final && final.candidateId !== starting.candidateId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a non-improvement verdict must retain the comparison baseline as its final id",
          path: ["selection", "decision", "finalPublicChampionId"],
        });
      }
      if (eligibleChallenger && eligibleDelta !== null && eligibleDelta >= 3 && decision.verdict !== "clear_improvement") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a best qualified challenger with score delta at least 3 must be a clear improvement",
          path: ["selection", "decision", "verdict"],
        });
      }
      if (eligibleChallenger && eligibleDelta !== null && eligibleDelta < 3 && decision.verdict !== "start_reference_retained") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a qualified challenger below the score-delta threshold must retain the Starting Reference",
          path: ["selection", "decision", "verdict"],
        });
      }
    }
  }
  if (value.selection.scoringIdentity.contractSha256 !== value.contractSha256) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "public-selection scoring identity must match contractSha256",
      path: ["selection", "scoringIdentity"],
    });
  }
  validatePublicSelectionSemanticRecovery(
    value,
    value.budget.envelope.existingRecoveryReserve,
    true,
    ctx,
  );
});
export type PublicSelectionResultArtifact = z.infer<typeof PublicSelectionResultArtifactSchema>;
