import test from "node:test";
import assert from "node:assert/strict";
import {
  CandidateOriginSchema,
  CandidateOutcomeSchema,
  CandidateRecordV3Schema,
  ConfidenceAssessmentSchema,
  ConfidenceLevelSchema,
  DEFAULT_U1_SCORING_PROFILE,
  EvaluationContractV3Schema,
  DraftItemSchema,
  DraftItemTestSourceSchema,
  IntentOptionSchema,
  RunStageSchema,
  SkillRootSchema,
  TaskCardSchema,
  U1BDraftItemSchema,
  confidenceLevelForScore,
  type TaskCard,
} from "../types.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

// ── TaskCard ─────────────────────────────────────────────────────

function minimalTaskCard(): Record<string, unknown> {
  return {
    schemaVersion: 3,
    createdAt: "2026-08-16T00:00:00.000Z",
    producer: { kind: "human", name: "operator" },
    sourceHashes: { skill: HASH_A },
    goal: "A busy maintainer wants a trustworthy weekly digest of their repository activity.",
    scenarios: [
      { id: "s1", userRequest: "Summarize what changed in repo X this week." },
      { id: "s2", userRequest: "Summarize what changed in repo Y this week." },
    ],
    redlines: ["Never fabricate repository facts."],
    capabilityBoundary: {
      allowedCapabilities: ["digest"],
      network: "controlled",
      filesystem: "forbidden",
      externalActions: "forbidden",
    },
    qualityPriorities: ["correctness", "evidence", "format", "speed", "cost"],
    confirmation: { status: "draft" },
  };
}

test("TaskCard accepts a minimal valid card", () => {
  const card = TaskCardSchema.parse(minimalTaskCard()) as TaskCard;
  assert.equal(card.scenarios.length, 2);
  assert.equal(card.confirmation.status, "draft");
});

test("TaskCard rejects an empty goal", () => {
  const card = minimalTaskCard();
  (card as { goal: string }).goal = "   ";
  assert.throws(() => TaskCardSchema.parse(card), /goal/);
});

test("TaskCard rejects fewer than two scenarios", () => {
  const card = minimalTaskCard() as { scenarios: unknown[] };
  card.scenarios = [card.scenarios[0]];
  assert.throws(() => TaskCardSchema.parse(card), /scenarios/);
});

test("a natural-language draft may be incomplete, but a confirmed card may not", () => {
  const incomplete = minimalTaskCard() as Record<string, unknown> & {
    scenarios: unknown[];
    redlines: unknown[];
    confirmation: Record<string, unknown>;
  };
  incomplete.scenarios = [];
  incomplete.redlines = [];
  incomplete.goalSha256 = HASH_A;
  incomplete.intentStatus = "needs_clarification";
  incomplete.answeredDimensions = [];
  incomplete.unresolvedDimensions = [
    "goal_and_intended_user",
    "inputs_and_evidence",
    "output_and_format",
    "capability_boundary_and_redlines",
    "success_criteria_and_protected_behavior",
  ];
  incomplete.clarifications = [];
  TaskCardSchema.parse(incomplete);

  incomplete.confirmation = {
    status: "confirmed",
    confirmedBy: "operator",
    confirmedAt: "2026-08-16T01:00:00.000Z",
    confirmationMode: "human",
    confirmedContentSha256: HASH_A,
  };
  assert.throws(() => TaskCardSchema.parse(incomplete), /intent_incomplete|needs_clarification|unresolved/i);
});

test("TaskCard rejects an undeclared side-effect boundary", () => {
  const missingWhole = minimalTaskCard() as Record<string, unknown>;
  delete missingWhole.capabilityBoundary;
  assert.throws(() => TaskCardSchema.parse(missingWhole), /capabilityBoundary/);

  const missingNetwork = minimalTaskCard() as {
    capabilityBoundary: Record<string, unknown>;
  };
  delete missingNetwork.capabilityBoundary.network;
  assert.throws(() => TaskCardSchema.parse(missingNetwork), /network/);
});

