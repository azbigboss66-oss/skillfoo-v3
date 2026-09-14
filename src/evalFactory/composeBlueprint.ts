import { findAdaptersForCapability } from "../runtime/adapterRegistry.js";
import { taskCardContentSha256 } from "../intake/taskCard.js";
import {
  DEFAULT_U1_SCORING_PROFILE,
  EvaluationBlueprintSchema,
  U1_CONTRACT_VERSION,
  type EvaluationBlueprint,
  type Producer,
  type QualityPriorityRanking,
  type TaskCard,
} from "../types.js";

// ── T04: deterministic test blueprint from a confirmed task card ──
//
// The blueprint is composed mechanically from the task card — no model,
// no filesystem, no access to candidate artefacts or holdout data. It
// fixes WHAT a skill should be tested on before any generation happens.

const BLUEPRINT_PRODUCER: Producer = { kind: "cli", name: "skillfoo-blueprint" };

/** Rank-position weights for the five quality dimensions (descending, sum 1). */
const RANK_WEIGHTS = [0.35, 0.28, 0.21, 0.10, 0.06] as const;

const BLUEPRINT_ITEM_TYPES = ["trigger", "near-miss", "negative"] as const;

const U1_RUBRIC_DIMENSIONS = [
  "task_correctness",
  "evidence_boundary",
  "capability_boundary",
  "output_structure",
  "actionability",
] as const;

const SPLIT_TARGET = { publicRatio: 0.8, holdoutRatio: 0.2 } as const;

function weightsFromPriorities(priorities: QualityPriorityRanking): Array<{
  dimension: QualityPriorityRanking[number];
  weight: number;
}> {
  return priorities.map((dimension, index) => ({
    dimension,
    weight: RANK_WEIGHTS[index] ?? 0,
  }));
}

function targetCountsFor(scenarioCount: number): { public: number; holdout: number } {
  const holdout = Math.max(1, Math.round(scenarioCount * SPLIT_TARGET.holdoutRatio));
  const publicCount = Math.max(1, scenarioCount - holdout);
  return { public: publicCount, holdout };
}

function adapterForCapability(capability: string): string {
  const candidates = findAdaptersForCapability(capability);
  const first = candidates[0];
  if (!first) {
    throw new Error(
      `NO_ADAPTER_FOR_CAPABILITY: no adapter declared for "${capability}"; declare it before composing a blueprint`,
    );
  }
  return first.id;
}

/**
 * Compose a deterministic evaluation blueprint from a task card.
 * Pure: same card in, same blueprint out (createdAt aside).
 */
export function composeBlueprint(taskCard: TaskCard): EvaluationBlueprint {
  return EvaluationBlueprintSchema.parse({
    schemaVersion: 3,
    createdAt: new Date().toISOString(),
    producer: BLUEPRINT_PRODUCER,
    sourceHashes: {
      taskCard: taskCardContentSha256(taskCard),
    },
    capabilityMap: taskCard.capabilityBoundary.allowedCapabilities.map((capability) => ({
      capability,
      adapterId: adapterForCapability(capability),
      targetCounts: targetCountsFor(taskCard.scenarios.length),
    })),
    itemTypes: [...BLUEPRINT_ITEM_TYPES],
    weights: weightsFromPriorities(taskCard.qualityPriorities),
    redlines: [...taskCard.redlines],
    splitTarget: { ...SPLIT_TARGET },
    scenarioIds: taskCard.scenarios.map((scenario) => scenario.id),
    rubricDimensions: [...U1_RUBRIC_DIMENSIONS],
    u1ContractVersion: U1_CONTRACT_VERSION,
    scoringProfile: {
      ...DEFAULT_U1_SCORING_PROFILE,
      dimensions: DEFAULT_U1_SCORING_PROFILE.dimensions.map((dimension) => ({ ...dimension })),
      protectedDimensions: [...DEFAULT_U1_SCORING_PROFILE.protectedDimensions],
    },
  });
}
