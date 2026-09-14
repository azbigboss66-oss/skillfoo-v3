import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confirmTaskCard,
  createGoalTaskCardDraft,
  createTaskCardDraft,
  fixtureIntentOptions,
  IntakeError,
  parseTaskCardInput,
} from "./taskCard.js";
import {
  taskCardConfirmedPath,
  taskCardDraftPath,
  TASK_CARD_CONFIRMED_FILENAME,
  TASK_CARD_DRAFT_FILENAME,
} from "../storage/paths.js";
import { TaskCardSchema } from "../types.js";
import { runCli } from "../cli.js";

// Assemble test-only secret lookalikes at runtime so repository scanners do
// not mistake deterministic redaction sentinels for live credentials.
const OPENAI_LIKE_SECRET = ["sk", "abcdefghijklmnop1234567890"].join("-");
const GITHUB_LIKE_SECRET = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");

// ── T03: 5-minute Task Card intake ───────────────────────────────
// Human gives high-information constraints only; the card is a draft
// until explicitly confirmed; offline intent fixtures are always
// low-confidence; token-like input is rejected without echoing it.

function validInput(): Record<string, unknown> {
  return {
    goal: "A busy maintainer wants a trustworthy weekly digest of repository activity.",
    scenarios: [
      { userRequest: "Summarize what changed in repo X this week." },
      { userRequest: "Summarize what changed in repo Y this week." },
    ],
    redlines: ["Never fabricate repository facts."],
    intentDetails: {
      goal_and_intended_user: "Repository maintainers need a trustworthy weekly digest.",
      inputs_and_evidence: "Use only the supplied repository evidence and identify missing facts.",
      output_and_format: "Return a structured weekly digest.",
      capability_boundary_and_redlines: "No network, file, script, or external action; never fabricate facts.",
      success_criteria_and_protected_behavior: "Preserve factual accuracy and make evidence gaps explicit.",
    },
    capabilityBoundary: {
      allowedCapabilities: ["instruction"],
      network: "forbidden",
      filesystem: "forbidden",
      externalActions: "forbidden",
    },
  };
}

// ── Input validation ─────────────────────────────────────────────

test("valid input normalizes to a draft-ready shape", () => {
  const input = parseTaskCardInput(validInput());
  assert.equal(input.goal.length > 0, true);
  assert.deepEqual(input.scenarios.map((s) => s.id), ["s1", "s2"]);
  assert.deepEqual(input.qualityPriorities, [
    "correctness",
    "evidence",
    "format",
    "speed",
    "cost",
  ]);
});

test("invalid intake input fails with a structured code", () => {
  const oneScenario = validInput();
  (oneScenario as { scenarios: unknown[] }).scenarios = [
    (validInput().scenarios as { userRequest: string }[])[0],
  ];
  assert.throws(
    () => parseTaskCardInput(oneScenario),
    (e: unknown) => e instanceof IntakeError && e.code === "INVALID_INTAKE_INPUT",
  );

  const noBoundary = validInput() as Record<string, unknown>;
  delete noBoundary.capabilityBoundary;
  assert.throws(
    () => parseTaskCardInput(noBoundary),
    (e: unknown) => e instanceof IntakeError && e.code === "INVALID_INTAKE_INPUT",
  );

  const unknownKey = { ...validInput(), extra: "field" };
  assert.throws(
    () => parseTaskCardInput(unknownKey),
    (e: unknown) => e instanceof IntakeError && e.code === "INVALID_INTAKE_INPUT",
  );
});

test("token-like input is rejected and never echoed back", () => {
  const leaked = validInput() as { scenarios: { userRequest: string }[] };
  leaked.scenarios[0].userRequest = `use key ${OPENAI_LIKE_SECRET} for api`;
  assert.throws(
    () => parseTaskCardInput(leaked),
    (e: unknown) => {
      assert.ok(e instanceof IntakeError);
      assert.equal(e.code, "TOKEN_LIKE_INPUT");
      assert.ok(!e.message.includes(OPENAI_LIKE_SECRET));
      return true;
    },
  );

  const ghPat = validInput() as { references?: string[] };
  ghPat.references = [`see ${GITHUB_LIKE_SECRET}`];
  assert.throws(
    () => parseTaskCardInput(ghPat),
    (e: unknown) => e instanceof IntakeError && e.code === "TOKEN_LIKE_INPUT",
  );
});

