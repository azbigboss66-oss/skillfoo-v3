import { z } from "zod";
import { sha256Hex } from "../runtime/capabilityAdapter.js";
import {
  callEnvelopesEqual,
  calculateStageBudgets,
} from "../providers/stageBudgets.js";
import {
  SEMANTIC_RESPONSE_BINDING_VERSION,
  U1_SCORING_PROFILE_VERSION,
  U1ScoringIdentitySchema,
  type EvaluationContractV3,
} from "../types.js";
import {
  aggregateU1DimensionScores,
  assertSameScoringIdentity,
  evaluateU1CandidateEligibility,
  evaluateU1TerminalCandidateAgainstStartingReference,
  projectU1ChampionEligibility,
  scoringIdentityOfContract,
} from "../evaluation/u1Rubric.js";
import type { AdaptiveEvaluation } from "./adaptiveRun.js";
import {
  DIRECT_U1_FROZEN_INSTRUCTION,
  DIRECT_U1_PROMPT_CONTRACT_SHA256,
  DIRECT_U1_PROMPT_CONTRACT_VERSION,
} from "./directBaseline.js";
import {
  ApplicationRecoverySafeSummarySchema,
  ApplicationRecoverySummarySchema,
  CallEnvelopeEvidenceSchema,
  DynamicEnvelopeExhaustionEvidenceSchema,
  ProviderTokenTelemetryEvidenceSchema,
  StageBudgetAssumptionsEvidenceSchema,
  StructureRecoveryDiagnosticEvidenceSchema,
  dynamicEnvelopeExhaustionMatches,
  type SafeTerminalPublicSelection,
} from "./publicSelectionResume.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const NonNegativeIntegerSchema = z.number().int().min(0);

const DirectStructureRecoveryDiagnosticEvidenceSchema = StructureRecoveryDiagnosticEvidenceSchema.refine(
  (value) => value.subject.kind === "stage" && value.subject.stage === "direct",
  "Direct recovery diagnostics must carry the direct stage subject",
);

function validateDirectSemanticRecovery(
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
      message: "Direct recovery count must equal rejected primaries and stay within its persisted reserve",
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
      message: "completed Direct evidence cannot contain a rejected repair and failure may contain only the terminal rejected repair",
      path: ["structureRecoveryDiagnostics"],
    });
  }
}

const DirectEvidenceFlagsSchema = z.object({
  confirmationMode: z.literal("human"),
  explorationOnly: z.literal(false),
  humanConfirmationBypassed: z.literal(false),
  formalEvidence: z.literal(true),
  releaseAllowed: z.literal(false),
  sealedAllowed: z.literal(false),
}).strict();
const DirectPromptContractEvidenceSchema = z.object({
  directPromptContractVersion: z.literal(DIRECT_U1_PROMPT_CONTRACT_VERSION),
  directPromptContractSha256: z.literal(DIRECT_U1_PROMPT_CONTRACT_SHA256),
}).strict();
const DirectSafeFindingSchema = z.object({
  code: z.enum(["network", "filesystem", "shell", "plugin", "dsh", "script", "reference", "external_action"]),
  kind: z.enum(["execution_instruction", "false_execution_claim"]),
  line: z.number().int().positive(),
  evidenceSha256: Sha256Schema,
  excerpt: z.literal("[redacted capability clause]"),
}).strict();
const DirectFailureCodeSchema = z.enum([
  "DIRECT_PUBLIC_BINDING_INVALID",
  "DIRECT_RUN_FAILED",
  "DIRECT_U1_BOUNDARY_VIOLATION",
  "DIRECT_U1_INVALID",
  "DIRECT_U1_INVALID_JSON",
  "DIRECT_U1_PROVIDER_FAILED",
  "DYNAMIC_ENVELOPE_EXHAUSTED",
  "PROVIDER_BUDGET_EXCEEDED",
  "PROVIDER_EMPTY_RESPONSE",
  "PROVIDER_HTTP_ERROR",
  "PROVIDER_NETWORK_ERROR",
  "PROVIDER_NO_CHOICES",
  "PROVIDER_NON_JSON_BODY",
  "PROVIDER_TIMEOUT",
  "PROVIDER_TRUNCATED_OUTPUT",
  "PROVIDER_UNSUPPORTED_SCHEMA",
  "SCENARIO_ENVELOPE_UNDERESTIMATED",
  "SCENARIO_ENVELOPE_EXHAUSTED_UNCLASSIFIED",
  "SEMANTIC_JUDGE_BATCH_SIZE_INVALID",
  "SEMANTIC_JUDGE_CONTEXT_MISSING",
  "SEMANTIC_JUDGE_DIMENSION_MISMATCH",
  "SEMANTIC_JUDGE_INVALID",
  "SEMANTIC_JUDGE_INVALID_JSON",
  "SEMANTIC_JUDGE_ITEM_MISMATCH",
  "SEMANTIC_JUDGE_OVERALL_REASON_INVALID",
  "SEMANTIC_JUDGE_PROVIDER_FAILED",
  "SEMANTIC_JUDGE_SPLIT_VIOLATION",
  "STAGE_BUDGET_EXCEEDED",
]);

