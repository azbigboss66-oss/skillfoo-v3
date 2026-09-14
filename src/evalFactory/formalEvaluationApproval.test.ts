import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeBlueprint } from "./composeBlueprint.js";
import { sampleTaskCard } from "./composeBlueprint.test.js";
import { createFixtureGenerator, generateDraft } from "./generateDraft.js";
import { createRuleCurator, curateDraft } from "./curateDraft.js";
import { confirmEvaluationReview, createEvaluationReview } from "./evaluationReview.js";
import { freezeContract } from "./freezeContract.js";
import * as formalApprovalModule from "./formalEvaluationApproval.js";
import {
  approveEvaluationForFormalFreeze,
  assertFormalEvaluationApprovalBindings,
  formalEvaluationLanePath,
  persistFormalEvaluationApproval,
  verifyPersistedFormalEvaluationLane,
  formalEvaluationApprovalPath,
  FormalEvaluationApprovalError,
} from "./formalEvaluationApproval.js";
import {
  EvaluationDraftSchema,
  TaskCardSchema,
  type EvaluationDraft,
  type TaskCard,
} from "../types.js";
import {
  evaluationCurationPath,
  evaluationDraftPath,
  evaluationReviewConfirmedPath,
  evaluationReviewDraftPath,
  evaluationReviewMarkdownPath,
  evaluationContractV3Path,
  evaluationHoldoutV3Path,
  taskCardConfirmedPath,
} from "../storage/paths.js";

test("public formal-approval API exposes no flag-only live authorization helper", () => {
  const exported = formalApprovalModule as Record<string, unknown>;
  assert.equal(exported.inspectFormalHumanConfirmationGate, undefined);
  assert.equal(exported.withFormalHumanConfirmationGate, undefined);
});

async function reviewedFixture(card: TaskCard = sampleTaskCard()) {
  const blueprint = composeBlueprint(card);
  const machineDraft = await generateDraft(blueprint, card, createFixtureGenerator());
  const draft = EvaluationDraftSchema.parse({
    ...machineDraft,
    items: machineDraft.items.map((item) => ({
      ...item,
      reviewStatus: "machine-draft",
    })),
    calibration: machineDraft.calibration
      ? { ...machineDraft.calibration, reviewStatus: "machine-draft" }
      : undefined,
  });
  const curation = await curateDraft(draft, card, blueprint, createRuleCurator());
  const review = createEvaluationReview({ taskCard: card, draft, curation });
  return { blueprint, draft, curation, review };
}

const SAMPLE_DEVIATION_REASON =
  "low sample: 3 scenarios make the isolation-safe holdout floor 3 of 17 items";

async function persistedReviewedFixture() {
  const projectDir = await mkdtemp(join(tmpdir(), "skillfoo-formal-readonly-"));
  const taskCard = sampleTaskCard();
  const { draft, curation, review } = await reviewedFixture(taskCard);
  await writeFile(taskCardConfirmedPath(projectDir), `${JSON.stringify(taskCard, null, 2)}\n`, "utf8");
  await writeFile(evaluationDraftPath(projectDir), `${JSON.stringify(draft, null, 2)}\n`, "utf8");
  await writeFile(evaluationCurationPath(projectDir), `${JSON.stringify(curation, null, 2)}\n`, "utf8");
  await writeFile(evaluationReviewDraftPath(projectDir), `${JSON.stringify(review, null, 2)}\n`, "utf8");
  const approval = approveEvaluationForFormalFreeze(
    { taskCard, draft, curation, review },
    {
      operator: "persisted-readonly-fixture",
      confirmationMode: "test-fixture",
      projectDir,
      liveProvider: false,
    },
  );
  await persistFormalEvaluationApproval(projectDir, approval);
  return { projectDir, approval };
}