// ── Draft creation ───────────────────────────────────────────────

test("a draft card parses as a TaskCard and carries stable source hashes", async () => {
  const input = parseTaskCardInput(validInput());
  const { card, contentSha256 } = await createTaskCardDraft(input);
  const parsed = TaskCardSchema.parse(card);
  assert.equal(parsed.confirmation.status, "draft");
  assert.match(parsed.sourceHashes.intakeInput ?? "", /^[0-9a-f]{64}$/);
  assert.match(contentSha256, /^[0-9a-f]{64}$/);
});

test("a goal-only draft persists bounded incompleteness and the source Skill hash", async () => {
  const skillDir = await mkdtemp(join(tmpdir(), "skillfoo-goal-intake-"));
  await writeFile(join(skillDir, "SKILL.md"), "# Goal intake source\n", "utf8");

  const { card } = await createGoalTaskCardDraft(
    "为一线销售把已有商机信息整理成可核验的下一步建议。",
    { skillDir },
  );

  assert.equal(card.intentStatus, "needs_clarification");
  assert.equal(card.unresolvedDimensions?.length, 5);
  assert.equal(card.clarifications?.length, 0);
  assert.match(card.goalSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.match(card.sourceHashes.skillMd ?? "", /^[0-9a-f]{64}$/);
  assert.equal(card.scenarios.length, 0);
  assert.equal(card.redlines.length, 0);
});

test("goal clarification answers are persisted as the five complete intent details", async () => {
  const answers = {
    goal_and_intended_user: "Help repository maintainers prepare a trustworthy digest.",
    inputs_and_evidence: "Use only the supplied repository evidence and identify gaps.",
    output_and_format: "Return a concise structured digest with evidence labels.",
    capability_boundary_and_redlines: "No network, scripts, file writes, or invented facts.",
    success_criteria_and_protected_behavior: "Preserve factual attribution and explicit limitations.",
  };
  const clarifications = Object.entries(answers).map(([dimension, answer]) => ({
    dimension: dimension as keyof typeof answers,
    promptZh: `请确认 ${dimension}`,
    answer,
  }));

  const { card } = await createGoalTaskCardDraft("生成可信的仓库周报。", { clarifications });

  assert.equal(card.intentStatus, "complete");
  assert.deepEqual(card.intentDetails, answers);
  assert.deepEqual(card.unresolvedDimensions, []);
  assert.doesNotThrow(() => confirmTaskCard(card, "operator"));
});

test("an incomplete natural-language Task Card cannot be confirmed", async () => {
  const { card } = await createGoalTaskCardDraft("改好这个 Skill。", {});
  assert.throws(
    () => confirmTaskCard(card, "operator"),
    (error: unknown) => error instanceof IntakeError && error.code === "CONFIRMATION_REQUIRES_COMPLETE_INTENT",
  );
});

test("a current complete Task Card missing any persisted intent detail cannot be confirmed", async () => {
  const { card } = await createTaskCardDraft(parseTaskCardInput(validInput()));
  const incomplete = {
    ...card,
    intentDetails: {
      goal_and_intended_user: "Repository maintainers need a trustworthy weekly digest.",
      inputs_and_evidence: "Use only the supplied repository evidence and name missing facts.",
      output_and_format: "Return a structured weekly digest.",
      capability_boundary_and_redlines: "No network, file, script, or external action; never fabricate facts.",
      // success_criteria_and_protected_behavior is intentionally absent.
    },
  } as Parameters<typeof confirmTaskCard>[0];

  assert.throws(
    () => confirmTaskCard(incomplete, "operator"),
    (error: unknown) =>
      error instanceof IntakeError && error.code === "CONFIRMATION_REQUIRES_COMPLETE_INTENT",
  );
});

test("goal-only intake rejects token-like content without echoing it", async () => {
  await assert.rejects(
    () => createGoalTaskCardDraft(`使用 ${OPENAI_LIKE_SECRET} 改进 Skill。`, {}),
    (error: unknown) =>
      error instanceof IntakeError &&
      error.code === "TOKEN_LIKE_INPUT" &&
      !error.message.includes(OPENAI_LIKE_SECRET),
  );
});

test("the same input yields the same content hash across invocations", async () => {
  const first = await createTaskCardDraft(parseTaskCardInput(validInput()));
  // createdAt has millisecond resolution; force a different timestamp so the
  // "hash excludes createdAt" property is actually exercised, not vacuous.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await createTaskCardDraft(parseTaskCardInput(validInput()));
  assert.equal(first.contentSha256, second.contentSha256);
  assert.notEqual(first.card.createdAt, second.card.createdAt);
});

test("a skill directory is referenced by hash only, never by content", async () => {
  const skillDir = await mkdtemp(join(tmpdir(), "skillfoo-intake-skill-"));
  await writeFile(
    join(skillDir, "SKILL.md"),
    "# Legacy behavior\nUNIQUEMARKER42 do the old thing.",
    "utf8",
  );
  const { card } = await createTaskCardDraft(parseTaskCardInput(validInput()), {
    skillDir,
  });
  const serialized = JSON.stringify(card);
  assert.ok(!serialized.includes("UNIQUEMARKER42"));
  assert.match(card.sourceHashes.skillMd ?? "", /^[0-9a-f]{64}$/);
});

// ── Intent fixtures (offline, never high confidence) ─────────────

test("offline intent fixtures are always low-confidence", async () => {
  const input = parseTaskCardInput(validInput());
  const options = fixtureIntentOptions(input);
  assert.ok(options.length >= 1 && options.length <= 3);
  for (const option of options) {
    assert.equal(option.confidence?.level, "low");
    assert.ok(
      option.confidence?.reasons.some((r) => /offline|no model|fixture/i.test(r)),
      "fixture intents must disclose they were generated without a model",
    );
  }

  const { card } = await createTaskCardDraft(input, { intentFixture: true });
  assert.ok(card.intentOptions && card.intentOptions.length > 0);
  for (const option of card.intentOptions) {
    assert.equal(option.confidence?.level, "low");
  }
});

// ── Confirmation ─────────────────────────────────────────────────

test("confirmation requires an operator and flips the card state", async () => {
  const { card, contentSha256 } = await createTaskCardDraft(parseTaskCardInput(validInput()));
  assert.throws(
    () => confirmTaskCard(card, ""),
    (e: unknown) => e instanceof IntakeError && e.code === "CONFIRMATION_REQUIRES_OPERATOR",
  );

  const confirmed = confirmTaskCard(card, "operator");
  const parsed = TaskCardSchema.parse(confirmed.card);
  assert.equal(parsed.confirmation.status, "confirmed");
  assert.equal(parsed.confirmation.confirmedBy, "operator");
  assert.equal(parsed.confirmation.confirmationMode, "human");
  assert.equal(parsed.confirmation.confirmedContentSha256, contentSha256);
  assert.equal(confirmed.cardSha256, contentSha256);

  assert.throws(
    () => confirmTaskCard(confirmed.card, "operator"),
    (e: unknown) => e instanceof IntakeError && e.code === "ALREADY_CONFIRMED",
  );
});

test("fixture confirmation is explicit and remains distinguishable from a human review", async () => {
  const { card, contentSha256 } = await createTaskCardDraft(parseTaskCardInput(validInput()));
  const confirmed = confirmTaskCard(card, "task-card-fixture", { mode: "test-fixture" });

  assert.equal(confirmed.card.confirmation.status, "confirmed");
  assert.equal(confirmed.card.confirmation.confirmationMode, "test-fixture");
  assert.equal(confirmed.card.confirmation.confirmedContentSha256, contentSha256);
});

// ── Path helpers ─────────────────────────────────────────────────

test("task card paths are deterministic", () => {
  assert.equal(TASK_CARD_DRAFT_FILENAME, "task-card.draft.json");
  assert.equal(TASK_CARD_CONFIRMED_FILENAME, "task-card.confirmed.json");
  assert.equal(taskCardDraftPath("/p"), join("/p", "task-card.draft.json"));
  assert.equal(taskCardConfirmedPath("/p"), join("/p", "task-card.confirmed.json"));
});

// ── CLI surface ──────────────────────────────────────────────────

async function writeInputFile(dir: string, input: Record<string, unknown>): Promise<string> {
  const path = join(dir, "intake-input.json");
  await writeFile(path, JSON.stringify(input), "utf8");
  return path;
}

test("CLI intake writes a draft without echoing raw input", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "skillfoo-intake-cli-"));
  const inputPath = await writeInputFile(workDir, validInput());

  const result = await runCli(["intake", "--from", inputPath, "--out", workDir]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /task-card\.draft\.json/);
  assert.match(result.stdout, /draft/i);

  const draft = JSON.parse(await readFile(taskCardDraftPath(workDir), "utf8"));
  const parsed = TaskCardSchema.parse(draft);
  assert.equal(parsed.confirmation.status, "draft");
  assert.equal(await fileExists(taskCardConfirmedPath(workDir)), false);
});

