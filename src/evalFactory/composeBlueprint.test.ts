import test from "node:test";
import assert from "node:assert/strict";
import { composeBlueprint } from "./composeBlueprint.js";
import {
  EvaluationBlueprintSchema,
  TaskCardSchema,
  type EvaluationBlueprint,
  type TaskCard,
} from "../types.js";
import { taskCardContentSha256 } from "../intake/taskCard.js";

export function sampleTaskCard(): TaskCard {
  const draft = TaskCardSchema.parse({
    schemaVersion: 3,
    createdAt: "2026-08-16T00:00:00.000Z",
    producer: { kind: "human", name: "operator" },
    sourceHashes: { intakeInput: "a".repeat(64) },
    goal: "A busy maintainer wants a trustworthy weekly digest of repository activity.",
    goalSha256: "b".repeat(64),
    intentStatus: "complete",
    answeredDimensions: [
      "goal_and_intended_user",
      "inputs_and_evidence",
      "output_and_format",
      "capability_boundary_and_redlines",
      "success_criteria_and_protected_behavior",
    ],
    unresolvedDimensions: [],
    clarifications: [],
    intentDetails: {
      goal_and_intended_user: "Help a busy repository maintainer produce a trustworthy weekly digest.",
      inputs_and_evidence: "Use only the repository activity supplied by the caller and declared evidence.",
      output_and_format: "Return a concise weekly digest with a clear no-change case.",
      capability_boundary_and_redlines: "Do not fabricate facts or claim network access.",
      success_criteria_and_protected_behavior: "Preserve factual attribution, no-change handling, and concise output.",
    },
    scenarios: [
      { id: "s1", userRequest: "Summarize repo X this week." },
      { id: "s2", userRequest: "Summarize repo Y this week." },
      { id: "s3", userRequest: "Nothing changed, what do I tell my team?" },
    ],
    redlines: ["Never fabricate repository facts.", "Never claim a network call was made."],
    capabilityBoundary: {
      allowedCapabilities: ["instruction"],
      network: "forbidden",
      filesystem: "forbidden",
      externalActions: "forbidden",
    },
    qualityPriorities: ["correctness", "evidence", "format", "speed", "cost"],
    confirmation: { status: "draft" },
  });
  return TaskCardSchema.parse({
    ...draft,
    confirmation: {
      status: "confirmed",
      confirmedBy: "task-card-fixture",
      confirmedAt: "2026-08-16T00:01:00.000Z",
      confirmationMode: "test-fixture",
      confirmedContentSha256: taskCardContentSha256(draft),
    },
  });
}

test("blueprint parses and covers every declared capability with an adapter", () => {
  const card = sampleTaskCard();
  const blueprint = composeBlueprint(card);
  assert.ok(EvaluationBlueprintSchema.safeParse(blueprint).success);

  assert.equal(blueprint.capabilityMap.length, 1);
  const entry = blueprint.capabilityMap[0];
  assert.equal(entry.capability, "instruction");
  assert.equal(entry.adapterId, "instruction-v1");
  assert.ok(entry.targetCounts.public >= 1);
  assert.ok(entry.targetCounts.holdout >= 1);
});

test("weights derive from quality priorities: five dimensions, descending, sum 1", () => {
  const blueprint = composeBlueprint(sampleTaskCard());
  const weights = blueprint.weights.map((entry) => entry.weight);
  assert.equal(blueprint.weights[0].dimension, "correctness");
  assert.equal(blueprint.weights[4].dimension, "cost");
  for (let i = 1; i < weights.length; i++) {
    assert.ok(weights[i - 1] > weights[i], "weights must strictly descend along the ranking");
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 0.001);
});

test("blueprint carries split target, redlines and scenario ids from the card", () => {
  const card = sampleTaskCard();
  const blueprint = composeBlueprint(card);
  assert.ok(blueprint.splitTarget.publicRatio >= 0.5);
  assert.equal(blueprint.splitTarget.publicRatio + blueprint.splitTarget.holdoutRatio, 1);
  assert.deepEqual(blueprint.redlines, card.redlines);
  assert.deepEqual(blueprint.scenarioIds, ["s1", "s2", "s3"]);
  assert.deepEqual(blueprint.itemTypes, ["trigger", "near-miss", "negative"]);
});

test("new blueprints freeze all five U1 rubric dimensions exactly once", () => {
  const blueprint = composeBlueprint(sampleTaskCard());
  assert.deepEqual(blueprint.rubricDimensions, [
    "task_correctness",
    "evidence_boundary",
    "capability_boundary",
    "output_structure",
    "actionability",
  ]);
  assert.equal(new Set(blueprint.rubricDimensions ?? []).size, 5);
  assert.equal(blueprint.u1ContractVersion, "v2");
  assert.equal(blueprint.scoringProfile?.version, "u1-scoring-profile-v3");
  assert.equal(blueprint.scoringProfile?.taskVerifierVersion, "u1-task-verifier-v3");
});

test("blueprint pins the task card by content hash", () => {
  const card = sampleTaskCard();
  const blueprint = composeBlueprint(card);
  assert.equal(blueprint.sourceHashes.taskCard, taskCardContentSha256(card));
});

test("composeBlueprint is deterministic apart from createdAt", () => {
  const first = composeBlueprint(sampleTaskCard());
  const second = composeBlueprint(sampleTaskCard());
  const strip = (value: EvaluationBlueprint) => JSON.stringify({ ...value, createdAt: "" });
  assert.equal(strip(first), strip(second));
});
