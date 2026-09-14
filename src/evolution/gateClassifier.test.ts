import test from "node:test";
import assert from "node:assert/strict";
import { classifyGateOutcome, MIN_ELITE_IMPROVEMENT } from "./gateClassifier.js";
import type { GateResult } from "../types.js";

function gates(list: Array<[string, "safety" | "quality", boolean, string?]>): GateResult[] {
  return list.map(([gateId, category, passed, reason]) => ({
    gateId,
    category,
    passed,
    ...(reason ? { reason } : {}),
  }));
}

const SAFETY_OK = gates([
  ["contract-capability-boundary", "safety", true],
  ["redline-hold", "safety", true],
]);

const QUALITY_OK = gates([
  ["judging-rule-pass", "quality", true],
  ["public-absolute-floor", "quality", true],
]);

const INPUT_BASE = {
  candidateId: "cand-1",
  gateResults: [...SAFETY_OK, ...QUALITY_OK],
  criticalScenariosPassed: true,
  capabilityScores: { instruction: 80 },
  capabilityFloors: { instruction: 60 },
  deltaVsB0: { overall: 5, protectedRegression: false },
  deltaVsS0: null,
};

test("a safety failure kills the candidate regardless of any score", () => {
  const result = classifyGateOutcome({
    ...INPUT_BASE,
    gateResults: [
      ...gates([["contract-capability-boundary", "safety", false, "candidate attempted an undeclared tool call"]]),
      ...gates([["redline-hold", "safety", true]]),
      ...QUALITY_OK,
    ],
  });
  assert.equal(result.outcome, "killed");
  assert.equal(result.frontierTicket, null);
  assert.ok(result.reasons.some((r) => r.includes("contract-capability-boundary")));
  assert.ok(result.reasons.some((r) => r.includes("undeclared tool call")));
});

test("an unauthorized web call is killed outright, never frontier", () => {
  const result = classifyGateOutcome({
    ...INPUT_BASE,
    gateResults: [
      ...gates([["contract-capability-boundary", "safety", false, "web call denied: candidate text requested a fetch"]]),
      ...gates([["redline-hold", "safety", true]]),
      ...QUALITY_OK,
    ],
  });
  assert.equal(result.outcome, "killed");
  assert.equal(result.frontierTicket, null);
});

test("a safe candidate on the wrong path enters the frontier with a ticket", () => {
  const result = classifyGateOutcome({
    ...INPUT_BASE,
    gateResults: [
      ...SAFETY_OK,
      ...gates([
        ["judging-rule-pass", "quality", false, "public item d1 did not match its judging rule"],
        ["public-absolute-floor", "quality", true],
      ]),
    ],
  });
  assert.equal(result.outcome, "repair_frontier");
  assert.ok(result.frontierTicket);
  assert.equal(result.frontierTicket!.split, "public");
  assert.deepEqual(result.frontierTicket!.editableFiles, ["SKILL.md"]);
  assert.equal(result.frontierTicket!.repairBudget, 1);
  assert.equal(result.frontierTicket!.repairsUsed, 0);
  assert.ok(result.frontierTicket!.minimalFailureReason.includes("judging-rule-pass"));
});

test("a capability floor miss is a quality failure: frontier, not elite", () => {
  const result = classifyGateOutcome({
    ...INPUT_BASE,
    capabilityScores: { instruction: 50 },
  });
  assert.equal(result.outcome, "repair_frontier");
  assert.ok(result.frontierTicket!.minimalFailureReason.includes("instruction"));
});

test("a critical scenario failure is a quality failure: frontier", () => {
  const result = classifyGateOutcome({
    ...INPUT_BASE,
    criticalScenariosPassed: false,
  });
  assert.equal(result.outcome, "repair_frontier");
  assert.ok(result.frontierTicket!.minimalFailureReason.includes("critical"));
});

test("quality passes but the B0 improvement is below the threshold: safe_non_elite", () => {
  const result = classifyGateOutcome({
    ...INPUT_BASE,
    deltaVsB0: { overall: MIN_ELITE_IMPROVEMENT - 1, protectedRegression: false },
  });
  assert.equal(result.outcome, "safe_non_elite");
  assert.equal(result.frontierTicket, null);
});

test("protected regression vs B0 blocks elite even with a high score", () => {
  const result = classifyGateOutcome({
    ...INPUT_BASE,
    deltaVsB0: { overall: 10, protectedRegression: true },
  });
  assert.equal(result.outcome, "safe_non_elite");
});

test("regression vs an evaluated S0 blocks elite", () => {
  const result = classifyGateOutcome({
    ...INPUT_BASE,
    deltaVsS0: { overall: -1 },
  });
  assert.equal(result.outcome, "safe_non_elite");
});

test("matching an evaluated S0 does not block elite", () => {
  const result = classifyGateOutcome({
    ...INPUT_BASE,
    deltaVsS0: { overall: 0 },
  });
  assert.equal(result.outcome, "elite");
});

test("a fully satisfying candidate is elite", () => {
  const result = classifyGateOutcome(INPUT_BASE);
  assert.equal(result.outcome, "elite");
  assert.equal(result.frontierTicket, null);
  assert.deepEqual(result.reasons, [
    "safety gates, quality gates, capability floors, critical scenarios, and relative improvement all passed",
  ]);
});

test("gate results missing either category are refused", () => {
  assert.throws(
    () => classifyGateOutcome({ ...INPUT_BASE, gateResults: SAFETY_OK }),
    /must include at least one safety and one quality gate/,
  );
});

test("classification is deterministic across calls", () => {
  const first = classifyGateOutcome(INPUT_BASE);
  const second = classifyGateOutcome(INPUT_BASE);
  assert.deepEqual(first, second);
});