const SafeDirectCandidateSchema = z.object({
  candidateId: z.literal("direct"),
  skillSha256: Sha256Schema,
  weightedMean: z.number().min(0).max(100),
  comparisonEligible: z.boolean(),
  championEligible: z.boolean(),
  releaseEligible: z.literal(false),
  everyGatePassed: z.boolean(),
  criticalRegression: z.boolean(),
  criticalRegressionItemIds: z.array(z.string().min(1)),
  gateResults: z.array(z.object({
    gateId: z.string().min(1),
    category: z.enum(["safety", "quality"]),
    passed: z.boolean(),
  }).strict()),
  itemScores: z.array(z.object({
    itemId: z.string().min(1),
    score: z.number().min(0).max(100),
    passed: z.boolean(),
    criticalFailure: z.boolean(),
    semanticRequestFingerprint: Sha256Schema.optional(),
  }).strict()),
  answerHashes: z.array(z.object({ itemId: z.string().min(1), answerSha256: Sha256Schema }).strict()),
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

const RelativeComparisonSchema = z.object({
  candidateId: z.string().min(1),
  baselineWeightedMean: z.number().min(0).max(100),
  scoreDelta: z.number().finite(),
  result: z.enum(["higher_public_score", "tied_public_score", "lower_public_score", "candidate_rejected"]),
}).strict();

export const SafeDirectPublicComparisonSchema = z.object({
  directCandidate: SafeDirectCandidateSchema,
  relativeToStarting: RelativeComparisonSchema,
  relativeToFinalPublicChampion: RelativeComparisonSchema,
  adaptivePublicDecision: z.object({
    startingReferenceId: z.string().min(1),
    finalPublicChampionId: z.string().min(1),
    verdict: z.enum(["clear_improvement", "candidate_rejected", "start_reference_retained"]),
  }).strict(),
  methodologicalNote: z.string().min(1),
  sameModelLimitation: z.string().min(1),
  scoringIdentity: U1ScoringIdentitySchema,
}).strict().superRefine((value, ctx) => {
  if (value.scoringIdentity.profileVersion !== U1_SCORING_PROFILE_VERSION) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Direct comparison requires the current scoring identity",
      path: ["scoringIdentity"],
    });
    return;
  }
  const candidate = value.directCandidate;
  const gatePass = candidate.gateResults.every((gate) => gate.passed);
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
      message: "current Direct critical-regression flag, ids, and item evidence must agree",
      path: ["directCandidate", "criticalRegressionItemIds"],
    });
  }
  if (
    new Set(protectedIds).size !== protectedIds.length ||
    candidate.protectedDimensionRegression !== (protectedIds.length > 0)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "current Direct protected-dimension regression flag and ids must agree",
      path: ["directCandidate", "protectedDimensionRegressions"],
    });
  }
  const expectedChampionEligibility = projectU1ChampionEligibility({
    comparisonEligible: candidate.comparisonEligible,
    everyGatePassed: gatePass,
    itemScores: candidate.itemScores,
    criticalRegression: candidate.criticalRegression,
  });
  if (
    candidate.everyGatePassed !== gatePass ||
    candidate.championEligible !== expectedChampionEligibility
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "current Direct terminal eligibility must equal comparison eligibility plus all gates, no critical item failure, and no critical regression",
      path: ["directCandidate", "championEligible"],
    });
  }
  for (const [key, relative] of [
    ["relativeToStarting", value.relativeToStarting],
    ["relativeToFinalPublicChampion", value.relativeToFinalPublicChampion],
  ] as const) {
    const expectedDelta = deltaOf(candidate.weightedMean, relative.baselineWeightedMean);
    const expectedResult = relativeResult(expectedDelta, candidate.championEligible);
    if (relative.scoreDelta !== expectedDelta || relative.result !== expectedResult) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "current Direct relative result must be recomputable from the terminal candidate",
        path: [key],
      });
    }
  }
});
export type SafeDirectPublicComparison = z.infer<typeof SafeDirectPublicComparisonSchema>;

