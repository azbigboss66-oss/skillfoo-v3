import { sha256Hex } from "../runtime/capabilityAdapter.js";
import { mapBoundedStable } from "../runtime/parallel.js";
import type { ContractItemScore, InstructionBatchScorer, InstructionGateInput } from "../runtime/instructionAdapter.js";
import {
  U1ScoringProfileSchema,
  type EvaluationContractV3,
  type GateResult,
  type U1RubricDimensionId,
  type U1ScoringProfile,
  type U1ApplicationRecoverySummary,
} from "../types.js";
import type { FunnelEvalItem, FunnelScenarioRunner } from "./funnel.js";
import {
  aggregateU1DimensionScores,
  evaluateU1TerminalCandidateAgainstStartingReference,
  evaluateU1CandidateEligibility,
  scoringIdentityOfContract,
} from "../evaluation/u1Rubric.js";
import type { U1ScoringIdentity } from "../types.js";
import type { U1RecoveryContext } from "./structureRecovery.js";

export type PublicSelectionVerdict =
  | "clear_improvement"
  | "candidate_rejected"
  | "start_reference_retained"
  | "not_comparable";

export interface PublicSelectCandidateEvidence {
  candidateId: string;
  rootKind: "b0" | "s0" | "evolved";
  skillSha256: string;
  weightedMean: number;
  /** The candidate completed the frozen public contract and may be used as a comparison baseline. */
  comparisonEligible: boolean;
  /** The candidate may become or remain the public champion. */
  championEligible: boolean;
  /** U1 is permanently no-release; this field makes that boundary explicit. */
  releaseEligible: false;
  everyGatePassed: boolean;
  criticalRegression: boolean;
  criticalRegressionItemIds: string[];
  dimensionScores: Record<U1RubricDimensionId, number>;
  protectedDimensionRegression: boolean;
  protectedDimensionRegressions: U1RubricDimensionId[];
}

export interface PublicSelectionFailureItemSummary {
  itemId: string;
  score: number;
  criticalFailure: boolean;
}

export interface PublicSelectionFailureCandidateSummary extends PublicSelectCandidateEvidence {
  failedGateIds: string[];
  failedItems: PublicSelectionFailureItemSummary[];
}

export interface PublicSelectionSafeDiagnostics {
  candidateSummaries: PublicSelectionFailureCandidateSummary[];
}

export class PublicSelectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly safeDiagnostics?: PublicSelectionSafeDiagnostics,
  ) {
    super(`${code}: ${message}`);
    this.name = "PublicSelectionError";
  }
}

export interface PublicSelectionDecision {
  startingReferenceId: string | null;
  finalPublicChampionId: string | null;
  verdict: PublicSelectionVerdict;
  reasonCode?: "no_safe_candidate" | "no_comparison_baseline";
  comparisonEligible: boolean;
  championEligible: boolean;
  releaseEligible: false;
  scoreDelta: number;
  criticalRegression: boolean;
  protectedDimensionRegression: boolean;
  protectedDimensionRegressions: U1RubricDimensionId[];
  sameModelLimitation: string;
}

export interface TerminalPublicSelectCandidate {
  candidateId: string;
  rootKind: "b0" | "s0" | "evolved";
  skillMd: string;
}

export interface PublicSelectCandidateEvaluation extends PublicSelectCandidateEvidence {
  gateResults: GateResult[];
  itemScores: ContractItemScore[];
  answerHashes: Array<{ itemId: string; answerSha256: string }>;
}

export interface TerminalPublicSelectionResult {
  shortlistCandidateIds: string[];
  candidateEvaluations: PublicSelectCandidateEvaluation[];
  decision: PublicSelectionDecision;
  scoringIdentity: U1ScoringIdentity;
  /** Content-free evidence for the one permitted per candidate-item loop retry. */
  applicationRecovery: U1ApplicationRecoverySummary[];
}

export const SAME_MODEL_SELECTION_LIMITATION =
  "Proposer and semantic evaluation may use the same provider/model family. Strict schemas, deterministic verification and separated public, Direct and sealed stages reduce but do not eliminate circular self-validation. Current model evidence is not independent human evaluation or proof of general effectiveness.";