test("CLI intake --goal writes a zero-network incomplete draft with only missing dimensions", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "skillfoo-goal-cli-"));
  const skillDir = join(workDir, "b0-source");
  await mkdir(skillDir);
  await writeFile(join(skillDir, "SKILL.md"), "# B0 only\n", "utf8");
  const oldFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("network must stay unused during intake");
  }) as typeof fetch;
  try {
    const result = await runCli([
      "intake",
      "--goal",
      "为一线销售把已有商机信息整理成可核验的下一步建议。",
      "--skill-dir",
      skillDir,
      "--out",
      workDir,
    ]);
    assert.equal(result.exitCode, 0);
    assert.equal(fetchCalls, 0);
    assert.match(result.stdout, /needs_clarification/);
    assert.match(result.stdout, /5/);

    const parsed = TaskCardSchema.parse(JSON.parse(await readFile(taskCardDraftPath(workDir), "utf8")));
    assert.equal(parsed.intentStatus, "needs_clarification");
    assert.equal(parsed.unresolvedDimensions?.length, 5);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("CLI intake refuses to combine structured input with interactive clarification", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "skillfoo-intake-conflict-"));
  const inputPath = await writeInputFile(workDir, validInput());
  const result = await runCli(["intake", "--from", inputPath, "--interactive", "--out", workDir]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /INTAKE_INPUT_CONFLICT/);
});

