import test from "node:test";
import assert from "node:assert/strict";
import { ZodError } from "zod";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  freezeContract,
  FreezeError,
  assertEvolutionTrainOnlyReference,
  loadEvolutionItems,
  loadTerminalSelectionItems,
  evaluationContractContentSha256,
  semanticFingerprint,
  SPLIT_MIN_HOLDOUT_ITEMS,
  SPLIT_MAX_RATIO_DEVIATION,
  type FreezeInput,
} from "./freezeContract.js";
import { composeBlueprint, } from "./composeBlueprint.js";
import { sampleTaskCard } from "./composeBlueprint.test.js";
import { createFixtureGenerator, generateDraft } from "./generateDraft.js";
import { createRuleCurator, curateDraft } from "./curateDraft.js";
import {
  CurationResultSchema,
  DEFAULT_U1_SCORING_PROFILE,
  EvaluationContractV3Schema,
  EvaluationDraftSchema,
  FrozenContractManifestSchema,
  HoldoutFileSchema,
  TaskCardSchema,
  type CurationResult,
  type EvaluationContractV3,
  type TaskCard,
} from "../types.js";
import { scoringIdentityOfContract, U1RubricError } from "../evaluation/u1Rubric.js";
import { confirmTaskCard } from "../intake/taskCard.js";
import {
  createEvaluationReview,
  confirmEvaluationReview,
  evaluationReviewConfirmationSha256,
} from "./evaluationReview.js";
import { stableStringify } from "../intake/taskCard.js";
import { loadU1RuntimeBinding } from "../runtime/u1ScenarioRunner.js";
import type { FrozenRuntimeContextManifest } from "../runtime/frozenContext.js";

async function greenPipeline(card: TaskCard) {
  const blueprint = composeBlueprint(card);
  const draft = await generateDraft(blueprint, card, createFixtureGenerator());
  const curation = await curateDraft(draft, card, blueprint, createRuleCurator());
  return { blueprint, draft, curation };
}

function freezeInput(overrides: Partial<FreezeInput> = {}): Omit<FreezeInput, "adapterId"> & { adapterId?: string } {
  const input = { adapterId: "instruction-v1", ...overrides } as FreezeInput;
  if (input.taskCard && input.draft && !input.evaluationReview) {
    input.evaluationReview = confirmEvaluationReview(
      createEvaluationReview({ taskCard: input.taskCard, draft: input.draft, curation: input.curation }),
      "evaluation-review-fixture",
      { mode: "test-fixture" },
    );
    input.evidenceMode = "test-fixture";
  }
  return input;
}

/** The 3-scenario sample cannot land within tolerance (see the low-sample tests). */
const SAMPLE_DEVIATION_REASON =
  "low sample: 3 scenarios make the isolation-safe holdout floor 3 of 8 items (0.375 vs target 0.2)";

function reconfirmFixture(card: TaskCard): TaskCard {
  const draft = TaskCardSchema.parse({ ...card, confirmation: { status: "draft" } });
  return confirmTaskCard(draft, "task-card-fixture", { mode: "test-fixture" }).card;
}