function finiteScore(candidate: PublicSelectCandidateEvidence): number {
  if (!Number.isFinite(candidate.weightedMean) || candidate.weightedMean < 0 || candidate.weightedMean > 100) {
    throw new Error(`PUBLIC_SELECTION_EVIDENCE_INVALID: ${candidate.candidateId} weightedMean must be within 0..100`);
  }
  return candidate.weightedMean;
}

function comparisonEligible(candidate: PublicSelectCandidateEvidence): boolean {
  if (typeof candidate.comparisonEligible !== "boolean") {
    throw new PublicSelectionError(
      "PUBLIC_SELECTION_ELIGIBILITY_MISSING",
      `candidate ${candidate.candidateId} lacks current comparison eligibility`,
    );
  }
  return candidate.comparisonEligible;
}

function championEligible(candidate: PublicSelectCandidateEvidence): boolean {
  if (typeof candidate.championEligible !== "boolean") {
    throw new PublicSelectionError(
      "PUBLIC_SELECTION_ELIGIBILITY_MISSING",
      `candidate ${candidate.candidateId} lacks current champion eligibility`,
    );
  }
  return candidate.championEligible;
}

/** Choose the stronger comparison-eligible generation-zero baseline. An exact tie retains B0. */
export function selectStartingReference(input: {
  b0: PublicSelectCandidateEvidence;
  s0: PublicSelectCandidateEvidence;
}): PublicSelectCandidateEvidence {
  if (input.b0.rootKind !== "b0" || input.s0.rootKind !== "s0") {
    throw new Error("PUBLIC_SELECTION_ROOT_INVALID: Starting Reference requires one B0 and one S0 root");
  }
  finiteScore(input.b0);
  finiteScore(input.s0);
  const b0Comparable = comparisonEligible(input.b0);
  const s0Comparable = comparisonEligible(input.s0);
  if (!b0Comparable && !s0Comparable) {
    throw new PublicSelectionError(
      "PUBLIC_SELECTION_NO_SAFE_ROOT",
      "neither B0 nor S0 is eligible as the public comparison baseline",
    );
  }
  if (!b0Comparable) return input.s0;
  if (!s0Comparable) return input.b0;
  return input.s0.weightedMean > input.b0.weightedMean ? input.s0 : input.b0;
}

function terminalDecision(
  startingReference: PublicSelectCandidateEvidence,
  challenger: PublicSelectCandidateEvidence | null,
  verdict: PublicSelectionVerdict,
  protectedDimensionRegressions: readonly U1RubricDimensionId[] = [],
  reasonCode?: "no_safe_candidate",
): PublicSelectionDecision {
  const scoreDelta = challenger === null
    ? 0
    : Math.round((challenger.weightedMean - startingReference.weightedMean) * 100) / 100;
  const finalCandidate = verdict === "clear_improvement" && challenger !== null
    ? challenger
    : startingReference;
  return {
    startingReferenceId: startingReference.candidateId,
    finalPublicChampionId: finalCandidate.candidateId,
    verdict,
    ...(reasonCode ? { reasonCode } : {}),
    comparisonEligible: comparisonEligible(finalCandidate),
    championEligible: championEligible(finalCandidate),
    releaseEligible: false,
    scoreDelta,
    criticalRegression: challenger?.criticalRegression ?? false,
    protectedDimensionRegression: protectedDimensionRegressions.length > 0,
    protectedDimensionRegressions: [...protectedDimensionRegressions],
    sameModelLimitation: SAME_MODEL_SELECTION_LIMITATION,
  };
}

function notComparableDecision(): PublicSelectionDecision {
  return {
    startingReferenceId: null,
    finalPublicChampionId: null,
    verdict: "not_comparable",
    reasonCode: "no_comparison_baseline",
    comparisonEligible: false,
    championEligible: false,
    releaseEligible: false,
    scoreDelta: 0,
    criticalRegression: false,
    protectedDimensionRegression: false,
    protectedDimensionRegressions: [],
    sameModelLimitation: SAME_MODEL_SELECTION_LIMITATION,
  };
}