test("one approval action creates a separately hash-bound formal draft without mutating development inputs", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "skillfoo-formal-approval-"));
  const taskCard = sampleTaskCard();
  const { draft, curation, review } = await reviewedFixture(taskCard);
  const before = JSON.stringify({ taskCard, draft, curation, review });

  const bundle = approveEvaluationForFormalFreeze(
    { taskCard, draft, curation, review },
    {
      operator: "formal-approval-fixture",
      confirmationMode: "test-fixture",
      projectDir,
      liveProvider: false,
    },
  );

  assert.equal(JSON.stringify({ taskCard, draft, curation, review }), before);
  assert.notEqual(bundle.record.source.evaluationDraftSha256, bundle.record.formal.evaluationDraftSha256);
  assert.equal(bundle.record.itemBindings.length, draft.items.length);
  assert.ok(bundle.formalDraft.items.every((item) => item.reviewStatus === "human-confirmed"));
  assert.equal(bundle.formalDraft.calibration?.reviewStatus, "human-confirmed");
  assert.equal(bundle.formalReview.confirmation.status, "confirmed");
  assert.equal(
    bundle.formalReview.confirmation.status === "confirmed"
      ? bundle.formalReview.confirmation.confirmationMode
      : "missing",
    "test-fixture",
  );
  assert.equal(bundle.record.formalEligible, false);
  assert.match(bundle.record.approvalSha256, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => assertFormalEvaluationApprovalBindings(bundle));

  const changedDraft = EvaluationDraftSchema.parse({
    ...bundle.formalDraft,
    items: bundle.formalDraft.items.map((item, index) =>
      index === 0 ? { ...item, judgingRule: `${item.judgingRule} changed` } : item,
    ),
  });
  assert.throws(
    () => assertFormalEvaluationApprovalBindings({ ...bundle, formalDraft: changedDraft }),
    (error: unknown) =>
      error instanceof FormalEvaluationApprovalError && error.code === "FORMAL_APPROVAL_HASH_DRIFT",
  );

  const changedTaskCard = TaskCardSchema.parse({
    ...bundle.taskCard,
    confirmation: bundle.taskCard.confirmation.status === "confirmed"
      ? { ...bundle.taskCard.confirmation, confirmedBy: "different-fixture-operator" }
      : bundle.taskCard.confirmation,
  });
  assert.throws(
    () => assertFormalEvaluationApprovalBindings({ ...bundle, taskCard: changedTaskCard }),
    (error: unknown) =>
      error instanceof FormalEvaluationApprovalError && error.code === "FORMAL_APPROVAL_HASH_DRIFT",
  );
});

test("a historical confirmed card without all five intent details cannot authorize a new formal approval", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "skillfoo-formal-intent-"));
  const completeCard = sampleTaskCard();
  const { draft, curation, review } = await reviewedFixture(completeCard);
  const incompleteCard = structuredClone(completeCard);
  delete incompleteCard.intentDetails?.success_criteria_and_protected_behavior;

  assert.throws(
    () => approveEvaluationForFormalFreeze(
      { taskCard: TaskCardSchema.parse(incompleteCard), draft, curation, review },
      {
        operator: "fixture-only",
        confirmationMode: "test-fixture",
        projectDir,
        liveProvider: false,
      },
    ),
    (error: unknown) =>
      error instanceof FormalEvaluationApprovalError && error.code === "FORMAL_TASK_CARD_INTENT_INCOMPLETE",
  );
});

test("formal approval persistence commits a new lane atomically and never overwrites development artefacts", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "skillfoo-formal-persist-"));
  const taskCard = sampleTaskCard();
  const { draft, curation, review } = await reviewedFixture(taskCard);
  const developmentBytes = `${JSON.stringify(draft, null, 2)}\n`;
  await writeFile(evaluationDraftPath(projectDir), developmentBytes, "utf8");
  const bundle = approveEvaluationForFormalFreeze(
    { taskCard, draft, curation, review },
    {
      operator: "formal-persist-fixture",
      confirmationMode: "test-fixture",
      projectDir,
      liveProvider: false,
    },
  );

  const written = await persistFormalEvaluationApproval(projectDir, bundle);
  assert.equal(written.directory, formalEvaluationLanePath(projectDir));
  assert.equal(await readFile(evaluationDraftPath(projectDir), "utf8"), developmentBytes);
  assert.equal(JSON.parse(await readFile(evaluationDraftPath(written.directory), "utf8")).items.length, draft.items.length);
  assert.equal(JSON.parse(await readFile(evaluationCurationPath(written.directory), "utf8")).sourceHashes.draft, bundle.record.formal.evaluationDraftSha256);
  assert.equal(JSON.parse(await readFile(evaluationReviewConfirmedPath(written.directory), "utf8")).confirmation.confirmationMode, "test-fixture");
  assert.match(await readFile(evaluationReviewMarkdownPath(written.directory), "utf8"), /中文评测合同摘要/);
  assert.equal(JSON.parse(await readFile(taskCardConfirmedPath(written.directory), "utf8")).confirmation.confirmationMode, "test-fixture");
  assert.ok((await readdir(projectDir)).every((name) => !name.includes(".formal-approval-tmp-")));

  await assert.rejects(
    () => persistFormalEvaluationApproval(projectDir, bundle),
    (error: unknown) =>
      error instanceof FormalEvaluationApprovalError && error.code === "FORMAL_APPROVAL_LANE_EXISTS",
  );
});