test("a green fixture pipeline freezes into a valid contract, holdout file and manifest", async () => {
  const card = sampleTaskCard();
  const { blueprint, draft, curation } = await greenPipeline(card);
  const bundle = await freezeContract(
    freezeInput({ taskCard: card, blueprint, draft, curation, deviationReason: SAMPLE_DEVIATION_REASON }) as FreezeInput,
  );

  assert.ok(EvaluationContractV3Schema.safeParse(bundle.contract).success);
  assert.ok(HoldoutFileSchema.safeParse(bundle.holdoutFile).success);
  assert.ok(FrozenContractManifestSchema.safeParse(bundle.manifest).success);
  assert.match(bundle.contract.contractSha256, /^[0-9a-f]{64}$/);
  assert.match(bundle.manifest.holdoutSha256, /^[0-9a-f]{64}$/);
  assert.equal(bundle.contract.explorationOnly, true);
  assert.equal(bundle.contract.generation.generatorCuratorIsolation, "independent");
  assert.ok(bundle.contract.goalConfidence.reasons.length >= 3, "goal confidence must be explainable");
  assert.ok(bundle.contract.evalConfidence.reasons.length >= 3, "eval confidence must be explainable");
  assert.ok(bundle.holdoutFile.items.length >= 1);
  assert.equal(bundle.contract.trainItemIds?.length, 8);
  assert.equal(bundle.contract.selectItemIds?.length, 6);
  assert.equal(bundle.contract.calibrationMinAdjacentGap, 10);
  assert.equal(bundle.manifest.trainItemIds?.length, 8);
  assert.equal(bundle.manifest.selectItemIds?.length, 6);
  assert.equal(bundle.manifest.holdoutItemIds.length, 3);
  assert.match(bundle.manifest.trainItemsSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.match(bundle.manifest.selectItemsSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.match(bundle.manifest.holdoutItemsSha256 ?? "", /^[0-9a-f]{64}$/);
  const contractCalibrationHash = (bundle.contract as typeof bundle.contract & {
    calibrationTripletSha256?: string;
  }).calibrationTripletSha256;
  const manifestCalibrationHash = (bundle.manifest as typeof bundle.manifest & {
    calibrationTripletSha256?: string;
  }).calibrationTripletSha256;
  assert.match(contractCalibrationHash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(manifestCalibrationHash, contractCalibrationHash);
  assert.deepEqual(
    bundle.manifest.holdoutItemIds,
    bundle.holdoutFile.items.map((item) => item.itemId),
  );
});

test("new U1-B freeze binds one complete scoring identity and rejects verifier item drift", async (t) => {
  const card = sampleTaskCard();
  const { blueprint, draft, curation } = await greenPipeline(card);
  const bundle = await freezeContract(
    freezeInput({ taskCard: card, blueprint, draft, curation, deviationReason: SAMPLE_DEVIATION_REASON }) as FreezeInput,
  );

  assert.equal(bundle.contract.u1ContractVersion, "v2");
  assert.deepEqual(bundle.contract.scoringProfile, DEFAULT_U1_SCORING_PROFILE);
  assert.ok(draft.items.every((item) => item.taskVerifier?.version === DEFAULT_U1_SCORING_PROFILE.taskVerifierVersion));
  assert.deepEqual(scoringIdentityOfContract({ contract: bundle.contract, items: draft.items }), {
    contractSha256: bundle.contract.contractSha256,
    profileVersion: DEFAULT_U1_SCORING_PROFILE.version,
    taskVerifierVersion: DEFAULT_U1_SCORING_PROFILE.taskVerifierVersion,
    rubricVersion: DEFAULT_U1_SCORING_PROFILE.rubricVersion,
  });

  const profileDrift = {
    ...bundle.contract,
    scoringProfile: {
      ...bundle.contract.scoringProfile!,
      dimensions: bundle.contract.scoringProfile!.dimensions.map((dimension, index) =>
        index === 0 ? { ...dimension, minimumScore: dimension.minimumScore + 1 } : dimension),
    },
  } as EvaluationContractV3;
  assert.throws(
    () => scoringIdentityOfContract({ contract: profileDrift }),
    (error: unknown) => error instanceof U1RubricError && error.code === "U1_SCORING_CONTRACT_HASH_MISMATCH",
  );
  const versionDrift = { ...bundle.contract, u1ContractVersion: "v1" as const } as unknown as EvaluationContractV3;
  assert.throws(
    () => scoringIdentityOfContract({ contract: versionDrift }),
    (error: unknown) => error instanceof U1RubricError && error.code === "U1_SCORING_CONTRACT_HASH_MISMATCH",
  );
  const selectItem = draft.items.find((item) => item.selectionRole === "select")!;
  const root = await mkdtemp(join(tmpdir(), "skillfoo-scoring-item-drift-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const driftedDraft = {
    ...draft,
    items: draft.items.map((item) => item.itemId !== selectItem.itemId ? item : {
      ...item,
      taskVerifier: {
        ...item.taskVerifier!,
        rules: item.taskVerifier!.rules.map((rule, index) => index !== 0 || rule.kind !== "forbidden_content"
          ? rule
          : { ...rule, value: `${rule.value} drifted` }),
      },
    }),
  };
  const draftPath = join(root, "evaluation-draft.json");
  await writeFile(draftPath, JSON.stringify(driftedDraft), "utf8");
  await assert.rejects(
    () => loadTerminalSelectionItems(draftPath, bundle.manifest),
    (error: unknown) => error instanceof FreezeError && error.code === "FREEZE_INPUT_INVALID",
  );
});

test("new U1-B freeze refuses a blueprint that omits the complete scoring profile", async () => {
  const card = sampleTaskCard();
  const { blueprint, draft, curation } = await greenPipeline(card);
  const { scoringProfile: _omittedScoringProfile, ...historicalShape } = blueprint;
  await assert.rejects(
    () => freezeContract(freezeInput({
      taskCard: card,
      blueprint: historicalShape as unknown as typeof blueprint,
      draft,
      curation,
      deviationReason: SAMPLE_DEVIATION_REASON,
    }) as FreezeInput),
    (error: unknown) => error instanceof FreezeError && error.code === "FREEZE_U1_SCORING_PROFILE_REQUIRED",
  );
});

test("current U1 freeze rejects a non-current scoring identity at the schema boundary", async () => {
  const card = sampleTaskCard();
  const { blueprint, draft, curation } = await greenPipeline(card);
  const historicalProfileBlueprint = {
    ...blueprint,
    scoringProfile: {
      ...blueprint.scoringProfile!,
      version: "u1-scoring-profile-v1" as const,
      taskVerifierVersion: "u1-task-verifier-v1" as const,
      rubricVersion: "u1-five-dimension-rubric-v1" as const,
    },
  };
  await assert.rejects(
    () => freezeContract(freezeInput({
      taskCard: card,
      blueprint: historicalProfileBlueprint as unknown as typeof blueprint,
      draft,
      curation,
      deviationReason: SAMPLE_DEVIATION_REASON,
    }) as FreezeInput),
    (error: unknown) => {
      assert.ok(error instanceof ZodError);
      assert.deepEqual(
        new Set(error.issues.map((issue) => issue.path.join("."))),
        new Set(["version", "taskVerifierVersion", "rubricVersion"]),
      );
      return true;
    },
  );
});

test("reference-v1 freeze binds the canonical runtime-context manifest SHA and requires it", async () => {
  const card = sampleTaskCard();
  const { blueprint, draft, curation } = await greenPipeline(card);
  const referenceBlueprint = {
    ...blueprint,
    capabilityMap: blueprint.capabilityMap.map((entry) => ({ ...entry, adapterId: "reference-v1" })),
  };
  const runtimeContextManifestSha256 = "f".repeat(64);
  const bundle = await freezeContract({
    ...freezeInput({ taskCard: card, blueprint: referenceBlueprint, draft, curation, deviationReason: SAMPLE_DEVIATION_REASON }),
    adapterId: "reference-v1",
    runtimeContextManifestSha256,
  } as FreezeInput & { runtimeContextManifestSha256: string });
  assert.equal(bundle.contract.sourceHashes.runtimeContextManifest, runtimeContextManifestSha256);
  assert.equal(evaluationContractContentSha256(bundle.contract), bundle.contract.contractSha256);

  await assert.rejects(
    () => freezeContract({
      ...freezeInput({ taskCard: card, blueprint: referenceBlueprint, draft, curation, deviationReason: SAMPLE_DEVIATION_REASON }),
      adapterId: "reference-v1",
    } as FreezeInput),
    (error: unknown) =>
      error instanceof FreezeError &&
      (error as unknown as { code: string }).code === "FROZEN_CONTEXT_REQUIRED",
  );
});

test("U1 runtime binding rejects a manifest SHA that differs from the frozen contract", async (t) => {
  const card = sampleTaskCard();
  const { blueprint, draft, curation } = await greenPipeline(card);
  const base = await freezeContract(
    freezeInput({ taskCard: card, blueprint, draft, curation, deviationReason: SAMPLE_DEVIATION_REASON }) as FreezeInput,
  );
  const expectedManifestSha = "f".repeat(64);
  const drifted = {
    ...base.contract,
    adapterId: "reference-v1",
    sourceHashes: { ...base.contract.sourceHashes, runtimeContextManifest: expectedManifestSha },
    contractSha256: "0".repeat(64),
  };
  drifted.contractSha256 = evaluationContractContentSha256(drifted);
  const contract = EvaluationContractV3Schema.parse(drifted);

  const root = await mkdtemp(join(tmpdir(), "skillfoo-runtime-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "reference.txt"), "bound", "utf8");
  const content: Omit<FrozenRuntimeContextManifest, "manifestSha256"> = {
    schemaVersion: 1,
    adapterId: "reference-v1",
    entries: [{
      id: "bound",
      kind: "reference",
      path: "reference.txt",
      mediaType: "text/plain",
      sha256: createHash("sha256").update("bound", "utf8").digest("hex"),
    }],
    replays: [],
  };
  const manifest: FrozenRuntimeContextManifest = {
    ...content,
    manifestSha256: createHash("sha256").update(stableStringify(content), "utf8").digest("hex"),
  };
  const manifestPath = join(root, "runtime-context.v1.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await assert.rejects(
    () => loadU1RuntimeBinding({ contract, runtimeContextPath: manifestPath }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "FROZEN_CONTEXT_HASH_MISMATCH",
  );
});

test("U1-B freeze rejects any count other than 8 train / 6 select / 3 holdout", async () => {
  const card = sampleTaskCard();
  const { blueprint, draft } = await greenPipeline(card);
  const firstTrain = draft.items.find((item) => item.selectionRole === "train")!;
  const reduced = EvaluationDraftSchema.parse({
    ...draft,
    items: draft.items.filter((item) => item.itemId !== firstTrain.itemId),
  });
  const curation = await curateDraft(reduced, card, blueprint, createRuleCurator());
  await assert.rejects(
    () => freezeContract(freezeInput({ taskCard: card, blueprint, draft: reduced, curation }) as FreezeInput),
    (error: unknown) => error instanceof FreezeError && error.code === "FREEZE_U1B_COUNT_MISMATCH",
  );
});

test("formal U1-B freeze rejects machine-draft items even with real human confirmations", async () => {
  const cardDraft = TaskCardSchema.parse({ ...sampleTaskCard(), confirmation: { status: "draft" } });
  const card = confirmTaskCard(cardDraft, "human-operator", { mode: "human" }).card;
  const { blueprint, draft, curation } = await greenPipeline(card);
  const evaluationReview = confirmEvaluationReview(
    createEvaluationReview({ taskCard: card, draft, curation }),
    "human-evaluation-reviewer",
    { mode: "human" },
  );
  await assert.rejects(
    () => freezeContract({
      taskCard: card,
      blueprint,
      draft,
      curation,
      evaluationReview,
      evidenceMode: "formal",
      adapterId: "instruction-v1",
    }),
    (error: unknown) => error instanceof FreezeError && error.code === "FREEZE_U1B_REVIEW_STATUS",
  );
});

test("U1-B freeze rejects train/select overlap even when ids and families differ", async () => {
  const card = sampleTaskCard();
  const { blueprint, draft } = await greenPipeline(card);
  const train = draft.items.find((item) => item.selectionRole === "train")!;
  const select = draft.items.find((item) => item.selectionRole === "select")!;
  const overlapped = EvaluationDraftSchema.parse({
    ...draft,
    items: draft.items.map((item) => item.itemId === select.itemId ? { ...item, input: train.input } : item),
  });
  const curation = await curateDraft(overlapped, card, blueprint, createRuleCurator());
  await assert.rejects(
    () => freezeContract(freezeInput({ taskCard: card, blueprint, draft: overlapped, curation }) as FreezeInput),
    (error: unknown) => error instanceof FreezeError && error.code === "FREEZE_U1B_ROLE_CROSSOVER",
  );
});

test("U1-B freeze rejects a scenario family crossing from public into sealed holdout", async () => {
  const card = sampleTaskCard();
  const { blueprint, draft } = await greenPipeline(card);
  const train = draft.items.find((item) => item.selectionRole === "train")!;
  const holdout = draft.items.find((item) => item.split === "holdout")!;
  const crossed = EvaluationDraftSchema.parse({
    ...draft,
    items: draft.items.map((item) => item.itemId === holdout.itemId
      ? { ...item, scenarioFamily: train.scenarioFamily }
      : item),
  });
  const curation = await curateDraft(crossed, card, blueprint, createRuleCurator());
  await assert.rejects(
    () => freezeContract(freezeInput({ taskCard: card, blueprint, draft: crossed, curation }) as FreezeInput),
    (error: unknown) => error instanceof FreezeError && error.code === "FREEZE_U1B_ROLE_CROSSOVER",
  );
});

test("the same freeze inputs always produce the same contract hash", async () => {
  const card = sampleTaskCard();
  const { blueprint, draft, curation } = await greenPipeline(card);
  const input = freezeInput({
    taskCard: card,
    blueprint,
    draft,
    curation,
    deviationReason: SAMPLE_DEVIATION_REASON,
  }) as FreezeInput;
  const first = await freezeContract(input);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await freezeContract(input);
  assert.equal(first.contract.contractSha256, second.contract.contractSha256);
  assert.equal(first.manifest.holdoutSha256, second.manifest.holdoutSha256);
});

test("the contract self-hash detects schema-valid content drift", async () => {
  const card = sampleTaskCard();
  const { blueprint, draft, curation } = await greenPipeline(card);
  const bundle = await freezeContract(freezeInput({
    taskCard: card,
    blueprint,
    draft,
    curation,
    deviationReason: SAMPLE_DEVIATION_REASON,
  }) as FreezeInput);
  assert.equal(evaluationContractContentSha256(bundle.contract), bundle.contract.contractSha256);
  const drifted = EvaluationContractV3Schema.parse({
    ...bundle.contract,
    sameModelLimitation: `${bundle.contract.sameModelLimitation ?? ""} drift`,
  });
  assert.notEqual(evaluationContractContentSha256(drifted), drifted.contractSha256);
});

test("an unconfirmed task card is refused", async () => {
  const card = sampleTaskCard() as TaskCard & { confirmation: Record<string, unknown> };
  card.confirmation = { status: "draft" };
  const { blueprint, draft, curation } = await greenPipeline(sampleTaskCard());
  await assert.rejects(
    () => freezeContract(freezeInput({ taskCard: card as unknown as TaskCard, blueprint, draft, curation }) as FreezeInput),
    (e: unknown) => e instanceof FreezeError && e.code === "TASK_CARD_NOT_CONFIRMED",
  );
});

test("freeze refuses a missing independent evaluation review", async () => {
  const card = sampleTaskCard();
  const { blueprint, draft, curation } = await greenPipeline(card);
  await assert.rejects(
    () => freezeContract({
      taskCard: card,
      blueprint,
      draft,
      curation,
      adapterId: "instruction-v1",
      evidenceMode: "test-fixture",
    }),
    (error: unknown) => error instanceof FreezeError && error.code === "EVALUATION_REVIEW_REQUIRED",
  );
});

test("fixture double confirmation freezes exploration-only and records its evidence mode", async () => {
  const card = sampleTaskCard();
  const { blueprint, draft, curation } = await greenPipeline(card);
  const evaluationReview = confirmEvaluationReview(
    createEvaluationReview({ taskCard: card, draft, curation }),
    "evaluation-review-fixture",
    { mode: "test-fixture" },
  );
  const bundle = await freezeContract({
    taskCard: card,
    blueprint,
    draft,
    curation,
    evaluationReview,
    evidenceMode: "test-fixture",
    adapterId: "instruction-v1",
    deviationReason: SAMPLE_DEVIATION_REASON,
  });

  assert.equal(bundle.contract.explorationOnly, true);
  assert.equal(bundle.contract.confirmationMode, "test-fixture");
  assert.equal(bundle.contract.humanConfirmationBypassed, false);
  assert.equal(bundle.manifest.evaluationReviewHash, evaluationReviewConfirmationSha256(evaluationReview));
});

test("a draft whose curator did not accept is refused", async () => {
  const card = sampleTaskCard();
  const { blueprint, draft } = await greenPipeline(card);
  const failed = CurationResultSchema.parse({
    ...CurationResultSchema.parse(
      (await greenPipeline(card)).curation,
    ),
    verdict: "needs_revision",
    findings: [],
  });
  await assert.rejects(
    () => freezeContract(freezeInput({ taskCard: card, blueprint, draft, curation: failed as CurationResult }) as FreezeInput),
    (e: unknown) => e instanceof FreezeError && e.code === "CURATION_NOT_PASSED",
  );
});

test("an adapter that is not declared in the blueprint is refused", async () => {
  const card = sampleTaskCard();
  const { blueprint, draft, curation } = await greenPipeline(card);
  await assert.rejects(
    () => freezeContract(freezeInput({ taskCard: card, blueprint, draft, curation, adapterId: "unknown-v1" }) as FreezeInput),
    (e: unknown) => e instanceof FreezeError && e.code === "FREEZE_ADAPTER_UNDECLARED",
  );
});

test("a draft bound to a different task card is refused", async () => {
  const card = sampleTaskCard();
  const otherCard = reconfirmFixture({
    ...sampleTaskCard(),
    goal: "A different goal entirely.",
  });
  const { blueprint, draft, curation } = await greenPipeline(card);
  await assert.rejects(
    () =>
      freezeContract(
        freezeInput({ taskCard: otherCard, blueprint, draft, curation, deviationReason: SAMPLE_DEVIATION_REASON }) as FreezeInput,
      ),
    (e: unknown) => e instanceof FreezeError && e.code === "FREEZE_INPUT_INVALID",
  );
});

test("semantic fingerprints normalize case and whitespace", () => {
  assert.equal(
    semanticFingerprint("  Summarize   repo X. "),
    semanticFingerprint("summarize repo x."),
  );
});

// ── T05b: split policy (target ratio, tolerance, forced deviations) ──

function wideCard(scenarioCount: number): TaskCard {
  return reconfirmFixture(TaskCardSchema.parse({
    ...sampleTaskCard(),
    scenarios: Array.from({ length: scenarioCount }, (_, index) => ({
      id: `s${index + 1}`,
      userRequest: `Request number ${index + 1} for the weekly digest.`,
    })),
    confirmation: { status: "draft" },
  }));
}

test("split policy: a draft within tolerance freezes without a deviation reason", async () => {
  // New U1-B suites always freeze 3/17 holdout items, within the 0.2 target tolerance.
  const card = wideCard(10);
  const { blueprint, draft, curation } = await greenPipeline(card);
  const bundle = await freezeContract(freezeInput({ taskCard: card, blueprint, draft, curation }) as FreezeInput);

  const holdout = draft.items.filter((item) => item.split === "holdout").length;
  assert.equal(bundle.contract.splitPolicy.targetHoldoutRatio, 0.2);
  assert.equal(bundle.contract.splitPolicy.minHoldoutItems, SPLIT_MIN_HOLDOUT_ITEMS);
  assert.equal(bundle.contract.splitPolicy.maxRatioDeviation, SPLIT_MAX_RATIO_DEVIATION);
  assert.equal(bundle.contract.splitPolicy.actualHoldoutRatio, holdout / draft.items.length);
  assert.equal(bundle.contract.splitPolicy.deviationReason, undefined);
});

test("evolution input guards reject holdout references and stay fail-closed", async () => {
  const card = sampleTaskCard();
  const { blueprint, draft, curation } = await greenPipeline(card);
  const bundle = await freezeContract(
    freezeInput({ taskCard: card, blueprint, draft, curation, deviationReason: SAMPLE_DEVIATION_REASON }) as FreezeInput,
  );
  const manifest = bundle.manifest;

  const publicId = manifest.trainItemIds[0];
  const holdoutId = manifest.holdoutItemIds[0];
  assertEvolutionTrainOnlyReference(publicId, manifest);
  assertEvolutionTrainOnlyReference(join("x", "evaluation-contract.v3.json"), manifest);
  assert.throws(
    () => assertEvolutionTrainOnlyReference(holdoutId, manifest),
    (e: unknown) => e instanceof FreezeError && e.code === "HOLDOUT_REFERENCE_FORBIDDEN",
  );
  assert.throws(
    () => assertEvolutionTrainOnlyReference(join("x", "evaluation-holdout.v3.json"), manifest),
    /HOLDOUT_REFERENCE_FORBIDDEN/,
  );
  assert.throws(() => assertEvolutionTrainOnlyReference("d999", manifest), /HOLDOUT_REFERENCE_FORBIDDEN/);
});

test("loadEvolutionItems exposes train only and rejects select ids and a holdout file path", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "skillfoo-freeze-"));
  const card = sampleTaskCard();
  const { blueprint, draft, curation } = await greenPipeline(card);
  const bundle = await freezeContract(
    freezeInput({ taskCard: card, blueprint, draft, curation, deviationReason: SAMPLE_DEVIATION_REASON }) as FreezeInput,
  );

  await writeFile(join(workDir, "evaluation-draft.json"), JSON.stringify(draft), "utf8");
  await writeFile(join(workDir, "evaluation-manifest.v3.json"), JSON.stringify(bundle.manifest), "utf8");

  const publicItems = await loadEvolutionItems(join(workDir, "evaluation-draft.json"), bundle.manifest);
  assert.deepEqual(
    publicItems.map((entry) => entry.itemId).sort(),
    [...bundle.manifest.trainItemIds].sort(),
  );
  const selectItems = await loadTerminalSelectionItems(
    join(workDir, "evaluation-draft.json"),
    bundle.manifest,
  );
  assert.deepEqual(
    selectItems.map((entry) => entry.itemId).sort(),
    [...bundle.manifest.selectItemIds].sort(),
  );
  assert.ok(selectItems.every((entry) => entry.selectionRole === "select"));
  assert.ok(selectItems.every((entry) => !bundle.manifest.trainItemIds.includes(entry.itemId)));
  assert.throws(
    () => assertEvolutionTrainOnlyReference(bundle.manifest.selectItemIds?.[0] ?? "missing-select", bundle.manifest),
    (error: unknown) => error instanceof FreezeError && error.code === "SELECTION_REFERENCE_FORBIDDEN",
  );

  const holdoutPath = join(workDir, "evaluation-holdout.v3.json");
  await writeFile(holdoutPath, JSON.stringify(bundle.holdoutFile), "utf8");
  await assert.rejects(
    () => loadEvolutionItems(holdoutPath, bundle.manifest),
    (e: unknown) => e instanceof FreezeError && e.code === "HOLDOUT_REFERENCE_FORBIDDEN",
  );
});
