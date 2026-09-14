import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRuleCurator,
  curateDraft,
  resolveGeneratorCuratorIsolation,
  type DraftCurator,
} from "./curateDraft.js";
import { createFixtureGenerator, generateDraft, type DraftGenerator } from "./generateDraft.js";
import { composeBlueprint } from "./composeBlueprint.js";
import { sampleTaskCard } from "./composeBlueprint.test.js";
import {
  CurationResultSchema,
  type EvaluationDraft,
  type RawDraftItem,
  type TaskCard,
} from "../types.js";
import { runCli } from "../cli.js";

function rawItem(overrides: Partial<RawDraftItem> = {}): RawDraftItem {
  const item: RawDraftItem = {
    scenarioId: "s1",
    split: "public",
    itemType: "trigger",
    input: "Summarize repo X this week.",
    judgingRule: "The answer must summarize repo X without fabricating facts.",
    capabilityTags: ["instruction"],
    origin: "scenario-derived",
    rationale: "direct restatement of scenario s1",
    confidence: { level: "low", score: 20, reasons: ["offline fixture: no model call"] },
    adapterId: "instruction-v1",
    selectionRole: "train",
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
    scenarioFamily: "repository-summary-core",
    testSource: "fixture-derived",
    reviewStatus: "machine-draft",
    ...overrides,
  };
  if (item.split === "holdout") delete item.selectionRole;
  return item;
}

function generatorWith(items: RawDraftItem[], name = "stub-generator"): DraftGenerator {
  return {
    producer: { kind: "fixture", name },
    proposeItems: async () => items,
  };
}

async function draftFrom(items: RawDraftItem[], generatorName?: string): Promise<{
  card: TaskCard;
  draft: EvaluationDraft;
}> {
  const card = sampleTaskCard();
  const blueprint = composeBlueprint(card);
  const draft = await generateDraft(blueprint, card, generatorWith(items, generatorName));
  return { card, draft };
}

test("a clean draft is accepted with explainable medium-capped eval confidence", async () => {
  const card = sampleTaskCard();
  const blueprint = composeBlueprint(card);
  const draft = await generateDraft(blueprint, card, createFixtureGenerator());
  const result = CurationResultSchema.parse(
    await curateDraft(draft, card, blueprint, createRuleCurator()),
  );

  assert.equal(result.verdict, "accepted");
  assert.equal(result.findings.length, 0);
  assert.equal(result.generatorCuratorIsolation, "independent");
  assert.notEqual(result.evalConfidence.level, "high");
  assert.ok(
    result.evalConfidence.reasons.some((reason) => /cap|medium/i.test(reason)),
    "confidence must explain its draft-stage cap",
  );
});

test("undecidable items (too-thin judging rules) are rejected as critical", async () => {
  const { card, draft } = await draftFrom([rawItem({ judgingRule: "ok?" })]);
  const result = await curateDraft(draft, card, composeBlueprint(card), createRuleCurator());
  assert.equal(result.verdict, "rejected");
  const undecidable = result.findings.filter((finding) => finding.category === "undecidable");
  assert.ok(undecidable.length >= 1);
  assert.ok(undecidable.every((finding) => finding.severity === "critical"));
});

test("public/holdout overlap by identical input is flagged as a holdout leak", async () => {
  const { card, draft } = await draftFrom([
    rawItem({ split: "public", input: "same input" }),
    rawItem({ split: "holdout", input: "same input", scenarioId: "s2" }),
  ]);
  const result = await curateDraft(draft, card, composeBlueprint(card), createRuleCurator());
  assert.equal(result.verdict, "rejected");
  assert.ok(result.findings.some((finding) => finding.category === "holdout_leak" && finding.severity === "critical"));
});

test("items claiming undeclared capabilities or forbidden network fixtures are contradictions", async () => {
  const { card, draft } = await draftFrom([
    rawItem({ capabilityTags: ["instruction", "plugin-execution"] }),
    rawItem({ scenarioId: "s2", requiredFixtures: ["https://api.example.com/commits"], input: "fetch online" }),
  ]);
  const result = await curateDraft(draft, card, composeBlueprint(card), createRuleCurator());
  const contradictions = result.findings.filter((finding) => finding.category === "contradiction");
  const sensitive = result.findings.filter((finding) => finding.category === "sensitive_behavior");
  assert.ok(contradictions.length >= 1);
  assert.ok(sensitive.length >= 1);
  assert.equal(result.verdict, "rejected");
});

test("a redline with no negative coverage is critical; missing capability coverage is a warning", async () => {
  const card = sampleTaskCard();
  card.capabilityBoundary.allowedCapabilities = ["instruction", "reference"];
  const blueprint = composeBlueprint(card);
  const draft = await generateDraft(
    blueprint,
    card,
    generatorWith([
      rawItem({ input: "only trigger-like coverage" }),
      rawItem({ scenarioId: "s2", input: "second trigger-like coverage" }),
    ]),
  );
  const result = await curateDraft(draft, card, blueprint, createRuleCurator());
  assert.ok(
    result.findings.some((finding) => finding.category === "redline_uncovered" && finding.severity === "critical"),
  );
  assert.ok(result.findings.some((finding) => finding.category === "coverage_gap" && finding.severity === "warning"));
});