test("TaskCard quality priorities must rank all five dimensions exactly once", () => {
  const short = minimalTaskCard() as { qualityPriorities: string[] };
  short.qualityPriorities = ["correctness", "evidence", "format", "speed"];
  assert.throws(() => TaskCardSchema.parse(short), /qualityPriorities/);

  const dup = minimalTaskCard() as { qualityPriorities: string[] };
  dup.qualityPriorities = ["correctness", "correctness", "format", "speed", "cost"];
  assert.throws(() => TaskCardSchema.parse(dup), /qualityPriorities/);
});

test("TaskCard confirmation requires who and when once confirmed", () => {
  const unconfirmed = minimalTaskCard() as { confirmation: Record<string, unknown> };
  unconfirmed.confirmation = { status: "confirmed" };
  assert.throws(() => TaskCardSchema.parse(unconfirmed), /confirmation/);

  unconfirmed.confirmation = {
    status: "confirmed",
    confirmedBy: "operator",
    confirmedAt: "2026-08-16T01:00:00.000Z",
  };
  assert.throws(() => TaskCardSchema.parse(unconfirmed), /confirmationMode|confirmedContentSha256/);

  unconfirmed.confirmation = {
    status: "confirmed",
    confirmedBy: "operator",
    confirmedAt: "2026-08-16T01:00:00.000Z",
    confirmationMode: "human",
    confirmedContentSha256: HASH_A,
  };
  TaskCardSchema.parse(unconfirmed);
});

test("TaskCard confirmation mode admits only human or test-fixture", () => {
  const card = minimalTaskCard() as { confirmation: Record<string, unknown> };
  card.confirmation = {
    status: "confirmed",
    confirmedBy: "operator",
    confirmedAt: "2026-08-16T01:00:00.000Z",
    confirmationMode: "model",
    confirmedContentSha256: HASH_A,
  };
  assert.throws(() => TaskCardSchema.parse(card), /confirmationMode/);
});

test("IntentOption requires a non-empty statement", () => {
  IntentOptionSchema.parse({ id: "i1", statement: "Weekly repo digest writer." });
  assert.throws(() => IntentOptionSchema.parse({ id: "i1", statement: "" }));
});

function u1BDraftItem(): Record<string, unknown> {
  return {
    itemId: "d1",
    scenarioId: "s1",
    split: "public",
    itemType: "trigger",
    input: "Summarize repository activity from the supplied evidence.",
    judgingRule: "The answer must use supplied evidence and state any missing facts.",
    capabilityTags: ["instruction"],
    origin: "scenario-derived",
    rationale: "direct task probe",
    confidence: { level: "low", score: 20, reasons: ["offline fixture"] },
    adapterId: "instruction-v1",
    selectionRole: "train",
    scenarioFamily: "repository-summary-core",
    testSource: "fixture-derived",
    reviewStatus: "machine-draft",
    rubric: {
      critical: false,
      passThreshold: 70,
      mustHave: ["uses supplied evidence"],
      mustNotHave: ["fabricated repository facts"],
      dimensions: [
        { id: "task_correctness", weight: 0.35 },
        { id: "evidence_boundary", weight: 0.25 },
        { id: "capability_boundary", weight: 0.2 },
        { id: "output_structure", weight: 0.1 },
        { id: "actionability", weight: 0.1 },
      ],
    },
  };
}

test("legacy V3 draft items remain readable but are not U1-B evidence items", () => {
  const legacy = u1BDraftItem();
  delete legacy.selectionRole;
  delete legacy.scenarioFamily;
  delete legacy.testSource;
  delete legacy.reviewStatus;
  delete legacy.rubric;

  assert.ok(DraftItemSchema.safeParse(legacy).success);
  assert.equal(U1BDraftItemSchema.safeParse(legacy).success, false);
});

test("U1-B public items require a complete evidence block and train/select role", () => {
  const valid = u1BDraftItem();
  assert.ok(U1BDraftItemSchema.safeParse(valid).success);

  const partial = u1BDraftItem();
  delete partial.reviewStatus;
  assert.equal(DraftItemSchema.safeParse(partial).success, false);

  assert.equal(
    U1BDraftItemSchema.safeParse({ ...valid, selectionRole: "score" }).success,
    false,
  );
});

