import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeBlueprint } from "./composeBlueprint.js";
import { sampleTaskCard } from "./composeBlueprint.test.js";
import { createFixtureGenerator, generateDraft } from "./generateDraft.js";
import { createRuleCurator, curateDraft } from "./curateDraft.js";
import {
  assertU1BLiveEvidencePreflight,
  assertEvaluationReviewBindings,
  confirmEvaluationReview,
  createEvaluationReview,
  evaluationDraftContentSha256,
  evaluationReviewContentSha256,
  evaluationReviewConfirmationSha256,
  EvaluationReviewError,
  renderEvaluationReviewZh,
} from "./evaluationReview.js";
import {
  EvaluationReviewSchema,
  TaskCardSchema,
  type EvaluationContractV3,
  type EvaluationDraft,
} from "../types.js";
import { confirmTaskCard, taskCardContentSha256 } from "../intake/taskCard.js";
import {
  evaluationReviewDraftPath,
  evaluationReviewMarkdownPath,
  taskCardConfirmedPath,
} from "../storage/paths.js";
import { runCli } from "../cli.js";

async function reviewFixture() {
  const card = sampleTaskCard();
  const blueprint = composeBlueprint(card);
  const draft = await generateDraft(blueprint, card, createFixtureGenerator());
  const curation = await curateDraft(draft, card, blueprint, createRuleCurator());
  const review = createEvaluationReview({ taskCard: card, draft, curation });
  return { card, draft, curation, review };
}

test("Chinese evaluation review records counts and families without sealed bodies or rules", async () => {
  const { card, draft, curation } = await reviewFixture();
  const sentinelInput = "SEALED-HOLDOUT-INPUT-DO-NOT-DISCLOSE";
  const sentinelRule = "SEALED-HOLDOUT-JUDGING-RULE-DO-NOT-DISCLOSE";
  const items = draft.items.map((item) => item.split === "holdout"
    ? { ...item, input: sentinelInput, judgingRule: sentinelRule }
    : item);
  const sealedDraft = { ...draft, items } as EvaluationDraft;
  const review = createEvaluationReview({ taskCard: card, draft: sealedDraft, curation });
  const parsed = EvaluationReviewSchema.parse(review);
  const markdown = renderEvaluationReviewZh(parsed);

  assert.equal(parsed.language, "zh-CN");
  assert.equal(parsed.publicSummary.trainCount, items.filter((item) => item.selectionRole === "train").length);
  assert.equal(parsed.publicSummary.selectCount, items.filter((item) => item.selectionRole === "select").length);
  assert.equal(parsed.publicSummary.holdoutCount, items.filter((item) => item.split === "holdout").length);
  assert.ok(parsed.publicSummary.scenarioFamilies.length > 0);
  assert.match(markdown, /中文评测摘要|评测合同/);
  assert.match(markdown, new RegExp(card.goal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(JSON.stringify(parsed), new RegExp(sentinelInput));
  assert.doesNotMatch(JSON.stringify(parsed), new RegExp(sentinelRule));
  assert.doesNotMatch(markdown, new RegExp(sentinelInput));
  assert.doesNotMatch(markdown, new RegExp(sentinelRule));
  assert.doesNotMatch(markdown, /evaluation-holdout|judgingRule|expectedOutcome/i);
  assert.equal(
    parsed.reviewDocumentSha256,
    createHash("sha256").update(markdown, "utf8").digest("hex"),
  );
});

test("Chinese review exposes rubric thresholds, protected failures, curator provenance and risk notes", async () => {
  const { card, draft, curation } = await reviewFixture();
  const review = createEvaluationReview({ taskCard: card, draft, curation });
  const markdown = renderEvaluationReviewZh(review);

  assert.deepEqual(
    review.rubricSummary!.dimensionWeights.map((entry) => entry.id).sort(),
    ["actionability", "capability_boundary", "evidence_boundary", "output_structure", "task_correctness"],
  );
  assert.deepEqual(
    review.rubricSummary!.itemThresholds.map((entry) => entry.itemType).sort(),
    ["near-miss", "negative", "trigger"],
  );
  assert.deepEqual(review.protectedBehaviorsZh, card.redlines);
  assert.ok(review.absoluteFailureConditionsZh!.length >= 2);
  assert.deepEqual(review.curator, curation.producer);
  assert.equal(review.generatorCuratorIsolation, curation.generatorCuratorIsolation);
  assert.deepEqual(review.evalConfidence, curation.evalConfidence);
  assert.ok(review.riskNotesZh!.some((note) => /human|人工/i.test(note)));
  assert.match(markdown, /Rubric 维度与阈值/);
  assert.match(markdown, /受保护行为与绝对失败条件/);
  assert.match(markdown, /生成与评审来源/);
  assert.match(markdown, /风险说明/);
});

test("review confirmation is explicit test-fixture evidence and binds reviewed content", async () => {
  const { card, draft, review } = await reviewFixture();
  const confirmed = confirmEvaluationReview(review, "evaluation-review-fixture", {
    mode: "test-fixture",
  });

  assert.equal(confirmed.confirmation.status, "confirmed");
  assert.equal(confirmed.confirmation.confirmationMode, "test-fixture");
  assert.equal(confirmed.confirmation.confirmedContentSha256, evaluationReviewConfirmationSha256(review));
  assert.equal(confirmed.taskCardHash, card.confirmation.status === "confirmed" ? card.confirmation.confirmedContentSha256 : "");
  assert.equal(confirmed.draftSha256, evaluationDraftContentSha256(draft));
  assert.doesNotThrow(() => assertEvaluationReviewBindings({ review: confirmed, taskCard: card, draft }));
});

test("Task Card, draft, or review-content hash drift invalidates the confirmation", async () => {
  const { card, draft, review } = await reviewFixture();
  const confirmed = confirmEvaluationReview(review, "evaluation-review-fixture", {
    mode: "test-fixture",
  });
  const changedDraft = {
    ...draft,
    items: draft.items.map((item, index) => index === 0 ? { ...item, rationale: `${item.rationale} changed` } : item),
  } as EvaluationDraft;
  assert.throws(
    () => assertEvaluationReviewBindings({ review: confirmed, taskCard: card, draft: changedDraft }),
    (error: unknown) => error instanceof EvaluationReviewError && error.code === "EVALUATION_REVIEW_HASH_DRIFT",
  );

  const changedReview = {
    ...confirmed,
    publicSummary: { ...confirmed.publicSummary, criticalItemCount: confirmed.publicSummary.criticalItemCount + 1 },
  };
  assert.throws(
    () => assertEvaluationReviewBindings({ review: changedReview, taskCard: card, draft }),
    (error: unknown) => error instanceof EvaluationReviewError && error.code === "EVALUATION_REVIEW_HASH_DRIFT",
  );
});

test("CLI eval-review writes a sealed-safe Chinese draft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillfoo-eval-review-"));
  const { card } = await reviewFixture();
  await writeFile(taskCardConfirmedPath(dir), JSON.stringify(card), "utf8");
  const draftRun = await runCli(["eval-draft", "--task-card", taskCardConfirmedPath(dir), "--out", dir]);
  assert.equal(draftRun.exitCode, 0);

  const reviewRun = await runCli(["eval-review", "--dir", dir]);
  assert.equal(reviewRun.exitCode, 0);
  assert.match(reviewRun.stdout, /evaluation-review\.draft\.json/);
  const review = EvaluationReviewSchema.parse(JSON.parse(await readFile(evaluationReviewDraftPath(dir), "utf8")));
  assert.equal(review.confirmation.status, "draft");
  assert.match(await readFile(evaluationReviewMarkdownPath(dir), "utf8"), /中文评测合同摘要/);
});