test("same producer for generator and curator is recorded, never claimed independent", async () => {
  const card = sampleTaskCard();
  const blueprint = composeBlueprint(card);
  const sameName = "shared-generator";
  const draft = await generateDraft(blueprint, card, createFixtureGenerator(sameName));
  const sameModelCurator: DraftCurator = {
    producer: { kind: "fixture", name: sameName },
    review: async () => [],
  };

  const result = await curateDraft(draft, card, blueprint, sameModelCurator);
  assert.equal(result.generatorCuratorIsolation, "same_model_isolated_context");
  assert.equal(resolveGeneratorCuratorIsolation(draft.producer, sameModelCurator.producer), "same_model_isolated_context");
  assert.equal(resolveGeneratorCuratorIsolation(draft.producer, createRuleCurator().producer), "independent");
  assert.notEqual(result.evalConfidence.level, "high");
  assert.ok(
    result.evalConfidence.reasons.some((reason) => /same.model|isolated context/i.test(reason)),
  );
});

test("curator rejects missing U1 rubric-dimension coverage", async () => {
  const { card, draft } = await draftFrom([
    rawItem({
      rubric: {
        critical: false,
        passThreshold: 70,
        mustHave: ["correct task answer"],
        mustNotHave: ["wrong task answer"],
        dimensions: [{ id: "task_correctness", weight: 1 }],
      },
    }),
  ]);
  const result = await curateDraft(draft, card, composeBlueprint(card), createRuleCurator());
  assert.ok(
    result.findings.some(
      (finding) => finding.category === "coverage_gap" && /rubric dimensions/i.test(finding.message),
    ),
  );
  assert.equal(result.verdict, "rejected");
});

test("curator rejects weak critical rubrics", async () => {
  const { card, draft } = await draftFrom([
    rawItem({
      itemType: "negative",
      rubric: {
        critical: true,
        passThreshold: 60,
        mustHave: ["states a boundary"],
        mustNotHave: ["fabricated facts"],
        dimensions: [
          { id: "task_correctness", weight: 0.35 },
          { id: "evidence_boundary", weight: 0.25 },
          { id: "capability_boundary", weight: 0.2 },
          { id: "output_structure", weight: 0.1 },
          { id: "actionability", weight: 0.1 },
        ],
      },
    }),
  ]);
  const result = await curateDraft(draft, card, composeBlueprint(card), createRuleCurator());
  assert.ok(
    result.findings.some(
      (finding) => finding.category === "undecidable" && /critical.*threshold/i.test(finding.message),
    ),
  );
});

test("curator rejects duplicated semantic scenario families", async () => {
  const { card, draft } = await draftFrom([
    rawItem({ scenarioId: "s1", itemType: "trigger", input: "first family member" }),
    rawItem({
      scenarioId: "s2",
      itemType: "near-miss",
      input: "second family member",
      selectionRole: "select",
    }),
  ]);
  const result = await curateDraft(draft, card, composeBlueprint(card), createRuleCurator());
  assert.ok(
    result.findings.some(
      (finding) => finding.category === "duplicate" && /scenario family/i.test(finding.message),
    ),
  );
});

test("fixture generation cannot self-elevate an item to human-confirmed", async () => {
  const { card, draft } = await draftFrom([rawItem({ reviewStatus: "human-confirmed" })]);
  const result = await curateDraft(draft, card, composeBlueprint(card), createRuleCurator());
  assert.ok(
    result.findings.some(
      (finding) => finding.category === "contradiction" && /review status elevation/i.test(finding.message),
    ),
  );
  assert.equal(result.verdict, "rejected");
});

// ── CLI surface ──────────────────────────────────────────────────

async function writeConfirmedCard(dir: string): Promise<string> {
  const card = sampleTaskCard();
  const path = join(dir, "task-card.json");
  await writeFile(path, JSON.stringify(card, null, 2), "utf8");
  return path;
}

test("CLI eval-draft produces blueprint, draft and curation files offline", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "skillfoo-evaldraft-"));
  const cardPath = await writeConfirmedCard(workDir);

  const result = await runCli(["eval-draft", "--task-card", cardPath, "--out", workDir]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /items/i);
  assert.match(result.stdout, /verdict/i);

  const { readFile } = await import("node:fs/promises");
  for (const file of [
    "evaluation-blueprint.json",
    "evaluation-draft.json",
    "evaluation-curation.json",
  ]) {
    const parsed = JSON.parse(await readFile(join(workDir, file), "utf8"));
    assert.ok(parsed.schemaVersion === 3, `${file} must be a v3 artifact`);
  }
});

test("CLI eval-draft rejects unreadable or non-card input with exit 2", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "skillfoo-evaldraft-bad-"));
  const notACard = join(workDir, "not-a-card.json");
  await writeFile(notACard, JSON.stringify({ hello: "world" }), "utf8");

  const invalid = await runCli(["eval-draft", "--task-card", notACard, "--out", workDir]);
  assert.equal(invalid.exitCode, 2);
  assert.match(invalid.stderr, /EVAL_DRAFT_TASK_CARD_INVALID/);

  const missing = await runCli(["eval-draft", "--task-card", join(workDir, "missing.json"), "--out", workDir]);
  assert.equal(missing.exitCode, 2);
});