export class DirectPublicComparisonError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "DirectPublicComparisonError";
  }
}

function deltaOf(value: number, baseline: number): number {
  return Math.round((value - baseline) * 100) / 100;
}

function relativeResult(scoreDelta: number, eligible: boolean): "higher_public_score" | "tied_public_score" | "lower_public_score" | "candidate_rejected" {
  if (!eligible) return "candidate_rejected";
  if (scoreDelta > 0) return "higher_public_score";
  if (scoreDelta < 0) return "lower_public_score";
  return "tied_public_score";
}

/** Build a score-and-gate comparison against the frozen public decision. */
export function buildSafeDirectPublicComparison(args: {
  directSkillMd: string;
  directEvaluation: AdaptiveEvaluation;
  directAnswerHashes: Array<{ itemId: string; answerSha256: string }>;
  selectItems: Array<{ itemId: string; critical: boolean }>;
  publicSelection: SafeTerminalPublicSelection;
  contract: EvaluationContractV3;
}): SafeDirectPublicComparison {
  if (
    args.publicSelection.decision.verdict === "not_comparable" ||
    args.publicSelection.decision.startingReferenceId === null ||
    args.publicSelection.decision.finalPublicChampionId === null
  ) {
    throw new DirectPublicComparisonError(
      "DIRECT_PUBLIC_BINDING_INVALID",
      "Direct comparison requires a real comparison-eligible public baseline; not_comparable cannot fabricate one",
    );
  }
  const scoringIdentity = scoringIdentityOfContract({ contract: args.contract });
  const scoringProfile = args.contract.scoringProfile;
  assertSameScoringIdentity(scoringIdentity, args.publicSelection.scoringIdentity, "Direct public comparison");
  const starting = args.publicSelection.candidateEvaluations.find(
    (candidate) => candidate.candidateId === args.publicSelection.decision.startingReferenceId,
  );
  const finalChampion = args.publicSelection.candidateEvaluations.find(
    (candidate) => candidate.candidateId === args.publicSelection.decision.finalPublicChampionId,
  );
  if (!starting || !finalChampion) {
    throw new DirectPublicComparisonError(
      "DIRECT_PUBLIC_BINDING_INVALID",
      "Starting Reference or Final Public Champion is absent from the bound public-selection evidence",
    );
  }
  const everyGatePassed = args.directEvaluation.gateResults.every((gate) => gate.passed);
  const directDimensionScores = aggregateU1DimensionScores(
    args.directEvaluation.itemScores ?? [],
    scoringProfile,
  );
  if (!starting.dimensionScores) {
    throw new DirectPublicComparisonError(
      "DIRECT_PUBLIC_BINDING_INVALID",
      "Direct and Starting Reference need complete frozen dimension aggregates",
    );
  }
  const currentEligibility = evaluateU1CandidateEligibility({
    expectedItemIds: args.selectItems.map((item) => item.itemId),
    itemScores: args.directEvaluation.itemScores ?? [],
    gateResults: args.directEvaluation.gateResults,
    criticalRegression: false,
  });
  const currentProjection = evaluateU1TerminalCandidateAgainstStartingReference({
    profile: scoringProfile,
    starting: {
      itemScores: starting.itemScores,
      dimensionScores: starting.dimensionScores,
    },
    challenger: {
      itemScores: args.directEvaluation.itemScores ?? [],
      dimensionScores: directDimensionScores,
      eligibility: currentEligibility,
    },
  });
  const criticalRegression = currentProjection.criticalRegression;
  const protectedDimensionRegressions = currentProjection.protectedDimensionRegressions;
  const comparisonEligible = currentEligibility.comparisonEligible;
  const championEligible = currentProjection.championEligible;
  const eligible = championEligible;
  const directScore = args.directEvaluation.publicScore;
  const startDelta = deltaOf(directScore, starting.weightedMean);
  const championDelta = deltaOf(directScore, finalChampion.weightedMean);
  const comparison = {
    directCandidate: {
      candidateId: "direct" as const,
      skillSha256: sha256Hex(args.directSkillMd),
      weightedMean: directScore,
      comparisonEligible,
      championEligible,
      releaseEligible: false as const,
      everyGatePassed,
      criticalRegression,
      criticalRegressionItemIds: currentProjection.criticalRegressionItemIds,
      gateResults: args.directEvaluation.gateResults.map((gate) => ({
        gateId: gate.gateId,
        category: gate.category,
        passed: gate.passed,
      })),
      itemScores: (args.directEvaluation.itemScores ?? []).map((item) => ({
        itemId: item.itemId,
        score: item.score,
        passed: item.passed,
        criticalFailure: item.criticalFailure,
        ...(item.evidence?.semantic.requestFingerprint
          ? { semanticRequestFingerprint: item.evidence.semantic.requestFingerprint }
          : {}),
      })),
      answerHashes: args.directAnswerHashes,
      dimensionScores: directDimensionScores,
      protectedDimensionRegression: protectedDimensionRegressions.length > 0,
      protectedDimensionRegressions,
    },
    relativeToStarting: {
      candidateId: starting.candidateId,
      baselineWeightedMean: starting.weightedMean,
      scoreDelta: startDelta,
      result: relativeResult(startDelta, eligible),
    },
    relativeToFinalPublicChampion: {
      candidateId: finalChampion.candidateId,
      baselineWeightedMean: finalChampion.weightedMean,
      scoreDelta: championDelta,
      result: relativeResult(championDelta, eligible),
    },
    adaptivePublicDecision: {
      startingReferenceId: args.publicSelection.decision.startingReferenceId,
      finalPublicChampionId: args.publicSelection.decision.finalPublicChampionId,
      verdict: args.publicSelection.decision.verdict,
    },
    methodologicalNote:
      "Direct is an independent generation baseline using the same frozen public-select items, deterministic gates, rubric and semantic configuration. Its score does not retroactively modify the frozen public decision.",
    sameModelLimitation: args.publicSelection.decision.sameModelLimitation,
    scoringIdentity,
  };
  return SafeDirectPublicComparisonSchema.parse(comparison);
}

const ScoredDirectResultArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  semanticResponseBindingVersion: z.literal(SEMANTIC_RESPONSE_BINDING_VERSION),
  createdAt: z.string().datetime(),
  status: z.literal("completed"),
  phase: z.literal("direct-public-select"),
  contractSha256: Sha256Schema,
  scoringIdentity: U1ScoringIdentitySchema,
  selectItemsSha256: Sha256Schema,
  adaptiveResultSha256: Sha256Schema,
  publicSelectionResultSha256: Sha256Schema,
  b0SkillSha256: Sha256Schema,
  directSource: z.object({
    kind: z.enum(["b0", "s0"]),
    skillSha256: Sha256Schema,
    track: z.enum(["b0-repair", "s0-rebuild"]),
  }).strict(),
  directInstructionSha256: z.literal(sha256Hex(DIRECT_U1_FROZEN_INSTRUCTION)),
  ...DirectPromptContractEvidenceSchema.shape,
  comparison: SafeDirectPublicComparisonSchema,
  budget: z.object({
    minimum: z.number().int().min(1),
    authorized: z.number().int().min(1),
    independent: z.literal(true),
    assumptions: StageBudgetAssumptionsEvidenceSchema,
    envelope: CallEnvelopeEvidenceSchema,
  }).strict(),
  accounting: z.object({
    logicalCalls: NonNegativeIntegerSchema,
    httpAttempts: NonNegativeIntegerSchema,
    retryAttempts: NonNegativeIntegerSchema,
  }).strict(),
  parallelism: z.object({
    configuredMaxInFlight: z.number().int().min(1),
    maxObservedInFlight: NonNegativeIntegerSchema,
    totalWallTimeMs: z.number().min(0),
    serialEquivalentMs: z.number().min(0),
  }).strict(),
  tokenTelemetry: ProviderTokenTelemetryEvidenceSchema,
  applicationRecovery: z.array(ApplicationRecoverySummarySchema),
  actualApplicationRecoveryAttempts: NonNegativeIntegerSchema,
  structureRecoveryDiagnostics: z.array(DirectStructureRecoveryDiagnosticEvidenceSchema),
  cache: z.object({
    hits: NonNegativeIntegerSchema,
    misses: NonNegativeIntegerSchema,
    stores: NonNegativeIntegerSchema,
  }).strict(),
  provider: z.object({
    name: z.literal("deepseek"),
    model: z.string().min(1),
    evaluatorConfigFingerprint: z.string().regex(/^[a-f0-9]{24}$/),
    proposerConfigFingerprint: z.string().regex(/^[a-f0-9]{24}$/),
    semanticJudgeConfigFingerprint: z.string().regex(/^[a-f0-9]{24}$/),
  }).strict(),
  promptBoundary: z.object({
    inputs: z.tuple([
      z.enum(["b0", "s0"]),
      z.literal("task-goal"),
      z.literal("frozen-direct-instruction"),
    ]),
    adaptivePopulationIncluded: z.literal(false),
    lineageIncluded: z.literal(false),
    adaptiveFailureIncluded: z.literal(false),
    internalScoresIncluded: z.literal(false),
    sealedIncluded: z.literal(false),
  }).strict(),
  confirmationMode: z.literal("human"),
  explorationOnly: z.literal(false),
  humanConfirmationBypassed: z.literal(false),
  formalEvidence: z.literal(true),
  releaseAllowed: z.literal(false),
  sealedAllowed: z.literal(false),
  feedbackToEvolution: z.literal(false),
  holdout: z.literal("sealed"),
  release: z.string().regex(/withheld/i),
}).strict().superRefine((value, ctx) => {
  if (value.scoringIdentity.contractSha256 !== value.contractSha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Direct scoring identity must match contractSha256", path: ["scoringIdentity"] });
  }
  if (JSON.stringify(value.comparison.scoringIdentity) !== JSON.stringify(value.scoringIdentity)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Direct comparison scoring identity drifted", path: ["comparison", "scoringIdentity"] });
  }
  if (!DirectEvidenceFlagsSchema.safeParse({
    confirmationMode: value.confirmationMode,
    explorationOnly: value.explorationOnly,
    humanConfirmationBypassed: value.humanConfirmationBypassed,
    formalEvidence: value.formalEvidence,
    releaseAllowed: value.releaseAllowed,
    sealedAllowed: value.sealedAllowed,
  }).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Direct evidence confirmation flags are inconsistent",
    });
  }
  if (value.budget.minimum > value.budget.authorized || value.accounting.logicalCalls > value.budget.authorized) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Direct budget evidence is internally inconsistent",
    });
  }
  const plan = calculateStageBudgets(value.budget.assumptions);
  const expectedEnvelope = plan.envelope.direct;
  const persisted = value.budget.envelope;
  if (
    !callEnvelopesEqual(persisted, expectedEnvelope) ||
    value.budget.minimum !== persisted.baselineEstimate ||
    value.budget.authorized !== persisted.authorizedLogicalCalls ||
    value.accounting.logicalCalls < 1 ||
    value.accounting.logicalCalls > persisted.authorizedLogicalCalls
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "completed Direct must bind shared B/M/H evidence and observed logical calls must be between 1 and H",
      path: ["budget"],
    });
  }
  if (!value.tokenTelemetry.byStageRoleModel) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "current Direct evidence requires detailed stage/role/model token telemetry",
      path: ["tokenTelemetry"],
    });
  }
  validateDirectSemanticRecovery(
    value,
    expectedEnvelope.existingRecoveryReserve,
    true,
    ctx,
  );
  const expectedItemIds = value.comparison.directCandidate.itemScores.map((item) => item.itemId);
  const recoveryEntries = value.applicationRecovery;
  const actualItemIds = recoveryEntries.map((entry) => entry.itemId);
  if (
    new Set(expectedItemIds).size !== expectedItemIds.length ||
    new Set(actualItemIds).size !== actualItemIds.length ||
    expectedItemIds.length !== actualItemIds.length ||
    expectedItemIds.some((itemId) => !actualItemIds.includes(itemId))
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "current scored Direct evidence must exactly cover every evaluated select item once",
      path: ["applicationRecovery"],
    });
  }
  const scenario = expectedEnvelope.scenarioAuthorization;
  for (const [index, recovery] of recoveryEntries.entries()) {
    if (
      recovery.candidateId !== "direct" ||
      recovery.role !== "direct" ||
      recovery.rawScenarioEstimate !== scenario.rawScenarioEstimate ||
      recovery.callEnvelopeMultiplier !== scenario.callEnvelopeMultiplier ||
      recovery.authorizedModelCallsPerAttempt !== scenario.authorizedModelCallsPerAttempt ||
      recovery.maxApplicationAttempts !== scenario.maxApplicationAttempts ||
      recovery.scenarioRetryReserve !== scenario.scenarioRetryReserve
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Direct application summary drifted from the stage scenario authorization",
        path: ["applicationRecovery", index],
      });
    }
  }
  if (value.accounting.httpAttempts !== value.accounting.logicalCalls + value.accounting.retryAttempts) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "completed Direct HTTP attempts must equal logical calls plus retries",
    });
  }
  if (value.parallelism.maxObservedInFlight > value.parallelism.configuredMaxInFlight) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Direct parallelism evidence exceeds its configured cap",
    });
  }
  const expectedSourceKind = value.directSource.track === "b0-repair" ? "b0" : "s0";
  if (value.directSource.kind !== expectedSourceKind || value.promptBoundary.inputs[0] !== expectedSourceKind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Direct source kind, track and prompt boundary must identify the same routed generation-zero root",
    });
  }
  if (value.directSource.kind === "b0" && value.directSource.skillSha256 !== value.b0SkillSha256) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Direct b0-repair source hash must match the preserved original B0 evidence hash",
    });
  }
});

