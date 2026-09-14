// ── V3.1 T18: the adaptive evolution runner ────────────────────────
//
// Drives the population through the T16 decision table with everything
// model-shaped injected: a FunnelScenarioRunner for evaluation and the
// T17 live proposers for repair/mutation. The invariants this loop owes
// the audit: the population triple (B0 anchor + Elite + Diversity) is
// alive after every generation, every child records its lineage, the
// 2nd-or-later refinement needs a progress certificate, budget and
// proposer failures stop the run with a resubmission suggestion instead
// of falling back to fixtures, and no holder of a killed evaluation
// ever becomes a parent.

import { sha256Hex } from "../runtime/capabilityAdapter.js";
import { stableStringify } from "../intake/taskCard.js";
import { mapBoundedSettled, mapBoundedStable, type ParallelTiming } from "../runtime/parallel.js";
import { applyContractGates, contractItemPassed, type ContractItemScore, type InstructionBatchScorer, type InstructionGateInput } from "../runtime/instructionAdapter.js";
import { ProviderBudgetError, type RunCallAccounting, type RunCallBudget } from "../providers/runBudget.js";
import {
  LiveProposalError,
  promptCardFactsOf,
  type LiveMutationProposer,
  type U1MutationFeedbackItem,
  type U1MutationTrainFeedback,
} from "../bootstrap/liveBootstrapProposer.js";
import { SemanticJudgeError } from "../evaluation/semanticJudge.js";
import { scoringIdentityOfContract } from "../evaluation/u1Rubric.js";
import {
  projectApplicationRecoveryAttempt,
  projectRecoveryDiagnostic,
  type U1ApplicationRecoveryAttempt,
  type U1RecoveryContext,
  type U1RecoveryDiagnostic,
  type U1RecoveryHooks,
  type U1RecoverySubject,
} from "./structureRecovery.js";
import type {
  CandidateOutcome,
  EvaluationContractV3,
  GateResult,
  RunApplicationRecoveryEvidence,
  SkillRootKind,
  TaskCard,
  U1ScoringIdentity,
} from "../types.js";
import {
  advanceStagnation,
  progressCertificateOf,
  recoverySuggestionForStop,
  routeAdaptiveStep,
  type AdaptivePolicy,
  type AdaptiveRoute,
  type AdaptiveRouteState,
  type RecoverySuggestion,
} from "./adaptivePolicy.js";
import { RepairFrontierError, type FrontierRepairProposer } from "./repairFrontier.js";
import { selectBootstrapSlice, type FunnelEvalItem, type FunnelEvent, type FunnelScenarioRunner } from "./funnel.js";
export class AdaptiveRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AdaptiveRunError";
  }
}

export type AdaptiveOutcome = Extract<CandidateOutcome, "elite" | "safe_non_elite" | "killed">;
export type AdaptiveGenerationCoverage = "full" | "partial" | "none";

export interface AdaptiveEvaluation {
  publicScore: number;
  solvedItemIds: string[];
  itemScores?: ContractItemScore[];
  gateResults: GateResult[];
  safetyFailures: number;
  qualityFailures: number;
  outcome: AdaptiveOutcome;
  /** Screening evidence is never release readiness; full public is required for acceptance. */
  evaluatedItemIds?: string[];
  phase?: "pinned" | "public";
  /** Content-free evidence for candidate-item loop retries; model/task bodies are never copied. */
  applicationRecoveries?: Array<RunApplicationRecoveryEvidence & { itemId: string }>;
}

export interface AdaptiveLoopRecoverySummary {
  attemptedItems: number;
  recoveredAfterSingleRetry: number;
  persistentCandidateLoops: number;
  retryCompletedNonFinal: number;
  additionalModelCalls: number;
}

export type AdaptiveChildKind = "exploit" | "diversify";

export interface AdaptiveRunCandidate {
  candidateId: string;
  originRoot: SkillRootKind;
  generation: number;
  parentCandidateId: string | null;
  childKind: AdaptiveChildKind | null;
  skillMd: string;
  evaluation: AdaptiveEvaluation | null;
  /** Repairs consumed along this candidate's lineage; certificate gating reads it. */
  refinementsUsed?: number;
  hypothesis?: string;
}

export interface AdaptivePopulation {
  anchorCandidateId: string;
  eliteId: string | null;
  diversityId: string | null;
  eliteReason: string;
  diversityReason: string;
}

function rankingOf(a: AdaptiveRunCandidate, b: AdaptiveRunCandidate): number {
  const ea = a.evaluation!;
  const eb = b.evaluation!;
  return (
    eb.publicScore - ea.publicScore ||
    eb.solvedItemIds.length - ea.solvedItemIds.length ||
    a.candidateId.localeCompare(b.candidateId)
  );
}

function isSafe(candidate: AdaptiveRunCandidate): boolean {
  return candidate.evaluation !== null && candidate.evaluation.outcome !== "killed";
}

/**
 * Select the population triple from the evaluated candidates. The anchor
 * keeps the B0 seat by identity; the elite seat goes to the best safe
 * candidate; the diversity seat requires both distinct content and
 * complementarity. No candidate may occupy two seats merely under a
 * different label, and an absent distinct candidate leaves Diversity empty.
 */
export function selectAdaptivePopulation(input: {
  anchorCandidateId: string;
  candidates: AdaptiveRunCandidate[];
}): AdaptivePopulation {
  const safeByHash = new Map<string, AdaptiveRunCandidate>();
  for (const candidate of input.candidates.filter(isSafe)) {
    const hash = sha256Hex(candidate.skillMd);
    const existing = safeByHash.get(hash);
    if (
      !existing ||
      candidate.candidateId === input.anchorCandidateId ||
      (existing.candidateId !== input.anchorCandidateId && rankingOf(candidate, existing) < 0)
    ) {
      safeByHash.set(hash, candidate);
    }
  }
  const safePool = [...safeByHash.values()];
  const killedCount = input.candidates.filter(
    (candidate) => candidate.evaluation?.outcome === "killed",
  ).length;
  const anchor =
    input.candidates.find((candidate) => candidate.candidateId === input.anchorCandidateId) ?? null;

  const elite = [...safePool].sort(rankingOf)[0] ?? null;
  const solvedByElite = new Set(elite?.evaluation?.solvedItemIds ?? []);

  let diversity: AdaptiveRunCandidate | null = null;
  let diversityReason: string;

  const complementary = safePool
    .filter((candidate) => candidate !== elite)
    .map((candidate) => ({
      candidate,
      newItems: (candidate.evaluation?.solvedItemIds ?? []).filter((id) => !solvedByElite.has(id)),
    }))
    .filter(
      ({ candidate, newItems }) =>
        newItems.length > 0 || (elite !== null && candidate.originRoot !== elite.originRoot),
    )
    .sort((a, b) => rankingOf(a.candidate, b.candidate));

  if (elite && complementary.length > 0) {
    const winner = complementary[0];
    diversity = winner.candidate;
    const complement =
      winner.newItems.length > 0
        ? `solved items [${winner.newItems.join(", ")}]`
        : `a different origin root (${winner.candidate.originRoot} vs ${elite.originRoot})`;
    diversityReason = [
      `diversity seat: ${winner.candidate.candidateId} (${winner.candidate.originRoot}, ${winner.candidate.evaluation!.publicScore} points)`,
      `complements the elite ${elite.candidateId} with ${complement};`,
      `excluded ${killedCount} killed candidate(s) from the pool`,
    ].join(" ");
  } else {
    diversityReason =
      `diversity seat: empty — no distinct safe complementary Skill content exists; ${anchor && isSafe(anchor) ? "the anchor remains available only in its own seat" : "the anchor itself is not safe"}`;
  }

  return {
    anchorCandidateId: input.anchorCandidateId,
    eliteId: elite?.candidateId ?? null,
    diversityId: diversity?.candidateId ?? null,
    eliteReason: elite
      ? `elite seat: ${elite.candidateId} (${elite.originRoot}) leads the safe pool at ${elite.evaluation!.publicScore} points with ${elite.evaluation!.solvedItemIds.length} solved item(s)`
      : "elite seat: empty — every evaluated candidate is killed or unevaluated; nothing survived the safety bar",
    diversityReason,
  };
}

// ── Run result types ──────────────────────────────────────────────

export type AdaptiveStopReason =
  | "generations_completed"
  | "public_goal_met"
  | "safety_kill"
  | "budget_exhausted"
  | "proposer_failure"
  | "no_valid_child"
  | "root_rebuild"
  | "stagnation_stop";