test("the approved formal bindings produce a new contract hash while the source contract stays unchanged", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "skillfoo-formal-contract-"));
  const taskCard = sampleTaskCard();
  const { blueprint, draft, curation, review } = await reviewedFixture(taskCard);
  const sourceReview = confirmEvaluationReview(review, "source-contract-fixture", {
    mode: "test-fixture",
  });
  const sourceBundle = await freezeContract({
    taskCard,
    blueprint,
    draft,
    curation,
    evaluationReview: sourceReview,
    evidenceMode: "test-fixture",
    adapterId: "instruction-v1",
    deviationReason: SAMPLE_DEVIATION_REASON,
  });
  const sourceBefore = JSON.stringify(sourceBundle);
  const approval = approveEvaluationForFormalFreeze(
    { taskCard, draft, curation, review },
    {
      operator: "formal-contract-fixture",
      confirmationMode: "test-fixture",
      projectDir,
      liveProvider: false,
    },
  );
  const formalBundle = await freezeContract({
    taskCard,
    blueprint,
    draft: approval.formalDraft,
    curation: approval.formalCuration,
    evaluationReview: approval.formalReview,
    evidenceMode: "test-fixture",
    adapterId: "instruction-v1",
    deviationReason: SAMPLE_DEVIATION_REASON,
  });

  assert.notEqual(formalBundle.contract.contractSha256, sourceBundle.contract.contractSha256);
  assert.equal(JSON.stringify(sourceBundle), sourceBefore);
  assert.equal(formalBundle.contract.sourceHashes.draft, approval.record.formal.evaluationDraftSha256);
  assert.equal(formalBundle.contract.sourceHashes.curation, approval.record.formal.curationSha256);
  assert.equal(formalBundle.contract.evaluationReviewHash, approval.record.formal.evaluationReviewBindingSha256);
});

test("test-fixture approval is confined to the OS temp tree and cannot authorize a live Provider", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "skillfoo-formal-fixture-boundary-"));
  const taskCard = sampleTaskCard();
  const { draft, curation, review } = await reviewedFixture(taskCard);
  const bundle = approveEvaluationForFormalFreeze(
    { taskCard, draft, curation, review },
    {
      operator: "fixture-only",
      confirmationMode: "test-fixture",
      projectDir,
      liveProvider: false,
    },
  );

  assert.throws(
    () => approveEvaluationForFormalFreeze(
      { taskCard, draft, curation, review },
      {
        operator: "fixture-outside-temp",
        confirmationMode: "test-fixture",
        projectDir: process.cwd(),
        liveProvider: false,
      },
    ),
    (error: unknown) =>
      error instanceof FormalEvaluationApprovalError && error.code === "FORMAL_FIXTURE_DIRECTORY_REQUIRED",
  );

  assert.throws(
    () => approveEvaluationForFormalFreeze(
      { taskCard, draft, curation, review },
      {
        operator: "fixture-live-forbidden",
        confirmationMode: "test-fixture",
        projectDir,
        liveProvider: true,
      },
    ),
    (error: unknown) =>
      error instanceof FormalEvaluationApprovalError && error.code === "FORMAL_FIXTURE_LIVE_FORBIDDEN",
  );
});

test("0/2 persisted formal gate returns a stable zero-side-effect waiting result", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "skillfoo-formal-empty-"));
  const result = await verifyPersistedFormalEvaluationLane(projectDir);

  assert.deepEqual(result, {
    status: "WAITING_FOR_HUMAN_CONFIRMATION",
    confirmations: {
      completed: 0,
      required: 2,
      missing: ["task_card", "evaluation_review"],
    },
    formalEvidence: false,
    effects: { fetches: 0, providerCalls: 0, writes: 0 },
  });
});