/**
 * Terminal public-select decision. The output intentionally contains only
 * aggregate decision evidence; it has no item text, judge reason, prompt or
 * failure payload that a proposer or repair path could consume.
 */
export function selectFinalPublicChampion(input: {
  startingReference: PublicSelectCandidateEvidence;
  challengers: readonly PublicSelectCandidateEvidence[];
  scoringProfile: U1ScoringProfile;
}): PublicSelectionDecision {
  finiteScore(input.startingReference);
  if (!comparisonEligible(input.startingReference)) {
    throw new Error("PUBLIC_SELECTION_START_INVALID: Starting Reference must be comparison-eligible");
  }

  const novelByHash = new Map<string, PublicSelectCandidateEvidence>();
  for (const candidate of input.challengers) {
    finiteScore(candidate);
    if (!comparisonEligible(candidate)) continue;
    if (candidate.skillSha256 === input.startingReference.skillSha256) continue;
    const existing = novelByHash.get(candidate.skillSha256);
    if (
      existing === undefined ||
      candidate.weightedMean > existing.weightedMean ||
      (candidate.weightedMean === existing.weightedMean && candidate.skillSha256.localeCompare(existing.skillSha256) < 0)
    ) {
      novelByHash.set(candidate.skillSha256, candidate);
    }
  }
  const novel = [...novelByHash.values()];
  const eligible = novel.filter((candidate) => championEligible(candidate));
  const eligibleChallenger = [...eligible].sort(
    (left, right) => right.weightedMean - left.weightedMean || left.skillSha256.localeCompare(right.skillSha256),
  )[0] ?? null;
  const challenger = eligibleChallenger ?? [...novel].sort(
    (left, right) => right.weightedMean - left.weightedMean || left.skillSha256.localeCompare(right.skillSha256),
  )[0] ?? null;
  if (challenger === null) {
    return championEligible(input.startingReference)
      ? terminalDecision(input.startingReference, null, "start_reference_retained")
      : terminalDecision(input.startingReference, null, "start_reference_retained", [], "no_safe_candidate");
  }

  const profile = U1ScoringProfileSchema.parse(input.scoringProfile);
  if (!input.startingReference.dimensionScores || !challenger.dimensionScores) {
    throw new PublicSelectionError(
      "PUBLIC_SELECTION_SCORING_IDENTITY_MISSING",
      "terminal protected-dimension comparison requires complete frozen dimension aggregates",
    );
  }
  const protectedDimensionRegressions = profile.protectedDimensions.filter((dimension) => {
    const before = input.startingReference.dimensionScores?.[dimension];
    const after = challenger.dimensionScores?.[dimension];
    if (!Number.isFinite(before) || !Number.isFinite(after)) {
      throw new PublicSelectionError(
        "PUBLIC_SELECTION_SCORING_IDENTITY_MISSING",
        "terminal protected-dimension comparison requires every frozen dimension aggregate",
      );
    }
    return (after as number) < (before as number);
  });

  if (eligibleChallenger === null) {
    if (!championEligible(input.startingReference)) {
      return terminalDecision(
        input.startingReference,
        challenger,
        "start_reference_retained",
        protectedDimensionRegressions,
        "no_safe_candidate",
      );
    }
    return terminalDecision(
      input.startingReference,
      challenger,
      "candidate_rejected",
      protectedDimensionRegressions,
    );
  }
  const delta = eligibleChallenger.weightedMean - input.startingReference.weightedMean;
  if (delta >= 3) {
    return terminalDecision(
      input.startingReference,
      eligibleChallenger,
      "clear_improvement",
      protectedDimensionRegressions,
    );
  }
  return terminalDecision(
    input.startingReference,
    eligibleChallenger,
    "start_reference_retained",
    protectedDimensionRegressions,
  );
}

/**
 * Evaluate a frozen terminal shortlist on public-select and make the final
 * public decision. There is intentionally no proposer, mutation, repair, or
 * feedback callback in this boundary.
 */