test("CLI intake rejects token-like input with exit 2 and no echo", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "skillfoo-intake-cli-"));
  const leaked = validInput() as { scenarios: { userRequest: string }[] };
  leaked.scenarios[0].userRequest = `token ${OPENAI_LIKE_SECRET} here`;
  const inputPath = await writeInputFile(workDir, leaked);

  const result = await runCli(["intake", "--from", inputPath, "--out", workDir]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /TOKEN_LIKE_INPUT/);
  assert.ok(!result.stderr.includes(OPENAI_LIKE_SECRET));
  assert.ok(!result.stdout.includes(OPENAI_LIKE_SECRET));
  assert.equal(await fileExists(taskCardDraftPath(workDir)), false);
});

test("CLI intake --confirm produces a confirmed card with the stable hash", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "skillfoo-intake-cli-"));
  const inputPath = await writeInputFile(workDir, validInput());

  const draftRun = await runCli(["intake", "--from", inputPath, "--out", workDir]);
  assert.equal(draftRun.exitCode, 0);

  const confirmRun = await runCli([
    "intake",
    "--confirm",
    taskCardDraftPath(workDir),
    "--by",
    "operator",
    "--out",
    workDir,
  ]);
  assert.equal(confirmRun.exitCode, 0);
  assert.match(confirmRun.stdout, /^[0-9a-f]{64}$/m);

  const confirmed = JSON.parse(await readFile(taskCardConfirmedPath(workDir), "utf8"));
  const parsed = TaskCardSchema.parse(confirmed);
  assert.equal(parsed.confirmation.status, "confirmed");
  assert.equal(parsed.confirmation.confirmedBy, "operator");
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}