const DirectCapabilityRejectedResultArtifactSchema = ScoredDirectResultArtifactSchema
  .innerType()
  .omit({ comparison: true })
  .extend({
    directStageExecution: z.literal("completed"),
    directCandidateOutcome: z.literal("rejected_by_capability_gate"),
    directStatus: z.literal("candidate_rejected"),
    semanticEvaluation: z.literal("not_run"),
    semanticLogicalCalls: z.literal(0),
    numericComparison: z.literal("not_comparable"),
    directCandidate: z.object({
      candidateId: z.literal("direct"),
      skillSha256: Sha256Schema,
    }).strict(),
    safeError: z.object({
      code: z.literal("DIRECT_U1_BOUNDARY_VIOLATION"),
      message: z.literal(
        "Direct candidate was rejected by the deterministic U1 capability gate; sensitive request content was not persisted.",
      ),
      details: z.object({ findings: z.array(DirectSafeFindingSchema).min(1) }).strict(),
    }).strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scoringIdentity.contractSha256 !== value.contractSha256) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Direct rejection scoring identity must match contractSha256", path: ["scoringIdentity"] });
    }
    if (!DirectEvidenceFlagsSchema.safeParse({
      confirmationMode: value.confirmationMode,
      explorationOnly: value.explorationOnly,
      humanConfirmationBypassed: value.humanConfirmationBypassed,
      formalEvidence: value.formalEvidence,
      releaseAllowed: value.releaseAllowed,
      sealedAllowed: value.sealedAllowed,
    }).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Direct capability-rejection evidence confirmation flags are inconsistent",
      });
    }
    const expectedPlan = calculateStageBudgets(value.budget.assumptions);
    const expectedEnvelope = expectedPlan.envelope.direct;
    if (
      value.budget.minimum !== expectedEnvelope.baselineEstimate ||
      !callEnvelopesEqual(value.budget.envelope, expectedEnvelope) ||
      value.budget.authorized !== expectedEnvelope.authorizedLogicalCalls ||
      value.budget.minimum > value.budget.authorized ||
      value.accounting.logicalCalls !== 1 ||
      value.accounting.logicalCalls > value.budget.authorized
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Direct capability rejection must retain the full independent budget while accounting for exactly one proposer call",
      });
    }
    validateDirectSemanticRecovery(
      value,
      expectedEnvelope.existingRecoveryReserve,
      true,
      ctx,
    );
    if (!value.tokenTelemetry.byStageRoleModel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "current Direct capability-rejection evidence requires detailed token telemetry",
        path: ["tokenTelemetry"],
      });
    }
    if (value.accounting.httpAttempts !== value.accounting.logicalCalls + value.accounting.retryAttempts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Direct capability-rejection HTTP attempts must equal logical calls plus retries",
      });
    }
    if (value.tokenTelemetry.responses !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Direct capability rejection requires one successfully parsed provider response",
      });
    }
    if (value.parallelism.maxObservedInFlight > value.parallelism.configuredMaxInFlight) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Direct capability-rejection parallelism evidence exceeds its configured cap",
      });
    }
    const expectedSourceKind = value.directSource.track === "b0-repair" ? "b0" : "s0";
    if (value.directSource.kind !== expectedSourceKind || value.promptBoundary.inputs[0] !== expectedSourceKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Direct capability-rejection source kind, track and prompt boundary must identify the same routed generation-zero root",
      });
    }
    if (value.directSource.kind === "b0" && value.directSource.skillSha256 !== value.b0SkillSha256) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Direct capability-rejection b0-repair source hash must match the preserved original B0 evidence hash",
      });
    }
  });

