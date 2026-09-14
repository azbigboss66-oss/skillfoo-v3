// Shared sealed benchmark-audit comparison used by the current U1 chain.
// Callers provide the exact method labels; the evaluator remains fail-closed
// and never exposes sealed inputs to generation or repair paths.

import { sha256Hex } from "../runtime/capabilityAdapter.js";
import { applyContractGates, contractItemPassed, type ContractItemScore, type InstructionGateInput, type SealedInstructionBatchScorer } from "../runtime/instructionAdapter.js";
import type { RunCallBudget } from "../providers/runBudget.js";
import type {
  EvaluationContractV3,
  GateResult,
  U1ApplicationRecoverySummary,
} from "../types.js";
import type { FunnelEvalItem, FunnelEvent, FunnelScenarioRunner } from "./funnel.js";
import { scoringIdentityOfContract } from "../evaluation/u1Rubric.js";

export class AuditCompareError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuditCompareError";
  }
}

export interface LabelledAuditCompareCandidate<Label extends string> {
  label: Label;
  /** Human-readable provenance, e.g. "adaptive:final-elite" or "direct:one-shot". */
  candidateSource: string;
  skillMd: string;
}

export interface LabelledAuditCandidateEvaluation<Label extends string> {
  label: Label;
  candidateSource: string;
  skillSha256: string;
  auditScore: number;
  solvedItemIds: string[];
  gateResults: GateResult[];
  skippedGates: Array<{ gateId: string; reason: string }>;
  safetyFailures: number;
  qualityFailures: number;
  itemScores: ContractItemScore[];
}

export interface LabelledAuditCompareResult<Label extends string> {
  itemsCount: number;
  auditScenarioIds: string[];
  contractSha256: string;
  candidates: LabelledAuditCandidateEvaluation<Label>[];
  winner: Label | "tie";
  accounting: { logicalCalls: number; httpAttempts: number; retryAttempts: number };
  wallTimeMs: number;
  events: FunnelEvent[];
  /** Content-free per-candidate-item attempt evidence. */
  applicationRecovery: U1ApplicationRecoverySummary[];
}

/** The public floor is defined on the public split; the sealed audit split carries no public items. */
const PUBLIC_ONLY_GATE_IDS = new Set(["public-absolute-floor"]);

/**
 * Shared sealed evaluator. Callers supply the exact, unique method labels.
 * The whole scenario + semantic envelope is checked before the first item.
 */