export type AdaptiveLaneStatus =
  | "proposed"
  | "no_change"
  | "candidate_rejected"
  | "evaluated"
  | "provider_failed"
  | "budget_failed";

export type MutationLaneDetailStatus =
  | "requested"
  | "no_change"
  | "generated"
  | "rejected_by_schema"
  | "rejected_by_scope"
  | "rejected_by_capability"
  | "screened"
  | "safe_non_elite"
  | "elite_eligible"
  | "provider_failed"
  | "budget_failed";

export interface AdaptiveLaneLedger {
  kind: "exploit" | "diversify";
  candidateId: string;
  parentCandidateId: string;
  parentRole: "elite" | "diversity";
  status: AdaptiveLaneStatus;
  detailStatus: MutationLaneDetailStatus;
  failureCode?: string;
  findingCodes?: string[];
  findingExcerpts?: string[];
  /** Content-free binding to the bounded public-train feedback sent to this lane. */
  feedbackSha256: string;
  feedbackFailureCount: number;
  feedbackSuccessCount: number;
}

export interface AdaptiveGenerationLedger {
  generation: number;
  route: AdaptiveRoute;
  reason: string;
  entryAnchorId: string;
  entryEliteId: string;
  entryDiversityId: string;
  wallTimeMs: number;
  childrenProposed: number;
  childrenEvaluated: number;
  childrenAccepted: number;
  childrenAttempted: number;
  childrenGenerated: number;
  childrenRejected: number;
  childrenNoChange: number;
  childrenScreened: number;
  childrenPromoted: number;
  /** Valid terminal child coverage; rejected lanes never count as generated/evaluated/screened. */
  generationCoverage?: AdaptiveGenerationCoverage;
  lanes: AdaptiveLaneLedger[];
}

export interface AdaptiveRunResult {
  stopReason: AdaptiveStopReason;
  stopDetail: string;
  recoverySuggestion?: RecoverySuggestion;
  candidates: AdaptiveRunCandidate[];
  population: AdaptivePopulation;
  generations: AdaptiveGenerationLedger[];
  finalElite: AdaptiveRunCandidate | null;
  explorationOnly: boolean;
  accounting: RunCallAccounting;
  events: FunnelEvent[];
  pinnedItemIds: string[];
  totalWallTimeMs: number;
  serialEquivalentMs: number;
  maxObservedInFlight: number;
  /** Current formal application-level structure-recovery count. */
  actualApplicationRecoveryAttempts: number;
  /** Strict eight-field diagnostics only; raw model text is never retained here. */
  structureRecoveryDiagnostics?: U1RecoveryDiagnostic[];
  scoringIdentity: U1ScoringIdentity;
  /** Aggregate of the content-free per-item application-retry evidence above. */
  applicationLoopRecovery?: AdaptiveLoopRecoverySummary;
}

class NoValidMutationChildError extends Error {
  constructor(readonly generation: number, reason = "both mutation lanes were rejected by candidate-local validation") {
    super(`NO_VALID_CHILD: generation ${generation} has no viable mutation child (${reason})`);
    this.name = "NoValidMutationChildError";
  }
}

const CANDIDATE_LOCAL_PROPOSAL_CODES = new Set([
  "LIVE_PROPOSAL_INVALID_JSON",
  "LIVE_PROPOSAL_INVALID",
  "LIVE_PROPOSAL_NOOP",
  "LIVE_PROPOSAL_PRIVILEGE_ESCALATION",
  "LIVE_PROPOSAL_FILE_SCOPE_VIOLATION",
  "LIVE_MUTATION_U1_BOUNDARY_VIOLATION",
]);

function candidateLocalProposalError(error: unknown): error is LiveProposalError {
  return error instanceof LiveProposalError && CANDIDATE_LOCAL_PROPOSAL_CODES.has(error.code);
}

const CANDIDATE_LOCAL_SEMANTIC_CODES = new Set([
  "SEMANTIC_JUDGE_INVALID_JSON",
  "SEMANTIC_JUDGE_INVALID",
  "SEMANTIC_JUDGE_ITEM_MISMATCH",
  "SEMANTIC_JUDGE_ITEM_ORDER_MISMATCH",
  "SEMANTIC_JUDGE_DIMENSION_MISMATCH",
  "SEMANTIC_JUDGE_OVERALL_REASON_INVALID",
]);

function candidateLocalSemanticError(error: unknown): error is SemanticJudgeError {
  return error instanceof SemanticJudgeError && CANDIDATE_LOCAL_SEMANTIC_CODES.has(error.code);
}

function rejectedLaneDetail(error: LiveProposalError): MutationLaneDetailStatus {
  if (error.code === "LIVE_PROPOSAL_INVALID_JSON" || error.code === "LIVE_PROPOSAL_INVALID" || error.code === "LIVE_PROPOSAL_NOOP") {
    return "rejected_by_schema";
  }
  if (error.code === "LIVE_PROPOSAL_FILE_SCOPE_VIOLATION") return "rejected_by_scope";
  return "rejected_by_capability";
}

export interface AdaptiveRunArgs {
  policy: AdaptivePolicy;
  contract: EvaluationContractV3;
  taskCard: TaskCard;
  publicItems: FunnelEvalItem[];
  anchor: { candidateId: string; originRoot: SkillRootKind; skillMd: string };
  seeds?: Array<{ candidateId: string; originRoot: SkillRootKind; skillMd: string }>;
  runner: FunnelScenarioRunner;
  scoreRuns?: InstructionBatchScorer;
  mutationProposer: LiveMutationProposer;
  repairProposer?: FrontierRepairProposer;
  budget: RunCallBudget;
  /** Caller-local limit for independent scenario/proposal requests. */
  maxInFlight?: 1 | 2 | 3 | 4;
  /** V3.2 CLI behavior: a full-public perfect elite ends the run before any needless edit. */
  stopOnPublicGoal?: boolean;
  /** Optional live observer for already-sanitized stage metadata; it never changes routing or budget. */
  onEvent?: (event: FunnelEvent) => void;
  now?: () => string;
}

interface StopState {
  reason: AdaptiveStopReason;
  detail: string;
  recovery?: RecoverySuggestion;
}

/**
 * Run the adaptive loop. Never throws for budget exhaustion, structured
 * proposer failures, safety kills, or routing stops — each lands in the
 * result with a resubmission suggestion. Unexpected runner errors still
 * propagate: the loop never guesses around a broken harness.
 */
