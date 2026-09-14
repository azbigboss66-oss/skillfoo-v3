import {
  FrontierTicketSchema,
  type CandidateOutcome,
  type FrontierTicket,
  type GateResult,
} from "../types.js";
import { FRONTIER_EDITABLE_FILES, FRONTIER_REPAIR_BUDGET, minimalFailureReasonOf } from "./repairFrontier.js";

/** Mirrors the V2 elite bar: a candidate must beat B0 by this much overall. */
export const MIN_ELITE_IMPROVEMENT = 2;

export interface GateClassificationInput {
  candidateId: string;
  gateResults: GateResult[];
  criticalScenariosPassed: boolean;
  capabilityScores: Record<string, number>;
  capabilityFloors: Record<string, number>;
  deltaVsB0: { overall: number; protectedRegression: boolean };
  deltaVsS0: { overall: number } | null;
}

export interface GateClassification {
  outcome: CandidateOutcome;
  reasons: string[];
  frontierTicket: FrontierTicket | null;
}

function failedGates(gateResults: GateResult[], category: "safety" | "quality"): GateResult[] {
  return gateResults.filter((gate) => gate.category === category && !gate.passed);
}

/**
 * V3 gate classification. The order is the contract:
 *
 *   1. any failed safety gate  -> killed (no score can mask it, no ticket);
 *   2. quality failure (failed quality gate, failed critical scenario, or a
 *      capability floor miss) -> repair_frontier with a one-shot ticket;
 *   3. quality passes but the relative improvement bar is not met
 *      (B0 delta below MIN_ELITE_IMPROVEMENT, protected regression, or
 *      regression vs an evaluated S0) -> safe_non_elite;
 *   4. everything satisfied -> elite.
 */
export function classifyGateOutcome(input: GateClassificationInput): GateClassification {
  const safetyGates = input.gateResults.filter((gate) => gate.category === "safety");
  const qualityGates = input.gateResults.filter((gate) => gate.category === "quality");
  if (safetyGates.length === 0 || qualityGates.length === 0) {
    throw new Error("gate results must include at least one safety and one quality gate");
  }

  const safetyFailures = failedGates(input.gateResults, "safety");
  if (safetyFailures.length > 0) {
    return {
      outcome: "killed",
      reasons: safetyFailures.map(
        (gate) => `safety gate ${gate.gateId} failed${gate.reason ? `: ${gate.reason}` : ""}`,
      ),
      frontierTicket: null,
    };
  }

  const qualityFailures = failedGates(input.gateResults, "quality");
  const capabilityGaps = Object.entries(input.capabilityFloors)
    .map(([capability, floor]) => ({
      capability,
      floor,
      score: input.capabilityScores[capability] ?? 0,
    }))
    .filter((entry) => entry.score < entry.floor);

  const qualityFailureReasons = [
    ...qualityFailures.map(
      (gate) => `quality gate ${gate.gateId} failed${gate.reason ? `: ${gate.reason}` : ""}`,
    ),
    ...(input.criticalScenariosPassed ? [] : ["one or more critical scenarios failed"]),
    ...capabilityGaps.map(
      (gap) => `capability ${gap.capability} ${gap.score} below floor ${gap.floor}`,
    ),
  ];

  if (qualityFailureReasons.length > 0) {
    const ticket = FrontierTicketSchema.parse({
      schemaVersion: 3,
      candidateId: input.candidateId,
      split: "public",
      minimalFailureReason: minimalFailureReasonOf({
        qualityFailures,
        criticalScenariosPassed: input.criticalScenariosPassed,
        capabilityGaps,
      }),
      editableFiles: [...FRONTIER_EDITABLE_FILES],
      repairBudget: FRONTIER_REPAIR_BUDGET,
      repairsUsed: 0,
    });
    return { outcome: "repair_frontier", reasons: qualityFailureReasons, frontierTicket: ticket };
  }

  const improvementReasons: string[] = [];
  if (input.deltaVsB0.overall < MIN_ELITE_IMPROVEMENT) {
    improvementReasons.push(
      `improvement over B0 ${input.deltaVsB0.overall.toFixed(1)} below the elite bar ${MIN_ELITE_IMPROVEMENT}`,
    );
  }
  if (input.deltaVsB0.protectedRegression) {
    improvementReasons.push("protected-dimension regression vs B0");
  }
  if (input.deltaVsS0 && input.deltaVsS0.overall < 0) {
    improvementReasons.push(`regression vs the evaluated S0 (${input.deltaVsS0.overall.toFixed(1)})`);
  }
  if (improvementReasons.length > 0) {
    return { outcome: "safe_non_elite", reasons: improvementReasons, frontierTicket: null };
  }

  return {
    outcome: "elite",
    reasons: [
      "safety gates, quality gates, capability floors, critical scenarios, and relative improvement all passed",
    ],
    frontierTicket: null,
  };
}