export async function runLabelledAuditCompare<Label extends string>(args: {
  contract: EvaluationContractV3;
  auditItems: FunnelEvalItem[];
  candidates: Array<LabelledAuditCompareCandidate<Label>>;
  requiredLabels: readonly Label[];
  runner: FunnelScenarioRunner;
  scoreRuns?: SealedInstructionBatchScorer;
  semanticBatchSize?: number;
  budget: RunCallBudget;
  now?: () => string;
}): Promise<LabelledAuditCompareResult<Label>> {
  scoringIdentityOfContract({ contract: args.contract, items: args.auditItems });
  const now = args.now ?? (() => new Date().toISOString());
  const events: FunnelEvent[] = [];
  const emit = (type: string, payload: Record<string, unknown> = {}): void => {
    events.push({ at: now(), type, ...payload });
  };

  if (args.auditItems.length === 0) {
    throw new AuditCompareError(
      "AUDIT_COMPARE_NO_ITEMS",
      "AUDIT_COMPARE_NO_ITEMS: the sealed benchmark-audit file holds no items; there is nothing to compare",
    );
  }
  const publicItem = args.auditItems.find((item) => item.split !== "holdout");
  if (publicItem) {
    throw new AuditCompareError(
      "AUDIT_COMPARE_SPLIT_INVALID",
      `AUDIT_COMPARE_SPLIT_INVALID: item ${publicItem.itemId} carries split "${publicItem.split}"; the benchmark-audit comparison only accepts sealed holdout-split items`,
    );
  }
  const requiredLabels = new Set(args.requiredLabels);
  const labels = new Set(args.candidates.map((candidate) => candidate.label));
  if (
    args.requiredLabels.length === 0 ||
    requiredLabels.size !== args.requiredLabels.length ||
    args.candidates.length !== args.requiredLabels.length ||
    labels.size !== args.requiredLabels.length ||
    args.requiredLabels.some((label) => !labels.has(label)) ||
    args.candidates.some((candidate) => candidate.skillMd.trim().length === 0)
  ) {
    throw new AuditCompareError(
      "AUDIT_COMPARE_CANDIDATES_INVALID",
      `AUDIT_COMPARE_CANDIDATES_INVALID: the comparison needs exactly ${args.requiredLabels.length} non-empty candidates labelled ${args.requiredLabels.join(", ")}`,
    );
  }

  const semanticBatchSize = args.semanticBatchSize ?? args.auditItems.length;
  if (!Number.isInteger(semanticBatchSize) || semanticBatchSize < 1) {
    throw new AuditCompareError(
      "AUDIT_COMPARE_SEMANTIC_BATCH_INVALID",
      "AUDIT_COMPARE_SEMANTIC_BATCH_INVALID: semanticBatchSize must be a positive integer",
    );
  }
  const scenarioCalls = args.auditItems.length * args.candidates.length;
  const semanticJudgeCalls = args.scoreRuns
    ? args.candidates.length * Math.ceil(args.auditItems.length / semanticBatchSize)
    : 0;
  const requiredCalls = scenarioCalls + semanticJudgeCalls;
  const remainingCalls = args.budget.caps.maxLogicalCalls - args.budget.accounting.logicalCalls;
  if (requiredCalls > remainingCalls) {
    throw new AuditCompareError(
      "AUDIT_COMPARE_BUDGET_INSUFFICIENT",
      `AUDIT_COMPARE_BUDGET_INSUFFICIENT: the comparison needs ${requiredCalls} logical calls `
        + `(${args.auditItems.length} sealed items x ${args.candidates.length} candidates${semanticJudgeCalls > 0 ? ` + ${semanticJudgeCalls} semantic judge batches` : ""}) but only `
        + `${remainingCalls} remain under the authorized cap ${args.budget.caps.maxLogicalCalls}; refusing to start a run that cannot finish`,
    );
  }

  const startedAtMs = Date.now();
  emit("run_start", {
    contractSha256: args.contract.contractSha256,
    itemsCount: args.auditItems.length,
    candidates: args.candidates.map((candidate) => candidate.candidateSource),
  });

  const evaluations: Array<LabelledAuditCandidateEvaluation<Label>> = [];
  const applicationRecovery: U1ApplicationRecoverySummary[] = [];
  for (const candidate of args.candidates) {
    const snapshotId = sha256Hex(candidate.skillMd).slice(0, 12);
    const runs: InstructionGateInput[] = [];
    for (const item of args.auditItems) {
      const transcript = await args.runner({ item, skillMd: candidate.skillMd, snapshotId });
      if (transcript.applicationRecovery) {
        applicationRecovery.push({
          candidateId: String(candidate.label),
          itemId: item.itemId,
          role: "sealed",
          ...transcript.applicationRecovery,
        });
      }
      runs.push({
        item: {
          itemId: item.itemId,
          split: "holdout",
          itemType: item.itemType,
          scenarioId: item.scenarioId, input: item.input, judgingRule: item.judgingRule, ...(item.redlineRefs ? { redlineRefs: item.redlineRefs } : {}),
          rubric: item.rubric,
          taskVerifier: item.taskVerifier,
        },
        transcript,
      });
    }
    const scored = args.scoreRuns ? await args.scoreRuns({ contract: args.contract, runs }) : applyContractGates({ contract: args.contract, runs });
    const holdoutScores = scored.itemScores.filter((entry) => entry.split === "holdout");
    const auditScore =
      holdoutScores.length === 0
        ? 0
        : Math.round(holdoutScores.reduce((sum, entry) => sum + entry.score, 0) / holdoutScores.length);
    const gateResults = scored.gateResults.filter((gate) => !PUBLIC_ONLY_GATE_IDS.has(gate.gateId));
    const skippedGates = scored.gateResults
      .filter((gate) => PUBLIC_ONLY_GATE_IDS.has(gate.gateId))
      .map((gate) => ({
        gateId: gate.gateId,
        reason: "the gate is defined on the public split only; the sealed audit split carries no public items",
      }));
    const evaluation: LabelledAuditCandidateEvaluation<Label> = {
      label: candidate.label,
      candidateSource: candidate.candidateSource,
      skillSha256: sha256Hex(candidate.skillMd),
      auditScore,
      solvedItemIds: holdoutScores.filter(contractItemPassed).map((entry) => entry.itemId),
      gateResults,
      skippedGates,
      safetyFailures: gateResults.filter((gate) => gate.category === "safety" && !gate.passed).length,
      qualityFailures: gateResults.filter((gate) => gate.category === "quality" && !gate.passed).length,
      itemScores: holdoutScores,
    };
    evaluations.push(evaluation);
    emit("candidate_scored", {
      label: evaluation.label,
      candidateSource: evaluation.candidateSource,
      auditScore: evaluation.auditScore,
      solvedItems: evaluation.solvedItemIds.length,
    });
  }

  const eligibleForWinner = args.contract.scoringProfile
    ? evaluations.filter((entry) => entry.safetyFailures === 0 && entry.qualityFailures === 0)
    : evaluations;
  const bestScore = eligibleForWinner.length > 0
    ? Math.max(...eligibleForWinner.map((entry) => entry.auditScore))
    : null;
  const best = bestScore === null
    ? []
    : eligibleForWinner.filter((entry) => entry.auditScore === bestScore);
  const winner: LabelledAuditCompareResult<Label>["winner"] = best.length === 1 ? best[0].label : "tie";

  const result: LabelledAuditCompareResult<Label> = {
    itemsCount: args.auditItems.length,
    auditScenarioIds: args.auditItems.map((item) => item.scenarioId),
    contractSha256: args.contract.contractSha256,
    candidates: evaluations,
    winner,
    accounting: args.budget.accounting,
    wallTimeMs: Date.now() - startedAtMs,
    events,
    applicationRecovery,
  };
  emit("run_end", {
    winner,
    scores: Object.fromEntries(evaluations.map((entry) => [entry.label, entry.auditScore])),
  });
  return result;
}