export async function runTerminalPublicSelection(args: {
  contract: EvaluationContractV3;
  selectItems: readonly FunnelEvalItem[];
  candidates: readonly TerminalPublicSelectCandidate[];
  runner: FunnelScenarioRunner;
  scoreRuns: InstructionBatchScorer;
  /** Mandatory one-shot JSON schema recovery for each public semantic batch. */
  semanticRecovery: U1RecoveryContext;
  maxInFlight: number;
}): Promise<TerminalPublicSelectionResult> {
  if (args.selectItems.length === 0) {
    throw new PublicSelectionError("PUBLIC_SELECTION_ITEMS_MISSING", "terminal selection needs frozen public-select items");
  }
  if (args.selectItems.some((item) => item.split !== "public" || item.rubric === undefined)) {
    throw new PublicSelectionError(
      "PUBLIC_SELECTION_ITEMS_INVALID",
      "every terminal item must be public and carry its frozen U1 rubric",
    );
  }
  const selectItemIds = args.selectItems.map((item) => item.itemId);
  if (new Set(selectItemIds).size !== selectItemIds.length) {
    throw new PublicSelectionError("PUBLIC_SELECTION_ITEMS_INVALID", "terminal select item ids must be unique");
  }
  const scoringIdentity = scoringIdentityOfContract({
    contract: args.contract,
    items: args.selectItems,
  });
  const scoringProfile = args.contract.scoringProfile;
  const b0Roots = args.candidates.filter((candidate) => candidate.rootKind === "b0");
  const s0Roots = args.candidates.filter((candidate) => candidate.rootKind === "s0");
  const candidateIds = args.candidates.map((candidate) => candidate.candidateId);
  if (b0Roots.length !== 1 || s0Roots.length !== 1) {
    throw new PublicSelectionError("PUBLIC_SELECTION_ROOTS_MISSING", "terminal shortlist requires exactly one B0 and one S0 root");
  }
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new PublicSelectionError("PUBLIC_SELECTION_CANDIDATES_INVALID", "terminal shortlist candidate ids must be unique");
  }
  const b0 = b0Roots[0];
  const s0 = s0Roots[0];

  const candidateHash = new Map<string, string>();
  const firstCandidateByHash = new Map<string, TerminalPublicSelectCandidate>();
  for (const candidate of args.candidates) {
    const hash = sha256Hex(candidate.skillMd);
    candidateHash.set(candidate.candidateId, hash);
    if (!firstCandidateByHash.has(hash)) firstCandidateByHash.set(hash, candidate);
  }
  const uniqueCandidates = [...firstCandidateByHash.values()];
  const tasks = uniqueCandidates.flatMap((candidate) =>
    args.selectItems.map((item) => ({ candidate, item }))
  );
  const runResult = await mapBoundedStable(tasks, args.maxInFlight, async ({ candidate, item }) => ({
    candidateId: candidate.candidateId,
    item,
    transcript: await args.runner({
      item,
      skillMd: candidate.skillMd,
      snapshotId: sha256Hex(candidate.skillMd).slice(0, 12),
    }),
  }));
  const runsByCandidate = new Map<string, InstructionGateInput[]>();
  for (const run of runResult.values) {
    const group = runsByCandidate.get(run.candidateId) ?? [];
    group.push({ item: run.item, transcript: run.transcript });
    runsByCandidate.set(run.candidateId, group);
  }

  const evaluationByHash = new Map<string, PublicSelectCandidateEvaluation>();
  const applicationRecovery: U1ApplicationRecoverySummary[] = [];
  const expectedItemIds = selectItemIds;
  for (const candidate of uniqueCandidates) {
    const hash = candidateHash.get(candidate.candidateId)!;
    const runs = runsByCandidate.get(candidate.candidateId) ?? [];
    const scored = await args.scoreRuns({
      contract: args.contract,
      runs,
      recovery: args.semanticRecovery,
    });
    for (const run of runs) {
      if (run.transcript.applicationRecovery) {
        applicationRecovery.push({
          candidateId: candidate.candidateId,
          itemId: run.item.itemId,
          role: "public-select",
          ...run.transcript.applicationRecovery,
        });
      }
    }
    const eligibility = evaluateU1CandidateEligibility({
      expectedItemIds,
      itemScores: scored.itemScores,
      gateResults: scored.gateResults,
      criticalRegression: false,
    });
    const everyGatePassed = scored.gateResults.every((gate) => gate.passed);
    evaluationByHash.set(hash, {
      candidateId: candidate.candidateId,
      rootKind: candidate.rootKind,
      skillSha256: hash,
      weightedMean: scored.publicScore,
      comparisonEligible: eligibility.comparisonEligible,
      championEligible: eligibility.championEligible,
      releaseEligible: eligibility.releaseEligible,
      everyGatePassed,
      criticalRegression: false,
      criticalRegressionItemIds: [],
      gateResults: scored.gateResults,
      itemScores: scored.itemScores,
      dimensionScores: aggregateU1DimensionScores(scored.itemScores, scoringProfile),
      protectedDimensionRegression: false,
      protectedDimensionRegressions: [],
      answerHashes: runs.map((run) => ({
        itemId: run.item.itemId,
        answerSha256: sha256Hex(JSON.stringify(run.transcript.parsedFinalAnswer ?? null)),
      })),
    });
  }

  const labelledEvaluations: PublicSelectCandidateEvaluation[] = args.candidates.map((candidate) => {
    const source = evaluationByHash.get(candidateHash.get(candidate.candidateId)!)!;
    return { ...source, candidateId: candidate.candidateId, rootKind: candidate.rootKind };
  });
  const b0Evidence = labelledEvaluations.find((candidate) => candidate.candidateId === b0.candidateId)!;
  const s0Evidence = labelledEvaluations.find((candidate) => candidate.candidateId === s0.candidateId)!;
  let startingReference: PublicSelectCandidateEvaluation;
  try {
    startingReference = selectStartingReference({
      b0: b0Evidence,
      s0: s0Evidence,
    }) as PublicSelectCandidateEvaluation;
  } catch (error) {
    if (error instanceof PublicSelectionError && error.code === "PUBLIC_SELECTION_NO_SAFE_ROOT") {
      return {
        shortlistCandidateIds: args.candidates.map((candidate) => candidate.candidateId),
        candidateEvaluations: labelledEvaluations,
        scoringIdentity,
        applicationRecovery,
        decision: notComparableDecision(),
      };
    }
    throw error;
  }
  const candidatesWithRegression = labelledEvaluations.map((candidate) => {
    if (candidate.rootKind !== "evolved") return candidate;
    if (!startingReference.dimensionScores || !candidate.dimensionScores) {
      throw new PublicSelectionError(
        "PUBLIC_SELECTION_SCORING_EVIDENCE_MISSING",
        "terminal comparison requires current five-dimensional aggregates",
      );
    }
    const absoluteEligibility = evaluateU1CandidateEligibility({
      expectedItemIds,
      itemScores: candidate.itemScores,
      gateResults: candidate.gateResults,
      criticalRegression: false,
    });
    const projection = evaluateU1TerminalCandidateAgainstStartingReference({
      profile: scoringProfile,
      starting: {
        itemScores: startingReference.itemScores,
        dimensionScores: startingReference.dimensionScores,
      },
      challenger: {
        itemScores: candidate.itemScores,
        dimensionScores: candidate.dimensionScores,
        eligibility: absoluteEligibility,
      },
    });
    return {
      ...candidate,
      criticalRegression: projection.criticalRegression,
      criticalRegressionItemIds: projection.criticalRegressionItemIds,
      championEligible: projection.championEligible,
      protectedDimensionRegression: projection.protectedDimensionRegression,
      protectedDimensionRegressions: projection.protectedDimensionRegressions,
      releaseEligible: false as const,
    };
  });
  const evolved = candidatesWithRegression.filter((candidate) => candidate.rootKind === "evolved");
  return {
    shortlistCandidateIds: args.candidates.map((candidate) => candidate.candidateId),
    candidateEvaluations: candidatesWithRegression,
    scoringIdentity,
    applicationRecovery,
    decision: selectFinalPublicChampion({
      startingReference,
      challengers: evolved,
      scoringProfile,
    }),
  };
}