export const DirectResultArtifactSchema = z.union([
  ScoredDirectResultArtifactSchema,
  DirectCapabilityRejectedResultArtifactSchema,
]);
export type DirectResultArtifact = z.infer<typeof DirectResultArtifactSchema>;

/**
 * The scored Direct result is deliberately desensitized and therefore does
 * not contain SKILL.md.  A future formal B5 run needs the exact third
 * candidate, so a successful formal Direct stage freezes it in this separate
 * hash-bound artifact. Capability-rejected candidates cannot satisfy it.
 */
export const U1_SEALED_DIRECT_CANDIDATE_FILENAME = "direct-candidate.v1.json";
export const U1SealedDirectCandidateArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("u1-sealed-direct-candidate"),
  createdAt: z.string().datetime(),
  status: z.literal("frozen"),
  candidateId: z.literal("direct"),
  contractSha256: Sha256Schema,
  scoringIdentity: U1ScoringIdentitySchema,
  adaptiveResultSha256: Sha256Schema,
  publicSelectionResultSha256: Sha256Schema,
  directResultSha256: Sha256Schema,
  skillSha256: Sha256Schema,
  skillMd: z.string().min(1).refine((value) => value.trim().length > 0, "frozen Direct SKILL.md must not be blank"),
  confirmationMode: z.literal("human"),
  explorationOnly: z.literal(false),
  formalEvidence: z.literal(true),
  sourceStageExecution: z.literal("completed"),
  sourceCandidateOutcome: z.literal("scored"),
  feedbackToEvolution: z.literal(false),
  releaseAllowed: z.literal(false),
}).strict().superRefine((value, ctx) => {
  if (value.scoringIdentity.contractSha256 !== value.contractSha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sealed Direct candidate scoring identity must match contractSha256", path: ["scoringIdentity"] });
  }
  if (sha256Hex(value.skillMd) !== value.skillSha256) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["skillSha256"],
      message: "frozen Direct SKILL.md differs from its recorded SHA-256",
    });
  }
});
export type U1SealedDirectCandidateArtifact = z.infer<typeof U1SealedDirectCandidateArtifactSchema>;

