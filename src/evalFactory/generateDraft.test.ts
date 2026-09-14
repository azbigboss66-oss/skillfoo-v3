import test from "node:test";
import assert from "node:assert/strict";
import { createFixtureGenerator, generateDraft, type DraftGenerator } from "./generateDraft.js";
import { composeBlueprint } from "./composeBlueprint.js";
import { sampleTaskCard } from "./composeBlueprint.test.js";
import {
  EvaluationDraftSchema,
  U1BDraftItemSchema,
  U1_TASK_VERIFIER_VERSION,
  type EvaluationDraft,
  type RawDraftItem,
} from "../types.js";

function fixtureBlueprint() {
  return composeBlueprint(sampleTaskCard());
}

test("fixture generator builds the frozen 8 train / 6 select / 3 holdout shape and covers redlines", async () => {
  const card = sampleTaskCard();
  const blueprint = fixtureBlueprint();
  const draft = EvaluationDraftSchema.parse(
    await generateDraft(blueprint, card, createFixtureGenerator()),
  );

  assert.equal(draft.items.length, 17);
  assert.equal(draft.items.filter((item) => item.selectionRole === "train").length, 8);
  assert.equal(draft.items.filter((item) => item.selectionRole === "select").length, 6);
  assert.equal(draft.items.filter((item) => item.split === "holdout").length, 3);

  for (const scenario of card.scenarios) {
    const trigger = draft.items.find((item) => item.scenarioId === scenario.id && item.itemType === "trigger");
    assert.ok(trigger, `trigger item missing for ${scenario.id}`);
  }
  for (const redline of card.redlines) {
    const negative = draft.items.find(
      (item) => item.itemType === "negative" && item.redlineRefs?.includes(redline),
    );
    assert.ok(negative, `no negative item covers redline: ${redline}`);
    assert.equal(negative?.origin, "redline-derived");
  }

  const publicItems = draft.items.filter((item) => item.split === "public");
  const holdoutItems = draft.items.filter((item) => item.split === "holdout");
  assert.ok(publicItems.length >= 1);
  assert.ok(holdoutItems.length >= 1);
  assert.equal(new Set(holdoutItems.map((item) => item.scenarioFamily)).size, 3);
});

test("draft items are deterministic: same input, same order, same item ids", async () => {
  const card = sampleTaskCard();
  const generator = createFixtureGenerator();
  // One blueprint object: composing twice would embed two createdAt values in
  // sourceHashes.blueprint and make this test flap on millisecond boundaries.
  const blueprint = fixtureBlueprint();
  const first = await generateDraft(blueprint, card, generator);
  const second = await generateDraft(blueprint, card, generator);
  const strip = (draft: EvaluationDraft) => JSON.stringify({ ...draft, createdAt: "" });

  assert.equal(strip(first), strip(second));
  assert.deepEqual(
    first.items.map((item) => item.itemId),
    first.items.map((_, index) => `d${index + 1}`),
  );
});

test("offline fixture items are always low confidence and disclose it", async () => {
  const card = sampleTaskCard();
  const draft = await generateDraft(fixtureBlueprint(), card, createFixtureGenerator());
  assert.ok(draft.items.length > 0);
  for (const item of draft.items) {
    assert.equal(item.confidence.level, "low");
    assert.ok(
      item.confidence.reasons.some((reason) => /offline|no model|fixture/i.test(reason)),
      "fixture items must disclose offline generation",
    );
  }
});

test("new fixture items carry complete U1-B provenance, roles, families and weighted rubrics", async () => {
  const card = sampleTaskCard();
  const draft = await generateDraft(fixtureBlueprint(), card, createFixtureGenerator());
  for (const item of draft.items) {
    assert.ok(U1BDraftItemSchema.safeParse(item).success, `${item.itemId} must be strict U1-B evidence`);
    assert.equal(item.testSource, "fixture-derived");
    assert.equal(item.reviewStatus, "machine-draft");
    assert.ok(item.scenarioFamily);
    assert.ok(item.rubric);
    assert.equal(item.taskVerifier?.version, U1_TASK_VERIFIER_VERSION);
    assert.ok(item.taskVerifier?.rules.every((rule) =>
      rule.effect === "quality" && rule.dimension !== undefined && rule.weight !== undefined && rule.weight > 0),
    );
    if (item.split === "public") {
      assert.ok(item.selectionRole === "train" || item.selectionRole === "select");
    } else {
      assert.equal(item.selectionRole, undefined);
    }
  }
  assert.ok(draft.items.some((item) => item.selectionRole === "train"));
  assert.ok(draft.items.some((item) => item.selectionRole === "select"));
  assert.equal(new Set(draft.items.map((item) => item.scenarioFamily)).size, draft.items.length);
});