test("U1-B holdout items forbid public selection roles", () => {
  const holdout: Record<string, unknown> = { ...u1BDraftItem(), split: "holdout" };
  assert.equal(U1BDraftItemSchema.safeParse(holdout).success, false);
  delete holdout.selectionRole;
  assert.ok(U1BDraftItemSchema.safeParse(holdout).success);
});

test("draft item test sources admit source-grounded evidence without claiming real-user provenance", () => {
  for (const value of [
    "human-authored",
    "deepseek-draft",
    "fixture-derived",
    "source-grounded",
  ]) {
    assert.equal(DraftItemTestSourceSchema.safeParse(value).success, true, value);
  }
  assert.equal(DraftItemTestSourceSchema.safeParse("real-user").success, false);
});

test("U1-B rubric dimensions are unique, positive, and sum to one", () => {
  const badSum = u1BDraftItem() as { rubric: { dimensions: Array<{ id: string; weight: number }> } };
  badSum.rubric.dimensions[0].weight = 0.5;
  assert.equal(U1BDraftItemSchema.safeParse(badSum).success, false);

  const duplicate = u1BDraftItem() as { rubric: { dimensions: Array<{ id: string; weight: number }> } };
  duplicate.rubric.dimensions[4] = { id: "task_correctness", weight: 0.1 };
  assert.equal(U1BDraftItemSchema.safeParse(duplicate).success, false);

  const zero = u1BDraftItem() as { rubric: { dimensions: Array<{ id: string; weight: number }> } };
  zero.rubric.dimensions[4].weight = 0;
  assert.equal(U1BDraftItemSchema.safeParse(zero).success, false);
});

// ── 3. Confidence ────────────────────────────────────────────────

test("confidence scores must be integers in 0-100", () => {
  ConfidenceAssessmentSchema.parse({ level: "low", score: 0, reasons: ["r"] });
  ConfidenceAssessmentSchema.parse({ level: "high", score: 100, reasons: ["r"] });
  for (const score of [-1, 101, 55.5, "70"]) {
    assert.throws(() =>
      ConfidenceAssessmentSchema.parse({ level: "medium", score, reasons: ["r"] }));
  }
});

test("confidence level cannot be omitted — no silent high default", () => {
  assert.throws(() =>
    ConfidenceAssessmentSchema.parse({ score: 80, reasons: ["r"] }), /level/);
  assert.throws(() =>
    ConfidenceAssessmentSchema.parse({ level: "high", reasons: ["r"] }), /score/);
  assert.throws(() =>
    ConfidenceAssessmentSchema.parse({ level: "high", score: 80 }), /reasons/);
});

test("confidence level must be consistent with the score band", () => {
  assert.throws(() =>
    ConfidenceAssessmentSchema.parse({ level: "high", score: 10, reasons: ["r"] }), /level/);
  assert.equal(confidenceLevelForScore(39), "low");
  assert.equal(confidenceLevelForScore(40), "medium");
  assert.equal(confidenceLevelForScore(70), "high");
  assert.throws(() => confidenceLevelForScore(101));
});

test("ConfidenceLevel admits only the explicit enum", () => {
  assert.throws(() => ConfidenceLevelSchema.parse("very-high"));
});

// ── 4. Candidate origin and gate results ─────────────────────────

function candidateRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 3,
    createdAt: "2026-08-16T00:00:00.000Z",
    producer: { kind: "cli", name: "skillfoo" },
    sourceHashes: { snapshot: HASH_B },
    snapshotId: "snap-001",
    originRoot: "s0",
    origin: "s0-scaffold",
    gateResults: [
      { gateId: "no-unauthorized-network", category: "safety", passed: true },
      { gateId: "output-format", category: "quality", passed: false, reason: "missing digest section" },
    ],
    outcome: "repair_frontier",
    ...overrides,
  };
}

test("CandidateOrigin only admits the four V3 lanes", () => {
  for (const origin of ["b0-repair", "s0-scaffold", "repair-frontier", "evolution"]) {
    CandidateOriginSchema.parse(origin);
  }
  assert.throws(() => CandidateOriginSchema.parse("baseline"));
});