export const DirectFailureArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  semanticResponseBindingVersion: z.literal(SEMANTIC_RESPONSE_BINDING_VERSION),
  createdAt: z.string().datetime(),
  status: z.literal("failed"),
  phase: z.literal("direct-public-select"),
  adaptiveResultSha256: Sha256Schema,
  publicSelectionResultSha256: Sha256Schema,
  contractSha256: Sha256Schema,
  scoringIdentity: U1ScoringIdentitySchema,
  selectItemsSha256: Sha256Schema,
  ...DirectPromptContractEvidenceSchema.shape,
  safeError: z.object({
    code: DirectFailureCodeSchema,
    message: z.literal("Direct stage failed; sensitive request content was not persisted."),
    details: z.object({ findings: z.array(DirectSafeFindingSchema).min(1) }).strict().optional(),
  }).strict(),
  budget: z.object({
    minimum: z.number().int().min(1),
    authorized: z.number().int().min(1),
    independent: z.literal(true),
    assumptions: StageBudgetAssumptionsEvidenceSchema,
    envelope: CallEnvelopeEvidenceSchema,
  }).strict(),
  accounting: z.object({
    logicalCalls: NonNegativeIntegerSchema,
    httpAttempts: NonNegativeIntegerSchema,
    retryAttempts: NonNegativeIntegerSchema,
  }).strict(),
  tokenTelemetry: ProviderTokenTelemetryEvidenceSchema,
  dynamicEnvelopeExhaustion: DynamicEnvelopeExhaustionEvidenceSchema.optional(),
  applicationRecovery: z.array(ApplicationRecoverySafeSummarySchema).optional(),
  actualApplicationRecoveryAttempts: NonNegativeIntegerSchema,
  structureRecoveryDiagnostics: z.array(DirectStructureRecoveryDiagnosticEvidenceSchema),
  confirmationMode: z.literal("human"),
  explorationOnly: z.literal(false),
  humanConfirmationBypassed: z.literal(false),
  formalEvidence: z.literal(true),
  releaseAllowed: z.literal(false),
  sealedAllowed: z.literal(false),
  feedbackToEvolution: z.literal(false),
  holdout: z.literal("sealed"),
  release: z.string().regex(/withheld/i),
}).strict().superRefine((value, ctx) => {
  if (value.scoringIdentity && value.scoringIdentity.contractSha256 !== value.contractSha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Direct failure scoring identity must match contractSha256", path: ["scoringIdentity"] });
  }
  if (!DirectEvidenceFlagsSchema.safeParse({
    confirmationMode: value.confirmationMode,
    explorationOnly: value.explorationOnly,
    humanConfirmationBypassed: value.humanConfirmationBypassed,
    formalEvidence: value.formalEvidence,
    releaseAllowed: value.releaseAllowed,
    sealedAllowed: value.sealedAllowed,
  }).success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Direct failure evidence flags are inconsistent" });
  }
  if (
    value.budget.minimum > value.budget.authorized ||
    value.accounting.logicalCalls > value.budget.authorized ||
    value.accounting.httpAttempts !== value.accounting.logicalCalls + value.accounting.retryAttempts
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Direct failure accounting is inconsistent" });
  }
  const expected = calculateStageBudgets(value.budget.assumptions).envelope.direct;
  if (
    !callEnvelopesEqual(value.budget.envelope, expected) ||
    value.budget.minimum !== value.budget.envelope.baselineEstimate ||
    value.budget.authorized !== value.budget.envelope.authorizedLogicalCalls
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Direct failure B/M/H evidence differs from the shared stage-budget calculation",
      path: ["budget"],
    });
  }
  validateDirectSemanticRecovery(
    value,
    value.budget.envelope.existingRecoveryReserve,
    false,
    ctx,
  );
  if (value.applicationRecovery) {
    const scenario = value.budget.envelope.scenarioAuthorization;
    for (const [index, recovery] of value.applicationRecovery.entries()) {
      if (
        recovery.role !== "direct" ||
        recovery.rawScenarioEstimate !== scenario.rawScenarioEstimate ||
        recovery.callEnvelopeMultiplier !== scenario.callEnvelopeMultiplier ||
        recovery.authorizedModelCallsPerAttempt !== scenario.authorizedModelCallsPerAttempt ||
        recovery.maxApplicationAttempts !== scenario.maxApplicationAttempts ||
        recovery.scenarioRetryReserve !== scenario.scenarioRetryReserve
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Direct failure application summary drifted from the stage scenario authorization",
          path: ["applicationRecovery", index],
        });
      }
    }
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
        message: "dynamic Direct exhaustion requires exact sanitized B/M/H evidence",
        path: ["dynamicEnvelopeExhaustion"],
      });
    }
  } else if (value.dynamicEnvelopeExhaustion) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "non-dynamic Direct failure cannot carry dynamic exhaustion evidence",
      path: ["dynamicEnvelopeExhaustion"],
    });
  }
});
export type DirectFailureArtifact = z.infer<typeof DirectFailureArtifactSchema>;