test("new U1-B drafts freeze one reviewed train calibration triplet with distinct Good Borderline Unsafe answers", async () => {
  const card = sampleTaskCard();
  const draft = await generateDraft(fixtureBlueprint(), card, createFixtureGenerator());
  const calibration = (draft as EvaluationDraft & {
    calibration?: {
      sourceItemId: string;
      sourceItemSha256: string;
      answers: { good: string; borderline: string; unsafe: string };
      reviewStatus: string;
      testSource: string;
    };
  }).calibration;

  assert.ok(calibration, "a new U1-B draft must carry its frozen calibration triplet");
  const source = draft.items.find((item) => item.itemId === calibration.sourceItemId);
  assert.ok(source, "the calibration source must resolve inside the same frozen draft");
  assert.equal(source.selectionRole, "train", "calibration may not use terminal select or sealed holdout items");
  assert.match(calibration.sourceItemSha256, /^[0-9a-f]{64}$/);
  assert.equal(calibration.reviewStatus, "machine-draft");
  assert.equal(calibration.testSource, "fixture-derived");
  assert.ok(calibration.answers.good.trim());
  assert.ok(calibration.answers.borderline.trim());
  assert.ok(calibration.answers.unsafe.trim());
  assert.equal(new Set(Object.values(calibration.answers)).size, 3);
});

test("fixture variants are semantic boundary probes, not Please-also or Never-stripping templates", async () => {
  const card = sampleTaskCard();
  const draft = await generateDraft(fixtureBlueprint(), card, createFixtureGenerator());
  assert.equal(draft.items.some((item) => /Please also:/i.test(item.input)), false);
  assert.equal(draft.items.some((item) => /^Give me the result right now/i.test(item.input)), false);
  assert.equal(
    draft.items.some((item) => item.confidence.reasons.some((reason) => /derived mechanically/i.test(reason))),
    false,
  );

  const negativeInputs = draft.items
    .filter((item) => item.itemType === "negative")
    .map((item) => item.input);
  assert.equal(new Set(negativeInputs).size, negativeInputs.length);
});

test("identical raw inputs are deduplicated before item ids are assigned", async () => {
  const card = sampleTaskCard();
  const raw = (split: "public" | "holdout"): RawDraftItem => ({
    scenarioId: "s1",
    split,
    itemType: "trigger",
    input: "Summarize repo X this week.",
    judgingRule: "The answer must summarize repo X without fabrication.",
    capabilityTags: ["instruction"],
    origin: "scenario-derived",
    rationale: "direct restatement of scenario s1",
    confidence: { level: "low", score: 20, reasons: ["offline fixture: no model call"] },
    adapterId: "instruction-v1",
  });
  const duplicateGenerator: DraftGenerator = {
    producer: { kind: "fixture", name: "duplicate-generator" },
    proposeItems: async () => [raw("public"), raw("public"), raw("holdout")],
  };

  const draft = await generateDraft(fixtureBlueprint(), card, duplicateGenerator);
  assert.equal(draft.items.length, 2);
  assert.deepEqual(
    draft.items.map((item) => item.itemId),
    ["d1", "d2"],
  );
  assert.equal(draft.producer.kind, "fixture");
  assert.ok(draft.sourceHashes.taskCard);
  assert.ok(draft.sourceHashes.blueprint);
});

test("every item carries an adapter declared in the blueprint capability map", async () => {
  const card = sampleTaskCard();
  const draft = await generateDraft(fixtureBlueprint(), card, createFixtureGenerator());
  const declaredAdapters = new Set(fixtureBlueprint().capabilityMap.map((entry) => entry.adapterId));
  for (const item of draft.items) {
    assert.ok(declaredAdapters.has(item.adapterId), `item ${item.itemId} uses undeclared adapter ${item.adapterId}`);
  }
});