export async function runAdaptive(args: AdaptiveRunArgs): Promise<AdaptiveRunResult> {
  const now = args.now ?? (() => new Date().toISOString());
  const runWallStartedAtMs = Date.now();
  const events: FunnelEvent[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  const emit = (type: string, payload: Record<string, unknown> = {}): void => {
    const event: FunnelEvent = { at: now(), type, ...payload, cacheHits, cacheMisses };
    events.push(event);
    args.onEvent?.(event);
  };

  const items = args.publicItems;
  const scoringIdentity = scoringIdentityOfContract({
    contract: args.contract,
    items,
  });
  const proposerTaskCard = promptCardFactsOf(args.taskCard, {
    requireComplete: true,
    allowedScenarioIds: [...new Set(items.map((item) => item.scenarioId))],
  });
  const maxInFlight = args.maxInFlight ?? 1;
  const pinnedItems = selectBootstrapSlice(items);
  const declaredRoots = [args.anchor, ...(args.seeds ?? [])];
  const uniqueRootByHash = new Map<string, (typeof declaredRoots)[number]>();
  for (const root of declaredRoots) {
    const hash = sha256Hex(root.skillMd);
    if (!uniqueRootByHash.has(hash)) uniqueRootByHash.set(hash, root);
  }
  const rootRepresentatives = [...uniqueRootByHash.values()];
  const duplicateRoots = declaredRoots.filter(
    (root) => !rootRepresentatives.some((kept) => kept.candidateId === root.candidateId),
  );
  let actualApplicationRecoveryAttempts = 0;
  const structureRecoveryDiagnostics: U1RecoveryDiagnostic[] = [];
  const recoveryHooks: U1RecoveryHooks = {
    onApplicationRecoveryAttempt(attempt: U1ApplicationRecoveryAttempt) {
      const safeAttempt = projectApplicationRecoveryAttempt(attempt);
      if (safeAttempt.subject.kind !== "candidate") {
        throw new TypeError("ADAPTIVE_RECOVERY_SUBJECT_INVALID: Adaptive recovery must be candidate-bound");
      }
      actualApplicationRecoveryAttempts += 1;
      emit("application_recovery_attempt", {
        operation: safeAttempt.operation,
        mode: safeAttempt.mode,
        attempt: safeAttempt.attempt,
        generation: safeAttempt.subject.generation,
        lane: safeAttempt.subject.lane,
        requestFingerprintSha256: safeAttempt.requestFingerprintSha256,
      });
    },
    onDiagnostic(diagnostic: U1RecoveryDiagnostic) {
      const safeDiagnostic = projectRecoveryDiagnostic(diagnostic);
      structureRecoveryDiagnostics.push(safeDiagnostic);
      emit("structure_recovery_diagnostic", {
        ...safeDiagnostic,
        findingCodes: [...safeDiagnostic.findingCodes],
      });
    },
  };
  const recoveryContextOf = (subject: U1RecoverySubject): U1RecoveryContext => ({
    subject,
    hooks: recoveryHooks,
  });

  if (
    args.policy.mode !== "standard" ||
    args.policy.explorationOnly ||
    args.policy.minChildGenerations > args.policy.maxGenerations
  ) {
    throw new AdaptiveRunError(
      "ADAPTIVE_MINIMUM_GENERATION_POLICY_INVALID",
      "ADAPTIVE_MINIMUM_GENERATION_POLICY_INVALID: current Adaptive must be standard, non-exploratory, and fund two child generations",
    );
  }

  if (
    args.policy.maxRefinementsPerCandidate > 0 &&
    args.policy.earlyRepair !== "off" &&
    !args.repairProposer
  ) {
    throw new AdaptiveRunError(
      "ADAPTIVE_RUN_REPAIR_PROPOSER_REQUIRED",
      "ADAPTIVE_RUN_REPAIR_PROPOSER_REQUIRED: the policy allows refinements "
        + `(maxRefinementsPerCandidate=${args.policy.maxRefinementsPerCandidate}, earlyRepair=${args.policy.earlyRepair}) `
        + "but no repairProposer was wired; refusing to run a refinement-capable policy without its repair lane",
    );
  }

  const itemTypeOf = new Map(items.map((item) => [item.itemId, item.itemType]));
  const candidates: AdaptiveRunCandidate[] = [];
  const byId = new Map<string, AdaptiveRunCandidate>();
  const candidateIdBySkillHash = new Map<string, string>();
  const evidenceByCandidate = new Map<string, Map<string, InstructionGateInput>>();
  const parallelTimings: ParallelTiming[] = [];
  let maxObservedInFlight = 0;
  const recoverySubjectOfCandidate = (
    candidate: Pick<AdaptiveRunCandidate, "candidateId" | "generation" | "childKind">,
  ): U1RecoverySubject => ({
    kind: "candidate",
    generation: candidate.generation,
    lane: candidate.generation === 0
      ? candidate.candidateId === args.anchor.candidateId ? "anchor" : "seed"
      : candidate.childKind ?? "exploit",
  });

  const trainFeedbackOf = (candidate: AdaptiveRunCandidate): U1MutationTrainFeedback => {
    const evaluation = candidate.evaluation;
    const evidence = evidenceByCandidate.get(candidate.candidateId);
    if (!evaluation || !evidence) return { failures: [], successes: [] };
    const scores = new Map((evaluation.itemScores ?? []).map((score) => [score.itemId, score]));
    const trainItemIds = new Set(args.contract.trainItemIds);
    const short = (value: string): string => value.slice(0, 240);
    const actualTypeOf = (value: unknown): string => {
      if (Array.isArray(value)) return "array";
      if (value === null) return "null";
      return typeof value;
    };

    const summaries = items
      .filter((item) => item.split === "public" && trainItemIds.has(item.itemId))
      .map((item): {
        feedback: U1MutationFeedbackItem;
        passed: boolean;
        hardOrCriticalFailure: boolean;
        lowestDimensionScore: number;
      } | null => {
        const run = evidence.get(item.itemId);
        const score = scores.get(item.itemId);
        if (!run || !score) return null;
        const verifierRules = item.taskVerifier?.rules ?? [];
        const answerRecord =
          run.transcript.parsedFinalAnswer !== null &&
          typeof run.transcript.parsedFinalAnswer === "object" &&
          !Array.isArray(run.transcript.parsedFinalAnswer)
            ? run.transcript.parsedFinalAnswer as Record<string, unknown>
            : null;
        const ruleFeedback = (score.evidence?.deterministic.ruleResults ?? []).map((result) => {
          const definition = verifierRules.find((rule) => rule.ruleId === result.ruleId);
          const effect = result.effect ?? (
            definition && "effect" in definition && typeof definition.effect === "string"
              ? definition.effect
              : undefined
          );
          return {
            ruleId: result.ruleId,
            kind: definition?.kind ?? "unknown",
            passed: result.passed,
            ...(effect ? { effect } : {}),
            ...(result.dimension ? { dimension: result.dimension } : {}),
            ...(result.failureCode ? { failureCode: result.failureCode } : {}),
            ...(definition && "field" in definition ? { field: definition.field } : {}),
            ...(definition?.kind === "output_field"
              ? { expectedType: definition.valueType }
              : definition?.kind === "numeric_value"
                ? { expectedType: "number" }
                : definition?.kind === "exact_value"
                  ? { expectedType: actualTypeOf(definition.expected) }
                  : {}),
            ...(definition && "field" in definition
              ? {
                  actualType: answerRecord && Object.prototype.hasOwnProperty.call(answerRecord, definition.field)
                    ? actualTypeOf(answerRecord[definition.field])
                    : "missing",
                }
              : {}),
            scope: "item-local" as const,
          };
        });
        const dimensionEvidence = score.evidence?.effectiveDimensions ?? score.evidence?.semantic.dimensions ?? [];
        const scenarioFamily = (item as FunnelEvalItem & { scenarioFamily?: string }).scenarioFamily;
        const feedback: U1MutationFeedbackItem = {
          itemId: item.itemId,
          itemType: item.itemType,
          ...(scenarioFamily ? { family: scenarioFamily } : {}),
          input: item.input,
          terminalReason: run.transcript.terminalReason,
          score: score.score,
          ...(ruleFeedback.length > 0 ? { rules: ruleFeedback } : {}),
          ...(dimensionEvidence.length > 0
            ? {
                dimensions: dimensionEvidence.map((dimension) => ({
                  id: dimension.id,
                  score: dimension.score,
                  reason: short(dimension.reason),
                })),
              }
            : {}),
          ...(run.transcript.toolEvents.length > 0
            ? {
                toolTrace: run.transcript.toolEvents.map((event) => ({
                  toolName: event.toolName,
                  ...(typeof event.args.id === "string" ? { logicalId: event.args.id } : {}),
                  success: event.success,
                })),
              }
            : {}),
        };
        const passed = contractItemPassed(score);
        const hardRuleFailed = ruleFeedback.some(
          (rule) => !rule.passed && (rule.effect === "hard_safety" || rule.effect === "hard_contract"),
        );
        return {
          feedback,
          passed,
          hardOrCriticalFailure: !passed && (hardRuleFailed || score.criticalFailure === true),
          lowestDimensionScore: dimensionEvidence.length > 0
            ? Math.min(...dimensionEvidence.map((dimension) => dimension.score))
            : Number.POSITIVE_INFINITY,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const stableFailureOrder = [...summaries].filter((entry) => !entry.passed).sort((left, right) =>
      Number(right.hardOrCriticalFailure) - Number(left.hardOrCriticalFailure) ||
      left.lowestDimensionScore - right.lowestDimensionScore ||
      left.feedback.itemId.localeCompare(right.feedback.itemId),
    );
    const stableSuccessOrder = [...summaries].filter((entry) => entry.passed).sort((left, right) =>
      left.feedback.itemId.localeCompare(right.feedback.itemId),
    );

    return {
      failures: stableFailureOrder.slice(0, 6).map((entry) => entry.feedback),
      successes: stableSuccessOrder.slice(0, 2).map((entry) => entry.feedback),
    };
  };

  const trainItemIdsForPrompt = new Set(args.contract.trainItemIds);
  const authorizedToolLogicalIds = [...new Set(items
    .filter((item) => item.split === "public" && trainItemIdsForPrompt.has(item.itemId))
    .flatMap((item) => item.taskVerifier?.rules ?? [])
    .flatMap((rule) => {
      const tool = "tool" in rule && typeof rule.tool === "string" ? rule.tool : null;
      const logicalId = "logicalId" in rule && typeof rule.logicalId === "string" ? rule.logicalId : null;
      if (!logicalId) return [];
      if (tool) return [`${tool}:${logicalId}`];
      if (rule.kind === "evidence_reference") {
        return [`${rule.resourceKind === "attachment" ? "attachment.read" : "reference.read"}:${logicalId}`];
      }
      return [];
    }))];

  const evaluate = async (
    candidateId: string,
    skillMd: string,
    requestedItems: FunnelEvalItem[],
    phase: "pinned" | "public",
    itemConcurrency: number = maxInFlight,
    recoverySubject?: U1RecoverySubject,
  ): Promise<AdaptiveEvaluation> => {
    const snapshotId = sha256Hex(skillMd).slice(0, 12);
    const evidence = evidenceByCandidate.get(candidateId) ?? new Map<string, InstructionGateInput>();
    evidenceByCandidate.set(candidateId, evidence);
    const missing = requestedItems.filter((item) => !evidence.has(item.itemId));
    cacheHits += requestedItems.length - missing.length;
    cacheMisses += missing.length;
    const batch = await mapBoundedStable(missing, itemConcurrency, async (item) => {
      const transcript = await args.runner({ item, skillMd, snapshotId });
      return {
        item: {
          itemId: item.itemId,
          split: "public" as const,
          itemType: item.itemType,
          scenarioId: item.scenarioId, input: item.input, judgingRule: item.judgingRule, ...(item.redlineRefs ? { redlineRefs: item.redlineRefs } : {}),
          rubric: item.rubric,
          taskVerifier: item.taskVerifier,
        },
        transcript,
      } satisfies InstructionGateInput;
    });
    parallelTimings.push(...batch.timings);
    maxObservedInFlight = Math.max(maxObservedInFlight, batch.maxObservedInFlight);
    for (const run of batch.values) evidence.set(run.item.itemId, run);
    const runs = requestedItems.map((item) => evidence.get(item.itemId)!);
    const recovery = recoverySubject ? recoveryContextOf(recoverySubject) : undefined;
    const scored = args.scoreRuns
      ? await args.scoreRuns({
          contract: args.contract,
          runs,
          recovery: recovery ?? (() => {
            throw new TypeError("ADAPTIVE_SEMANTIC_RECOVERY_SUBJECT_REQUIRED: each scored candidate needs a fixed recovery subject");
          })(),
        })
      : applyContractGates({ contract: args.contract, runs });
    const safetyFailures = scored.gateResults.filter((g) => g.category === "safety" && !g.passed).length;
    const qualityFailures = scored.gateResults.filter((g) => g.category === "quality" && !g.passed).length;
    const outcome: AdaptiveOutcome =
      safetyFailures > 0 ? "killed" : qualityFailures > 0 ? "safe_non_elite" : "elite";
    const applicationRecoveries = runs.flatMap((run) =>
      run.transcript.applicationRecovery
        ? [{ itemId: run.item.itemId, ...run.transcript.applicationRecovery }]
        : [],
    );
    return {
      publicScore: scored.publicScore,
      solvedItemIds: scored.itemScores.filter(contractItemPassed).map((entry) => entry.itemId),
      itemScores: scored.itemScores,
      gateResults: scored.gateResults,
      safetyFailures,
      qualityFailures,
      outcome,
      evaluatedItemIds: runs.map((run) => run.item.itemId),
      phase,
      ...(applicationRecoveries.length > 0 ? { applicationRecoveries } : {}),
    };
  };

  const record = (candidate: AdaptiveRunCandidate): void => {
    candidates.push(candidate);
    byId.set(candidate.candidateId, candidate);
    const hash = sha256Hex(candidate.skillMd);
    if (!candidateIdBySkillHash.has(hash) || candidate.candidateId === args.anchor.candidateId) {
      candidateIdBySkillHash.set(hash, candidate.candidateId);
    }
  };

  // The route state is always derived from the CURRENT candidate pool so a
  // budget stop at any point still yields an honest resubmission suggestion.
  const routeStateOf = (lastRepairProgressed: boolean | null, stagnation: number): AdaptiveRouteState => {
    const population = selectAdaptivePopulation({
      anchorCandidateId: args.anchor.candidateId,
      candidates,
    });
    const elite = population.eliteId ? (byId.get(population.eliteId) ?? null) : null;
    const killedCount = candidates.filter((c) => c.evaluation?.outcome === "killed").length;
    const safetyViolations = elite ? 0 : killedCount;

    const anchorCandidate = byId.get(args.anchor.candidateId) ?? null;
    const seedCandidates = (args.seeds ?? [])
      .map((seed) => byId.get(seed.candidateId) ?? null)
      .filter((c): c is AdaptiveRunCandidate => c?.evaluation != null);
    const unsolvedSet = (evaluation: AdaptiveEvaluation): Set<string> =>
      new Set(items.map((item) => item.itemId).filter((id) => !evaluation.solvedItemIds.includes(id)));
    const sameSet = (a: Set<string>, b: Set<string>): boolean =>
      a.size === b.size && [...a].every((id) => b.has(id));
    // A pinned slice is a safety/triage screen, not enough evidence to
    // conclude that two roots share one global failure.  Otherwise omitted
    // public items would be treated as failures and a rough U1 skill could be
    // rebuilt before either mutation lane is allowed to help it.
    const hasFullPublicEvidence = (evaluation: AdaptiveEvaluation | null | undefined): boolean =>
      evaluation?.phase === "public" ||
      (evaluation?.evaluatedItemIds?.length === items.length &&
        items.every((item) => evaluation.evaluatedItemIds!.includes(item.itemId)));
    const rootsHaveFullPublicEvidence =
      hasFullPublicEvidence(anchorCandidate?.evaluation) &&
      seedCandidates.length > 0 &&
      seedCandidates.every((candidate) => hasFullPublicEvidence(candidate.evaluation));
    const b0s0SameCoreFailure =
      rootsHaveFullPublicEvidence &&
      anchorCandidate?.evaluation != null &&
      seedCandidates.length > 0 &&
      anchorCandidate.evaluation.outcome !== "elite" &&
      seedCandidates.every((c) => c.evaluation!.outcome !== "elite") &&
      seedCandidates.every((c) => sameSet(unsolvedSet(anchorCandidate.evaluation!), unsolvedSet(c.evaluation!)));

    const confidenceFloor = args.contract.thresholds.confidenceFloor;
    const contractConfidenceLow =
      args.contract.goalConfidence.score < confidenceFloor ||
      args.contract.evalConfidence.score < confidenceFloor;

    const eliteUnsolvedTypes = elite
      ? [
          ...new Set(
            items
              .filter((item) => !elite.evaluation!.solvedItemIds.includes(item.itemId))
              .map((item) => itemTypeOf.get(item.itemId)!),
          ),
        ]
      : [];

    const parent = elite?.parentCandidateId ? (byId.get(elite.parentCandidateId) ?? null) : null;
    const protectedDimensionRegression =
      elite?.evaluation != null &&
      parent?.evaluation != null &&
      elite.evaluation.solvedItemIds.length < parent.evaluation.solvedItemIds.length;

    return {
      budgetRemainingLogicalCalls: args.budget.caps.maxLogicalCalls - args.budget.accounting.logicalCalls,
      safetyViolations,
      b0s0SameCoreFailure,
      contractConfidenceLow,
      failureClasses: eliteUnsolvedTypes,
      protectedDimensionRegression,
      lastRepairProgressed,
      refinementsUsed: elite?.refinementsUsed ?? 0,
      consecutiveStagnation: stagnation,
    };
  };

  const budgetStop = (e: ProviderBudgetError): StopState => ({
    reason: "budget_exhausted",
    detail: e.message,
    recovery: recoverySuggestionForStop(routeStateOf(lastRepairProgressed, consecutiveStagnation)),
  });

  let stop: StopState | null = null;
  let lastRepairProgressed: boolean | null = null;
  let consecutiveStagnation = 0;
  let deferred: AdaptiveRunCandidate[] = [];

  emit("run_start", {
    contractSha256: args.contract.contractSha256,
    publicItems: items.length,
    roots: declaredRoots.map((root) => root.candidateId),
    explorationOnly: args.policy.explorationOnly,
    minChildGenerations: args.policy.minChildGenerations,
  });
  for (const duplicate of duplicateRoots) {
    emit("root_duplicate_skipped", {
      candidateId: duplicate.candidateId,
      skillSha256: sha256Hex(duplicate.skillMd),
      reason: "identical SKILL.md content is evaluated once and cannot occupy another population seat",
    });
  }

  // Fully evaluate each unique B0/S0 content before the first parent selection.
  try {
    const rootBatch = await mapBoundedStable(rootRepresentatives, maxInFlight, async (root) => ({
      root,
      evaluation: await evaluate(
        root.candidateId,
        root.skillMd,
        items,
        "public",
        1,
        { kind: "candidate", generation: 0, lane: root.candidateId === args.anchor.candidateId ? "anchor" : "seed" },
      ),
    }));
    maxObservedInFlight = Math.max(maxObservedInFlight, rootBatch.maxObservedInFlight);
    const rootEvaluationByHash = new Map(
      rootBatch.values.map(({ root, evaluation }) => [sha256Hex(root.skillMd), evaluation]),
    );
    for (const root of declaredRoots) {
      const evaluation = rootEvaluationByHash.get(sha256Hex(root.skillMd))!;
      record({
        candidateId: root.candidateId,
        originRoot: root.originRoot,
        generation: 0,
        parentCandidateId: null,
        childKind: null,
        skillMd: root.skillMd,
        evaluation,
        refinementsUsed: 0,
      });
      emit("candidate_screened", {
        candidateId: root.candidateId,
        pinnedScore: evaluation.publicScore,
        outcome: evaluation.outcome,
      });
    }
  } catch (e) {
    if (e instanceof ProviderBudgetError) {
      stop = budgetStop(e);
    } else {
      throw e;
    }
  }

  let population = selectAdaptivePopulation({
    anchorCandidateId: args.anchor.candidateId,
    candidates,
  });
  const generations: AdaptiveGenerationLedger[] = [];
  let u1NoValidChildGeneration: number | null = null;
  const laneByCandidateId = new Map<string, { lane: AdaptiveLaneLedger; ledger: AdaptiveGenerationLedger }>();

  const proposeMutations = async (
    generation: number,
    eliteParent: AdaptiveRunCandidate,
    diversityParent: AdaptiveRunCandidate,
    state: AdaptiveRouteState,
    evaluateChildren: boolean,
    ledger: AdaptiveGenerationLedger,
    exploitLanePurpose: "exploit_known_failures" | "repair_incompatible_b0" = "exploit_known_failures",
  ): Promise<void> => {
    const kinds = ["exploit", "diversify"] as const;
    const feedbackByKind = new Map(kinds.map((kind) => {
      const parent = kind === "exploit" ? eliteParent : diversityParent;
      const feedback = trainFeedbackOf(parent);
      return [kind, feedback] as const;
    }));
    const lanes = kinds.map((kind): AdaptiveLaneLedger => {
      const parent = kind === "exploit" ? eliteParent : diversityParent;
      const feedback = feedbackByKind.get(kind)!;
      return {
        kind,
        candidateId: `g${generation}-${kind}`,
        parentCandidateId: parent.candidateId,
        parentRole: kind === "exploit" ? "elite" : "diversity",
        status: "proposed",
        detailStatus: "requested",
        feedbackSha256: sha256Hex(stableStringify(feedback)),
        feedbackFailureCount: feedback.failures.length,
        feedbackSuccessCount: feedback.successes.length,
      };
    });
    ledger.lanes.push(...lanes);
    ledger.childrenAttempted += lanes.length;
    emit("mutation_lanes_requested", {
      generation,
      lanes: lanes.map((lane) => ({ kind: lane.kind, candidateId: lane.candidateId })),
    });

    const proposalBatch = await mapBoundedSettled(
      kinds,
      Math.min(maxInFlight, 2),
      async (kind) => {
        const recovery = recoveryContextOf({ kind: "candidate", generation, lane: kind });
        return {
          kind,
          proposal: await args.mutationProposer.proposeMutation({
          eliteSkillMd: kind === "exploit" ? eliteParent.skillMd : diversityParent.skillMd,
          diversitySkillMd: kind === "exploit" ? diversityParent.skillMd : eliteParent.skillMd,
          failureClasses: state.failureClasses,
          lanePurpose: kind === "exploit" ? exploitLanePurpose : "diversify_alternative",
          trainFeedback: feedbackByKind.get(kind)!,
          taskCard: proposerTaskCard,
          contract: { ...args.contract, authorizedToolLogicalIds },
          ...(recovery ? { recovery } : {}),
          }),
        };
      },
    );
    parallelTimings.push(...proposalBatch.timings);
    maxObservedInFlight = Math.max(maxObservedInFlight, proposalBatch.maxObservedInFlight);
    const children: AdaptiveRunCandidate[] = [];
    let fatalError: unknown = null;
    proposalBatch.values.forEach((settled, index) => {
      const kind = kinds[index];
      const lane = lanes[index];
      if (settled.status === "rejected") {
        const error = settled.reason;
        if (candidateLocalProposalError(error)) {
          lane.status = "candidate_rejected";
          lane.detailStatus = rejectedLaneDetail(error);
          lane.failureCode = error.code;
          lane.findingCodes = [...new Set(error.findings.map((finding) => `${finding.code}:${finding.kind}`))];
          ledger.childrenRejected += 1;
          emit("mutation_lane_rejected", {
            generation,
            kind,
            candidateId: lane.candidateId,
            failureCode: error.code,
            findingCodes: lane.findingCodes,
          });
          return;
        }
        if (error instanceof ProviderBudgetError) {
          lane.status = "budget_failed";
          lane.detailStatus = "budget_failed";
          lane.failureCode = "PROVIDER_BUDGET_EXCEEDED";
        } else {
          lane.status = "provider_failed";
          lane.detailStatus = "provider_failed";
          lane.failureCode = error instanceof LiveProposalError ? error.code : "MUTATION_PROVIDER_FAILED";
        }
        fatalError ??= error;
        return;
      }

      if (settled.value.proposal.decision === "no_change") {
        lane.status = "no_change";
        lane.detailStatus = "no_change";
        ledger.childrenNoChange += 1;
        emit("mutation_lane_no_change", {
          generation,
          kind,
          candidateId: lane.candidateId,
        });
        return;
      }

      const proposedHash = sha256Hex(settled.value.proposal.skillMd);
      const duplicateOf = candidateIdBySkillHash.get(proposedHash) ??
        children.find((candidate) => sha256Hex(candidate.skillMd) === proposedHash)?.candidateId ??
        deferred.find((candidate) => sha256Hex(candidate.skillMd) === proposedHash)?.candidateId;
      if (duplicateOf) {
        lane.status = "no_change";
        lane.detailStatus = "no_change";
        ledger.childrenNoChange += 1;
        emit("mutation_lane_duplicate", {
          generation,
          kind,
          candidateId: lane.candidateId,
          duplicateOf,
          skillSha256: proposedHash,
        });
        return;
      }

      lane.status = "proposed";
      lane.detailStatus = "generated";
      ledger.childrenGenerated += 1;
      ledger.childrenProposed += 1;
      const parent = kind === "exploit" ? eliteParent : diversityParent;
      const child: AdaptiveRunCandidate = {
        candidateId: lane.candidateId,
        originRoot: parent.originRoot,
        generation,
        parentCandidateId: parent.candidateId,
        childKind: kind,
        skillMd: settled.value.proposal.skillMd,
        evaluation: null,
        refinementsUsed: parent.refinementsUsed ?? 0,
        hypothesis: settled.value.proposal.hypothesis,
      };
      children.push(child);
      candidateIdBySkillHash.set(proposedHash, child.candidateId);
      laneByCandidateId.set(child.candidateId, { lane, ledger });
    });

    if (fatalError !== null) throw fatalError;
    if (children.length === 0) {
      u1NoValidChildGeneration = generation;
      return;
    }

    if (!evaluateChildren) {
      for (const child of children) {
        record(child);
        deferred.push(child);
      }
      emit("children_deferred", { generation, candidateIds: children.map((c) => c.candidateId) });
      return;
    }

    const evaluationBatch = await mapBoundedSettled(children, maxInFlight, async (child) => ({
      child,
      evaluation: await evaluate(
        child.candidateId,
        child.skillMd,
        pinnedItems,
        "pinned",
        1,
        recoverySubjectOfCandidate(child),
      ),
    }));
    maxObservedInFlight = Math.max(maxObservedInFlight, evaluationBatch.maxObservedInFlight);
    let evaluationFatalError: unknown = null;
    for (let settledIndex = 0; settledIndex < evaluationBatch.values.length; settledIndex += 1) {
      const settled = evaluationBatch.values[settledIndex];
      if (settled.status === "rejected") {
        const child = children[settledIndex];
        const laneState = laneByCandidateId.get(child.candidateId);
        if (candidateLocalSemanticError(settled.reason) && laneState) {
          laneState.lane.status = "candidate_rejected";
          laneState.lane.detailStatus = "rejected_by_schema";
          laneState.lane.failureCode = settled.reason.code;
          laneState.ledger.childrenGenerated -= 1;
          laneState.ledger.childrenProposed -= 1;
          laneState.ledger.childrenRejected += 1;
          emit("mutation_lane_rejected", {
            generation,
            kind: laneState.lane.kind,
            candidateId: laneState.lane.candidateId,
            failureCode: settled.reason.code,
          });
          continue;
        }
        evaluationFatalError ??= settled.reason;
        continue;
      }
      const { child, evaluation } = settled.value;
      ledger.childrenEvaluated += 1;
      ledger.childrenScreened += 1;
      child.evaluation = evaluation;
      record(child);
      const laneState = laneByCandidateId.get(child.candidateId);
      if (laneState) {
        laneState.lane.status = "evaluated";
        laneState.lane.detailStatus = "screened";
      }
      emit("candidate_screened", {
        candidateId: child.candidateId,
        pinnedScore: evaluation.publicScore,
        outcome: evaluation.outcome,
      });
    }
    if (evaluationFatalError !== null) throw evaluationFatalError;
  };

  /** A slice pass is only a screening result. Acceptance needs all public evidence. */
  const promotePinnedCandidates = async (): Promise<void> => {
    const survivors = candidates.filter(
      (candidate) => candidate.evaluation?.phase === "pinned" && candidate.evaluation.outcome !== "killed",
    );
    const promotionBatch = await mapBoundedSettled(survivors, maxInFlight, async (candidate) => ({
      candidate,
      evaluation: await evaluate(
        candidate.candidateId,
        candidate.skillMd,
        items,
        "public",
        1,
        recoverySubjectOfCandidate(candidate),
      ),
    }));
    maxObservedInFlight = Math.max(maxObservedInFlight, promotionBatch.maxObservedInFlight);
    let promotionFatalError: unknown = null;
    for (let settledIndex = 0; settledIndex < promotionBatch.values.length; settledIndex += 1) {
      const settled = promotionBatch.values[settledIndex];
      if (settled.status === "rejected") {
        const candidate = survivors[settledIndex];
        const laneState = laneByCandidateId.get(candidate.candidateId);
        if (candidate.generation > 0 && candidateLocalSemanticError(settled.reason) && laneState) {
          laneState.lane.status = "candidate_rejected";
          laneState.lane.detailStatus = "rejected_by_schema";
          laneState.lane.failureCode = settled.reason.code;
          laneState.ledger.childrenGenerated -= 1;
          laneState.ledger.childrenProposed -= 1;
          laneState.ledger.childrenEvaluated -= 1;
          laneState.ledger.childrenScreened -= 1;
          laneState.ledger.childrenRejected += 1;
          const candidateIndex = candidates.findIndex((entry) => entry.candidateId === candidate.candidateId);
          if (candidateIndex >= 0) candidates.splice(candidateIndex, 1);
          byId.delete(candidate.candidateId);
          evidenceByCandidate.delete(candidate.candidateId);
          emit("mutation_lane_rejected", {
            generation: candidate.generation,
            kind: laneState.lane.kind,
            candidateId: laneState.lane.candidateId,
            failureCode: settled.reason.code,
          });
          continue;
        }
        promotionFatalError ??= settled.reason;
        continue;
      }
      const { candidate, evaluation } = settled.value;
      candidate.evaluation = evaluation;
      const laneState = laneByCandidateId.get(candidate.candidateId);
      if (laneState) {
        laneState.lane.status = "evaluated";
        laneState.lane.detailStatus =
          evaluation.outcome === "elite"
            ? "elite_eligible"
            : evaluation.outcome === "killed"
              ? "screened"
              : "safe_non_elite";
        if (evaluation.outcome !== "killed") {
          laneState.ledger.childrenPromoted += 1;
          laneState.ledger.childrenAccepted += 1;
        }
      }
      emit("candidate_evaluated", {
        candidateId: candidate.candidateId,
        publicScore: evaluation.publicScore,
        outcome: evaluation.outcome,
      });
    }
    if (promotionFatalError !== null) throw promotionFatalError;
  };

  if (!stop) {
    outer: for (let generation = 1; generation <= args.policy.maxGenerations; generation += 1) {
      // ── Deferred children from the previous generation are evaluated first ──
      const hasDeferredChildren = deferred.length > 0;
      for (const child of deferred) {
        try {
          const evaluation = await evaluate(
            child.candidateId,
            child.skillMd,
            pinnedItems,
            "pinned",
            1,
            recoverySubjectOfCandidate(child),
          );
          child.evaluation = evaluation;
          const laneState = laneByCandidateId.get(child.candidateId);
          if (laneState) {
            laneState.lane.status = "evaluated";
            laneState.lane.detailStatus = "screened";
            laneState.ledger.childrenScreened += 1;
            laneState.ledger.childrenEvaluated += 1;
          }
          emit("candidate_evaluated", {
            candidateId: child.candidateId,
            publicScore: evaluation.publicScore,
            outcome: evaluation.outcome,
          });
        } catch (e) {
          if (e instanceof ProviderBudgetError) {
            stop = budgetStop(e);
            break outer;
          }
          throw e;
        }
      }
      deferred = [];

      if (hasDeferredChildren) {
        try {
          await promotePinnedCandidates();
        } catch (e) {
          if (e instanceof ProviderBudgetError) {
            stop = budgetStop(e);
            break outer;
          }
          throw e;
        }
      }

      population = selectAdaptivePopulation({
        anchorCandidateId: args.anchor.candidateId,
        candidates,
      });
      const currentElite = population.eliteId ? (byId.get(population.eliteId) ?? null) : null;
      const completedBeforeRoute = generations.length;
      const minimumGenerationPending =
        completedBeforeRoute < args.policy.minChildGenerations;
      const eliteHasFullPublicSuccess =
        currentElite?.evaluation?.outcome === "elite" &&
        currentElite.evaluation.solvedItemIds.length === items.length &&
        currentElite.evaluation.evaluatedItemIds?.length === items.length &&
        items.every((item) => currentElite.evaluation!.evaluatedItemIds!.includes(item.itemId));
      if (args.stopOnPublicGoal && eliteHasFullPublicSuccess) {
        if (minimumGenerationPending) {
          emit("minimum_generation_stop_deferred", {
            generation,
            requestedStop: "public_goal_met",
            completedChildGenerations: completedBeforeRoute,
            minChildGenerations: args.policy.minChildGenerations,
            candidateId: currentElite!.candidateId,
          });
        } else {
          stop = {
            reason: "public_goal_met",
            detail: `public_goal_met: ${currentElite!.candidateId} passed every frozen public item and all gates; no further mutation or refinement is justified`,
          };
          emit("public_goal_met", { generation, candidateId: currentElite!.candidateId });
          break;
        }
      }
      const bestBefore =
        population.eliteId && byId.get(population.eliteId)?.evaluation
          ? byId.get(population.eliteId)!.evaluation!.publicScore
          : null;

      const observedState = routeStateOf(lastRepairProgressed, consecutiveStagnation);
      const state = observedState;
      const routedDecision = routeAdaptiveStep(args.policy, state);
      let decision = routedDecision;
      let repairIncompatibleB0 = false;
      if (minimumGenerationPending) {
        const deferStagnationStop =
          routedDecision.route === "stop" &&
          state.budgetRemainingLogicalCalls > 0 &&
          state.consecutiveStagnation >= args.policy.stagnationPatience;
        if (routedDecision.route === "refine_elite" || deferStagnationStop) {
          decision = {
            route: "targeted_mutation",
            reason:
              `minimum_generation_override: ${routedDecision.route} is deferred until `
              + `${args.policy.minChildGenerations} settled child-generation slots; `
              + "run exploit + diversify from the current Elite/Diversity seats",
            recoverySuggestion: "mutate",
            requiresProgressCertificate: false,
          };
          emit("minimum_generation_route_override", {
            generation,
            originalRoute: routedDecision.route,
            route: decision.route,
            completedChildGenerations: completedBeforeRoute,
            minChildGenerations: args.policy.minChildGenerations,
          });
        }
      }
      if (routedDecision.route === "root_rebuild") {
        repairIncompatibleB0 = true;
        decision = {
          route: "targeted_mutation",
          reason:
            `current_incompatible_b0_repair: ${routedDecision.reason}; keep B0 immutable and derive `
            + "an exploit child with repair_incompatible_b0 while the diversify lane continues from S0/Diversity",
          recoverySuggestion: "mutate",
          requiresProgressCertificate: false,
        };
        emit("root_rebuild_derived_repair", {
          generation,
          originalRoute: routedDecision.route,
          route: decision.route,
          immutableRootCandidateId: args.anchor.candidateId,
        });
      }
      emit("route_decision", {
        generation,
        route: decision.route,
        reason: decision.reason,
        originalRoute: routedDecision.route,
      });

      if (decision.route === "stop") {
        stop = {
          reason:
            state.consecutiveStagnation >= args.policy.stagnationPatience
              ? "stagnation_stop"
              : "budget_exhausted",
          detail: decision.reason,
          recovery: decision.recoverySuggestion,
        };
        break;
      }
      if (decision.route === "killed_rebuild") {
        stop = { reason: "safety_kill", detail: decision.reason, recovery: decision.recoverySuggestion };
        emit("safety_kill", { generation, detail: decision.reason });
        break;
      }
      if (decision.route === "root_rebuild") {
        stop = { reason: "root_rebuild", detail: decision.reason, recovery: decision.recoverySuggestion };
        emit("root_rebuild", { generation, detail: decision.reason });
        break;
      }

      const wallStart = Date.now();
      const ledger: AdaptiveGenerationLedger = {
        generation,
        route: decision.route,
        reason: decision.reason,
        entryAnchorId: population.anchorCandidateId,
        entryEliteId: population.eliteId ?? population.anchorCandidateId,
        entryDiversityId: population.diversityId ?? population.eliteId ?? population.anchorCandidateId,
        wallTimeMs: 0,
        childrenProposed: 0,
        childrenEvaluated: 0,
        childrenAccepted: 0,
        childrenAttempted: 0,
        childrenGenerated: 0,
        childrenRejected: 0,
        childrenNoChange: 0,
        childrenScreened: 0,
        childrenPromoted: 0,
        lanes: [],
      };
      emit("generation_start", { generation, route: decision.route });

      const selectedEliteParent =
        (population.eliteId ? byId.get(population.eliteId) : null) ?? byId.get(args.anchor.candidateId)!;
      const selectedDiversityParent =
        (population.diversityId ? byId.get(population.diversityId) : null) ?? selectedEliteParent;
      const immutableB0Parent = byId.get(args.anchor.candidateId)!;
      const distinctSeedParent = (args.seeds ?? [])
        .map((seed) => byId.get(seed.candidateId) ?? null)
        .find((candidate): candidate is AdaptiveRunCandidate =>
          candidate !== null && sha256Hex(candidate.skillMd) !== sha256Hex(immutableB0Parent.skillMd)
        );
      const eliteParent = repairIncompatibleB0 ? immutableB0Parent : selectedEliteParent;
      const diversityParent = repairIncompatibleB0
        ? (distinctSeedParent ?? selectedDiversityParent)
        : selectedDiversityParent;

      try {
        if (decision.route === "refine_elite" && eliteParent.evaluation) {
          const parentEvaluation = eliteParent.evaluation;
          const repairStartedAtMs = Date.now();
          const proposal = await args.repairProposer!.proposeTargetedRepair({
            ticket: {
              schemaVersion: 3,
              candidateId: eliteParent.candidateId,
              split: "public",
              minimalFailureReason:
                parentEvaluation.qualityFailures > 0
                  ? `${parentEvaluation.qualityFailures} bounded quality finding(s) require repair`
                  : "elite refinement requested by the adaptive route",
              editableFiles: ["SKILL.md"],
              repairBudget: args.policy.maxRefinementsPerCandidate,
              repairsUsed: eliteParent.refinementsUsed ?? 0,
            },
            skillMd: eliteParent.skillMd,
            trainFeedback: trainFeedbackOf(eliteParent),
            adapterId: args.contract.adapterId,
            taskCard: proposerTaskCard,
            lanePurpose: "exploit_known_failures",
            failureClasses: state.failureClasses,
            authorizedToolLogicalIds,
            recovery: recoveryContextOf({ kind: "candidate", generation, lane: "exploit" }),
          });
          const repairEndedAtMs = Date.now();
          parallelTimings.push({
            index: parallelTimings.length,
            startedAtMs: repairStartedAtMs,
            endedAtMs: repairEndedAtMs,
            durationMs: repairEndedAtMs - repairStartedAtMs,
          });
          const repairDuplicateOf = candidateIdBySkillHash.get(sha256Hex(proposal.skillMd));
          if (proposal.decision === "no_change" || repairDuplicateOf) {
            lastRepairProgressed = false;
            emit(repairDuplicateOf ? "repair_duplicate_no_change" : "repair_no_change", {
              generation,
              candidateId: eliteParent.candidateId,
              ...(repairDuplicateOf ? { duplicateOf: repairDuplicateOf } : {}),
            });
            const fallbackState = {
              ...state,
              refinementsUsed: state.refinementsUsed + 1,
              lastRepairProgressed: false,
            };
            const fallback = routeAdaptiveStep(args.policy, fallbackState);
            if (fallback.route === "targeted_mutation") {
              await proposeMutations(
                generation,
                eliteParent,
                diversityParent,
                fallbackState,
                true,
                ledger,
              );
            }
          } else {
            ledger.childrenProposed += 1;
          ledger.childrenAttempted += 1;
          ledger.childrenGenerated += 1;

          const child: AdaptiveRunCandidate = {
            candidateId: `g${generation}-refine`,
            originRoot: eliteParent.originRoot,
            generation,
            parentCandidateId: eliteParent.candidateId,
            childKind: "exploit",
            skillMd: proposal.skillMd,
            evaluation: null,
            refinementsUsed: (eliteParent.refinementsUsed ?? 0) + 1,
            hypothesis: proposal.hypothesis,
          };
          candidateIdBySkillHash.set(sha256Hex(child.skillMd), child.candidateId);
          let childEvaluation = await evaluate(
            child.candidateId,
            child.skillMd,
            pinnedItems,
            "pinned",
            maxInFlight,
            recoverySubjectOfCandidate(child),
          );
          if (childEvaluation.outcome !== "killed") {
            childEvaluation = await evaluate(
              child.candidateId,
              child.skillMd,
              items,
              "public",
              maxInFlight,
              recoverySubjectOfCandidate(child),
            );
          }
          ledger.childrenEvaluated += 1;
          ledger.childrenScreened += 1;

          if (decision.requiresProgressCertificate) {
            const certificate = progressCertificateOf({
              hardGateViolations: childEvaluation.safetyFailures,
              criticalFailureDrop:
                parentEvaluation.safetyFailures +
                parentEvaluation.qualityFailures -
                (childEvaluation.safetyFailures + childEvaluation.qualityFailures),
              scoreImprovement: childEvaluation.publicScore - parentEvaluation.publicScore,
              protectedDimensionRegression:
                childEvaluation.solvedItemIds.length < parentEvaluation.solvedItemIds.length,
              minRepairProgress: args.policy.minRepairProgress,
            });
            if (!certificate.granted) {
              lastRepairProgressed = false;
              emit("certificate_denied", {
                generation,
                candidateId: child.candidateId,
                failedConditions: certificate.failedConditions,
              });
              // The repair lane is spent for this generation: re-route with the
              // stalled-repair fact and let targeted mutation propose instead.
              // Its children are deferred — this generation's evaluation budget
              // already went to the denied repair.
              const fallbackState = { ...state, lastRepairProgressed: false };
              const fallback = routeAdaptiveStep(args.policy, fallbackState);
              if (fallback.route === "targeted_mutation") {
                await proposeMutations(generation, eliteParent, diversityParent, fallbackState, false, ledger);
              }
            } else {
              lastRepairProgressed = true;
              child.evaluation = childEvaluation;
              record(child);
              ledger.childrenAccepted += 1;
              ledger.childrenPromoted += 1;
              emit("candidate_evaluated", {
                candidateId: child.candidateId,
                publicScore: childEvaluation.publicScore,
                outcome: childEvaluation.outcome,
              });
            }
          } else {
            child.evaluation = childEvaluation;
            record(child);
            ledger.childrenAccepted += 1;
            ledger.childrenPromoted += 1;
            lastRepairProgressed =
              childEvaluation.publicScore - parentEvaluation.publicScore >=
                args.policy.minRepairProgress ||
              childEvaluation.safetyFailures + childEvaluation.qualityFailures <
                parentEvaluation.safetyFailures + parentEvaluation.qualityFailures;
            emit("candidate_evaluated", {
              candidateId: child.candidateId,
              publicScore: childEvaluation.publicScore,
              outcome: childEvaluation.outcome,
            });
          }
          }
        } else {
        await proposeMutations(
          generation,
          eliteParent,
          diversityParent,
          state,
          true,
          ledger,
          repairIncompatibleB0 ? "repair_incompatible_b0" : "exploit_known_failures",
        );
      }
      await promotePinnedCandidates();
      } catch (e) {
        if (e instanceof ProviderBudgetError) {
          stop = budgetStop(e);
          emit("budget_exhausted", { generation, detail: e.message });
        } else if (e instanceof NoValidMutationChildError) {
          stop = { reason: "no_valid_child", detail: e.message };
          emit("no_valid_child", {
            generation,
            detail: e.message,
            lanes: ledger.lanes,
          });
        } else if (e instanceof LiveProposalError || e instanceof RepairFrontierError) {
          // Both live proposer lanes fail closed as structured stops —
          // RepairFrontierError from the provider-backed repair factory and
          // LiveProposalError from the mutation factory. Neither may rethrow
          // out of the loop nor fall back to a fixture candidate.
          stop = { reason: "proposer_failure", detail: e.message };
          emit("proposer_failure", { generation, detail: e.message });
        } else {
          ledger.wallTimeMs = Date.now() - wallStart;
          generations.push(ledger);
          throw e;
        }
        ledger.wallTimeMs = Date.now() - wallStart;
        generations.push(ledger);
        break;
      }

      const viableLaneCount = ledger.lanes.filter((lane) => {
        if (lane.status !== "evaluated") return false;
        const child = byId.get(lane.candidateId);
        return child?.evaluation?.phase === "public" && child.evaluation.outcome !== "killed";
      }).length;
      ledger.generationCoverage = viableLaneCount === 2
        ? "full"
        : viableLaneCount === 1
          ? "partial"
          : "none";
      ledger.wallTimeMs = Date.now() - wallStart;
      generations.push(ledger);

      population = selectAdaptivePopulation({
        anchorCandidateId: args.anchor.candidateId,
        candidates,
      });
      const bestAfter =
        population.eliteId && byId.get(population.eliteId)?.evaluation
          ? byId.get(population.eliteId)!.evaluation!.publicScore
          : null;
      const progressed =
        bestBefore !== null && bestAfter !== null ? bestAfter > bestBefore : bestAfter !== null;
      consecutiveStagnation = advanceStagnation(consecutiveStagnation, progressed);
      const generationEndPayloadBase = {
        generation,
        stagnation: consecutiveStagnation,
        entryAnchorId: ledger.entryAnchorId,
        entryEliteId: ledger.entryEliteId,
        entryDiversityId: ledger.entryDiversityId,
        anchorId: population.anchorCandidateId,
        eliteId: population.eliteId,
        diversityId: population.diversityId,
        childrenAttempted: ledger.childrenAttempted,
        childrenGenerated: ledger.childrenGenerated,
        childrenRejected: ledger.childrenRejected,
        childrenNoChange: ledger.childrenNoChange,
        childrenEvaluated: ledger.childrenEvaluated,
        childrenScreened: ledger.childrenScreened,
        generationCoverage: ledger.generationCoverage,
        lanes: ledger.lanes.map((lane) => ({
          kind: lane.kind,
          candidateId: lane.candidateId,
          status: lane.status,
          parentCandidateId: lane.parentCandidateId,
          parentRole: lane.parentRole,
          feedbackSha256: lane.feedbackSha256,
          feedbackFailureCount: lane.feedbackFailureCount,
          feedbackSuccessCount: lane.feedbackSuccessCount,
        })),
      };
      const generationEndPayload: Record<string, unknown> = {
        ...generationEndPayloadBase,
        completedGenerationSlots: generation,
        minChildGenerations: args.policy.minChildGenerations,
        minGenerationSlotsSatisfied: generation >= args.policy.minChildGenerations,
      };
      emit("generation_end", generationEndPayload);

      if (u1NoValidChildGeneration === generation) {
        stop = {
          reason: "no_valid_child",
          detail: `no_valid_child: generation ${generation} settled with no edit child; no_change is a normal terminal outcome`,
        };
        emit("no_valid_child", {
          generation,
          generationCoverage: ledger.generationCoverage,
          noChangeLanes: ledger.childrenNoChange,
        });
        break outer;
      }

      if (generation >= args.policy.minChildGenerations) {
        const terminalElite = population.eliteId ? (byId.get(population.eliteId) ?? null) : null;
        const terminalEliteHasFullPublicSuccess =
          terminalElite?.evaluation?.outcome === "elite" &&
          terminalElite.evaluation.solvedItemIds.length === items.length &&
          terminalElite.evaluation.evaluatedItemIds?.length === items.length &&
          items.every((item) => terminalElite.evaluation!.evaluatedItemIds!.includes(item.itemId));
        if (args.stopOnPublicGoal && terminalEliteHasFullPublicSuccess) {
          stop = {
            reason: "public_goal_met",
            detail:
              `public_goal_met: ${terminalElite!.candidateId} passed every frozen public item and all gates `
              + `after ${generation} settled generation slots`,
          };
          emit("public_goal_met", {
            generation,
            candidateId: terminalElite!.candidateId,
            completedGenerationSlots: generation,
          });
          break outer;
        }
        if (consecutiveStagnation >= args.policy.stagnationPatience) {
          stop = {
            reason: "stagnation_stop",
            detail:
              `stagnation: ${consecutiveStagnation} consecutive generation(s) without progress reached the patience limit `
              + `after ${generation} settled generation slots`,
            recovery: recoverySuggestionForStop(routeStateOf(lastRepairProgressed, consecutiveStagnation)),
          };
          emit("stagnation_stop", {
            generation,
            completedGenerationSlots: generation,
            stagnation: consecutiveStagnation,
          });
          break outer;
        }
      }
    }
  }

  if (!stop && generations.length < args.policy.minChildGenerations) {
    throw new AdaptiveRunError(
      "ADAPTIVE_MINIMUM_GENERATION_INCOMPLETE",
      `ADAPTIVE_MINIMUM_GENERATION_INCOMPLETE: settled ${generations.length}/${args.policy.minChildGenerations} required generation slots`,
    );
  }

  if (!stop) {
    stop = {
      reason: "generations_completed",
      detail: `completed ${args.policy.maxGenerations} generation(s) within budget; final elite ${population.eliteId ?? "none"}`,
    };
  }

  const finalElite = population.eliteId ? (byId.get(population.eliteId) ?? null) : null;
  const applicationRecoveryByContentItem = new Map<string, RunApplicationRecoveryEvidence & { itemId: string }>();
  for (const candidate of candidates) {
    for (const recovery of candidate.evaluation?.applicationRecoveries ?? []) {
      const contentIdentity = sha256Hex(candidate.skillMd);
      const identity = `${contentIdentity}:${recovery.itemId}`;
      if (!applicationRecoveryByContentItem.has(identity)) {
        applicationRecoveryByContentItem.set(identity, recovery);
      }
    }
  }
  const applicationRecoveries = [...applicationRecoveryByContentItem.values()];
  const loopRecoveries = applicationRecoveries.filter((entry) => entry.attempts.length === 2);
  const applicationLoopRecovery: AdaptiveLoopRecoverySummary | undefined = loopRecoveries.length > 0
    ? {
        attemptedItems: loopRecoveries.length,
        recoveredAfterSingleRetry: loopRecoveries.filter((entry) => entry.outcome === "recovered_after_single_retry").length,
        persistentCandidateLoops: loopRecoveries.filter((entry) => entry.outcome === "persistent_candidate_loop").length,
        retryCompletedNonFinal: loopRecoveries.filter((entry) => entry.outcome === "retry_completed_non_final").length,
        additionalModelCalls: loopRecoveries.reduce(
          (sum, entry) => sum + (entry.attempts[1]?.modelCalls ?? 0),
          0,
        ),
      }
    : undefined;
  const totalWallTimeMs = Date.now() - runWallStartedAtMs;
  const serialEquivalentMs = parallelTimings.reduce((sum, timing) => sum + timing.durationMs, 0);
  emit("run_end", {
    stopReason: stop.reason,
    stopDetail: stop.detail,
    recoverySuggestion: stop.recovery ?? null,
    logicalCalls: args.budget.accounting.logicalCalls,
    scoringIdentity,
    ...(applicationLoopRecovery ? { applicationLoopRecovery } : {}),
  });

  return {
    stopReason: stop.reason,
    stopDetail: stop.detail,
    ...(stop.recovery ? { recoverySuggestion: stop.recovery } : {}),
    candidates,
    population,
    generations,
    finalElite,
    explorationOnly: args.policy.explorationOnly,
    accounting: args.budget.accounting,
    events,
    pinnedItemIds: pinnedItems.map((item) => item.itemId),
    totalWallTimeMs,
    serialEquivalentMs,
    maxObservedInFlight,
    scoringIdentity,
    ...(applicationLoopRecovery ? { applicationLoopRecovery } : {}),
    actualApplicationRecoveryAttempts,
    structureRecoveryDiagnostics,
  };
}