test("a candidate with a failed safety gate can never be classified as elite", () => {
  const safetyFailed = candidateRecord({
    gateResults: [
      { gateId: "no-unauthorized-network", category: "safety", passed: false, reason: "called undeclared URL" },
      { gateId: "output-format", category: "quality", passed: true },
    ],
    outcome: "elite",
  });
  assert.throws(() => CandidateRecordV3Schema.parse(safetyFailed), /killed/);

  CandidateRecordV3Schema.parse(candidateRecord({
    gateResults: [
      { gateId: "no-unauthorized-network", category: "safety", passed: false, reason: "called undeclared URL" },
    ],
    outcome: "killed",
  }));
});

test("a quality-only failure may enter the repair frontier but not elite", () => {
  const record = candidateRecord({ outcome: "repair_frontier" });
  CandidateRecordV3Schema.parse(record);

  const asElite = candidateRecord({ outcome: "elite" });
  assert.throws(() => CandidateRecordV3Schema.parse(asElite), /elite/);
});

test("CandidateOutcome admits exactly the four V3 outcomes", () => {
  for (const outcome of ["killed", "repair_frontier", "safe_non_elite", "elite"]) {
    CandidateOutcomeSchema.parse(outcome);
  }
  assert.throws(() => CandidateOutcomeSchema.parse("negative"));
});

test("SkillRoot marks its kind and content hash", () => {
  SkillRootSchema.parse({
    kind: "b0",
    snapshotHash: HASH_B,
    createdAt: "2026-08-16T00:00:00.000Z",
    producer: { kind: "cli", name: "skillfoo" },
  });
  assert.throws(() => SkillRootSchema.parse({ kind: "b2", snapshotHash: HASH_B }));
  assert.throws(() => SkillRootSchema.parse({ kind: "b0", snapshotHash: "nothash" }));
});

test("RunStage covers the layered funnel stages", () => {
  for (const stage of ["doctor", "bootstrap_slice", "targeted_repair", "full_public", "holdout"]) {
    RunStageSchema.parse(stage);
  }
  assert.throws(() => RunStageSchema.parse("bootstrap"));
});

// ── 5. Evaluation contract V3 ────────────────────────────────────

function minimalContract(): Record<string, unknown> {
  return {
    schemaVersion: 3,
    createdAt: "2026-08-16T00:00:00.000Z",
    producer: { kind: "cli", name: "skillfoo" },
    sourceHashes: { taskCard: HASH_A },
    taskCardHash: HASH_A,
    skillSnapshotHash: HASH_B,
    adapterId: "instruction-v1",
    allowedCapabilities: ["digest"],
    capabilityBoundary: {
      allowedCapabilities: ["digest"],
      network: "controlled",
      filesystem: "forbidden",
      externalActions: "forbidden",
    },
    publicScenarioIds: ["p1", "p2"],
    holdoutScenarioIds: ["h1"],
    safetyGates: [{ gateId: "no-unauthorized-network", description: "No undeclared network calls." }],
    qualityGates: [{ gateId: "output-format", description: "Output must match the frozen format." }],
    goalConfidence: { level: "medium", score: 65, reasons: ["operator confirmed the goal"] },
    evalConfidence: { level: "medium", score: 65, reasons: ["curated fixture draft"] },
    generation: {
      generator: { kind: "provider", name: "generator-a" },
      curator: { kind: "curator", name: "curator-b" },
      generatorCuratorIsolation: "independent",
    },
    thresholds: { absoluteFloor: 70, confidenceFloor: 60 },
    splitPolicy: {
      targetHoldoutRatio: 0.2,
      minHoldoutItems: 3,
      maxRatioDeviation: 0.15,
      actualHoldoutRatio: 0.25,
    },
    explorationOnly: false,
    confirmationMode: "test-fixture",
    humanConfirmationBypassed: false,
    evaluationReviewHash: HASH_A,
    trainItemIds: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"],
    selectItemIds: ["s1", "s2", "s3", "s4", "s5", "s6"],
    trainItemsSha256: HASH_A,
    selectItemsSha256: HASH_B,
    calibrationMinAdjacentGap: 5,
    calibrationTripletSha256: HASH_C,
    sameModelLimitation: "The same model family generates and evaluates in isolated contexts.",
    u1ContractVersion: "v2",
    scoringProfile: DEFAULT_U1_SCORING_PROFILE,
    contractSha256: HASH_C,
  };
}