function evidenceContract(args: {
  taskCardHash: string;
  reviewHash: string;
  mode: "human" | "test-fixture";
}): EvaluationContractV3 {
  return {
    taskCardHash: args.taskCardHash,
    evaluationReviewHash: args.reviewHash,
    confirmationMode: args.mode,
    humanConfirmationBypassed: false,
    explorationOnly: args.mode !== "human",
    sourceHashes: { evaluationReview: args.reviewHash },
  } as unknown as EvaluationContractV3;
}

test("formal U1-B live preflight requires and accepts two independent human confirmations", async () => {
  const fixtureCard = sampleTaskCard();
  const humanCard = confirmTaskCard(
    TaskCardSchema.parse({ ...fixtureCard, confirmation: { status: "draft" } }),
    "task-card-human-reviewer",
  ).card;
  const blueprint = composeBlueprint(humanCard);
  const draft = await generateDraft(blueprint, humanCard, createFixtureGenerator());
  const curation = await curateDraft(draft, humanCard, blueprint, createRuleCurator());
  const review = confirmEvaluationReview(
    createEvaluationReview({ taskCard: humanCard, draft, curation }),
    "evaluation-human-reviewer",
  );
  const reviewHash = evaluationReviewConfirmationSha256(review);

  const result = assertU1BLiveEvidencePreflight({
    contract: evidenceContract({
      taskCardHash: taskCardContentSha256(humanCard),
      reviewHash,
      mode: "human",
    }),
    taskCard: humanCard,
    draft,
    review,
    noRelease: true,
  });

  assert.deepEqual(result, {
    track: "u1-b-formal",
    confirmationMode: "human",
    explorationOnly: false,
    humanConfirmationBypassed: false,
  });
});

test("live U1-B preflight rejects test-fixture confirmations", async () => {
  const { card, draft, review } = await reviewFixture();
  const confirmedReview = confirmEvaluationReview(review, "evaluation-review-fixture", {
    mode: "test-fixture",
  });
  const reviewHash = evaluationReviewConfirmationSha256(confirmedReview);

  assert.throws(
    () => assertU1BLiveEvidencePreflight({
      contract: evidenceContract({
        taskCardHash: taskCardContentSha256(card),
        reviewHash,
        mode: "test-fixture",
      }),
      taskCard: card,
      draft,
      review: confirmedReview,
      noRelease: true,
    }),
    /U1B_FIXTURE_LIVE_FORBIDDEN/,
  );
});

test("U1-B live preflight detects review and Task Card hash drift", async () => {
  const fixtureCard = sampleTaskCard();
  const humanCard = confirmTaskCard(
    TaskCardSchema.parse({ ...fixtureCard, confirmation: { status: "draft" } }),
    "task-card-human-reviewer",
  ).card;
  const blueprint = composeBlueprint(humanCard);
  const draft = await generateDraft(blueprint, humanCard, createFixtureGenerator());
  const curation = await curateDraft(draft, humanCard, blueprint, createRuleCurator());
  const review = confirmEvaluationReview(
    createEvaluationReview({ taskCard: humanCard, draft, curation }),
    "evaluation-human-reviewer",
  );
  const reviewHash = evaluationReviewConfirmationSha256(review);

  assert.throws(
    () => assertU1BLiveEvidencePreflight({
      contract: evidenceContract({
        taskCardHash: "f".repeat(64),
        reviewHash,
        mode: "human",
      }),
      taskCard: humanCard,
      draft,
      review,
      noRelease: true,
    }),
    /U1B_EVIDENCE_HASH_DRIFT/,
  );
});
