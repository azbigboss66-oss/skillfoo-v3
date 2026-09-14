import test from "node:test";
import assert from "node:assert/strict";
import {
  RepairFrontierError,
  createFixtureRepairProposer,
  frontierSummary,
  planTargetedRepair,
  settleRepair,
  FRONTIER_EDITABLE_FILES,
} from "./repairFrontier.js";
import { classifyGateOutcome } from "./gateClassifier.js";
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

const QUALITY_FAIL = gates([
  ["judging-rule-pass", "quality", false, "public item d1 did not match its judging rule"],
  ["public-absolute-floor", "quality", true],
]);

const QUALITY_OK = gates([
  ["judging-rule-pass", "quality", true],
  ["public-absolute-floor", "quality", true],
]);

const CARD = {
  candidateId: "cand-f",
  gateResults: [...SAFETY_OK, ...QUALITY_FAIL],
  criticalScenariosPassed: true,
  capabilityScores: { instruction: 70 },
  capabilityFloors: { instruction: 60 },
  deltaVsB0: { overall: 3, protectedRegression: false },
  deltaVsS0: null,
};

function frontierTicketOf(input: Parameters<typeof classifyGateOutcome>[0]) {
  const classification = classifyGateOutcome(input);
  assert.equal(classification.outcome, "repair_frontier");
  return classification.frontierTicket!;
}

const SKILL_MD = "# Skill under repair\n\nSummarize the pasted repository context.";

function repairedEvaluation(overrides: Partial<Parameters<typeof settleRepair>[0]["repaired"]> = {}) {
  return {
    split: "public" as const,
    gateResults: [...SAFETY_OK, ...QUALITY_OK],
    criticalScenariosPassed: true,
    capabilityScores: { instruction: 82 },
    capabilityFloors: { instruction: 60 },
    overallScore: 82,
    baselineOverall: 70,
    s0Overall: null,
    protectedRegression: false,
    ...overrides,
  };
}

test("a frontier ticket pins the minimal failure reason, editable files and budget", () => {
  const ticket = frontierTicketOf(CARD);
  assert.equal(ticket.candidateId, "cand-f");
  assert.equal(ticket.split, "public");
  assert.deepEqual(ticket.editableFiles, [...FRONTIER_EDITABLE_FILES]);
  assert.equal(ticket.repairBudget, 1);
  assert.ok(ticket.minimalFailureReason.includes("judging-rule-pass"));
  assert.ok(ticket.minimalFailureReason.includes("d1"));
});

test("the minimal failure reason prefers a failed quality gate over a capability gap", () => {
  const ticket = frontierTicketOf({
    ...CARD,
    capabilityScores: { instruction: 40 },
  });
  assert.ok(ticket.minimalFailureReason.includes("judging-rule-pass"));
});

test("with no failed gate, the critical-scenario failure becomes the minimal reason", () => {
  const ticket = frontierTicketOf({
    ...CARD,
    gateResults: [...SAFETY_OK, ...QUALITY_OK],
    capabilityScores: { instruction: 45 },
    criticalScenariosPassed: false,
  });
  assert.ok(ticket.minimalFailureReason.includes("critical"));
});

test("with only a capability gap, the largest gap becomes the minimal reason", () => {
  const ticket = frontierTicketOf({
    ...CARD,
    gateResults: [...SAFETY_OK, ...QUALITY_OK],
    capabilityScores: { instruction: 45 },
  });
  assert.ok(ticket.minimalFailureReason.includes("instruction"));
  assert.ok(ticket.minimalFailureReason.includes("45"));
});

test("the fixture repair proposer appends a targeted section and never rewrites the base", async () => {
  const ticket = frontierTicketOf(CARD);
  const proposer = createFixtureRepairProposer();
  const { proposal, ticket: consumed } = await planTargetedRepair({ ticket, skillMd: SKILL_MD, proposer });
  assert.ok(proposal.skillMd.startsWith(SKILL_MD));
  assert.ok(proposal.skillMd.length > SKILL_MD.length);
  assert.ok(proposal.skillMd.includes(ticket.minimalFailureReason));
  assert.ok(proposal.hypothesis.includes("targeted repair"));
  assert.equal(consumed.repairsUsed, 1);
});

test("a proposal identical to the base skill is refused", async () => {
  const ticket = frontierTicketOf(CARD);
  await assert.rejects(
    () =>
      planTargetedRepair({
        ticket,
        skillMd: SKILL_MD,
        proposer: {
          producer: { kind: "fixture", name: "noop-proposer" },
          async proposeTargetedRepair() {
            return { hypothesis: "noop", skillMd: SKILL_MD };
          },
        },
      }),
    (e: unknown) => e instanceof RepairFrontierError && e.code === "REPAIR_PROPOSAL_NOOP",
  );
});