test("a minimal valid contract is accepted", () => {
  const contract = EvaluationContractV3Schema.parse(minimalContract());
  assert.equal(contract.publicScenarioIds.length, 2);
});

test("public and holdout scenario ids must not overlap", () => {
  const overlap = minimalContract() as { holdoutScenarioIds: string[] };
  overlap.holdoutScenarioIds = ["h1", "p1"];
  assert.throws(() => EvaluationContractV3Schema.parse(overlap), /overlap/);
});

test("both splits must be non-empty and duplicate-free", () => {
  const emptyHoldout = minimalContract() as { holdoutScenarioIds: string[] };
  emptyHoldout.holdoutScenarioIds = [];
  assert.throws(() => EvaluationContractV3Schema.parse(emptyHoldout), /holdoutScenarioIds/);

  const dupPublic = minimalContract() as { publicScenarioIds: string[] };
  dupPublic.publicScenarioIds = ["p1", "p1"];
  assert.throws(() => EvaluationContractV3Schema.parse(dupPublic), /duplicate/);
});

test("the contract requires a frozen sha256 and its input hashes", () => {
  const badFrozen = minimalContract() as { contractSha256: string };
  badFrozen.contractSha256 = "deadbeef";
  assert.throws(() => EvaluationContractV3Schema.parse(badFrozen), /contractSha256/);

  const missingCardHash = minimalContract() as Record<string, unknown>;
  delete missingCardHash.taskCardHash;
  assert.throws(() => EvaluationContractV3Schema.parse(missingCardHash), /taskCardHash/);
});

test("the contract requires generator/curator provenance and both gate groups", () => {
  const noProvenance = minimalContract() as Record<string, unknown>;
  delete noProvenance.generation;
  assert.throws(() => EvaluationContractV3Schema.parse(noProvenance), /generation/);

  const noSafety = minimalContract() as { safetyGates: unknown[] };
  noSafety.safetyGates = [];
  assert.throws(() => EvaluationContractV3Schema.parse(noSafety), /safetyGates/);

  const noQuality = minimalContract() as { qualityGates: unknown[] };
  noQuality.qualityGates = [];
  assert.throws(() => EvaluationContractV3Schema.parse(noQuality), /qualityGates/);
});

test("same-model generation cannot claim independent review or high eval confidence", () => {
  const sameModel = minimalContract() as {
    generation: Record<string, unknown>;
    evalConfidence: { level: string; score: number; reasons: string[] };
    explorationOnly: boolean;
  };
  sameModel.generation.generatorCuratorIsolation = "same_model_isolated_context";
  sameModel.evalConfidence = { level: "high", score: 90, reasons: ["self-reviewed"] };
  assert.throws(() => EvaluationContractV3Schema.parse(sameModel), /same_model/);

  // T05: a below-floor score stays representable, but only as an
  // exploration-only contract — never on the release path.
  sameModel.evalConfidence = { level: "medium", score: 55, reasons: ["isolated-context self review"] };
  sameModel.explorationOnly = false;
  assert.throws(() => EvaluationContractV3Schema.parse(sameModel), /explorationOnly/);
  sameModel.explorationOnly = true;
  EvaluationContractV3Schema.parse(sameModel);
});

test("the split policy is required and forces a deviationReason when the split misses tolerance", () => {
  const missingPolicy = minimalContract() as Record<string, unknown>;
  delete missingPolicy.splitPolicy;
  assert.throws(() => EvaluationContractV3Schema.parse(missingPolicy), /splitPolicy/);

  const withinTolerance = EvaluationContractV3Schema.parse(minimalContract());
  assert.equal(withinTolerance.splitPolicy.deviationReason, undefined);

  const deviating = minimalContract() as { splitPolicy: Record<string, unknown> };
  deviating.splitPolicy = { ...deviating.splitPolicy, actualHoldoutRatio: 0.55 };
  assert.throws(() => EvaluationContractV3Schema.parse(deviating), /deviationReason/);

  deviating.splitPolicy.deviationReason = "scenario-block granularity leaves no compliant split";
  const justified = EvaluationContractV3Schema.parse(deviating);
  assert.equal(justified.splitPolicy.deviationReason, "scenario-block granularity leaves no compliant split");
});