test("persisted-lane verification requires the approval record and ignores contract/holdout files", async () => {
  const { projectDir, approval } = await persistedReviewedFixture();
  await writeFile(evaluationContractV3Path(projectDir), "not-json-and-must-not-be-read", "utf8");
  await writeFile(evaluationHoldoutV3Path(projectDir), "SEALED-BODY-MUST-NOT-BE-READ", "utf8");

  await assert.rejects(
    () => verifyPersistedFormalEvaluationLane(projectDir),
    (error: unknown) =>
      error instanceof FormalEvaluationApprovalError && error.code === "FORMAL_FIXTURE_LIVE_FORBIDDEN",
  );

  const verified = await verifyPersistedFormalEvaluationLane(projectDir, {
    verificationMode: "test-fixture",
  });
  assert.equal(verified.status, "FIXTURE_BINDINGS_VERIFIED");
  if (verified.status !== "FIXTURE_BINDINGS_VERIFIED") return;
  assert.equal(verified.approvalSha256, approval.record.approvalSha256);
  assert.equal(verified.formalEvidence, false);
  assert.deepEqual(verified.effects, { fetches: 0, providerCalls: 0, writes: 0 });

  await rm(formalEvaluationApprovalPath(projectDir));
  const missing = await verifyPersistedFormalEvaluationLane(projectDir, {
    verificationMode: "test-fixture",
  });
  assert.deepEqual(missing, {
    status: "WAITING_FOR_HUMAN_CONFIRMATION",
    confirmations: {
      completed: 1,
      required: 2,
      missing: ["evaluation_review"],
    },
    formalEvidence: false,
    effects: { fetches: 0, providerCalls: 0, writes: 0 },
  });
});

test("persisted-lane verification rejects a tampered approval record or formal curation", async () => {
  const recordFixture = await persistedReviewedFixture();
  const approvalPath = formalEvaluationApprovalPath(recordFixture.projectDir);
  const record = JSON.parse(await readFile(approvalPath, "utf8"));
  record.source.evaluationDraftSha256 = "f".repeat(64);
  await writeFile(approvalPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => verifyPersistedFormalEvaluationLane(recordFixture.projectDir, {
      verificationMode: "test-fixture",
    }),
    (error: unknown) =>
      error instanceof FormalEvaluationApprovalError && error.code === "FORMAL_APPROVAL_HASH_DRIFT",
  );

  const curationFixture = await persistedReviewedFixture();
  const formalCurationPath = evaluationCurationPath(formalEvaluationLanePath(curationFixture.projectDir));
  const curation = JSON.parse(await readFile(formalCurationPath, "utf8"));
  curation.summary = `${curation.summary} tampered`;
  await writeFile(formalCurationPath, `${JSON.stringify(curation, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => verifyPersistedFormalEvaluationLane(curationFixture.projectDir, {
      verificationMode: "test-fixture",
    }),
    (error: unknown) =>
      error instanceof FormalEvaluationApprovalError && error.code === "FORMAL_APPROVAL_HASH_DRIFT",
  );
});

test("persisted verification rejects schema-valid source or formal draft drift with FORMAL_APPROVAL_HASH_DRIFT", async () => {
  for (const lane of ["source", "formal"] as const) {
    const fixture = await persistedReviewedFixture();
    try {
      const draftPath = lane === "source"
        ? evaluationDraftPath(fixture.projectDir)
        : evaluationDraftPath(formalEvaluationLanePath(fixture.projectDir));
      const current = EvaluationDraftSchema.parse(JSON.parse(await readFile(draftPath, "utf8")));
      const drifted = EvaluationDraftSchema.parse({
        ...current,
        items: current.items.map((item, index) => index === 0
          ? { ...item, judgingRule: `${item.judgingRule} schema-valid-drift` }
          : item),
      });
      await writeFile(draftPath, `${JSON.stringify(drifted, null, 2)}\n`, "utf8");

      await assert.rejects(
        () => verifyPersistedFormalEvaluationLane(fixture.projectDir, {
          verificationMode: "test-fixture",
        }),
        (error: unknown) =>
          error instanceof FormalEvaluationApprovalError && error.code === "FORMAL_APPROVAL_HASH_DRIFT",
        `${lane} draft drift must fail before a resumable formal lane is returned`,
      );
    } finally {
      await rm(fixture.projectDir, { recursive: true, force: true });
    }
  }
});