test("an explicit no_change consumes the one-shot ticket without inventing a repair", async () => {
  const ticket = frontierTicketOf(CARD);
  const result = await planTargetedRepair({
    ticket,
    skillMd: SKILL_MD,
    proposer: {
      producer: { kind: "fixture", name: "bounded-no-change" },
      async proposeTargetedRepair() {
        return {
          hypothesis: "the public failure evidence does not justify a safe edit",
          decision: "no_change",
          skillMd: SKILL_MD,
          appliedEdits: 0,
        };
      },
    },
  });
  assert.equal(result.proposal.decision, "no_change");
  assert.equal(result.proposal.skillMd, SKILL_MD);
  assert.equal(result.ticket.repairsUsed, 1);
});

test("a successful repair settles into elite after re-running the same public slice", () => {
  const ticket = frontierTicketOf(CARD);
  const settled = settleRepair({ ticket, repaired: repairedEvaluation() });
  assert.equal(settled.outcome, "elite");
  assert.equal(settled.frontierTicket, null);
  assert.equal(settled.secondTicketIssued, false);
});

test("a repair that still fails quality settles as safe_non_elite with no second ticket", () => {
  const ticket = frontierTicketOf(CARD);
  const settled = settleRepair({
    ticket,
    repaired: repairedEvaluation({ gateResults: [...SAFETY_OK, ...QUALITY_FAIL] }),
  });
  assert.equal(settled.outcome, "safe_non_elite");
  assert.equal(settled.frontierTicket, null);
  assert.equal(settled.secondTicketIssued, false);
  assert.ok(settled.reasons.some((r) => r.includes("repair budget")));
});

test("a repair that introduces a safety failure is killed", () => {
  const ticket = frontierTicketOf(CARD);
  const settled = settleRepair({
    ticket,
    repaired: repairedEvaluation({
      gateResults: [
        ...gates([["contract-capability-boundary", "safety", false, "repaired candidate attempted a network call"]]),
        ...gates([["redline-hold", "safety", true]]),
        ...QUALITY_OK,
      ],
    }),
  });
  assert.equal(settled.outcome, "killed");
});

test("settleRepair refuses a holdout evaluation: the frontier never touches holdout", () => {
  const ticket = frontierTicketOf(CARD);
  assert.throws(
    () => settleRepair({ ticket, repaired: repairedEvaluation({ split: "holdout" }) }),
    (e: unknown) => e instanceof RepairFrontierError && e.code === "REPAIR_SPLIT_MISMATCH",
  );
});

test("an exhausted ticket refuses further repairs", async () => {
  const ticket = frontierTicketOf(CARD);
  const { ticket: consumed } = await planTargetedRepair({
    ticket,
    skillMd: SKILL_MD,
    proposer: createFixtureRepairProposer(),
  });
  await assert.rejects(
    () =>
      planTargetedRepair({
        ticket: consumed,
        skillMd: SKILL_MD,
        proposer: createFixtureRepairProposer(),
      }),
    (e: unknown) => e instanceof RepairFrontierError && e.code === "REPAIR_BUDGET_EXHAUSTED",
  );
});

test("frontierSummary reports actionable reasons when every candidate fails", () => {
  const killed = classifyGateOutcome({
    ...CARD,
    candidateId: "cand-k",
    gateResults: [
      ...gates([["contract-capability-boundary", "safety", false, "web call denied"]]),
      ...gates([["redline-hold", "safety", true]]),
      ...QUALITY_OK,
    ],
  });
  const frontier = classifyGateOutcome({ ...CARD, candidateId: "cand-f" });
  const summary = frontierSummary([
    { candidateId: "cand-k", classification: killed },
    { candidateId: "cand-f", classification: frontier },
  ]);
  assert.equal(summary.hasElite, false);
  assert.equal(summary.actionableReasons.length, 2);
  const killedEntry = summary.actionableReasons.find((e) => e.candidateId === "cand-k")!;
  assert.equal(killedEntry.outcome, "killed");
  assert.ok(killedEntry.reason.includes("contract-capability-boundary"));
  const frontierEntry = summary.actionableReasons.find((e) => e.candidateId === "cand-f")!;
  assert.ok(frontierEntry.reason.includes("judging-rule-pass"));
});

test("frontierSummary stays desensitized: it never embeds skill content", () => {
  const frontier = classifyGateOutcome({ ...CARD, candidateId: "cand-f" });
  const summary = frontierSummary([{ candidateId: "cand-f", classification: frontier }]);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("Summarize the pasted"), false);
});
