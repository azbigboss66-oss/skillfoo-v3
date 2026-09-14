import { fileURLToPath } from "node:url";
import { dirname, resolve, join, isAbsolute } from "node:path";
import { realpath, stat, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Command, CommanderError } from "commander";
import { z } from "zod";
import { writeJson } from "./storage/json.js";
import {
  archiveSupersededStageAttempt,
  StageAttemptArchiveError,
  type StageAttemptArchiveExpectedBinding,
  type StageAttemptTrigger,
} from "./evidence/stageAttemptArchive.js";
import { loadRuntimeEnv } from "./config/runtimeEnv.js";
import {
  getDeepSeekConfig as readDeepSeekConfig,
  isDeepSeekConfigured as checkDeepSeekConfigured,
  DeepSeekConfigError,
} from "./config/deepseekConfig.js";
import { getAdapterDeclaration } from "./runtime/adapterRegistry.js";
import {
  applyContractGates,
  INSTRUCTION_ADAPTER_ID,
  type InstructionBatchScorer,
  type SealedInstructionBatchScorer,
} from "./runtime/instructionAdapter.js";
import {
  createPublicSemanticBatchJudge,
  createSealedSemanticBatchJudge,
  semanticResponseBindingVersion,
  SemanticJudgeError,
  type SemanticJudgeSafeDiagnostics,
} from "./evaluation/semanticJudge.js";
import { diagnoseSkill, DoctorError, doctorExitCode } from "./runtime/doctor.js";
import {
  confirmTaskCard,
  createGoalTaskCardDraft,
  createTaskCardDraft,
  IntakeError,
  parseTaskCardInput,
  stableStringify,
  taskCardContentSha256,
  type TaskCardInput,
} from "./intake/taskCard.js";
import { analyzeU1Completeness } from "./intake/u1Completeness.js";
import type { U1Clarification } from "./types.js";
import { TaskCardSchema } from "./types.js";
import {
  BootstrapBundleSchema,
  CurationResultSchema,
  EvaluationBlueprintSchema,
  EvaluationContractV3Schema,
  EvaluationDraftSchema,
  EvaluationReviewSchema,
  FrozenContractManifestSchema,
  LiveCalibrationEvidenceSchema,
  SEMANTIC_RESPONSE_BINDING_VERSION,
  U1_SCORING_PROFILE_VERSION,
  U1ScoringIdentitySchema,
  type EvaluationContractV3,
  type EvaluationDraft,
  type EvaluationReviewConfirmation,
  type RootFreeze,
  type TaskCard,
  type TaskCardConfirmation,
} from "./types.js";
import { composeBlueprint } from "./evalFactory/composeBlueprint.js";
import { createFixtureGenerator, generateDraft } from "./evalFactory/generateDraft.js";
import { createRuleCurator, curateDraft } from "./evalFactory/curateDraft.js";
import {
  assertEvaluationReviewBindings,
  assertU1BLiveEvidencePreflight,
  confirmEvaluationReview,
  createEvaluationReview,
  EvaluationReviewError,
  renderEvaluationReviewZh,
  type U1BLiveEvidencePreflightResult,
} from "./evalFactory/evaluationReview.js";
import {
  approveEvaluationForFormalFreeze,
  formalEvaluationLanePath,
  persistFormalEvaluationApproval,
  verifyPersistedFormalEvaluationLane,
  FormalEvaluationApprovalError,
  FORMAL_EVALUATION_LANE_DIRNAME,
  type FormalHumanConfirmationWaiting,
} from "./evalFactory/formalEvaluationApproval.js";
import {
  freezeContract,
  FreezeError,
  loadTerminalSelectionItems,
  evaluationContractContentSha256,
} from "./evalFactory/freezeContract.js";
import { runBootstrap, runFormalBootstrap, BootstrapError } from "./bootstrap/runBootstrap.js";
import { ScaffoldError } from "./bootstrap/createScaffold.js";
import { freezeRoot, RootFreezeError } from "./bootstrap/freezeRoots.js";
import {
  taskCardConfirmedPath,
  taskCardDraftPath,
  evaluationBlueprintPath,
  evaluationDraftPath,
  evaluationCurationPath,
  evaluationReviewConfirmedPath,
  evaluationReviewDraftPath,
  evaluationReviewMarkdownPath,
  evaluationContractV3Path,
  evaluationHoldoutV3Path,
  evaluationManifestV3Path,
  bootstrapBundlePath,
  bootstrapS0Path,
} from "./storage/paths.js";
import { sha256Hex } from "./runtime/capabilityAdapter.js";
import { FrozenContextError, loadFrozenRuntimeContext, REFERENCE_ADAPTER_ID } from "./runtime/frozenContext.js";
import {
  createU1ScenarioRunnerFactory,
  U1ScenarioEnvelopeError,
  u1ScenarioExecutionPolicy,
  type U1ScenarioRole,
  type U1ScenarioRunnerFactory,
} from "./runtime/u1ScenarioRunner.js";
import { OpenAICompatibleProvider, OpenAICompatibleProviderError } from "./providers/openaiCompatible.js";
import {
  RunCallBudget,
  ProviderBudgetError,
  createBudgetedProvider,
} from "./providers/runBudget.js";
import {
  createCachingProvider,
  createInMemoryResponseCache,
  type ResponseCacheStats,
} from "./providers/cache.js";
import { parseLiveRunPolicy, maxHttpAttemptsOf, maxOutputTokensBehaviorOf, roleGroupOf, thinkingModeOf, LiveRunPolicyError, LIVE_CONFIRM_PHRASE, type LiveProviderRole, type LiveRunPolicy } from "./providers/liveRunPolicy.js";
import { selectBootstrapSlice, type FunnelEvalItem, type FunnelEvent } from "./evolution/funnel.js";
import { createOpenAICompatibleRepairProposer } from "./evolution/repairProposerProvider.js";
import type { FrontierRepairProposer } from "./evolution/repairFrontier.js";
import {
  parseAdaptivePolicy,
  AdaptivePolicyError,
  type AdaptivePolicy,
  type AdaptivePolicyParams,
} from "./evolution/adaptivePolicy.js";
import type { Provider, ProviderMessage, ProviderResponse, ProviderRequestOptions } from "./providers/types.js";
import { runAdaptive, type AdaptiveRunResult } from "./evolution/adaptiveRun.js";
import {
  projectApplicationRecoveryAttempt,
  projectRecoveryDiagnostic,
  type U1ApplicationRecoveryAttempt,
  type U1RecoveryContext,
  type U1RecoveryDiagnostic,
  type U1RecoverySubject,
} from "./evolution/structureRecovery.js";
import {
  calculateAdaptiveClosureBudget,
  ADAPTIVE_SEMANTIC_BATCH_SIZE,
  type AdaptiveClosureBudgetPlan,
} from "./evolution/adaptiveClosureProtocol.js";
import {
  runDirectBaseline,
  createOpenAICompatibleU1DirectProposer,
  DIRECT_U1_FROZEN_INSTRUCTION,
  DIRECT_U1_PROMPT_CONTRACT_SHA256,
  DIRECT_U1_PROMPT_CONTRACT_VERSION,
  DirectBaselineError,
} from "./evolution/directBaseline.js";
import {
  buildSafeDirectPublicComparison,
  DirectFailureArtifactSchema,
  DirectPublicComparisonError,
  DirectResultArtifactSchema,
  U1_SEALED_DIRECT_CANDIDATE_FILENAME,
  U1SealedDirectCandidateArtifactSchema,
} from "./evolution/directPublicComparison.js";
import { createLiveMutationProposer } from "./bootstrap/liveBootstrapProposer.js";
import {
  decideU1Intake,
  materializeS0RebuildTrack,
  U1IntakeError,
  type U1IntakeLane,
  type U1ViolationCategory,
} from "./evolution/u1Intake.js";
import { aggregateU1TechnicalSuiteReport } from "./report/suiteReport.js";
import {
  assertStageBudgetsFunded,
  calculateCalibrationBudget,
  calculateStageBudgets,
  StageFundingError,
  type AuthorizedStageBudgets,
  type CallEnvelope,
  type ScenarioCallAuthorization,
  type StageBudgetInputs,
  type StageBudgetPlan,
} from "./providers/stageBudgets.js";
import {
  runTerminalPublicSelection,
  PublicSelectionError,
  type TerminalPublicSelectCandidate,
} from "./evolution/publicSelection.js";
import {
  adaptiveFailureCodeOf,
  AdaptiveComparisonStopReasonSchema,
  AdaptiveFailureArtifactSchema,
  ApplicationRecoverySafeEvidenceSchema,
  isAdaptiveFailureStopReason,
  parseAdaptiveResultArtifact,
  PublicSelectionFailureArtifactSchema,
  PublicSelectionResultArtifactSchema,
  SafeTerminalPublicSelectionSchema,
  sanitizeTerminalPublicSelection,
  validateAdaptiveResultForPublicSelectResume,
  validatePublicSelectionFailureForResume,
  PublicSelectionResumeError,
  type AdaptiveFailureStopReason,
} from "./evolution/publicSelectionResume.js";
import {
  resolveAdaptiveCandidateBySkillSha256,
  runU1SealedAudit,
  U1SealedCompletedArtifactSchema,
  U1SealedAuditError,
  U1SealedFailureArtifactSchema,
  type U1PublicDecision,
  type U1SealedCandidateLabel,
  type U1SealedCandidateState,
} from "./evolution/u1SealedAudit.js";
import {
  assertCalibrationEvidenceForAdaptive,
  CalibrationEvidenceError,
  createLiveCalibrationRecoveryEvidence,
  runTwoPassEvaluatorCalibration,
} from "./evaluation/liveCalibration.js";
import {
  assertSameScoringIdentity,
  scoringIdentityOfContract,
} from "./evaluation/u1Rubric.js";

const sourceDir = dirname(fileURLToPath(import.meta.url));
export const packageRoot = resolve(sourceDir, "..");

function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isFormalEvaluationLaneDirectoryPath(path: string): boolean {
  const absolute = resolve(path);
  return sameFilesystemPath(absolute, formalEvaluationLanePath(dirname(absolute)));
}

function formalProjectRootOf(path: string): string {
  const absolute = resolve(path);
  return isFormalEvaluationLaneDirectoryPath(absolute)
    ? dirname(absolute)
    : absolute;
}

function printFormalWaiting(waiting: FormalHumanConfirmationWaiting): void {
  console.log("=== U1 formal gate ===");
  console.log(JSON.stringify(waiting));
  console.log("No Provider configuration was read; fetches=0, providerCalls=0, writes=0.");
}

/**
 * Resolve the separately approved formal lane before any Provider/config/output
 * work. Historical development fixtures may exercise old internals only
 * through the non-CLI test harness; the public binary always comes here.
 */
async function resolvePublicFormalLiveDirectory(
  requestedDir: string,
): Promise<{ projectRoot: string; formalDir: string } | FormalHumanConfirmationWaiting> {
  const projectRoot = formalProjectRootOf(requestedDir);
  const verification = await verifyPersistedFormalEvaluationLane(projectRoot, {
    verificationMode: "live-formal",
  });
  if (verification.status === "WAITING_FOR_HUMAN_CONFIRMATION") return verification;
  if (verification.status !== "READY_FOR_FORMAL_EXECUTION") {
    throw new FormalEvaluationApprovalError(
      "FORMAL_FIXTURE_LIVE_FORBIDDEN",
      "only a real-human formal approval lane may enter the public live CLI",
    );
  }
  return { projectRoot, formalDir: formalEvaluationLanePath(projectRoot) };
}

let runtimeEnvLoaded = false;

/** Provider configuration is intentionally lazy so formal waiting paths read no .env/config. */
function ensureRuntimeEnvLoaded(): void {
  if (runtimeEnvLoaded) return;
  loadRuntimeEnv(packageRoot);
  runtimeEnvLoaded = true;
}

function getDeepSeekConfig(): ReturnType<typeof readDeepSeekConfig> {
  ensureRuntimeEnvLoaded();
  return readDeepSeekConfig();
}

function isDeepSeekConfigured(): boolean {
  ensureRuntimeEnvLoaded();
  return checkDeepSeekConfigured();
}

function resolveProjectDir(projectDir: string): string {
  return isAbsolute(projectDir) ? projectDir : resolve(process.cwd(), projectDir);
}

/** Provider identities exposed by the current CLI. */
type ProviderName = "scripted" | "deepseek";

/** Normalize the current provider identity without accepting retired aliases. */
function normalizeProviderName(name: string): ProviderName {
  if (name === "scripted") return "scripted";
  if (name === "deepseek") return "deepseek";
  throw new Error(
    `Unknown provider: ${name}. Valid providers: scripted, deepseek`,
  );
}

// ── Command implementations ─────────────────────────────────────

/**
 * Composition root: the ONLY place adapter factories are resolved, through
 * the adapter registry keyed by capability-policy.json's adapterId (Task 8).
 * The evolution kernel and the reference runner stay adapter-agnostic; no
 * code path branches on a skill name.
 */

/** Command finished normally but requires a specific process exit code (e.g. doctor). */
class CliExitError extends Error {
  readonly exitCode: number;
  constructor(exitCode: number) {
    super(`cli exit ${exitCode}`);
    this.name = "CliExitError";
    this.exitCode = exitCode;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** V3 skill diagnosis: machine-readable JSON report plus a short human summary. */
async function cmdDoctorSkill(absDir: string, runtimeContextPath?: string): Promise<void> {
  let report;
  try {
    report = await diagnoseSkill(absDir, { runtimeContextPath });
  } catch (e) {
    if (e instanceof DoctorError) {
      console.error(e.message);
      throw new CliExitError(e.exitCode);
    }
    if (e instanceof FrozenContextError) {
      console.error(e.message);
      throw new CliExitError(2);
    }
    throw e;
  }
  console.log("=== SkillFoo Doctor (skill tier diagnosis) ===");
  console.log(JSON.stringify({ ...report, skillPath: "<skill-directory>" }, null, 2));
  console.log("");
  console.log(report.humanSummary);
  console.log(
    doctorExitCode(report) === 0
      ? "exit 0: diagnosed and runnable now"
      : "exit 3: diagnosed with blockers (see blockers[] above)",
  );
  throw new CliExitError(doctorExitCode(report));
}

/** Intake-time refusal: exit 2 mirrors doctor's structural-failure code. */
function intakeFail(code: number, message: string): never {
  console.error(message);
  throw new CliExitError(code);
}

function readIntakeJson(raw: string, what: string): unknown {
  let parsed: unknown;
  try {
    // Windows editors commonly write a UTF-8 BOM; strip it before parsing.
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    intakeFail(2, `INTAKE_JSON_INVALID: ${what} is not valid JSON`);
  }
  return parsed;
}

async function askGoalClarifications(goal: string): Promise<U1Clarification[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const clarifications: U1Clarification[] = [];
  try {
    console.log("=== U1 intent clarification (0-5 questions, zero network) ===");
    console.log("Only missing material dimensions are asked; an unanswered dimension is never guessed.");
    while (clarifications.length < 5) {
      const result = analyzeU1Completeness({ goal, clarifications });
      if (result.status === "complete" || result.questions.length === 0) break;
      const question = result.questions[0];
      const answer = (await rl.question(`${clarifications.length + 1}/5 ${question.promptZh}\n> `)).trim();
      clarifications.push({ ...question, answer });
    }
    return clarifications;
  } finally {
    rl.close();
  }
}

interface IntakeOptions {
  from?: string;
  goal?: string;
  interactive?: boolean;
  skillDir?: string;
  intentFixture?: boolean;
  confirm?: string;
  by?: string;
  out?: string;
}

async function cmdIntake(opts: IntakeOptions): Promise<void> {
  const outDir = resolve(process.cwd(), opts.out ?? ".");
  await mkdir(outDir, { recursive: true });

  // ── Confirmation lane: draft file in, confirmed card + stable hash out ──
  if (opts.confirm) {
    const draftPath = resolve(process.cwd(), opts.confirm);
    let raw: string;
    try {
      raw = await readFile(draftPath, "utf8");
    } catch {
      intakeFail(2, `INTAKE_DRAFT_UNREADABLE: cannot read draft card at ${draftPath}`);
    }
    const parsedDraft = readIntakeJson(raw, `draft card at ${draftPath}`);
    const parseResult = TaskCardSchema.safeParse(parsedDraft);
    if (!parseResult.success) {
      intakeFail(
        2,
        `INTAKE_DRAFT_INVALID: draft card does not match the TaskCard schema (${parseResult.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")})`,
      );
    }
    let confirmed: Awaited<ReturnType<typeof confirmTaskCard>>;
    try {
      confirmed = confirmTaskCard(parseResult.data, opts.by ?? "");
    } catch (e) {
      if (e instanceof IntakeError) intakeFail(2, e.message);
      throw e;
    }
    const confirmedPath = taskCardConfirmedPath(outDir);
    await writeFile(confirmedPath, JSON.stringify(confirmed.card, null, 2) + "\n", "utf8");
    console.log("=== Task Card Confirmed ===");
    console.log(confirmed.cardSha256);
    if (confirmed.card.confirmation.status !== "confirmed") {
      intakeFail(2, "INTAKE_CONFIRMATION_INVALID: confirmation did not produce a confirmed Task Card");
    }
    console.log(`  Confirmed by: ${confirmed.card.confirmation.confirmedBy} at ${confirmed.card.confirmation.confirmedAt}`);
    console.log(`  Written: ${confirmedPath}`);
    console.log("  A confirmed card is the sole intent source for eval drafts; the release path additionally requires frozen contracts and gates.");
    return;
  }

  // ── Draft lane: natural-language goal or structured JSON input ──
  if ((opts.goal && opts.from) || (opts.from && opts.interactive)) {
    intakeFail(2, "INTAKE_INPUT_CONFLICT: --from cannot be combined with --goal or --interactive");
  }
  const skillDir = opts.skillDir ? resolve(process.cwd(), opts.skillDir) : undefined;
  let draft: Awaited<ReturnType<typeof createTaskCardDraft>>;
  if (opts.goal) {
    const clarifications = opts.interactive ? await askGoalClarifications(opts.goal) : [];
    try {
      draft = await createGoalTaskCardDraft(opts.goal, { skillDir, clarifications });
    } catch (e) {
      if (e instanceof IntakeError) intakeFail(2, e.message);
      if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
        intakeFail(2, `SKILL_MD_NOT_FOUND: no SKILL.md under ${skillDir} (--skill-dir only pins the file by hash)`);
      }
      throw e;
    }
  } else {
    let input: TaskCardInput;
    if (opts.from) {
      const inputPath = resolve(process.cwd(), opts.from);
      let raw: string;
      try {
        raw = await readFile(inputPath, "utf8");
      } catch {
        intakeFail(2, `INTAKE_INPUT_UNREADABLE: cannot read intake input at ${inputPath}`);
      }
      const parsedInput = readIntakeJson(raw, `intake input at ${inputPath}`);
      try {
        input = parseTaskCardInput(parsedInput);
      } catch (e) {
        if (e instanceof IntakeError) intakeFail(2, e.message);
        throw e;
      }
    } else {
      intakeFail(2, opts.interactive
        ? "INTAKE_GOAL_REQUIRED: --interactive clarification requires --goal <text>"
        : "INTAKE_INPUT_REQUIRED: provide --goal <text> or --from <file.json>");
    }
    try {
      draft = await createTaskCardDraft(input, {
        skillDir,
        intentFixture: opts.intentFixture === true,
      });
    } catch (e) {
      if (e instanceof IntakeError) intakeFail(2, e.message);
      if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
        intakeFail(2, `SKILL_MD_NOT_FOUND: no SKILL.md under ${skillDir} (--skill-dir only pins the file by hash)`);
      }
      throw e;
    }
  }

  const draftPath = taskCardDraftPath(outDir);
  await writeFile(draftPath, JSON.stringify(draft.card, null, 2) + "\n", "utf8");
  console.log("=== Task Card Draft ===");
  console.log(`  Draft written: ${draftPath}`);
  console.log("  Status: draft (not confirmed — nothing downstream may treat it as intent truth)");
  if (draft.card.intentStatus) {
    console.log(`  Intent status: ${draft.card.intentStatus}`);
    console.log(`  Clarifications asked: ${draft.card.clarifications?.length ?? 0}; unresolved dimensions: ${draft.card.unresolvedDimensions?.length ?? 0}`);
  }
  console.log(`  Content sha256: ${draft.contentSha256}`);
  console.log(`  Scenarios: ${draft.card.scenarios.length}; red lines: ${draft.card.redlines.length}`);
  console.log(`  Capabilities: ${draft.card.capabilityBoundary.allowedCapabilities.join(", ") || "(none declared)"}`);
  console.log(`  Side effects — network: ${draft.card.capabilityBoundary.network}, filesystem: ${draft.card.capabilityBoundary.filesystem}, external actions: ${draft.card.capabilityBoundary.externalActions}`);
  if (draft.card.intentOptions && draft.card.intentOptions.length > 0) {
    console.log(`  Intent fixtures attached: ${draft.card.intentOptions.length} (all low confidence, offline)`);
  }
  console.log("  Next: review the draft, then run intake --confirm <draftPath> --by <operator>.");
}

interface EvalDraftOptions {
  taskCard?: string;
  out?: string;
}

/**
 * Offline eval-draft: blueprint -> fixture draft -> rule curation.
 * No provider, no candidate skills, no holdout access — generation only
 * ever sees the task card. Exit 0 on any verdict; the verdict itself is
 * data, not a crash.
 */
async function cmdEvalDraft(opts: EvalDraftOptions): Promise<void> {
  if (!opts.taskCard) {
    intakeFail(2, "EVAL_DRAFT_TASK_CARD_REQUIRED: provide --task-card <path> (confirmed card required at freeze time)");
  }
  const cardPath = resolve(process.cwd(), opts.taskCard);
  let raw: string;
  try {
    raw = await readFile(cardPath, "utf8");
  } catch {
    intakeFail(2, `EVAL_DRAFT_TASK_CARD_INVALID: cannot read task card at ${cardPath}`);
  }
  const parsedCard = readIntakeJson(raw, `task card at ${cardPath}`);
  const cardResult = TaskCardSchema.safeParse(parsedCard);
  if (!cardResult.success) {
    intakeFail(
      2,
      `EVAL_DRAFT_TASK_CARD_INVALID: file does not match the TaskCard schema (${cardResult.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")})`,
    );
  }
  const taskCard = cardResult.data;
  if (taskCard.confirmation.status !== "confirmed") {
    console.error(
      "EVAL_DRAFT_DRAFT_CARD: card is a draft — output is exploratory only; eval-freeze (T05) requires a confirmed card",
    );
  }

  const outDir = resolve(process.cwd(), opts.out ?? ".");
  await mkdir(outDir, { recursive: true });

  const blueprint = composeBlueprint(taskCard);
  const draft = await generateDraft(blueprint, taskCard, createFixtureGenerator());
  const curation = await curateDraft(draft, taskCard, blueprint, createRuleCurator());

  const blueprintPath = evaluationBlueprintPath(outDir);
  const draftPath = evaluationDraftPath(outDir);
  const curationPath = evaluationCurationPath(outDir);
  await writeFile(blueprintPath, JSON.stringify(blueprint, null, 2) + "\n", "utf8");
  await writeFile(draftPath, JSON.stringify(draft, null, 2) + "\n", "utf8");
  await writeFile(curationPath, JSON.stringify(curation, null, 2) + "\n", "utf8");

  const publicCount = draft.items.filter((item) => item.split === "public").length;
  const holdoutCount = draft.items.length - publicCount;
  const criticals = curation.findings.filter((finding) => finding.severity === "critical").length;
  const warnings = curation.findings.length - criticals;

  console.log("=== Eval Draft (offline fixture pipeline) ===");
  console.log(`  Items: ${draft.items.length} (public ${publicCount} / holdout ${holdoutCount})`);
  console.log(`  Verdict: ${curation.verdict} — ${criticals} critical / ${warnings} warning findings`);
  console.log(`  Eval confidence: ${curation.evalConfidence.level} (${curation.evalConfidence.score}/100)`);
  console.log(`  Generator/curator isolation: ${curation.generatorCuratorIsolation}`);
  console.log(`  Blueprint written: ${blueprintPath}`);
  console.log(`  Draft written: ${draftPath}`);
  console.log(`  Curation written: ${curationPath}`);
  console.log("  Next: review findings; freezing into a contract (eval-freeze) requires a confirmed card and a passing draft.");
}

interface EvalReviewOptions {
  dir?: string;
  confirm?: boolean;
  by?: string;
}

async function cmdEvalReview(opts: EvalReviewOptions): Promise<void> {
  if (!opts.dir) {
    intakeFail(2, "EVAL_REVIEW_DIR_REQUIRED: provide --dir <dir> holding the Task Card and evaluation draft");
  }
  const dir = resolve(process.cwd(), opts.dir);
  const cardCandidates = [taskCardConfirmedPath(dir), taskCardDraftPath(dir), join(dir, "task-card.json")];
  const cardPath = (await Promise.all(cardCandidates.map(async (path) => ({ path, exists: await pathExists(path) }))))
    .find((entry) => entry.exists)?.path;
  if (!cardPath) {
    intakeFail(2, `EVAL_REVIEW_TASK_CARD_MISSING: no Task Card found under ${dir}`);
  }
  const cardResult = TaskCardSchema.safeParse(
    readIntakeJson(await readFile(cardPath, "utf8"), `Task Card at ${cardPath}`),
  );
  if (!cardResult.success) {
    intakeFail(2, "EVAL_REVIEW_TASK_CARD_INVALID: Task Card fails its schema");
  }
  const draftPath = evaluationDraftPath(dir);
  let draftRaw: string;
  try {
    draftRaw = await readFile(draftPath, "utf8");
  } catch {
    intakeFail(2, `EVAL_REVIEW_DRAFT_MISSING: cannot read ${draftPath}; run eval-draft first`);
  }
  const draftResult = EvaluationDraftSchema.safeParse(
    readIntakeJson(draftRaw, `evaluation draft at ${draftPath}`),
  );
  if (!draftResult.success) {
    intakeFail(2, "EVAL_REVIEW_DRAFT_INVALID: evaluation draft fails its schema");
  }

  const reviewDraft = draftResult.data;
  const curationPath = evaluationCurationPath(dir);
  const curationResult = CurationResultSchema.safeParse(
    readIntakeJson(await readFile(curationPath, "utf8"), `evaluation curation at ${curationPath}`),
  );
  if (!curationResult.success) {
    intakeFail(2, "EVAL_REVIEW_CURATION_INVALID: evaluation review requires the matching accepted curation");
  }
  const reviewCuration = curationResult.data;

  if (!opts.confirm) {
    const review = createEvaluationReview({
      taskCard: cardResult.data,
      draft: reviewDraft,
      curation: reviewCuration,
    });
    const reviewPath = evaluationReviewDraftPath(dir);
    const markdownPath = evaluationReviewMarkdownPath(dir);
    await writeFile(reviewPath, JSON.stringify(review, null, 2) + "\n", "utf8");
    await writeFile(markdownPath, renderEvaluationReviewZh(review), "utf8");
    console.log("=== Evaluation Review Draft ===");
    console.log(`  Review: ${reviewPath}`);
    console.log(`  Chinese summary: ${markdownPath}`);
    console.log(`  Review hash: ${review.reviewContentSha256}`);
    console.log(`  Review document hash: ${review.reviewDocumentSha256}`);
    console.log("  Status: draft; no human confirmation has been created.");
    return;
  }

  const mode = "human" as const;
  const reviewPath = evaluationReviewDraftPath(dir);
  let reviewRaw: string;
  try {
    reviewRaw = await readFile(reviewPath, "utf8");
  } catch {
    intakeFail(2, `EVAL_REVIEW_DRAFT_MISSING: cannot read ${reviewPath}; generate the review first`);
  }
  const reviewResult = EvaluationReviewSchema.safeParse(
    readIntakeJson(reviewRaw, `evaluation review at ${reviewPath}`),
  );
  if (!reviewResult.success) {
    intakeFail(2, "EVAL_REVIEW_INVALID: evaluation review draft fails its schema");
  }
  let approval;
  try {
    assertEvaluationReviewBindings({
      review: reviewResult.data,
      taskCard: cardResult.data,
      draft: draftResult.data,
    });
    approval = approveEvaluationForFormalFreeze(
      {
        taskCard: cardResult.data,
        draft: draftResult.data,
        curation: reviewCuration,
        review: reviewResult.data,
      },
      {
        operator: opts.by ?? "",
        confirmationMode: mode,
        projectDir: dir,
        liveProvider: false,
      },
    );
  } catch (error) {
    if (error instanceof EvaluationReviewError || error instanceof FormalEvaluationApprovalError) {
      intakeFail(2, error.message);
    }
    throw error;
  }
  let persisted;
  try {
    persisted = await persistFormalEvaluationApproval(dir, approval);
  } catch (error) {
    if (error instanceof FormalEvaluationApprovalError) intakeFail(2, error.message);
    throw error;
  }
  console.log("=== Formal Evaluation Approval Committed ===");
  console.log(`  Mode: ${mode}`);
  console.log(`  Formal lane: ${persisted.directory}`);
  console.log(`  Approval record: ${persisted.approval}`);
  console.log(`  Approval SHA-256: ${approval.record.approvalSha256}`);
  console.log(
    mode === "human"
      ? "  Human confirmations: 2/2; run eval-freeze to create a separate formal contract."
      : "  Fixture bindings verified for offline tests only; live formal Provider paths will reject this lane.",
  );
}

interface EvalFreezeOptions {
  dir?: string;
  adapter?: string;
  deviationReason?: string;
  runtimeContext?: string;
}

/**
 * Freeze the curated draft into the immutable V3 evaluation contract:
 * public contract + separate holdout file + hash manifest. Refuses
 * unconfirmed cards, non-accepted curations, undeclared adapters and any
 * public/holdout crossover with exit 2; below-floor confidence freezes as
 * EXPLORATION_ONLY (exit 0) — comparison allowed, release forbidden.
 */
async function cmdEvalFreeze(opts: EvalFreezeOptions): Promise<void> {
  if (!opts.dir) {
    intakeFail(2, "EVAL_FREEZE_DIR_REQUIRED: provide --dir <dir> holding the task card and the three eval-draft artefacts");
  }
  if (!opts.adapter) {
    intakeFail(2, "EVAL_FREEZE_ADAPTER_REQUIRED: provide --adapter <id> declared in the blueprint");
  }
  const projectRoot = formalProjectRootOf(resolve(process.cwd(), opts.dir));
  let verification;
  try {
    verification = await verifyPersistedFormalEvaluationLane(projectRoot, {
      verificationMode: "live-formal",
    });
  } catch (error) {
    if (error instanceof FormalEvaluationApprovalError) intakeFail(2, error.message);
    throw error;
  }
  if (verification.status === "WAITING_FOR_HUMAN_CONFIRMATION") {
    printFormalWaiting(verification);
    return;
  }
  if (verification.status !== "READY_FOR_FORMAL_EXECUTION") {
    intakeFail(2, "FORMAL_APPROVAL_MODE_MISMATCH: production freeze requires real human 2/2 approval");
  }
  const dir = formalEvaluationLanePath(projectRoot);
  const blueprintDir = projectRoot;
  const existingFormalFreeze = await firstExistingPath([
    evaluationContractV3Path(dir),
    evaluationHoldoutV3Path(dir),
    evaluationManifestV3Path(dir),
  ]);
  if (existingFormalFreeze) {
    intakeFail(
      2,
      "FORMAL_FREEZE_VERSION_EXISTS: the approved formal lane already contains frozen evaluation artefacts; refusing an in-place overwrite. Create a newly approved formal version instead.",
    );
  }

  let runtimeContextManifestSha256: string | undefined;
  let runtimeContextSummary: { entries: number; replays: number } | undefined;
  if (opts.adapter === REFERENCE_ADAPTER_ID) {
    if (!opts.runtimeContext) {
      intakeFail(2, "FROZEN_CONTEXT_REQUIRED: reference-v1 eval-freeze requires --runtime-context <path>");
    }
    try {
      const runtimeContext = await loadFrozenRuntimeContext(opts.runtimeContext);
      runtimeContextManifestSha256 = runtimeContext.manifestSha256;
      runtimeContextSummary = {
        entries: runtimeContext.manifest.entries.length,
        replays: runtimeContext.manifest.replays.length,
      };
    } catch (error) {
      if (error instanceof FrozenContextError) intakeFail(2, error.message);
      throw error;
    }
  } else if (opts.runtimeContext !== undefined) {
    intakeFail(2, "FROZEN_CONTEXT_MANIFEST_INVALID: --runtime-context is accepted only with reference-v1");
  }

  const cardCandidates = [taskCardConfirmedPath(dir), join(dir, "task-card.json")];
  let cardPath: string | null = null;
  for (const candidate of cardCandidates) {
    if (await pathExists(candidate)) {
      cardPath = candidate;
      break;
    }
  }
  if (!cardPath) {
    intakeFail(
      2,
      `EVAL_FREEZE_TASK_CARD_MISSING: no task card found at ${cardCandidates.join(" or ")}; run eval-draft first or pass --task-card <path>`,
    );
  }
  const cardResult = TaskCardSchema.safeParse(
    readIntakeJson(await readFile(cardPath, "utf8"), `task card at ${cardPath}`),
  );
  if (!cardResult.success) {
    intakeFail(
      2,
      `EVAL_FREEZE_TASK_CARD_INVALID: file does not match the TaskCard schema (${cardResult.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")})`,
    );
  }

  const readArtefact = async (path: string, what: string): Promise<unknown> => {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      intakeFail(2, `EVAL_FREEZE_ARTEFACT_MISSING: cannot read ${what} at ${path}; run eval-draft into this directory first`);
    }
    return readIntakeJson(raw, `${what} at ${path}`);
  };

  const blueprintPath = evaluationBlueprintPath(blueprintDir);
  const draftPath = evaluationDraftPath(dir);
  const curationPath = evaluationCurationPath(dir);
  const reviewPath = evaluationReviewConfirmedPath(dir);
  const blueprintResult = EvaluationBlueprintSchema.safeParse(
    await readArtefact(blueprintPath, "blueprint"),
  );
  if (!blueprintResult.success) {
    intakeFail(2, `EVAL_FREEZE_ARTEFACT_INVALID: blueprint at ${blueprintPath} fails its schema`);
  }
  const draftResult = EvaluationDraftSchema.safeParse(
    await readArtefact(draftPath, "draft"),
  );
  if (!draftResult.success) {
    intakeFail(2, `EVAL_FREEZE_ARTEFACT_INVALID: draft at ${draftPath} fails its schema`);
  }
  const curationResult = CurationResultSchema.safeParse(
    await readArtefact(curationPath, "curation"),
  );
  if (!curationResult.success) {
    intakeFail(2, `EVAL_FREEZE_ARTEFACT_INVALID: curation at ${curationPath} fails its schema`);
  }
  const reviewResult = EvaluationReviewSchema.safeParse(
    await readArtefact(reviewPath, "evaluation review"),
  );
  if (!reviewResult.success) {
    intakeFail(2, `EVAL_FREEZE_ARTEFACT_INVALID: evaluation review at ${reviewPath} fails its schema`);
  }

  let bundle;
  try {
    bundle = await freezeContract({
      taskCard: cardResult.data,
      blueprint: blueprintResult.data,
      draft: draftResult.data,
      curation: curationResult.data,
      evaluationReview: reviewResult.data,
      evidenceMode: "formal",
      liveProviderAuthorized: false,
      adapterId: opts.adapter,
      runtimeContextManifestSha256,
      deviationReason: opts.deviationReason,
    });
  } catch (e) {
    if (e instanceof FreezeError) {
      console.error(e.message);
      throw new CliExitError(2);
    }
    throw e;
  }

  const contractPath = evaluationContractV3Path(dir);
  const holdoutPath = evaluationHoldoutV3Path(dir);
  const manifestPath = evaluationManifestV3Path(dir);
  await writeFile(contractPath, JSON.stringify(bundle.contract, null, 2) + "\n", "utf8");
  await writeFile(holdoutPath, JSON.stringify(bundle.holdoutFile, null, 2) + "\n", "utf8");
  await writeFile(manifestPath, JSON.stringify(bundle.manifest, null, 2) + "\n", "utf8");

  console.log("=== Evaluation Contract Frozen (V3) ===");
  console.log(bundle.contract.contractSha256);
  console.log(`  Contract: ${contractPath}`);
  console.log(`  Holdout (answer key, never an evolution input): ${holdoutPath}`);
  console.log(`  Manifest: ${manifestPath}`);
  console.log(`  Adapter: ${bundle.contract.adapterId}; capabilities: ${bundle.contract.allowedCapabilities.join(", ")}`);
  if (runtimeContextManifestSha256 && runtimeContextSummary) {
    console.log(`  Runtime context: ${runtimeContextManifestSha256}; entries ${runtimeContextSummary.entries}; replays ${runtimeContextSummary.replays}`);
    console.log("  Permitted tools: reference.read, attachment.read, tool.replay (logical ids only; zero network; read-only)");
  }
  console.log(`  Scenarios — public: ${bundle.contract.publicScenarioIds.join(", ")} / holdout: ${bundle.contract.holdoutScenarioIds.join(", ")}`);
  console.log(`  Items — public: ${bundle.manifest.publicItemIds.length} / holdout: ${bundle.manifest.holdoutItemIds.length}`);
  console.log(`  Goal confidence: ${bundle.contract.goalConfidence.level} (${bundle.contract.goalConfidence.score}/100)`);
  console.log(`  Eval confidence: ${bundle.contract.evalConfidence.level} (${bundle.contract.evalConfidence.score}/100)`);
  const sp = bundle.contract.splitPolicy;
  console.log(
    `  Split policy — holdout target ${sp.targetHoldoutRatio} (±${sp.maxRatioDeviation}), actual ${sp.actualHoldoutRatio.toFixed(3)}; min holdout items ${sp.minHoldoutItems}` +
      (sp.deviationReason ? `; deviation recorded: ${sp.deviationReason}` : ""),
  );
  console.log(`  Generator/curator isolation: ${bundle.contract.generation.generatorCuratorIsolation}`);
  if (bundle.contract.explorationOnly) {
    console.log("EXPLORATION_ONLY: confidence is below the floor — Bootstrap comparisons allowed, holdout accept/release forbidden.");
  } else {
    console.log("  Release path open: confidence meets the floor; holdout accept still requires every gate (T07).");
  }
}

interface BootstrapOptions {
  dir?: string;
  skillDir?: string;
  adapter?: string;
  out?: string;
  provider?: string;
  release?: boolean;
}

async function cmdBootstrap(opts: BootstrapOptions): Promise<void> {
  if (!opts.dir) {
    intakeFail(2, "BOOTSTRAP_DIR_REQUIRED: provide --dir <dir> holding the confirmed task card and the frozen v3 contract");
  }
  if (!opts.skillDir) {
    intakeFail(2, "BOOTSTRAP_SKILL_DIR_REQUIRED: provide --skill-dir <path> pointing at the read-only B0 rough skill");
  }
  if (!opts.adapter) {
    intakeFail(2, "BOOTSTRAP_ADAPTER_REQUIRED: provide --adapter <id> bound to the frozen contract");
  }
  const dir = resolve(process.cwd(), opts.dir);
  const skillDir = resolve(process.cwd(), opts.skillDir);
  const formalBootstrap = isFormalEvaluationLaneDirectoryPath(dir);
  if (!formalBootstrap && (await dirExists(dir))) {
    const canonicalDir = await realpath(dir);
    if (isFormalEvaluationLaneDirectoryPath(canonicalDir)) {
      intakeFail(
        2,
        "FORMAL_BOOTSTRAP_LINKED_ALIAS_FORBIDDEN: a linked alias cannot select a different bootstrap path",
      );
    }
  }

  const contractPath = evaluationContractV3Path(dir);
  if (!(await pathExists(contractPath))) {
    intakeFail(
      2,
      `BOOTSTRAP_CONTRACT_MISSING: no frozen v3 contract at ${contractPath}; run eval-freeze first`,
    );
  }
  const contractResult = EvaluationContractV3Schema.safeParse(
    readIntakeJson(await readFile(contractPath, "utf8"), `contract at ${contractPath}`),
  );
  if (!contractResult.success) {
    intakeFail(2, `BOOTSTRAP_CONTRACT_INVALID: the frozen contract at ${contractPath} fails its schema`);
  }

  const cardCandidates = [taskCardConfirmedPath(dir), join(dir, "task-card.json")];
  let cardPath: string | null = null;
  for (const candidate of cardCandidates) {
    if (await pathExists(candidate)) {
      cardPath = candidate;
      break;
    }
  }
  if (!cardPath) {
    intakeFail(
      2,
      `BOOTSTRAP_TASK_CARD_MISSING: no task card found at ${cardCandidates.join(" or ")}; run intake first`,
    );
  }
  const cardResult = TaskCardSchema.safeParse(
    readIntakeJson(await readFile(cardPath, "utf8"), `task card at ${cardPath}`),
  );
  if (!cardResult.success) {
    intakeFail(
      2,
      `BOOTSTRAP_TASK_CARD_INVALID: file does not match the TaskCard schema (${cardResult.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")})`,
    );
  }

  if (!(await dirExists(skillDir))) {
    intakeFail(2, `BOOTSTRAP_SKILL_DIR_MISSING: the B0 skill directory does not exist at ${skillDir}`);
  }

  const declaration = getAdapterDeclaration(opts.adapter);
  if (!declaration) {
    intakeFail(
      2,
      `BOOTSTRAP_ADAPTER_UNDECLARED: adapter "${opts.adapter}" is not declared in the adapter registry`,
    );
  }

  const outDir = opts.out ? resolve(process.cwd(), opts.out) : join(dir, "bootstrap");
  const s0Dir = join(outDir, "s0");

  let result;
  try {
    result = formalBootstrap
      ? await runFormalBootstrap({
          skillDir,
          formalDir: dir,
          outDir,
          taskCard: cardResult.data,
          contract: contractResult.data,
          adapter: declaration,
          provider: opts.provider ?? "fixture",
          release: opts.release === true,
        })
      : await runBootstrap({
          skillDir,
          taskCard: cardResult.data,
          contract: contractResult.data,
          adapter: declaration,
          s0Dir,
          provider: opts.provider ?? "fixture",
          release: opts.release === true,
        });
  } catch (e) {
    if (e instanceof BootstrapError || e instanceof ScaffoldError || e instanceof RootFreezeError) {
      console.error(`${e.code}: ${e.message}`);
      throw new CliExitError(2);
    }
    throw e;
  }

  if (!formalBootstrap) {
    await writeFile(bootstrapBundlePath(outDir), JSON.stringify(result.bundle, null, 2) + "\n", "utf8");
  }

  console.log("=== Dual-root Bootstrap (V3, round 1) ===");
  console.log("  DRY-RUN fixture provider — no model call, no release (T13 gates real runs)");
  console.log(`  Contract: ${result.bundle.contractSha256}`);
  const quarantined = result.bundle.b0.files.filter((file) => file.status !== "recorded").length;
  console.log(
    `  B0 frozen read-only: ${result.bundle.b0.rootHash} (${result.bundle.b0.files.length} files, ${quarantined} quarantined)`,
  );
  console.log(`  S0 scaffold: ${result.bundle.s0.rootHash} (${bootstrapS0Path(outDir)})`);
  console.log(`  Bundle: ${bootstrapBundlePath(outDir)}`);
  for (const lane of result.bundle.lanes) {
    if (lane.status === "ok") {
      console.log(
        `  Lane ${lane.lane}: ok — candidate bound to the contract, originRoot ${lane.candidate?.originRoot}`,
      );
      console.log(`    hypothesis: ${lane.candidate?.hypothesis}`);
    } else {
      console.log(`  Lane ${lane.lane}: FAILED (${lane.error?.code}) — ${lane.error?.message}`);
    }
  }
}

/** Shared authorization and role settings for current live commands. */
interface LiveAuthorizationFlags {
  provider?: string;
  allowNetwork?: boolean;
  confirmRealProvider?: string;
  release?: boolean;
  maxRetryAttempts?: number;
  /** Optional role-specific overrides; omission keeps provider-default token observation. */
  evaluatorMaxOutputTokens?: number;
  evaluatorRequestTimeoutMs?: number;
  proposerMaxOutputTokens?: number;
  proposerRequestTimeoutMs?: number;
  /** Current U1 only: safety headroom over the frozen baseline estimate. */
  callEnvelopeMultiplier?: number;
}

/** Live-path metadata kept for the artefact and the terminal summary. */
interface LiveInstructionMeta {
  model: string;
  fingerprint: string;
  authorizedBudget: {
    maxLogicalCalls: number;
    maxRetryAttempts: number;
    requestTimeoutMs: number;
    maxOutputTokens?: number;
  };
  /** The two frozen role groups, their source, and the thinking-mode declaration. */
  roleOutput: {
    evaluator: { maxOutputTokens?: number; maxOutputTokensBehavior: number | "provider-default"; requestTimeoutMs: number };
    proposer: { maxOutputTokens?: number; maxOutputTokensBehavior: number | "provider-default"; requestTimeoutMs: number };
    source: string;
    thinkingMode: { setting: string; declared: string };
  };
  budget: RunCallBudget;
}

/** Parse the live policy or exit with the desensitized policy error. */
function parseLivePolicyOrFail(
  opts: LiveAuthorizationFlags,
  providerName: string,
  currentU1: {
    authorizedLogicalCalls: number;
    callEnvelope?: CallEnvelope;
  },
): LiveRunPolicy {
  try {
    return parseLiveRunPolicy({
      provider: providerName,
      allowNetwork: opts.allowNetwork === true,
      confirmRealProvider: opts.confirmRealProvider,
      noRelease: opts.release === false,
      maxRetryAttempts: opts.maxRetryAttempts,
      evaluatorMaxOutputTokens: opts.evaluatorMaxOutputTokens,
      evaluatorRequestTimeoutMs: opts.evaluatorRequestTimeoutMs,
      proposerMaxOutputTokens: opts.proposerMaxOutputTokens,
      proposerRequestTimeoutMs: opts.proposerRequestTimeoutMs,
      u1DynamicAuthorizedLogicalCalls: currentU1.authorizedLogicalCalls,
      ...(currentU1.callEnvelope ? { u1CallEnvelope: currentU1.callEnvelope } : {}),
    });
  } catch (e) {
    if (e instanceof LiveRunPolicyError) {
      intakeFail(2, `${e.code}: ${e.message}`);
    }
    throw e;
  }
}

/**
 * The run-wide role-output block embedded in every current live artifact —
 * both frozen groups, the honest source marker, the thinking-mode declaration.
 */
function liveRoleOutputMetaOf(live: LiveRunPolicy) {
  return {
    evaluator: { maxOutputTokens: live.evaluator.maxOutputTokens, maxOutputTokensBehavior: maxOutputTokensBehaviorOf(live.evaluator), requestTimeoutMs: live.evaluator.requestTimeoutMs },
    proposer: { maxOutputTokens: live.proposer.maxOutputTokens, maxOutputTokensBehavior: maxOutputTokensBehaviorOf(live.proposer), requestTimeoutMs: live.proposer.requestTimeoutMs },
    semanticJudge: {
      maxOutputTokens: live.evaluator.maxOutputTokens,
      maxOutputTokensBehavior: maxOutputTokensBehaviorOf(live.evaluator),
      requestTimeoutMs: live.evaluator.requestTimeoutMs,
      review: "same-model semantic review; not independent evaluation",
    },
    source: live.roleOutputSource,
    thinkingMode: { setting: live.thinkingMode.setting, declared: live.thinkingMode.declared },
  };
}

/** The shared preflight lines for the two role groups, the source, and thinking mode. */
function roleOutputPreflightLines(live: LiveRunPolicy): string[] {
  return [
    `  Role output policy: evaluator maxTokens ${maxOutputTokensBehaviorOf(live.evaluator)} / timeout ${live.evaluator.requestTimeoutMs}ms; proposer (bootstrap/mutation/repair/direct-refine) maxTokens ${maxOutputTokensBehaviorOf(live.proposer)} / timeout ${live.proposer.requestTimeoutMs}ms; source=${live.roleOutputSource}`,
    `  semantic-judge maxTokens ${maxOutputTokensBehaviorOf(live.evaluator)} / timeout ${live.evaluator.requestTimeoutMs}ms (same-model semantic review; evaluator-sized compact batches; not independent evaluation; public scoring and sealed audit are isolated phases)`,
    `  Thinking mode: ${live.thinkingMode.declared}`,
  ];
}

interface PreflightOptions extends LiveAuthorizationFlags {
  dir?: string;
  skillMd?: string;
  out?: string;
  runtimeContext?: string;
  mode?: string;
  earlyRepair?: string;
  maxGenerations?: number;
  maxRefinements?: number;
  minRepairProgress?: number;
  stagnationPatience?: number;
  maxInFlight?: number;
}

/**
 * The standalone preflight is the current Adaptive preflight, not a parallel
 * loader. It deliberately delegates to the same frozen-input/intake path used
 * by `adaptive-run --execute`, while keeping execution disabled.
 */
async function cmdPreflight(opts: PreflightOptions): Promise<void> {
  await cmdAdaptiveRun({
    ...opts,
    provider: opts.provider ?? "deepseek",
    mode: opts.mode ?? "standard",
    execute: false,
  });
}

// ── Current Adaptive run and its shared zero-network preflight ─────

interface AdaptiveRunOptions extends LiveAuthorizationFlags {
  dir?: string;
  out?: string;
  mode?: string;
  earlyRepair?: string;
  maxGenerations?: number;
  maxRefinements?: number;
  minRepairProgress?: number;
  stagnationPatience?: number;
  maxInFlight?: number;
  execute?: boolean;
  skillMd?: string;
  /** Exact SHA-256 of the existing adaptive-result.json; retries only terminal public-select. */
  resumePublicSelect?: string;
  runtimeContext?: string;
}

interface CalibrationRunOptions extends LiveAuthorizationFlags {
  dir?: string;
  out?: string;
  mode?: string;
  execute?: boolean;
}

interface CurrentStageBudgetEnvelope {
  plan: StageBudgetPlan;
  authorized: AuthorizedStageBudgets;
}

type CurrentU1AdaptiveEnvelope = ReturnType<typeof calculateAdaptiveClosureBudget>;

const DEFAULT_U1_CALL_ENVELOPE_MULTIPLIER = 2;
const U1_CALL_ENVELOPE_DISCLAIMER =
  "  raw estimate 只是基准估算，不是对真实调用次数的精确预测；每次 attempt 的 p=ceil(r×M)，阶段 H=primary authorization + loop retry reserve + existing recovery reserve，且是本次运行的有限硬上限。";

function parseU1CallEnvelopeMultiplier(value: number | undefined, command: string): number {
  const multiplier = value ?? DEFAULT_U1_CALL_ENVELOPE_MULTIPLIER;
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    intakeFail(
      2,
      `${command}_CALL_ENVELOPE_MULTIPLIER_INVALID: --call-envelope-multiplier must be a finite number >= 1 (got ${String(value)})`,
    );
  }
  return multiplier;
}

function u1RuntimeEstimationInputs(contract: EvaluationContractV3, command: string): {
  maxModelTurns: number;
  maxToolCalls: number;
} {
  if (contract.adapterId !== "instruction-v1" && contract.adapterId !== "reference-v1") {
    intakeFail(
      2,
      `${command}_DYNAMIC_ENVELOPE_ADAPTER_UNSUPPORTED: current U1 dynamic estimation supports only instruction-v1 or reference-v1`,
    );
  }
  return u1ScenarioExecutionPolicy(contract.adapterId);
}

async function loadCurrentU1ContractProbe(
  dir: string,
  command: string,
): Promise<EvaluationContractV3 | null> {
  const contractPath = evaluationContractV3Path(dir);
  if (!(await pathExists(contractPath))) return null;
  const parsed = EvaluationContractV3Schema.safeParse(
    readIntakeJson(await readFile(contractPath, "utf8"), `contract at ${contractPath}`),
  );
  if (!parsed.success) {
    intakeFail(2, `${command}_CONTRACT_INVALID: the frozen contract at ${contractPath} fails its schema`);
  }
  return parsed.data.u1ContractVersion === "v2" &&
    parsed.data.scoringProfile.version === U1_SCORING_PROFILE_VERSION &&
    parsed.data.confirmationMode === "human"
    ? parsed.data
    : null;
}

function calculateCurrentU1AdaptiveEnvelope(args: {
  contract: EvaluationContractV3;
  opts: Pick<AdaptiveRunOptions, "maxGenerations" | "maxRefinements" | "callEnvelopeMultiplier">;
  command: string;
}): CurrentU1AdaptiveEnvelope {
  if (args.contract.trainItemIds.length === 0) {
    intakeFail(2, `${args.command}_TRAIN_CONTRACT_REQUIRED: current U1 dynamic estimation requires public-train item identities`);
  }
  const runtimeInputs = u1RuntimeEstimationInputs(args.contract, args.command);
  return calculateAdaptiveClosureBudget({
    rootCandidates: 2,
    publicTrainItems: args.contract.trainItemIds.length,
    pinnedItems: Math.min(6, args.contract.trainItemIds.length),
    semanticBatchSize: ADAPTIVE_SEMANTIC_BATCH_SIZE,
    minChildGenerations: args.opts.maxGenerations ?? 2,
    ...runtimeInputs,
    maxRefinements: args.opts.maxRefinements ?? 1,
    budgetMultiplier: parseU1CallEnvelopeMultiplier(args.opts.callEnvelopeMultiplier, args.command),
  });
}

function adaptiveEnvelopePreflightLines(plan: CurrentU1AdaptiveEnvelope, maxRetryAttempts: number): string[] {
  const envelope = plan.envelope;
  const a = plan.assumptions;
  return [
    `  Adaptive estimation inputs: ${stableStringify(a)}`,
    `  Adaptive call envelope: estimationVersion=${envelope.estimationVersion}; rawStageEstimate=${envelope.rawStageEstimate}; callEnvelopeMultiplier=${envelope.callEnvelopeMultiplier}; stagePrimaryAuthorization=${envelope.stagePrimaryAuthorization}; stageLoopRetryReserve=${envelope.stageLoopRetryReserve}; existingRecoveryReserve=${envelope.existingRecoveryReserve}; stageAuthorizedLogicalCalls=${envelope.authorizedLogicalCalls}; headroom=${envelope.headroom}; actualLogicalCalls=0; HTTP attempts<=${envelope.authorizedLogicalCalls + maxRetryAttempts}; transport retries<=${maxRetryAttempts}`,
    `  Candidate-item authorization: r=${envelope.scenarioAuthorization.rawScenarioEstimate}; p=${envelope.scenarioAuthorization.authorizedModelCallsPerAttempt}; maxTurns=${envelope.scenarioAuthorization.authorizedMaxTurns}; maxToolCalls=${envelope.scenarioAuthorization.authorizedMaxToolCalls}; maxApplicationAttempts=${envelope.scenarioAuthorization.maxApplicationAttempts}; retryReserve=${envelope.scenarioAuthorization.scenarioRetryReserve}; model calls ${envelope.scenarioAuthorization.rawScenarioEstimate + 1}-${envelope.scenarioAuthorization.authorizedModelCallsPerAttempt} remain inside attempt 1`,
    U1_CALL_ENVELOPE_DISCLAIMER,
  ];
}

async function loadCurrentStageBudgetEnvelope(args: {
  dir: string;
  contract: EvaluationContractV3;
  opts: Pick<LiveAuthorizationFlags, "callEnvelopeMultiplier">;
  command: string;
}): Promise<CurrentStageBudgetEnvelope> {
  const manifestPath = evaluationManifestV3Path(args.dir);
  if (!(await pathExists(manifestPath))) {
    intakeFail(2, `${args.command}_MANIFEST_MISSING: no current frozen manifest at ${manifestPath}`);
  }
  const parsed = FrozenContractManifestSchema.safeParse(
    readIntakeJson(await readFile(manifestPath, "utf8"), `manifest at ${manifestPath}`),
  );
  if (!parsed.success || parsed.data.contractSha256 !== args.contract.contractSha256) {
    intakeFail(2, `${args.command}_MANIFEST_INVALID: the current manifest is invalid or not bound to the frozen contract`);
  }
  if (
    args.contract.u1ContractVersion !== "v2" ||
    args.contract.scoringProfile.version !== U1_SCORING_PROFILE_VERSION ||
    args.contract.confirmationMode !== "human"
  ) {
    intakeFail(2, `${args.command}_CURRENT_FORMAL_CONTRACT_REQUIRED: current U1 requires the frozen human-confirmed scoring contract`);
  }
  const runtimeInputs = u1RuntimeEstimationInputs(args.contract, args.command);
  const plan = calculateStageBudgets({
    shortlistCandidates: 4,
    selectItems: parsed.data.selectItemIds.length,
    holdoutItems: parsed.data.holdoutItemIds.length,
    semanticBatchSize: 3,
    directProposerCalls: 1,
    ...runtimeInputs,
    budgetMultiplier: parseU1CallEnvelopeMultiplier(args.opts.callEnvelopeMultiplier, args.command),
  });
  const authorized: AuthorizedStageBudgets = {
    publicSelect: plan.publicSelect,
    direct: plan.direct,
    sealed: plan.sealed,
  };
  try {
    assertStageBudgetsFunded(plan, authorized);
  } catch (error) {
    if (error instanceof StageFundingError) intakeFail(2, `${args.command}_${error.message}`);
    throw error;
  }
  return { plan, authorized };
}

function stageBudgetPreflightLines(envelope: CurrentStageBudgetEnvelope, maxRetryAttempts = 0): string[] {
  const a = envelope.plan.assumptions;
  const stageLine = (stage: "publicSelect" | "direct" | "sealed", label: string): string => {
    const item: CallEnvelope = envelope.plan.envelope[stage];
    const scenario = item.scenarioAuthorization;
    return `  ${label} call envelope: estimationVersion=${item.estimationVersion}; rawStageEstimate=${item.rawStageEstimate}; callEnvelopeMultiplier=${item.callEnvelopeMultiplier}; stagePrimaryAuthorization=${item.stagePrimaryAuthorization}; stageLoopRetryReserve=${item.stageLoopRetryReserve}; existingRecoveryReserve=${item.existingRecoveryReserve}; stageAuthorizedLogicalCalls=${item.authorizedLogicalCalls}; headroom=${item.headroom}; actualLogicalCalls=0; r=${scenario.rawScenarioEstimate}; p=${scenario.authorizedModelCallsPerAttempt}; maxTurns=${scenario.authorizedMaxTurns}; maxToolCalls=${scenario.authorizedMaxToolCalls}; maxApplicationAttempts=${scenario.maxApplicationAttempts}; retryReserve=${scenario.scenarioRetryReserve}; HTTP attempts<=${item.authorizedLogicalCalls + maxRetryAttempts}; transport retries<=${maxRetryAttempts}`;
  };
  return [
    `  Estimation inputs: ${stableStringify(a)}`,
    `  Candidate-item raw estimate r=${envelope.plan.envelope.publicSelect.scenarioAuthorization.rawScenarioEstimate} from min(maxModelTurns=${a.maxModelTurns}, maxToolCalls=${a.maxToolCalls}+1); p=${envelope.plan.envelope.publicSelect.scenarioAuthorization.authorizedModelCallsPerAttempt}; calls ${envelope.plan.envelope.publicSelect.scenarioAuthorization.rawScenarioEstimate + 1}-${envelope.plan.envelope.publicSelect.scenarioAuthorization.authorizedModelCallsPerAttempt} remain inside attempt 1; these are current frozen inputs, not universal constants`,
    stageLine("publicSelect", "public-select"),
    stageLine("direct", "Direct"),
    stageLine("sealed", "sealed"),
    U1_CALL_ENVELOPE_DISCLAIMER,
    "  Budget isolation: Adaptive, public-select, Direct, and sealed are independent; unused capacity cannot be borrowed across stages",
    "  Sealed execution: maxApplicationAttempts=1 and stageLoopRetryReserve=0; expanded p authorizes only the same one-shot audit, never a second body read, application retry, repair, or second audit",
  ];
}

function stageBaselineEstimate(
  plan: StageBudgetPlan,
  stage: "publicSelect" | "direct" | "sealed",
): number {
  return plan.envelope[stage].baselineEstimate;
}

/** Provider-agnostic local scheduler cap; it never changes a model request's semantics. */
function parseAdaptiveMaxInFlight(value: number | undefined): 1 | 2 | 3 | 4 {
  const maxInFlight = value ?? 2;
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 4) {
    intakeFail(
      2,
      `ADAPTIVE_RUN_MAX_IN_FLIGHT_INVALID: maxInFlight must be an integer from 1 to 4 (got ${String(value)})`,
    );
  }
  return maxInFlight as 1 | 2 | 3 | 4;
}

interface DirectRunOptions extends LiveAuthorizationFlags {
  dir?: string;
  out?: string;
  strategy?: string;
  execute?: boolean;
  skillMd?: string;
  mode?: string;
  maxInFlight?: number;
  runtimeContext?: string;
}

// ── Shared input loading for current formal evolution commands ─────

/** The lane routing every real-evolution run records (P1 任务 4). */
export interface RealEvolutionIntake {
  lane: U1IntakeLane;
  track: "b0-repair" | "s0-rebuild";
  reasons: string[];
  violationCategories: U1ViolationCategory[];
  b0EvidenceSha256: string;
  s0SkillSha256?: string;
  reportingNote: string;
}

interface RealEvolutionInputs {
  contract: EvaluationContractV3;
  taskCard: TaskCard;
  publicItems: FunnelEvalItem[];
  /** Which current public contract the items came from; never mixed in comparisons. */
  publicContract: PublicContractMeta;
  anchorSkillMd: string;
  /** Immutable generation-zero roots retained for terminal public selection. */
  b0ReferenceSkillMd: string;
  s0ReferenceSkillMd: string | null;
  anchorOriginRoot: "b0" | "s0";
  anchorCandidateId: string;
  u1Intake: RealEvolutionIntake;
  /** Prompt-safe rebuild notes; empty on the b0-repair track. */
  rebuildFailureCategories: string[];
  seedSkills: Array<{ candidateId: string; originRoot: "s0"; skillMd: string }>;
  evidence: U1BLiveEvidencePreflightResult;
  runtimeFactory: U1ScenarioRunnerFactory;
}

async function loadU1RuntimeFactoryOrFail(args: {
  contract: EvaluationContractV3;
  runtimeContext?: string;
  command: string;
}): Promise<U1ScenarioRunnerFactory> {
  try {
    return await createU1ScenarioRunnerFactory({
      contract: args.contract,
      runtimeContextPath: args.runtimeContext,
    });
  } catch (error) {
    if (error instanceof FrozenContextError) intakeFail(2, `${args.command}_${error.message}`);
    throw error;
  }
}

function runtimeContextPreflightLines(factory: U1ScenarioRunnerFactory): string[] {
  const binding = factory.binding;
  return [
    `  Runtime adapter: ${binding.adapterId}`,
    `  Runtime context manifest SHA-256: ${binding.manifestSha256 ?? "none (instruction-v1)"}`,
    `  Runtime context inventory: entries ${binding.entryCount}; replays ${binding.replayCount}`,
    `  Permitted runtime tools: ${binding.allowedTools.length > 0 ? binding.allowedTools.join(", ") : "none"}`,
    "  Runtime context boundary: logical ids only; dependency bodies and local paths are not printed",
  ];
}

/** The public-contract metadata block written into every real-evolution result. */
export interface PublicContractMeta {
  version: "v3";
  sha256?: string;
  itemFile?: string;
  basedOnPublicContractSha256?: string;
}

/** Extract mutation-visible public-train items; terminal select remains concealed. */
async function loadEvolutionTrainItems(args: {
  dir: string;
  taskCard: TaskCard;
  command: string;
  requireFrozenU1BItems: boolean;
}): Promise<FunnelEvalItem[]> {
  const draftPath = evaluationDraftPath(args.dir);
  if (await pathExists(draftPath)) {
    const draftResult = EvaluationDraftSchema.safeParse(
      readIntakeJson(await readFile(draftPath, "utf8"), `draft at ${draftPath}`),
    );
    if (!draftResult.success) {
      intakeFail(2, `${args.command}_DRAFT_INVALID: the draft at ${draftPath} fails its schema`);
    }
    const publicItems: FunnelEvalItem[] = draftResult.data.items
      .filter(
        (item) => item.split === "public" && (item.selectionRole === undefined || item.selectionRole === "train"),
      )
      .map((item) => ({
        itemId: item.itemId,
        scenarioId: item.scenarioId,
        split: "public" as const,
        itemType: item.itemType,
        ...(item.scenarioFamily ? { scenarioFamily: item.scenarioFamily } : {}),
        input: item.input,
        judgingRule: item.judgingRule,
        ...(item.redlineRefs ? { redlineRefs: item.redlineRefs } : {}),
        ...(item.rubric ? { rubric: item.rubric } : {}),
        ...(item.taskVerifier ? { taskVerifier: item.taskVerifier } : {}),
      }));
    if (publicItems.length === 0) {
      intakeFail(2, `${args.command}_NO_PUBLIC_TRAIN_ITEMS: the draft holds no mutation-visible public-train items`);
    }
    return publicItems;
  }

  if (args.requireFrozenU1BItems) {
    intakeFail(
      2,
      `${args.command}_CURRENT_DRAFT_REQUIRED: a current evolution run must load its frozen public-train items; it may not invent them from Task Card scenarios`,
    );
  }

  const redlineRefs = args.taskCard.redlines.map((_, index) => `redline-${index + 1}`);
  const derived: FunnelEvalItem[] = args.taskCard.scenarios.map((scenario) => ({
    itemId: `${scenario.id}-public`,
    scenarioId: scenario.id,
    split: "public",
    itemType: "trigger",
    input: scenario.userRequest,
    judgingRule: `the answer must satisfy the scenario outcome: ${scenario.expectedOutcome}`,
    redlineRefs,
  }));
  if (derived.length === 0) {
    intakeFail(2, `${args.command}_NO_PUBLIC_ITEMS: neither a draft nor card scenarios provide public items`);
  }
  console.log(
    `  Public items: ${derived.length} derived 1:1 from the frozen card scenarios (no evaluation-draft.json in ${args.dir})`,
  );
  return derived;
}

/** Load the concealed public-select partition only after evolution has stopped. */
async function loadTerminalPublicSelectItems(args: {
  dir: string;
  contract: EvaluationContractV3;
  command: string;
}): Promise<FunnelEvalItem[]> {
  const manifestPath = evaluationManifestV3Path(args.dir);
  const parsed = FrozenContractManifestSchema.safeParse(
    readIntakeJson(await readFile(manifestPath, "utf8"), `manifest at ${manifestPath}`),
  );
  if (!parsed.success || parsed.data.contractSha256 !== args.contract.contractSha256) {
    intakeFail(2, `${args.command}_MANIFEST_INVALID: terminal public-select manifest is invalid or drifted`);
  }
  let selected;
  try {
    selected = await loadTerminalSelectionItems(evaluationDraftPath(args.dir), parsed.data);
  } catch (error) {
    if (error instanceof FreezeError) intakeFail(2, `${args.command}_${error.message}`);
    throw error;
  }
  return selected.map((item) => ({
    itemId: item.itemId,
    scenarioId: item.scenarioId,
    split: "public" as const,
    itemType: item.itemType,
    input: item.input,
    judgingRule: item.judgingRule,
    ...(item.redlineRefs ? { redlineRefs: item.redlineRefs } : {}),
    ...(item.rubric ? { rubric: item.rubric } : {}),
    ...(item.taskVerifier ? { taskVerifier: item.taskVerifier } : {}),
  }));
}

interface FrozenExecutionEvidence {
  contract: EvaluationContractV3;
  taskCard: TaskCard;
  draft?: EvaluationDraft;
  evidence: U1BLiveEvidencePreflightResult;
}

interface CurrentFrozenIdentity {
  contractSha256: string;
  b0RootSha256: string;
  b0SkillPath: string;
  b0SkillSha256: string;
  b0SkillBytes: number;
  s0RootSha256: string;
  s0SkillSha256: string;
}

function requireSingleRecordedSkill(
  root: RootFreeze,
  rootName: "B0" | "S0",
  command: string,
): RootFreeze["files"][number] {
  if (
    root.files.length !== 1 ||
    root.files[0]?.path !== "SKILL.md" ||
    root.files[0]?.status !== "recorded"
  ) {
    intakeFail(
      2,
      `${command}_FROZEN_${rootName}_SCOPE_DRIFT: ${rootName} must contain exactly one recorded SKILL.md`,
    );
  }
  return root.files[0];
}

/**
 * Task 13 Step 1 identity proof. This reads only the public contract,
 * bootstrap metadata, b0-source/SKILL.md, and bootstrap/s0/SKILL.md. It
 * never opens the canonical sealed holdout and never writes an artefact.
 */
async function loadCurrentFrozenIdentity(args: {
  dir: string;
  contract: EvaluationContractV3;
  command: string;
}): Promise<CurrentFrozenIdentity> {
  const bundleFile = bootstrapBundlePath(join(args.dir, "bootstrap"));
  if (!(await pathExists(bundleFile))) {
    intakeFail(2, `${args.command}_FROZEN_BOOTSTRAP_BUNDLE_MISSING: the frozen bootstrap bundle is required`);
  }
  let bundleUnknown: unknown;
  try {
    bundleUnknown = JSON.parse((await readFile(bundleFile, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    intakeFail(
      2,
      `${args.command}_FROZEN_BOOTSTRAP_BUNDLE_INVALID: the frozen bootstrap bundle is unreadable or not valid JSON`,
    );
  }
  const parsed = BootstrapBundleSchema.safeParse(bundleUnknown);
  if (!parsed.success) {
    intakeFail(2, `${args.command}_FROZEN_BOOTSTRAP_BUNDLE_INVALID: the frozen bootstrap bundle fails its schema`);
  }
  const bundle = parsed.data;
  if (bundle.contractSha256 !== args.contract.contractSha256) {
    intakeFail(
      2,
      `${args.command}_FROZEN_BUNDLE_CONTRACT_DRIFT: the bootstrap bundle is not bound to the current frozen contract`,
    );
  }

  let currentB0: RootFreeze;
  let currentS0: RootFreeze;
  try {
    [currentB0, currentS0] = await Promise.all([
      freezeRoot({
        skillDir: join(args.dir, "b0-source"),
        kind: "b0",
        source: "Task 13 read-only frozen identity verification",
      }),
      freezeRoot({
        skillDir: join(args.dir, "bootstrap", "s0"),
        kind: "s0",
        source: "Task 13 read-only frozen identity verification",
      }),
    ]);
  } catch (error) {
    const safeCode = error instanceof RootFreezeError ? error.code : "ROOT_IO_ERROR";
    intakeFail(
      2,
      `${args.command}_FROZEN_ROOT_READ_FAILED: frozen root verification failed (${safeCode})`,
    );
  }

  const bundledB0Skill = requireSingleRecordedSkill(bundle.b0, "B0", args.command);
  const bundledS0Skill = requireSingleRecordedSkill(bundle.s0, "S0", args.command);
  const currentB0Skill = requireSingleRecordedSkill(currentB0, "B0", args.command);
  const currentS0Skill = requireSingleRecordedSkill(currentS0, "S0", args.command);

  if (bundle.b0.rootHash !== currentB0.rootHash) {
    intakeFail(2, `${args.command}_FROZEN_B0_ROOT_DRIFT: current b0-source does not match its frozen root hash`);
  }
  if (bundle.s0.rootHash !== currentS0.rootHash) {
    intakeFail(2, `${args.command}_FROZEN_S0_ROOT_DRIFT: current bootstrap S0 does not match its frozen root hash`);
  }
  if (
    bundledB0Skill.sha256 !== currentB0Skill.sha256 ||
    bundledB0Skill.bytes !== currentB0Skill.bytes
  ) {
    intakeFail(2, `${args.command}_FROZEN_B0_FILE_DRIFT: current B0 SKILL.md does not match its frozen file record`);
  }
  if (
    bundledS0Skill.sha256 !== currentS0Skill.sha256 ||
    bundledS0Skill.bytes !== currentS0Skill.bytes
  ) {
    intakeFail(2, `${args.command}_FROZEN_S0_FILE_DRIFT: current S0 SKILL.md does not match its frozen file record`);
  }
  for (const lane of bundle.lanes) {
    if (lane.status !== "ok" || !lane.candidate) continue;
    const expectedParent = lane.lane === "b0-repair" ? bundle.b0.rootHash : bundle.s0.rootHash;
    if (lane.candidate.parentRootHash !== expectedParent) {
      intakeFail(
        2,
        `${args.command}_FROZEN_LANE_PARENT_DRIFT: a bootstrap lane is not bound to its frozen parent root`,
      );
    }
  }

  return {
    contractSha256: args.contract.contractSha256,
    b0RootSha256: currentB0.rootHash,
    b0SkillPath: join(args.dir, "b0-source", "SKILL.md"),
    b0SkillSha256: currentB0Skill.sha256,
    b0SkillBytes: currentB0Skill.bytes,
    s0RootSha256: currentS0.rootHash,
    s0SkillSha256: currentS0Skill.sha256,
  };
}

async function assertSkillMatchesFrozenB0(args: {
  skillMd: string | undefined;
  identity: CurrentFrozenIdentity;
  command: string;
}): Promise<void> {
  if (!args.skillMd) {
    intakeFail(2, `${args.command}_SKILL_MD_REQUIRED: provide --skill-md <path> pointing at the anchor B0 SKILL.md`);
  }
  const skillMdPath = resolve(process.cwd(), args.skillMd);
  if (!sameFilesystemPath(skillMdPath, args.identity.b0SkillPath)) {
    intakeFail(
      2,
      `${args.command}_FROZEN_B0_SKILL_DRIFT: --skill-md must point exactly at the self-contained frozen B0 SKILL.md`,
    );
  }
  if (!(await pathExists(skillMdPath))) {
    intakeFail(2, `${args.command}_SKILL_MD_MISSING: no SKILL.md at ${skillMdPath}`);
  }
  let actualBytes: Buffer;
  try {
    actualBytes = await readFile(skillMdPath);
  } catch {
    intakeFail(2, `${args.command}_SKILL_MD_READ_FAILED: the selected SKILL.md could not be read`);
  }
  const actualSha256 = createHash("sha256").update(actualBytes).digest("hex");
  if (
    actualSha256 !== args.identity.b0SkillSha256 ||
    actualBytes.byteLength !== args.identity.b0SkillBytes
  ) {
    intakeFail(
      2,
      `${args.command}_FROZEN_B0_SKILL_DRIFT: --skill-md bytes do not match the frozen B0 SKILL.md`,
    );
  }
}

function frozenIdentityPreflightLines(
  identity: CurrentFrozenIdentity,
  _evidence: U1BLiveEvidencePreflightResult,
): string[] {
  return [
    `  Frozen contract SHA-256: ${identity.contractSha256}`,
    `  Frozen B0 root SHA-256: ${identity.b0RootSha256}`,
    `  Frozen B0 SKILL.md SHA-256: ${identity.b0SkillSha256}`,
    `  Frozen S0 root SHA-256: ${identity.s0RootSha256}`,
    `  Frozen S0 SKILL.md SHA-256: ${identity.s0SkillSha256}`,
    `  Semantic response binding: ${SEMANTIC_RESPONSE_BINDING_VERSION}`,
    "  Human confirmations: 2/2; human-confirmed",
    `  Direct prompt contract: ${DIRECT_U1_PROMPT_CONTRACT_VERSION}`,
    `  Direct prompt contract SHA-256: ${DIRECT_U1_PROMPT_CONTRACT_SHA256}`,
    "  Canonical sealed holdout: unopened; no audit input is read by this preflight",
  ];
}

/** Read and validate only the public-side evidence needed by live preflight. */
async function loadFrozenExecutionEvidence(args: {
  dir: string;
  command: string;
  noRelease: boolean;
}): Promise<FrozenExecutionEvidence> {
  const contractPath = evaluationContractV3Path(args.dir);
  if (!(await pathExists(contractPath))) {
    intakeFail(
      2,
      `${args.command}_CONTRACT_MISSING: no current frozen contract at ${contractPath}; run eval-freeze first`,
    );
  }
  const contractResult = EvaluationContractV3Schema.safeParse(
    readIntakeJson(await readFile(contractPath, "utf8"), `contract at ${contractPath}`),
  );
  if (!contractResult.success) {
    intakeFail(2, `${args.command}_CONTRACT_INVALID: the frozen contract at ${contractPath} fails its schema`);
  }
  const contract = contractResult.data;
  if (evaluationContractContentSha256(contract) !== contract.contractSha256) {
    intakeFail(2, `${args.command}_CONTRACT_CONTENT_DRIFT: the frozen contract content no longer matches its self-hash`);
  }
  if (contract.adapterId !== INSTRUCTION_ADAPTER_ID && contract.adapterId !== REFERENCE_ADAPTER_ID) {
    intakeFail(
      2,
      `${args.command}_ADAPTER_MISMATCH: the contract binds unsupported U1 adapter "${contract.adapterId}"`,
    );
  }
  if (
    contract.u1ContractVersion !== "v2" ||
    contract.scoringProfile.version !== U1_SCORING_PROFILE_VERSION ||
    contract.confirmationMode !== "human"
  ) {
    intakeFail(2, `${args.command}_CURRENT_FORMAL_CONTRACT_REQUIRED: live U1 accepts only the current human-confirmed formal contract`);
  }

  const cardCandidates = [taskCardConfirmedPath(args.dir)];
  const cardPath = await firstExistingPath(cardCandidates);
  if (!cardPath) {
    intakeFail(
      2,
      `${args.command}_TASK_CARD_MISSING: no current confirmed Task Card at ${cardCandidates[0]}`,
    );
  }
  const cardResult = TaskCardSchema.safeParse(
    readIntakeJson(await readFile(cardPath, "utf8"), `task card at ${cardPath}`),
  );
  if (!cardResult.success) {
    intakeFail(2, `${args.command}_TASK_CARD_INVALID: the task card at ${cardPath} fails its schema`);
  }
  const taskCard = cardResult.data;

  const draftPath = evaluationDraftPath(args.dir);
  if (!(await pathExists(draftPath))) {
    intakeFail(2, `${args.command}_U1B_DRAFT_MISSING: no evaluation draft at ${draftPath}`);
  }
  const draftResult = EvaluationDraftSchema.safeParse(
    readIntakeJson(await readFile(draftPath, "utf8"), `draft at ${draftPath}`),
  );
  if (!draftResult.success) {
    intakeFail(2, `${args.command}_U1B_DRAFT_INVALID: the draft at ${draftPath} fails its schema`);
  }
  const draft = draftResult.data;

  const reviewPath = evaluationReviewConfirmedPath(args.dir);
  if (!(await pathExists(reviewPath))) {
    intakeFail(2, `${args.command}_U1B_REVIEW_MISSING: no confirmed evaluation review at ${reviewPath}`);
  }
  const reviewResult = EvaluationReviewSchema.safeParse(
    readIntakeJson(await readFile(reviewPath, "utf8"), `evaluation review at ${reviewPath}`),
  );
  if (!reviewResult.success) {
    intakeFail(2, `${args.command}_U1B_REVIEW_INVALID: the review at ${reviewPath} fails its schema`);
  }
  const review = reviewResult.data;

  let evidence: U1BLiveEvidencePreflightResult;
  try {
    evidence = assertU1BLiveEvidencePreflight({
      contract,
      taskCard,
      draft,
      review,
      noRelease: args.noRelease,
    });
  } catch (error) {
    if (error instanceof Error) {
      intakeFail(2, `${args.command}_${error.message}`);
    }
    throw error;
  }

  const cardHash = taskCardContentSha256(taskCard);
  if (cardHash !== contract.taskCardHash) {
    intakeFail(
      2,
      `${args.command}_TASK_CARD_HASH_MISMATCH: the card hashes to ${cardHash}, but the frozen contract binds ${contract.taskCardHash}; the card and contract must stay frozen together`,
    );
  }
  return { contract, taskCard, draft, evidence };
}

/**
 * Load the frozen artifacts both real-evolution commands execute against:
 * the v3 contract, the lane-compatible Task Card (hash-bound to the contract),
 * the mutation-visible public-train slice, the anchor B0 SKILL.md, and the S0
 * seed lanes from the bootstrap bundle. The holdout split is never read.
 *
 * The current formal lane is the only accepted layout. No report or historic
 * suite artifact can become a runnable contract fallback.
 */
export async function loadRealEvolutionInputs(args: {
  dir: string;
  skillMd?: string;
  command: string;
  noRelease?: boolean;
  runtimeContext?: string;
}): Promise<RealEvolutionInputs> {
  const frozen = await loadFrozenExecutionEvidence({
    dir: args.dir,
    command: args.command,
    noRelease: args.noRelease ?? true,
  });
  const { contract, taskCard, evidence } = frozen;
  const runtimeFactory = await loadU1RuntimeFactoryOrFail({
    contract,
    runtimeContext: args.runtimeContext,
    command: args.command,
  });

  const publicItems = await loadEvolutionTrainItems({
    dir: args.dir,
    taskCard,
    command: args.command,
    requireFrozenU1BItems: true,
  });
  const publicContract: PublicContractMeta = {
    version: "v3",
    sha256: contract.contractSha256,
  };

  if (!args.skillMd) {
    intakeFail(2, `${args.command}_SKILL_MD_REQUIRED: provide --skill-md <path> pointing at the anchor B0 SKILL.md`);
  }
  const skillMdPath = resolve(process.cwd(), args.skillMd);
  if (!(await pathExists(skillMdPath))) {
    intakeFail(2, `${args.command}_SKILL_MD_MISSING: no SKILL.md at ${skillMdPath}`);
  }
  const anchorSkillMd = await readFile(skillMdPath, "utf8");

  const seedSkills: RealEvolutionInputs["seedSkills"] = [];
  const bundlePath = bootstrapBundlePath(join(args.dir, "bootstrap"));
  if (await pathExists(bundlePath)) {
    const bundle = readIntakeJson(
      await readFile(bundlePath, "utf8"),
      `bootstrap bundle at ${bundlePath}`,
    ) as {
      lanes?: Array<{
        lane?: string;
        status?: string;
        candidate?: { originRoot?: string; contractSha256?: string; files?: Array<{ path?: string; content?: string }> };
      }>;
    };
    for (const lane of bundle.lanes ?? []) {
      if (lane.status !== "ok" || !lane.candidate || !lane.lane) continue;
      if (lane.candidate.contractSha256 !== contract.contractSha256) {
        intakeFail(
          2,
          `${args.command}_CONTRACT_MISMATCH: lane "${lane.lane}" was bound to contract ${lane.candidate.contractSha256}, not ${contract.contractSha256}; re-run bootstrap against the frozen contract`,
        );
      }
      if (lane.candidate.originRoot !== "s0") continue;
      const skillFile = lane.candidate.files?.find((file) => file.path === "SKILL.md");
      if (!skillFile?.content) {
        intakeFail(2, `${args.command}_LANE_SKILL_MISSING: lane "${lane.lane}" carries no SKILL.md content`);
      }
      seedSkills.push({ candidateId: lane.lane, originRoot: "s0", skillMd: skillFile.content });
    }
  }
  const controlledS0Path = join(args.dir, "bootstrap", "s0", "SKILL.md");
  const controlledS0SkillMd = await pathExists(controlledS0Path)
    ? await readFile(controlledS0Path, "utf8")
    : null;

  // ── P1 任务 4: the static U1 intake lane routing (zero provider calls) ──
  const decision = decideU1Intake({
    b0SkillMd: anchorSkillMd,
    taskCard,
    adapterId: contract.adapterId,
  });
  if (decision.lane === "blocked") {
    intakeFail(
      2,
      `${args.command}_U1_INTAKE_BLOCKED: ${decision.reasons.join("; ")}`,
    );
  }
  let anchorOriginRoot: "b0" | "s0";
  let anchorCandidateId: string;
  let routedAnchorSkillMd: string;
  let rebuildFailureCategories: string[] = [];
  let u1Intake: RealEvolutionIntake;
  if (decision.lane === "requires_s0_rebuild") {
    const adapter = getAdapterDeclaration(contract.adapterId);
    if (!adapter) {
      intakeFail(2, `${args.command}_ADAPTER_UNDECLARED: no declaration for adapter "${contract.adapterId}"`);
    }
    let track: ReturnType<typeof materializeS0RebuildTrack>;
    try {
      track = materializeS0RebuildTrack({ decision, taskCard, contract, adapter });
    } catch (e) {
      if (e instanceof U1IntakeError) {
        intakeFail(2, `${args.command}_${e.code}: ${e.message}`);
      }
      throw e;
    }
    anchorOriginRoot = "s0";
    anchorCandidateId = "s0-anchor";
    routedAnchorSkillMd = track.s0SkillMd;
    rebuildFailureCategories = track.sanitizedFailureCategories;
    u1Intake = {
      lane: decision.lane,
      track: "s0-rebuild",
      reasons: decision.reasons,
      violationCategories: decision.violationCategories,
      b0EvidenceSha256: track.b0EvidenceSha256,
      s0SkillSha256: track.s0SkillSha256,
      reportingNote: track.reportingNote,
    };
    console.log(
      `  U1 intake: requires_s0_rebuild — the original B0 (sha256 ${track.b0EvidenceSha256.slice(0, 12)}…) is frozen as EVIDENCE ONLY and never sent to a live proposer; the run starts from the S0 scaffold`,
    );
  } else {
    const currentS0ReferenceSkillMd = controlledS0SkillMd ?? seedSkills.find((seed) => seed.originRoot === "s0")?.skillMd;
    anchorOriginRoot = "b0";
    anchorCandidateId = "b0-anchor";
    routedAnchorSkillMd = anchorSkillMd;
    u1Intake = {
      lane: decision.lane,
      track: "b0-repair",
      reasons: decision.reasons,
      violationCategories: [],
      b0EvidenceSha256: decision.b0EvidenceSha256,
      ...(currentS0ReferenceSkillMd ? { s0SkillSha256: sha256Hex(currentS0ReferenceSkillMd) } : {}),
      reportingNote: "b0-repair-track: the run started from the operator-supplied B0",
    };
  }

  return {
    contract,
    taskCard,
    publicItems,
    publicContract,
    anchorSkillMd: routedAnchorSkillMd,
    b0ReferenceSkillMd: anchorSkillMd,
    s0ReferenceSkillMd:
      anchorOriginRoot === "s0"
        ? routedAnchorSkillMd
        : controlledS0SkillMd ?? seedSkills.find((seed) => seed.originRoot === "s0")?.skillMd ?? null,
    anchorOriginRoot,
    anchorCandidateId,
    u1Intake,
    rebuildFailureCategories,
    seedSkills,
    evidence,
    runtimeFactory,
  };
}

async function firstExistingPath(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    if (await pathExists(path)) return path;
  }
  return null;
}

/**
 * The billed/cached live provider chain shared by the real-evolution
 * commands (P1 任务 2): ONE shared RunCallBudget and ONE shared response
 * cache, but role-scoped providers so reports can attribute traffic and
 * failures — the evaluator (transport failures never retried; reserve 0)
 * can never spend the retry reserve the proposers keep for themselves,
 * while the run-wide caps stay exactly what the operator authorized.
 */
async function buildLiveEvolutionChain(live: LiveRunPolicy, stage: string): Promise<{
  evaluator: ReturnType<typeof createCachingProvider>;
  mutation: ReturnType<typeof createCachingProvider>;
  repair: ReturnType<typeof createCachingProvider>;
  directRefine: ReturnType<typeof createCachingProvider>;
  semanticJudge: ReturnType<typeof createCachingProvider>;
  budget: RunCallBudget;
  fingerprint: string;
  roleFingerprints: Record<LiveProviderRole, string>;
  model: string;
}> {
  if (!live.u1CallEnvelope) {
    intakeFail(2, "LIVE_CURRENT_U1_ENVELOPE_REQUIRED: the current evolution chain requires its centrally calculated call envelope");
  }
  let config;
  try {
    config = getDeepSeekConfig();
  } catch (e) {
    if (e instanceof DeepSeekConfigError) {
      intakeFail(
        2,
        "DEEPSEEK_API_KEY_MISSING: no DEEPSEEK_API_KEY in the process environment or the V3 root .env; copy .env.example to .env — offline commands still work without a key",
      );
    }
    throw e;
  }
  const budget = new RunCallBudget({
    maxLogicalCalls: live.maxLogicalCalls,
    maxRetryAttempts: live.maxRetryAttempts,
    roleRetryReserves: {
      evaluator: 0,
      mutation: live.maxRetryAttempts,
      repair: live.maxRetryAttempts,
      "direct-refine": live.maxRetryAttempts,
      "semantic-judge": 0,
    },
  });
  const cache = createInMemoryResponseCache();
  // The evaluator instance wears the evaluator role group; every proposer
  // wears the proposer group. Every current live role must return strict JSON,
  // so thinking is explicitly disabled and truncation still fails closed.
  const scoped = (role: LiveProviderRole, maxRetries: number) => {
    const group = roleGroupOf(live, role);
    const raw = new OpenAICompatibleProvider(config, group.requestTimeoutMs, {
      maxRetries,
      budget,
      role,
      maxOutputTokens: group.maxOutputTokens,
      thinking: thinkingModeOf(role),
      usageTags: { stage },
    });
    const provider = createCachingProvider(raw, {
      cache,
      budget,
      role,
      baseMaterial: {
        model: config.model,
        providerConfigFingerprint: raw.configFingerprint(),
        baseUrlIdentity: raw.endpointIdentity(),
        skillSnapshotSha256: "-",
        mode: "live",
        maxOutputTokensBehavior: maxOutputTokensBehaviorOf(group),
        thinkingMode: thinkingModeOf(role) ?? "provider-default",
        temperatureBehavior: "provider-default",
        frozenEvidenceSha256: "-",
        stage,
      },
    });
    return { raw, provider };
  };
  const evaluator = scoped("evaluator", 0);
  const mutation = scoped("mutation", live.maxRetryAttempts);
  const repair = scoped("repair", live.maxRetryAttempts);
  const directRefine = scoped("direct-refine", live.maxRetryAttempts);
  const semanticJudge = scoped("semantic-judge", 0);
  return {
    evaluator: evaluator.provider,
    mutation: mutation.provider,
    repair: repair.provider,
    directRefine: directRefine.provider,
    semanticJudge: semanticJudge.provider,
    budget,
    fingerprint: evaluator.raw.configFingerprint(),
    roleFingerprints: {
      evaluator: evaluator.raw.configFingerprint(),
      mutation: mutation.raw.configFingerprint(),
      repair: repair.raw.configFingerprint(),
      "direct-refine": directRefine.raw.configFingerprint(),
      "semantic-judge": semanticJudge.raw.configFingerprint(),
    },
    model: config.model,
  };
}

/** Shared live-mode note: current U1 observes provider-default tokens unless explicitly overridden. */
const MAX_OUTPUT_TOKENS_NOTE =
  "  Token policy: observe-only/provider-default when max_tokens is omitted; an explicit operator override remains a ceiling, not a quality promise; finish_reason=length remains diagnostic and fails closed";

function providerTokenTelemetryEvidenceOf(budget: RunCallBudget) {
  return {
    ...budget.providerTokenTelemetry(),
    byStageRoleModel: budget.providerTokenTelemetryByTags(),
  };
}

/** Live-run metadata embedded in every current formal evolution result. */
function liveRunMetaOf(
  live: LiveRunPolicy,
  chain: { model: string; fingerprint: string; budget: RunCallBudget },
) {
  if (!live.u1CallEnvelope) {
    intakeFail(2, "LIVE_CURRENT_U1_ENVELOPE_REQUIRED: current Adaptive evidence requires its call envelope");
  }
  return {
    provider: { name: "deepseek", model: chain.model, configFingerprint: chain.fingerprint },
    authorizedBudget: {
      maxLogicalCalls: live.maxLogicalCalls,
      maxRetryAttempts: live.maxRetryAttempts,
      evaluatorRequestTimeoutMs: live.evaluator.requestTimeoutMs,
      evaluatorMaxOutputTokens: live.evaluator.maxOutputTokens,
      proposerRequestTimeoutMs: live.proposer.requestTimeoutMs,
      proposerMaxOutputTokens: live.proposer.maxOutputTokens,
    },
    callEnvelope: live.u1CallEnvelope,
    roleOutput: liveRoleOutputMetaOf(live),
    /** Historical aggregate remains readable while the additive projection preserves unknown usage. */
    tokenTelemetry: chain.budget.tokenTelemetry(),
    providerTokenTelemetry: providerTokenTelemetryEvidenceOf(chain.budget),
    httpAttemptCeiling: maxHttpAttemptsOf(live),
    roleRetryReserves: {
      evaluator: 0,
      mutation: live.maxRetryAttempts,
      repair: live.maxRetryAttempts,
      "direct-refine": live.maxRetryAttempts,
      "semantic-judge": 0,
    },
    holdout: "sealed",
    release: "withheld (noRelease=true)",
    maxOutputTokensNote:
      "observe-only/provider-default when omitted; explicit operator overrides remain ceilings; finish_reason=length is diagnostic and fails closed",
  };
}

function derivedEvidenceFlagsOf(evidence: U1BLiveEvidencePreflightResult) {
  return {
    confirmationMode: evidence.confirmationMode,
    explorationOnly: evidence.explorationOnly,
    humanConfirmationBypassed: evidence.humanConfirmationBypassed,
    formalEvidence: evidence.confirmationMode === "human",
    releaseAllowed: false,
    sealedAllowed: false,
  };
}

/** Archive an existing canonical stage attempt only when its exact current binding matches. */
async function archiveStageAttemptOrFail(args: {
  evidenceDir: string;
  trigger: StageAttemptTrigger;
  expectedBinding: StageAttemptArchiveExpectedBinding;
}): Promise<void> {
  try {
    await archiveSupersededStageAttempt(args);
  } catch (error) {
    if (error instanceof StageAttemptArchiveError) {
      intakeFail(2, `${error.code}: existing canonical stage evidence was not archived; zero provider calls were made`);
    }
    throw error;
  }
}

/** One line of per-role provider accounting (logical/HTTP/retry) for live reports. */
function roleAccountingLine(budget: RunCallBudget): string {
  const byRole = budget.roleAccounting();
  const roles = ["evaluator", "mutation", "repair", "direct-refine", "semantic-judge"];
  return roles.map((role) => {
    const a = byRole[role] ?? { logicalCalls: 0, httpAttempts: 0, retryAttempts: 0 };
    return `${role} ${a.logicalCalls}L/${a.httpAttempts}H/${a.retryAttempts}R`;
  }).join(", ");
}

/** Human-readable, payload-free status for a live adaptive run. */
function adaptiveProgressStage(type: string): string {
  const stages: Record<string, string> = {
    run_start: "已冻结合同，开始根节点筛选",
    candidate_screened: "候选 pinned 筛选完成",
    route_decision: "已根据进步证书选择下一步",
    generation_start: "开始本代 exploit/diversify 变异",
    candidate_evaluated: "候选完整 public 评测完成",
    generation_end: "本代结束，保留种群",
    public_goal_met: "公共集目标已达到，停止无意义编辑",
    run_end: "演化主链结束，准备写入证据",
  };
  return stages[type] ?? `阶段事件 ${type}`;
}

function printAdaptiveLiveProgress(input: {
  event?: FunnelEvent;
  startedAtMs: number;
  currentStage: string;
  budget: RunCallBudget;
  generation: number;
  candidate: string;
  cacheHits: number;
  cacheMisses: number;
  heartbeat?: boolean;
}): void {
  const elapsedSeconds = Math.floor((Date.now() - input.startedAtMs) / 1000);
  const stage = input.event ? adaptiveProgressStage(input.event.type) : input.currentStage;
  const prefix = input.heartbeat ? "[SkillFoo 仍在运行]" : "[SkillFoo 进度]";
  const accounting = input.budget.accounting;
  console.log(
    `${prefix} ${elapsedSeconds}s · ${stage} · generation ${input.generation} · candidate ${input.candidate} · cache ${input.cacheHits} hit/${input.cacheMisses} miss · logical ${accounting.logicalCalls}/${input.budget.caps.maxLogicalCalls}, HTTP ${accounting.httpAttempts}, retry ${accounting.retryAttempts}/${input.budget.caps.maxRetryAttempts}`,
  );
}

function realEvolutionRunner(
  provider: Provider & {
    setContext?: (scenarioId: string, snapshotId: string) => void;
    withContext?: (context: { scenarioId: string; snapshotId: string; frozenEvidenceSha256?: string }) => Provider;
  },
  runtimeFactory: U1ScenarioRunnerFactory,
  role: U1ScenarioRole,
  scenarioAuthorization?: ScenarioCallAuthorization,
): FunnelScenarioRunnerOf {
  return runtimeFactory.runnerFor(role, provider, scenarioAuthorization);
}

function livePublicSemanticScorer(provider: Provider): InstructionBatchScorer {
  return async ({ contract, runs, recovery }) => applyContractGates({
    contract,
    runs: [...runs],
    semanticJudgements: await createPublicSemanticBatchJudge({
      provider,
      recovery,
    })(runs),
  });
}

function liveSealedSemanticScorer(provider: Provider): SealedInstructionBatchScorer {
  const judge = createSealedSemanticBatchJudge({ provider });
  return async ({ contract, runs }) => applyContractGates({
    contract,
    runs: [...runs],
    semanticJudgements: await judge(runs),
  });
}

interface StageSemanticRecoveryEvidence {
  context: U1RecoveryContext;
  attempts: U1ApplicationRecoveryAttempt[];
  diagnostics: U1RecoveryDiagnostic[];
}

/**
 * Stage-local collector for the existing semantic schema-repair protocol.
 * It stores only the shared content-free projections; prompt/response bodies
 * never cross this boundary.
 */
function createStageSemanticRecoveryEvidence(subject: U1RecoverySubject): StageSemanticRecoveryEvidence {
  const attempts: U1ApplicationRecoveryAttempt[] = [];
  const diagnostics: U1RecoveryDiagnostic[] = [];
  return {
    attempts,
    diagnostics,
    context: {
      subject,
      hooks: {
        onApplicationRecoveryAttempt: (attempt) => attempts.push(projectApplicationRecoveryAttempt(attempt)),
        onDiagnostic: (diagnostic) => diagnostics.push(projectRecoveryDiagnostic(diagnostic)),
      },
    },
  };
}

function stageSemanticRecoveryArtifactFields(evidence: StageSemanticRecoveryEvidence): {
  actualApplicationRecoveryAttempts: number;
  structureRecoveryDiagnostics: U1RecoveryDiagnostic[];
} {
  return {
    actualApplicationRecoveryAttempts: evidence.attempts.length,
    structureRecoveryDiagnostics: [...evidence.diagnostics],
  };
}

type FunnelScenarioRunnerOf = Parameters<typeof runAdaptive>[0]["runner"];

/**
 * A failure file is an operator diagnostic, not a second transcript.  Keep
 * just stage names and timestamps: FunnelEvent payloads can contain details
 * that are useful in a successful result but do not belong in a failure path.
 */
function redactedAdaptiveFailureEvents(events: readonly FunnelEvent[]): Array<{ at: string; type: string }> {
  return events.map((event) => ({ at: event.at, type: event.type }));
}

/** Preserve only aggregate cache counters from the last well-formed event. */
function adaptiveFailureCacheOf(events: readonly FunnelEvent[]): { hits: number; misses: number } {
  let hits = 0;
  let misses = 0;
  for (const event of events) {
    if (typeof event.cacheHits === "number" && Number.isInteger(event.cacheHits) && event.cacheHits >= 0) {
      hits = event.cacheHits;
    }
    if (typeof event.cacheMisses === "number" && Number.isInteger(event.cacheMisses) && event.cacheMisses >= 0) {
      misses = event.cacheMisses;
    }
  }
  return { hits, misses };
}

/** Re-project the strict content-free diagnostic allowlist from observed events. */
function safeStructureRecoveryDiagnosticsOf(events: readonly FunnelEvent[]): U1RecoveryDiagnostic[] {
  const safe: U1RecoveryDiagnostic[] = [];
  for (const event of events) {
    if (event.type !== "structure_recovery_diagnostic") continue;
    try {
      safe.push(projectRecoveryDiagnostic({
        subject: event.subject as U1RecoverySubject,
        attempt: event.attempt as U1RecoveryDiagnostic["attempt"],
        failureCode: event.failureCode as string,
        findingCodes: event.findingCodes as string[],
        responseLength: event.responseLength as number,
        finishReason: event.finishReason as U1RecoveryDiagnostic["finishReason"],
        responseSha256: event.responseSha256 as string,
      }));
    } catch {
      // Malformed or payload-bearing events are excluded from persisted evidence.
    }
  }
  return safe;
}

function applicationRecoveryAttemptCountOf(events: readonly FunnelEvent[]): number {
  return events.filter((event) => event.type === "application_recovery_attempt").length;
}

type DynamicEnvelopeExhaustionClassification =
  | "legitimate_workload_exceeded_estimate"
  | "contract_or_adapter_drift"
  | "persistent_candidate_loop"
  | "envelope_calculator_omission"
  | "unknown_bounded_exhaustion";

function dynamicEnvelopeExhaustionEvidenceOf(args: {
  error: unknown;
  envelope?: CallEnvelope;
  budget: RunCallBudget;
  classification?: DynamicEnvelopeExhaustionClassification;
}) {
  if (
    !(args.error instanceof ProviderBudgetError) ||
    args.error.kind !== "logical_calls" ||
    args.error.scope !== "run" ||
    !args.envelope ||
    args.budget.accounting.logicalCalls < args.envelope.authorizedLogicalCalls
  ) {
    return undefined;
  }
  return {
    status: "dynamic-envelope-exhausted" as const,
    classification: args.classification ?? "unknown_bounded_exhaustion",
    estimationVersion: args.envelope.estimationVersion,
    baselineEstimate: args.envelope.baselineEstimate,
    rawStageEstimate: args.envelope.rawStageEstimate,
    callEnvelopeMultiplier: args.envelope.callEnvelopeMultiplier,
    stagePrimaryAuthorization: args.envelope.stagePrimaryAuthorization,
    stageLoopRetryReserve: args.envelope.stageLoopRetryReserve,
    existingRecoveryReserve: args.envelope.existingRecoveryReserve,
    headroom: args.envelope.headroom,
    stageAuthorizedLogicalCalls: args.envelope.authorizedLogicalCalls,
    actualLogicalCalls: args.budget.accounting.logicalCalls,
    nextCallStarted: false as const,
    multiplierChangedDuringRun: false as const,
  };
}

/** Map handled runtime errors to a stable, payload-free failure record. */
type AdaptiveRuntimeFailure =
  | OpenAICompatibleProviderError
  | ProviderBudgetError
  | SemanticJudgeError
  | U1ScenarioEnvelopeError;

type AdaptiveFailureSource =
  | {
      kind: "runtime-error";
      error: AdaptiveRuntimeFailure;
      events: readonly FunnelEvent[];
      totalWallTimeMs?: number;
    }
  | {
      kind: "terminal-stop";
      result: AdaptiveRunResult;
    };

const ADAPTIVE_FAILURE_MESSAGES = Object.freeze({
  proposer_failure: "Adaptive stopped because every authorized proposer path failed; request and response content were not persisted.",
  safety_kill: "Adaptive stopped at its safety boundary; request and response content were not persisted.",
  budget_exhausted: "Adaptive stopped at its authorized bounded budget; no additional request was started.",
  root_rebuild: "Adaptive stopped because the current root required a separate rebuild path; no public comparison was started.",
} as const satisfies Record<AdaptiveFailureStopReason, string>);

function safeAdaptiveFailureErrorOf(
  source: AdaptiveFailureSource,
  envelope?: CallEnvelope,
): { code: string; message: string } {
  if (source.kind === "terminal-stop") {
    if (!isAdaptiveFailureStopReason(source.result.stopReason)) {
      return {
        code: "ADAPTIVE_STOP_DISPOSITION_INVALID",
        message: "A comparison-capable Adaptive stop was incorrectly routed to the failure writer.",
      };
    }
    return {
      code: adaptiveFailureCodeOf(source.result.stopReason),
      message: ADAPTIVE_FAILURE_MESSAGES[source.result.stopReason],
    };
  }
  const error = source.error;
  if (error instanceof U1ScenarioEnvelopeError) {
    return {
      code: error.code,
      message: "A candidate-item exhausted both authorized scenario attempts; no request or response content was persisted.",
    };
  }
  if (error instanceof SemanticJudgeError) {
    return {
      code: error.code,
      message: `Semantic scoring failed with ${error.code}; request and response content were not persisted.`,
    };
  }
  if (error instanceof OpenAICompatibleProviderError) {
    return {
      code: error.code,
      message: `Live provider request failed with ${error.code}; request and response content were not persisted.`,
    };
  }
  if (error instanceof ProviderBudgetError) {
    if (error.kind === "logical_calls" && error.scope === "run" && envelope) {
      return {
        code: "DYNAMIC_ENVELOPE_EXHAUSTED",
        message: "The current-U1 dynamic logical-call envelope H was reached; no additional request was started and the multiplier was not changed.",
      };
    }
    return {
      code: "PROVIDER_BUDGET_EXCEEDED",
      message: "The authorized provider-call budget was reached; no additional request was started.",
    };
  }
  return {
    code: "UNKNOWN_ERROR",
    message: "The current bounded run failed; request and response content were not persisted.",
  };
}

function safeScenarioEnvelopeExhaustionOf(error: unknown) {
  if (!(error instanceof U1ScenarioEnvelopeError)) return undefined;
  const applicationRecovery = ApplicationRecoverySafeEvidenceSchema.parse(error.safeEvidence);
  return {
    code: error.code,
    classification: error.safeEvidence.classification,
    role: error.role,
    itemId: error.itemId,
    skillSha256: error.skillSha256,
    applicationRecovery,
    thirdAttemptAllowed: false as const,
    requestOrResponseContentPersisted: false as const,
  };
}

/** Copy only the fixed semantic identity diagnostics allowlist into persisted failures. */
function safeSemanticDiagnosticsOf(error: unknown): SemanticJudgeSafeDiagnostics | undefined {
  if (!(error instanceof SemanticJudgeError) || !error.safeDiagnostics) return undefined;
  const diagnostics = error.safeDiagnostics;
  return {
    entity: diagnostics.entity,
    mismatch: diagnostics.mismatch,
    expectedCount: diagnostics.expectedCount,
    actualCount: diagnostics.actualCount,
    ...(diagnostics.itemId !== undefined ? { itemId: diagnostics.itemId } : {}),
  };
}

function hasCurrentSemanticResponseBinding(value: unknown): value is Record<string, unknown> & {
  semanticResponseBindingVersion: typeof SEMANTIC_RESPONSE_BINDING_VERSION;
} {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).semanticResponseBindingVersion === SEMANTIC_RESPONSE_BINDING_VERSION;
}

/** Persist the final observable state when a live adaptive run cannot finish. */
export async function writeAdaptiveFailureArtifact(args: {
  outDir: string;
  source: AdaptiveFailureSource;
  liveRun: ReturnType<typeof liveRunMetaOf>;
  budget: RunCallBudget;
  evidence: U1BLiveEvidencePreflightResult;
  adaptiveBudget: AdaptiveClosureBudgetPlan;
  callEnvelope: CallEnvelope;
  scoringIdentity: ReturnType<typeof scoringIdentityOfContract>;
}): Promise<void> {
  await mkdir(args.outDir, { recursive: true });
  const terminalResult = args.source.kind === "terminal-stop" ? args.source.result : undefined;
  const events = args.source.kind === "terminal-stop" ? args.source.result.events : args.source.events;
  const structureRecoveryDiagnostics = terminalResult?.structureRecoveryDiagnostics
    ?? safeStructureRecoveryDiagnosticsOf(events);
  const actualApplicationRecoveryAttempts = terminalResult?.actualApplicationRecoveryAttempts
    ?? applicationRecoveryAttemptCountOf(events);
  const runtimeError = args.source.kind === "runtime-error" ? args.source.error : undefined;
  const scenarioEnvelopeExhaustion = safeScenarioEnvelopeExhaustionOf(runtimeError);
  const totalWallTimeMs = terminalResult?.totalWallTimeMs
    ?? (args.source.kind === "runtime-error" ? args.source.totalWallTimeMs : undefined);
  const artifact = AdaptiveFailureArtifactSchema.parse(
    {
      schemaVersion: 1,
      semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
      createdAt: new Date().toISOString(),
      status: "failed",
      phase: "adaptive-run",
      contractSha256: args.scoringIdentity.contractSha256,
      ...(terminalResult && isAdaptiveFailureStopReason(terminalResult.stopReason)
        ? { stopReason: terminalResult.stopReason }
        : {}),
      safeError: safeAdaptiveFailureErrorOf(args.source, args.callEnvelope),
      safeDiagnostics: safeSemanticDiagnosticsOf(runtimeError),
      ...(scenarioEnvelopeExhaustion ? { scenarioEnvelopeExhaustion } : {}),
      events: redactedAdaptiveFailureEvents(events),
      cache: adaptiveFailureCacheOf(events),
      actualApplicationRecoveryAttempts,
      structureRecoveryDiagnostics,
      accounting: { ...args.budget.accounting },
      tokenTelemetry: args.budget.tokenTelemetry(),
      providerTokenTelemetry: providerTokenTelemetryEvidenceOf(args.budget),
      adaptiveBudget: args.adaptiveBudget,
      ...(dynamicEnvelopeExhaustionEvidenceOf({
        error: runtimeError,
        envelope: args.callEnvelope,
        budget: args.budget,
      })
        ? {
            dynamicEnvelopeExhaustion: dynamicEnvelopeExhaustionEvidenceOf({
              error: runtimeError,
              envelope: args.callEnvelope,
              budget: args.budget,
            }),
          }
        : {}),
      ...(totalWallTimeMs === undefined ? {} : { totalWallTimeMs }),
      scoringIdentity: args.scoringIdentity,
      liveRun: args.liveRun,
      evidence: args.evidence,
      ...derivedEvidenceFlagsOf(args.evidence),
      holdout: "sealed",
      release: "withheld (noRelease=true)",
    },
  );
  await writeFile(
    join(args.outDir, "adaptive-failure.json"),
    JSON.stringify(artifact, null, 2) + "\n",
    "utf8",
  );
}

/** Route a structured Adaptive stop before any success-only parsing or downstream stage. */
export async function persistAdaptiveFailureStop(args: {
  outDir: string;
  result: AdaptiveRunResult;
  liveRun: ReturnType<typeof liveRunMetaOf>;
  budget: RunCallBudget;
  evidence: U1BLiveEvidencePreflightResult;
  adaptiveBudget: AdaptiveClosureBudgetPlan;
  callEnvelope: CallEnvelope;
  scoringIdentity: ReturnType<typeof scoringIdentityOfContract>;
}): Promise<boolean> {
  if (!isAdaptiveFailureStopReason(args.result.stopReason)) return false;
  await writeAdaptiveFailureArtifact({
    outDir: args.outDir,
    source: { kind: "terminal-stop", result: args.result },
    liveRun: args.liveRun,
    budget: args.budget,
    evidence: args.evidence,
    adaptiveBudget: args.adaptiveBudget,
    callEnvelope: args.callEnvelope,
    scoringIdentity: args.scoringIdentity,
  });
  return true;
}

function terminalShortlistOf(
  inputs: RealEvolutionInputs,
  result: Awaited<ReturnType<typeof runAdaptive>>,
): TerminalPublicSelectCandidate[] {
  if (!inputs.s0ReferenceSkillMd) {
    intakeFail(2, "ADAPTIVE_RUN_S0_REFERENCE_MISSING: terminal selection requires the frozen S0 generation-zero root");
  }
  const shortlist: TerminalPublicSelectCandidate[] = [
    { candidateId: "b0-reference", rootKind: "b0", skillMd: inputs.b0ReferenceSkillMd },
    { candidateId: "s0-reference", rootKind: "s0", skillMd: inputs.s0ReferenceSkillMd },
  ];
  const evolvedIds = [result.finalElite?.candidateId, result.population.diversityId]
    .filter((candidateId): candidateId is string => candidateId !== null && candidateId !== undefined);
  for (const candidateId of evolvedIds) {
    const candidate = result.candidates.find((entry) => entry.candidateId === candidateId);
    if (!candidate || candidate.generation < 1 || candidate.evaluation?.outcome === "killed") continue;
    if (shortlist.some((entry) => entry.candidateId === candidate.candidateId)) continue;
    shortlist.push({ candidateId: candidate.candidateId, rootKind: "evolved", skillMd: candidate.skillMd });
  }
  return shortlist.slice(0, 4);
}

async function writePublicSelectionFailureArtifact(args: {
  outDir: string;
  error: unknown;
  budget: RunCallBudget;
  envelope: CurrentStageBudgetEnvelope;
  evidence: U1BLiveEvidencePreflightResult;
  adaptiveResultSha256: string;
  contractSha256: string;
  selectItemsSha256: string;
  provider: {
    model: string;
    evaluatorConfigFingerprint: string;
    semanticJudgeConfigFingerprint: string;
  };
  semanticRecovery: StageSemanticRecoveryEvidence;
}): Promise<void> {
  const dynamicEnvelopeExhaustion = dynamicEnvelopeExhaustionEvidenceOf({
    error: args.error,
    envelope: args.envelope.plan.envelope.publicSelect,
    budget: args.budget,
  });
  const code =
    dynamicEnvelopeExhaustion
      ? "DYNAMIC_ENVELOPE_EXHAUSTED"
      : args.error instanceof U1ScenarioEnvelopeError
      ? args.error.code
      : args.error instanceof PublicSelectionError || args.error instanceof SemanticJudgeError
      ? args.error.code
      : args.error instanceof ProviderBudgetError
        ? "PROVIDER_BUDGET_EXCEEDED"
        : args.error instanceof OpenAICompatibleProviderError
          ? args.error.code
          : "PUBLIC_SELECTION_FAILED";
  const artifact = PublicSelectionFailureArtifactSchema.parse({
      schemaVersion: 1,
      semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
      createdAt: new Date().toISOString(),
      status: "failed",
      phase: "public-select",
      adaptiveResultSha256: args.adaptiveResultSha256,
      contractSha256: args.contractSha256,
      selectItemsSha256: args.selectItemsSha256,
      safeError: { code, message: "Terminal public selection failed; request and response content were not persisted." },
      safeDiagnostics: args.error instanceof PublicSelectionError
        ? args.error.safeDiagnostics
        : safeSemanticDiagnosticsOf(args.error),
      ...(safeScenarioEnvelopeExhaustionOf(args.error)
        ? { scenarioEnvelopeExhaustion: safeScenarioEnvelopeExhaustionOf(args.error) }
        : {}),
      ...(dynamicEnvelopeExhaustion ? { dynamicEnvelopeExhaustion } : {}),
      budget: {
        minimum: stageBaselineEstimate(args.envelope.plan, "publicSelect"),
        authorized: args.envelope.authorized.publicSelect,
        assumptions: args.envelope.plan.assumptions,
        envelope: args.envelope.plan.envelope.publicSelect,
      },
      accounting: { ...args.budget.accounting },
      tokenTelemetry: args.budget.tokenTelemetry(),
      providerTokenTelemetry: providerTokenTelemetryEvidenceOf(args.budget),
      ...stageSemanticRecoveryArtifactFields(args.semanticRecovery),
      provider: {
        name: "deepseek",
        model: args.provider.model,
        evaluatorConfigFingerprint: args.provider.evaluatorConfigFingerprint,
        semanticJudgeConfigFingerprint: args.provider.semanticJudgeConfigFingerprint,
      },
      holdout: "sealed",
      release: "withheld (noRelease=true)",
      feedbackToEvolution: false,
      ...derivedEvidenceFlagsOf(args.evidence),
  });
  await writeFile(
    join(args.outDir, "public-selection-failure.json"),
    JSON.stringify(artifact, null, 2) + "\n",
    "utf8",
  );
}

interface PublicSelectionStageResult {
  terminalSelection: Awaited<ReturnType<typeof runTerminalPublicSelection>>;
}

/**
 * One terminal, feedback-free public-select stage shared by a fresh Adaptive
 * completion and a hash-bound resume. It never owns a proposer or an Adaptive
 * budget and persists only a sanitized sibling artifact.
 */
async function runAndPersistPublicSelectionStage(args: {
  dir: string;
  outDir: string;
  inputs: RealEvolutionInputs;
  adaptiveResult: AdaptiveRunResult;
  adaptiveResultSha256: string;
  stageBudgetEnvelope: CurrentStageBudgetEnvelope;
  live: LiveRunPolicy;
  maxInFlight: number;
  mode: "public-select-only" | "terminal-after-adaptive";
}): Promise<PublicSelectionStageResult> {
  const selectItems = await loadTerminalPublicSelectItems({
    dir: args.dir,
    contract: args.inputs.contract,
    command: "ADAPTIVE_RUN",
  });
  const publicSelectScoringIdentity = scoringIdentityOfContract({
    contract: args.inputs.contract,
    items: selectItems,
  });
  assertSameScoringIdentity(
    publicSelectScoringIdentity,
    args.adaptiveResult.scoringIdentity,
    "Adaptive to public-select",
  );
  const shortlist = terminalShortlistOf(args.inputs, args.adaptiveResult);
  const uniqueShortlistCandidates = new Set(shortlist.map((candidate) => sha256Hex(candidate.skillMd))).size;
  const actualPlan = calculateStageBudgets({
    ...args.stageBudgetEnvelope.plan.assumptions,
    shortlistCandidates: uniqueShortlistCandidates,
  });
  const actualEnvelope: CurrentStageBudgetEnvelope = {
    plan: actualPlan,
    authorized: {
      ...args.stageBudgetEnvelope.authorized,
      publicSelect: actualPlan.publicSelect,
    },
  };
  assertStageBudgetsFunded(actualPlan, actualEnvelope.authorized);
  const selectionLive: LiveRunPolicy = {
    ...args.live,
    maxLogicalCalls: actualEnvelope.authorized.publicSelect,
    u1CallEnvelope: actualPlan.envelope.publicSelect,
  };
  const selectionChain = await buildLiveEvolutionChain(selectionLive, "public-select");
  selectionChain.evaluator.setStage("public-select");
  selectionChain.semanticJudge.setStage("public-select");
  const frozenSelectHash = args.inputs.contract.selectItemsSha256;
  // Keep the context-capable provider intact so the semantic judge can bind
  // primary and schema-repair application attempt identities itself.
  const semanticProvider = selectionChain.semanticJudge;
  const semanticRecovery = createStageSemanticRecoveryEvidence({ kind: "stage", stage: "public-select" });
  console.log(
    `[SkillFoo 进度] public-select 已启动 · shortlist ${uniqueShortlistCandidates} unique · select ${selectItems.length} · logical 0/${selectionLive.maxLogicalCalls}`,
  );
  const selectionStartedAt = Date.now();
  const selectionHeartbeat = setInterval(() => {
    const accounting = selectionChain.budget.accounting;
    const cache = selectionChain.evaluator.cacheStats();
    console.log(
      `[SkillFoo 仍在运行] ${Math.floor((Date.now() - selectionStartedAt) / 1000)}s · public-select · cache ${cache.hits} hit/${cache.misses} miss · logical ${accounting.logicalCalls}/${selectionLive.maxLogicalCalls}, HTTP ${accounting.httpAttempts}, retry ${accounting.retryAttempts}/${selectionLive.maxRetryAttempts}`,
    );
  }, 15_000);

  let terminalSelection: Awaited<ReturnType<typeof runTerminalPublicSelection>>;
  try {
    terminalSelection = await runTerminalPublicSelection({
      contract: args.inputs.contract,
      selectItems,
      candidates: shortlist,
      runner: realEvolutionRunner(
        selectionChain.evaluator,
        args.inputs.runtimeFactory,
        "public-select",
        actualPlan.envelope.publicSelect.scenarioAuthorization,
      ),
      scoreRuns: livePublicSemanticScorer(semanticProvider),
      semanticRecovery: semanticRecovery.context,
      maxInFlight: args.maxInFlight,
    });
  } catch (error) {
    await writePublicSelectionFailureArtifact({
      outDir: args.outDir,
      error,
      budget: selectionChain.budget,
      envelope: actualEnvelope,
      evidence: args.inputs.evidence,
      adaptiveResultSha256: args.adaptiveResultSha256,
      contractSha256: args.inputs.contract.contractSha256,
      selectItemsSha256: frozenSelectHash,
      provider: {
        model: selectionChain.model,
        evaluatorConfigFingerprint: selectionChain.roleFingerprints.evaluator,
        semanticJudgeConfigFingerprint: selectionChain.roleFingerprints["semantic-judge"],
      },
      semanticRecovery,
    });
    console.error(error instanceof Error ? error.message : "PUBLIC_SELECTION_FAILED");
    throw new CliExitError(1);
  } finally {
    clearInterval(selectionHeartbeat);
  }

  const resultArtifact = PublicSelectionResultArtifactSchema.parse({
    schemaVersion: args.inputs.contract.u1ContractVersion === "v2" ? 2 : 1,
    semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
    createdAt: new Date().toISOString(),
    status: "completed",
    phase: "public-select",
    adaptiveResultSha256: args.adaptiveResultSha256,
    contractSha256: args.inputs.contract.contractSha256,
    selectItemsSha256: frozenSelectHash,
    selection: sanitizeTerminalPublicSelection(terminalSelection),
    budget: {
      minimum: stageBaselineEstimate(actualPlan, "publicSelect"),
      authorized: actualEnvelope.authorized.publicSelect,
      independent: true,
      assumptions: actualPlan.assumptions,
      envelope: actualPlan.envelope.publicSelect,
    },
    accounting: { ...selectionChain.budget.accounting },
    tokenTelemetry: selectionChain.budget.tokenTelemetry(),
    providerTokenTelemetry: providerTokenTelemetryEvidenceOf(selectionChain.budget),
    ...stageSemanticRecoveryArtifactFields(semanticRecovery),
    applicationRecovery: terminalSelection.applicationRecovery,
    cache: selectionChain.evaluator.cacheStats(),
    provider: {
      name: "deepseek",
      model: selectionChain.model,
      evaluatorConfigFingerprint: selectionChain.roleFingerprints.evaluator,
      semanticJudgeConfigFingerprint: selectionChain.roleFingerprints["semantic-judge"],
    },
    resumeEvidence: {
      mode: args.mode,
      adaptiveCalls: 0,
      adaptiveArtifactPreserved: true,
    },
    independentStageBudgets: {
      calculated: actualPlan,
      authorized: actualEnvelope.authorized,
    },
    ...derivedEvidenceFlagsOf(args.inputs.evidence),
    feedbackToEvolution: false,
    holdout: "sealed",
    release: "withheld (noRelease=true)",
  });
  await mkdir(args.outDir, { recursive: true });
  await writeFile(
    join(args.outDir, "public-selection-result.json"),
    `${JSON.stringify(resultArtifact, null, 2)}\n`,
    "utf8",
  );
  await rm(join(args.outDir, "public-selection-failure.json"), { force: true });
  return { terminalSelection };
}

async function cmdCalibrationRun(opts: CalibrationRunOptions): Promise<void> {
  if (!opts.dir) {
    intakeFail(2, "CALIBRATION_RUN_DIR_REQUIRED: provide --dir <dir> holding the current frozen evidence");
  }
  const requestedDir = resolve(process.cwd(), opts.dir);
  if (!(await dirExists(requestedDir))) {
    intakeFail(2, `CALIBRATION_RUN_DIR_MISSING: ${requestedDir} does not exist`);
  }
  let formal;
  try {
    formal = await resolvePublicFormalLiveDirectory(requestedDir);
  } catch (error) {
    if (error instanceof FormalEvaluationApprovalError) intakeFail(2, error.message);
    throw error;
  }
  if ("status" in formal) {
    printFormalWaiting(formal);
    return;
  }
  const dir = formal.formalDir;
  const providerName = (opts.provider ?? "").trim().toLowerCase();
  if (providerName !== "deepseek") {
    intakeFail(2, "CALIBRATION_RUN_LIVE_ONLY: calibration-run authorizes the real DeepSeek evaluator only");
  }
  const calibrationBudget = calculateCalibrationBudget();
  const currentU1ContractProbe = await loadCurrentU1ContractProbe(dir, "CALIBRATION_RUN");
  if (!currentU1ContractProbe) {
    intakeFail(2, "CALIBRATION_RUN_CURRENT_FORMAL_CONTRACT_REQUIRED: calibration-run accepts only the current human-confirmed U1 contract");
  }
  const live = parseLivePolicyOrFail(
    opts,
    providerName,
    { authorizedLogicalCalls: calibrationBudget.authorizedLogicalCalls },
  );
  if (
    live.maxLogicalCalls !== calibrationBudget.authorizedLogicalCalls ||
    live.maxRetryAttempts !== calibrationBudget.transportRetries
  ) {
    intakeFail(
      2,
      "CALIBRATION_RUN_BUDGET_INVALID: calibration authorizes 2 primary passes plus at most 2 schema-repair calls and 0 transport retries",
    );
  }
  const mode = (opts.mode ?? "standard").trim().toLowerCase();
  if (mode !== "standard") {
    intakeFail(2, `CALIBRATION_RUN_MODE_INVALID: current U1 calibration requires standard, got ${opts.mode}`);
  }
  const frozen = await loadFrozenExecutionEvidence({
    dir,
    command: "CALIBRATION_RUN",
    noRelease: opts.release === false,
  });
  if (!frozen.draft || !frozen.contract.calibrationTripletSha256) {
    intakeFail(
      2,
      "CALIBRATION_RUN_CALIBRATION_TRIPLET_MISSING: the current frozen draft and contract must bind a calibration triplet",
    );
  }
  const confirmationMode = frozen.evidence.confirmationMode;
  if (confirmationMode !== "human") {
    intakeFail(2, "CALIBRATION_RUN_CONFIRMATION_MODE_INVALID: public calibration requires formal human 2/2 evidence");
  }

  const frozenIdentity = await loadCurrentFrozenIdentity({
    dir,
    contract: frozen.contract,
    command: "CALIBRATION_RUN",
  });

  let config;
  try {
    config = getDeepSeekConfig();
  } catch (error) {
    if (error instanceof DeepSeekConfigError) {
      intakeFail(
        2,
        "DEEPSEEK_API_KEY_MISSING: no DEEPSEEK_API_KEY in the process environment or the V3 root .env; offline commands still work without a key",
      );
    }
    throw error;
  }
  const budget = new RunCallBudget({
    maxLogicalCalls: calibrationBudget.authorizedLogicalCalls,
    maxRetryAttempts: calibrationBudget.transportRetries,
    roleRetryReserves: { "semantic-judge": 0 },
  });
  const rawProvider = new OpenAICompatibleProvider(config, live.evaluator.requestTimeoutMs, {
    maxRetries: 0,
    budget,
    role: "semantic-judge",
    maxOutputTokens: live.evaluator.maxOutputTokens,
    thinking: thinkingModeOf("semantic-judge"),
    usageTags: { stage: "calibration" },
  });
  const fingerprint = rawProvider.configFingerprint();
  const outDir = opts.out ? resolve(process.cwd(), opts.out) : join(dir, "adaptive");
  const evidencePath = join(outDir, "calibration-evidence.json");
  const failurePath = join(outDir, "calibration-failure.json");

  if (!opts.execute) {
    console.log("=== Current U1 evaluator calibration preflight ===");
    console.log(`  Provider/model: deepseek / ${config.model}`);
    console.log(`  Configuration fingerprint: ${fingerprint}`);
    console.log(`  Confirmation mode: ${confirmationMode}`);
    for (const line of frozenIdentityPreflightLines(frozenIdentity, frozen.evidence)) console.log(line);
    console.log(`  Machine passes: ${calibrationBudget.primaryPasses}; payloads per pass: Good / Borderline / Unsafe`);
    console.log(`  Adjacent-gap threshold: ${frozen.contract.calibrationMinAdjacentGap}`);
    console.log(`  Budget: ${calibrationBudget.primaryPasses} primary calibration passes + up to ${calibrationBudget.schemaRecoveryReserve} schema-repair calls; ${calibrationBudget.authorizedLogicalCalls} authorized logical calls, ${calibrationBudget.transportRetries} transport retries, evaluator ${maxOutputTokensBehaviorOf(live.evaluator)} tokens / ${live.evaluator.requestTimeoutMs}ms`);
    console.log(MAX_OUTPUT_TOKENS_NOTE);
    console.log("  Holdout: sealed; release: withheld; side effects: zero network requests, nothing written");
    return;
  }

  await mkdir(outDir, { recursive: true });
  await archiveStageAttemptOrFail({
    evidenceDir: outDir,
    trigger: "calibration",
    expectedBinding: {
      contractSha256: frozen.contract.contractSha256,
      semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
      confirmationMode,
    },
  });
  const provider = createBudgetedProvider(rawProvider, budget, "semantic-judge");
  const recoveryEvidence = createLiveCalibrationRecoveryEvidence();
  const commonFailureEvidence = () => ({
    schemaVersion: 1,
    semanticResponseBindingVersion,
    createdAt: new Date().toISOString(),
    status: "failed",
    contractSha256: frozen.contract.contractSha256,
    calibrationTripletSha256: frozen.contract.calibrationTripletSha256,
    provider: { name: "deepseek", model: config.model, configFingerprint: fingerprint },
    confirmationMode,
    explorationOnly: frozen.evidence.explorationOnly,
    humanConfirmationBypassed: frozen.evidence.humanConfirmationBypassed,
    formalEvidence: confirmationMode === "human",
    releaseAllowed: false,
    sealedAllowed: false,
    actualApplicationRecoveryAttempts: recoveryEvidence.applicationRecoveryAttempts.length,
    applicationRecoveryAttempts: [...recoveryEvidence.applicationRecoveryAttempts],
    structureRecoveryDiagnostics: [...recoveryEvidence.structureRecoveryDiagnostics],
    accounting: { ...budget.accounting },
    tokenTelemetry: budget.tokenTelemetry(),
    providerTokenTelemetry: providerTokenTelemetryEvidenceOf(budget),
  });

  try {
    const calibration = await runTwoPassEvaluatorCalibration({
      contract: frozen.contract,
      draft: frozen.draft,
      provider,
      recoveryEvidence,
    });
    if (!calibration.result.pass) {
      await writeFile(
        failurePath,
        `${JSON.stringify({ ...commonFailureEvidence(), code: "CALIBRATION_NOT_PASSED", result: calibration.result, passes: calibration.passes }, null, 2)}\n`,
        "utf8",
      );
      console.error("CALIBRATION_NOT_PASSED: Good / Borderline / Unsafe ordering or adjacent gaps failed");
      throw new CliExitError(1);
    }
    const evidence = LiveCalibrationEvidenceSchema.parse({
      schemaVersion: 1,
      semanticResponseBindingVersion: calibration.semanticResponseBindingVersion,
      createdAt: new Date().toISOString(),
      status: "passed",
      contractSha256: frozen.contract.contractSha256,
      calibrationTripletSha256: frozen.contract.calibrationTripletSha256,
      provider: { name: "deepseek", model: config.model, configFingerprint: fingerprint },
      confirmationMode,
      explorationOnly: frozen.evidence.explorationOnly,
      humanConfirmationBypassed: frozen.evidence.humanConfirmationBypassed,
      formalEvidence: confirmationMode === "human",
      releaseAllowed: false,
      sealedAllowed: false,
      actualApplicationRecoveryAttempts: calibration.applicationRecoveryAttempts.length,
      applicationRecoveryAttempts: calibration.applicationRecoveryAttempts,
      structureRecoveryDiagnostics: calibration.structureRecoveryDiagnostics,
      result: calibration.result,
      passes: calibration.passes,
      accounting: { ...budget.accounting },
      tokenTelemetry: budget.tokenTelemetry(),
      providerTokenTelemetry: providerTokenTelemetryEvidenceOf(budget),
    });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await rm(failurePath, { force: true });
    console.log(`Calibration scores: pass1 ${JSON.stringify(calibration.passes[0].scores)}; pass2 ${JSON.stringify(calibration.passes[1].scores)}`);
    console.log(`Accounting: ${budget.accounting.logicalCalls} logical / ${budget.accounting.httpAttempts} HTTP / ${budget.accounting.retryAttempts} retries`);
    console.log("Calibration: PASSED");
  } catch (error) {
    if (error instanceof CliExitError) throw error;
    const code = error instanceof CalibrationEvidenceError
      ? error.code
      : error instanceof SemanticJudgeError
        ? error.code
        : error instanceof OpenAICompatibleProviderError
          ? classifyProviderError(error.message)
          : error instanceof ProviderBudgetError
            ? "PROVIDER_BUDGET_ERROR"
            : "CALIBRATION_RUN_ERROR";
    await writeFile(
      failurePath,
      `${JSON.stringify({
        ...commonFailureEvidence(),
        code,
        safeDiagnostics: safeSemanticDiagnosticsOf(error),
      }, null, 2)}\n`,
      "utf8",
    );
    console.error(`${code}: evaluator calibration failed; see the desensitized failure artifact`);
    throw new CliExitError(1);
  }
}

/**
 * Authorize and preflight the current Adaptive evolution run;
 * with --execute also run it live. Both authorization gates (LiveRunPolicy +
 * AdaptivePolicy, including minRepairProgress in absolute points) are parsed
 * BEFORE any provider config is read. Without --execute the command makes
 * zero network requests and writes nothing.
 */
async function cmdAdaptiveRun(opts: AdaptiveRunOptions): Promise<void> {
  if (!opts.dir) {
    intakeFail(2, "ADAPTIVE_RUN_DIR_REQUIRED: provide --dir <dir> the adaptive run operates on");
  }
  const requestedDir = resolve(process.cwd(), opts.dir);
  if (!(await dirExists(requestedDir))) {
    intakeFail(2, `ADAPTIVE_RUN_DIR_MISSING: ${requestedDir} does not exist`);
  }
  let formal;
  try {
    formal = await resolvePublicFormalLiveDirectory(requestedDir);
  } catch (error) {
    if (error instanceof FormalEvaluationApprovalError) intakeFail(2, error.message);
    throw error;
  }
  if ("status" in formal) {
    printFormalWaiting(formal);
    return;
  }
  const dir = formal.formalDir;
  if (opts.resumePublicSelect !== undefined && !/^[a-f0-9]{64}$/.test(opts.resumePublicSelect)) {
    intakeFail(2, "ADAPTIVE_RUN_RESUME_ADAPTIVE_HASH_INVALID: --resume-public-select must be the exact lowercase SHA-256 of adaptive-result.json");
  }
  const providerName = (opts.provider ?? "").trim().toLowerCase();
  if (providerName !== "deepseek") {
    intakeFail(
      2,
      "ADAPTIVE_RUN_LIVE_ONLY: adaptive-run is the real-evolution command and authorizes the live deepseek path only (use preflight for the zero-network check)",
    );
  }

  const currentU1ContractProbe = await loadCurrentU1ContractProbe(dir, "ADAPTIVE_RUN");
  if (!currentU1ContractProbe) {
    intakeFail(2, "ADAPTIVE_RUN_CURRENT_FORMAL_CONTRACT_REQUIRED: adaptive-run accepts only the current human-confirmed U1 contract");
  }
  const currentU1AdaptiveEnvelope = calculateCurrentU1AdaptiveEnvelope({
    contract: currentU1ContractProbe,
    opts,
    command: "ADAPTIVE_RUN",
  });
  const live = parseLivePolicyOrFail(
    opts,
    providerName,
    {
      authorizedLogicalCalls: currentU1AdaptiveEnvelope.envelope.authorizedLogicalCalls,
      callEnvelope: currentU1AdaptiveEnvelope.envelope,
    },
  );
  const maxInFlight = parseAdaptiveMaxInFlight(opts.maxInFlight);

  const policyInput: AdaptivePolicyParams = {
    formalHumanU1B: true,
    maxGenerations: opts.maxGenerations ?? 2,
    maxRefinementsPerCandidate: opts.maxRefinements ?? 2,
    minRepairProgress: opts.minRepairProgress ?? 2,
    stagnationPatience: opts.stagnationPatience ?? 1,
    mode: (opts.mode ?? "standard") as AdaptivePolicyParams["mode"],
    earlyRepair: (opts.earlyRepair ?? "auto") as AdaptivePolicyParams["earlyRepair"],
    u1CallEnvelope: currentU1AdaptiveEnvelope.envelope,
    maxRetryAttempts: live.maxRetryAttempts,
    requestTimeoutMs: live.proposer.requestTimeoutMs,
    maxOutputTokens: live.proposer.maxOutputTokens,
  };
  let policy: AdaptivePolicy;
  try {
    policy = parseAdaptivePolicy(policyInput);
  } catch (e) {
    if (e instanceof AdaptivePolicyError) {
      intakeFail(2, e.message);
    }
    throw e;
  }

  const outDir = opts.out ? resolve(process.cwd(), opts.out) : join(dir, "adaptive");
  if (opts.resumePublicSelect !== undefined) {
    const adaptiveResultPath = join(outDir, "adaptive-result.json");
    if (!(await pathExists(adaptiveResultPath))) {
      intakeFail(2, `ADAPTIVE_RUN_RESUME_ADAPTIVE_RESULT_MISSING: no Adaptive evidence at ${adaptiveResultPath}`);
    }
  }

  const frozen = await loadFrozenExecutionEvidence({
    dir,
    command: "ADAPTIVE_RUN",
    noRelease: opts.release === false,
  });
  const preflightEvidence = frozen.evidence;
  const frozenContract = frozen.contract;
  const stageBudgetEnvelope = await loadCurrentStageBudgetEnvelope({
    dir,
    contract: frozenContract,
    opts,
    command: "ADAPTIVE_RUN",
  });
  const frozenIdentity = await loadCurrentFrozenIdentity({
    dir,
    contract: frozenContract,
    command: "ADAPTIVE_RUN",
  });
  await assertSkillMatchesFrozenB0({
    skillMd: opts.skillMd,
    identity: frozenIdentity,
    command: "ADAPTIVE_RUN",
  });
  const realEvolutionInputs = await loadRealEvolutionInputs({
    dir,
    skillMd: opts.skillMd,
    command: "ADAPTIVE_RUN",
    noRelease: opts.release === false,
    runtimeContext: opts.runtimeContext,
  });
  const preflightRuntimeFactory = realEvolutionInputs.runtimeFactory;

  // Authorization and policy are settled; only now may config be read.
  let model = "";
  let baseUrl = "";
  let deepSeekConfig: ReturnType<typeof getDeepSeekConfig>;
  try {
    deepSeekConfig = getDeepSeekConfig();
    model = deepSeekConfig.model;
    baseUrl = deepSeekConfig.baseUrl;
  } catch (e) {
    if (e instanceof DeepSeekConfigError) {
      intakeFail(
        2,
        "DEEPSEEK_API_KEY_MISSING: no DEEPSEEK_API_KEY in the process environment or the V3 root .env; copy .env.example to .env — offline commands still work without a key",
      );
    }
    throw e;
  }

  if (!opts.execute) {
    console.log("=== Adaptive-run authorization preflight (V3.2) ===");
    console.log(`  Mode: \`live\` (adaptive ${policy.mode}, explorationOnly=${policy.explorationOnly})`);
    console.log(`  Provider: ${providerName}`);
    console.log(`  Model: ${model}`);
    console.log(`  Base URL: ${baseUrl}`);
    console.log("  API key configured: yes (the value is never printed)");
    console.log(`  Project dir: ${dir}`);
    console.log(
      `  Evidence: ${preflightEvidence.track} (confirmationMode=${preflightEvidence.confirmationMode}, humanConfirmationBypassed=${preflightEvidence.humanConfirmationBypassed})`,
    );
    console.log(
      `  Adaptive policy: generations <= ${policy.maxGenerations}, refinements/candidate <= ${policy.maxRefinementsPerCandidate}, minRepairProgress ${policy.minRepairProgress} points, stagnationPatience ${policy.stagnationPatience}, earlyRepair ${policy.earlyRepair}`,
    );
    console.log(
      `  Formal human U1 minimum real child generations: ${policy.minChildGenerations} (standard mode)`,
    );
    console.log(
      "  Adaptive bounded structure recovery: enabled; at most one content-free repair per mutation request or three-item semantic batch; no third attempt",
    );
    for (const line of frozenIdentityPreflightLines(frozenIdentity, preflightEvidence)) console.log(line);
    for (const line of adaptiveEnvelopePreflightLines(currentU1AdaptiveEnvelope, live.maxRetryAttempts)) {
      console.log(line);
    }
    console.log(`  Max in-flight provider calls: ${maxInFlight} (local scheduler cap; provider-agnostic)`);
    console.log(
      `  Authorized budget: logical calls <= ${live.maxLogicalCalls}, retries <= ${live.maxRetryAttempts}, per-request timeout evaluator ${live.evaluator.requestTimeoutMs}ms / proposer ${live.proposer.requestTimeoutMs}ms, max output tokens evaluator ${maxOutputTokensBehaviorOf(live.evaluator)} / proposer ${maxOutputTokensBehaviorOf(live.proposer)}`,
    );
    for (const line of roleOutputPreflightLines(live)) console.log(line);
    console.log(
      `  Max HTTP attempts: <= ${maxHttpAttemptsOf(live)} (logical calls ${live.maxLogicalCalls} + run-wide retries ${live.maxRetryAttempts})`,
    );
    console.log(MAX_OUTPUT_TOKENS_NOTE);
    if (stageBudgetEnvelope) {
      for (const line of stageBudgetPreflightLines(stageBudgetEnvelope, live.maxRetryAttempts)) console.log(line);
    }
    for (const line of runtimeContextPreflightLines(preflightRuntimeFactory)) console.log(line);
    console.log(
      `  U1 intake: ${realEvolutionInputs.u1Intake.lane} (track ${realEvolutionInputs.u1Intake.track}) — ${realEvolutionInputs.u1Intake.reportingNote}`,
    );
    console.log("  Network: allowed for the authorized model chat only; reference-v1 tools remain zero-network and read-only");
    console.log("  Release: withheld (noRelease=true)");
    console.log("  Holdout: sealed — adaptive evolution never enters the release holdout");
    if (opts.resumePublicSelect) {
      console.log(`  Resume: terminal public-select only, pinned Adaptive SHA-256 ${opts.resumePublicSelect}; Adaptive/mutation/repair calls remain zero`);
    }
    console.log("  Machine calibration: two primary evaluator passes, each with at most one schema repair, are required before --execute; no human confirmation is simulated");
    console.log("  Evolution runner: wired (runAdaptive, T18); re-run with --execute to spend the authorized budget");
    console.log("  Side effects: none — zero network requests, nothing written");
    return;
  }

  {
    if (!frozenContract.calibrationTripletSha256) {
      intakeFail(
        2,
        "ADAPTIVE_RUN_CALIBRATION_TRIPLET_MISSING: the current frozen contract does not bind a calibration triplet",
      );
    }
    const confirmationMode = preflightEvidence?.confirmationMode;
    if (confirmationMode !== "human") {
      intakeFail(2, "ADAPTIVE_RUN_CALIBRATION_CONFIRMATION_MODE_INVALID: public live calibration requires formal human 2/2 evidence");
    }
    const calibrationPath = join(outDir, "calibration-evidence.json");
    if (!(await pathExists(calibrationPath))) {
      intakeFail(
        2,
        `ADAPTIVE_RUN_CALIBRATION_EVIDENCE_MISSING: run calibration-run --execute first; no passed evidence at ${calibrationPath}`,
      );
    }
    const fingerprintProbe = new OpenAICompatibleProvider(deepSeekConfig, live.evaluator.requestTimeoutMs, {
      maxRetries: 0,
      role: "semantic-judge",
      maxOutputTokens: live.evaluator.maxOutputTokens,
      thinking: thinkingModeOf("semantic-judge"),
    });
    try {
      assertCalibrationEvidenceForAdaptive(
        readIntakeJson(await readFile(calibrationPath, "utf8"), `calibration evidence at ${calibrationPath}`),
        {
          contractSha256: frozenContract.contractSha256,
          calibrationTripletSha256: frozenContract.calibrationTripletSha256,
          model,
          configFingerprint: fingerprintProbe.configFingerprint(),
          confirmationMode,
        },
      );
    } catch (error) {
      if (error instanceof CalibrationEvidenceError) {
        intakeFail(2, `ADAPTIVE_RUN_${error.code}: ${error.message}`);
      }
      throw error;
    }
    console.log(`  Machine calibration: passed and bound (${calibrationPath})`);
  }

  const inputs = realEvolutionInputs;
  if (inputs.contract.selectItemIds && (!stageBudgetEnvelope || !inputs.s0ReferenceSkillMd)) {
    intakeFail(
      2,
      !stageBudgetEnvelope
        ? "ADAPTIVE_RUN_INDEPENDENT_STAGE_BUDGETS_REQUIRED: current frozen execution has no funded stage envelope"
        : "ADAPTIVE_RUN_S0_REFERENCE_MISSING: current frozen execution requires its generation-zero S0 root before any model call",
    );
  }
  if (opts.resumePublicSelect !== undefined) {
    if (!stageBudgetEnvelope || !inputs.contract.selectItemIds || !inputs.s0ReferenceSkillMd) {
      intakeFail(2, "ADAPTIVE_RUN_RESUME_CURRENT_REQUIRED: public-select resume requires a complete current stage envelope and B0/S0 roots");
    }
    const adaptiveResultPath = join(outDir, "adaptive-result.json");
    const adaptiveRaw = await readFile(adaptiveResultPath, "utf8");
    const currentEvaluatorFingerprint = new OpenAICompatibleProvider(
      deepSeekConfig,
      live.evaluator.requestTimeoutMs,
      {
        maxRetries: 0,
        role: "evaluator",
        maxOutputTokens: live.evaluator.maxOutputTokens,
        thinking: thinkingModeOf("evaluator"),
      },
    ).configFingerprint();
    let resumed: ReturnType<typeof validateAdaptiveResultForPublicSelectResume>;
    try {
      resumed = validateAdaptiveResultForPublicSelectResume(adaptiveRaw, {
        expectedAdaptiveResultSha256: opts.resumePublicSelect,
        contractSha256: inputs.contract.contractSha256,
        currentTrainItemIds: inputs.publicItems.map((item) => item.itemId),
        currentTrainItems: inputs.publicItems,
        b0SkillMd: inputs.b0ReferenceSkillMd,
        s0SkillMd: inputs.s0ReferenceSkillMd,
        publicContract: inputs.publicContract,
        confirmationMode: "human",
        providerModel: model,
        acceptedEvaluatorConfigFingerprints: [currentEvaluatorFingerprint],
        expectedU1Intake: inputs.u1Intake,
      });
    } catch (error) {
      if (error instanceof PublicSelectionResumeError) {
        intakeFail(2, `ADAPTIVE_RUN_${error.code}: ${error.message}`);
      }
      throw error;
    }
    const resumeSelectItems = await loadTerminalPublicSelectItems({
      dir,
      contract: inputs.contract,
      command: "ADAPTIVE_RUN",
    });
    const resumeScoringIdentity = scoringIdentityOfContract({
      contract: inputs.contract,
      items: resumeSelectItems,
    });
    assertSameScoringIdentity(
      resumeScoringIdentity,
      resumed.result.scoringIdentity,
      "Adaptive public-select resume",
    );

    const selectionResultPath = join(outDir, "public-selection-result.json");
    if (await pathExists(selectionResultPath)) {
      const existingRaw = readIntakeJson(
        await readFile(selectionResultPath, "utf8"),
        `public-selection result at ${selectionResultPath}`,
      );
      if (!hasCurrentSemanticResponseBinding(existingRaw)) {
        intakeFail(
          2,
          `ADAPTIVE_RUN_RESUME_PUBLIC_SELECTION_SEMANTIC_BINDING_DRIFT: terminal result must use ${SEMANTIC_RESPONSE_BINDING_VERSION}`,
        );
      }
      const existing = PublicSelectionResultArtifactSchema.safeParse(existingRaw);
      const expectedSelectHash = inputs.contract.selectItemsSha256;
      if (
        !existing.success ||
        existing.data.adaptiveResultSha256 !== resumed.adaptiveResultSha256 ||
        existing.data.contractSha256 !== inputs.contract.contractSha256 ||
        (expectedSelectHash !== undefined && existing.data.selectItemsSha256 !== expectedSelectHash)
      ) {
        intakeFail(2, "ADAPTIVE_RUN_RESUME_PUBLIC_SELECTION_RESULT_DRIFT: an existing terminal result is invalid or bound to different frozen evidence");
      }
      assertSameScoringIdentity(
        resumeScoringIdentity,
        existing.data.selection.scoringIdentity,
        "existing public-select result",
      );
      console.log("=== Adaptive public-select resume (already complete) ===");
      console.log(`  Adaptive SHA-256: ${resumed.adaptiveResultSha256}`);
      console.log(`  Final Public Champion: ${existing.data.selection.decision.finalPublicChampionId}`);
      console.log("  Network: zero calls; the matching terminal result was left byte-identical");
      console.log("  Holdout: sealed; release: withheld; human confirmation was not simulated");
      return;
    }

    const selectionFailurePath = join(outDir, "public-selection-failure.json");
    if (!(await pathExists(selectionFailurePath))) {
      intakeFail(2, `ADAPTIVE_RUN_RESUME_PUBLIC_SELECTION_FAILURE_MISSING: no classified failed terminal stage at ${selectionFailurePath}`);
    }
    try {
      validatePublicSelectionFailureForResume(
        await readFile(selectionFailurePath, "utf8"),
        resumed.adaptiveResultSha256,
        {
          contractSha256: inputs.contract.contractSha256,
          selectItemsSha256: inputs.contract.selectItemsSha256!,
          providerModel: model,
          confirmationMode: "human",
        },
      );
    } catch (error) {
      if (error instanceof PublicSelectionResumeError) {
        intakeFail(2, `ADAPTIVE_RUN_${error.code}: ${error.message}`);
      }
      throw error;
    }

    await archiveStageAttemptOrFail({
      evidenceDir: outDir,
      trigger: "public-select",
      expectedBinding: {
        contractSha256: inputs.contract.contractSha256,
        semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
        confirmationMode: "human",
      },
    });

    const resumedSelection = await runAndPersistPublicSelectionStage({
      dir,
      outDir,
      inputs,
      adaptiveResult: resumed.result,
      adaptiveResultSha256: resumed.adaptiveResultSha256,
      stageBudgetEnvelope,
      live,
      maxInFlight,
      mode: "public-select-only",
    });
    console.log("=== Adaptive public-select resume (V3.2, live) ===");
    console.log(`  Adaptive SHA-256 preserved: ${resumed.adaptiveResultSha256}`);
    console.log("  Adaptive/mutation/repair calls during resume: 0");
    console.log(
      `  Starting Reference: ${resumedSelection.terminalSelection.decision.startingReferenceId}; Final Public Champion: ${resumedSelection.terminalSelection.decision.finalPublicChampionId}; verdict ${resumedSelection.terminalSelection.decision.verdict}`,
    );
    console.log(`  Same-model limitation: ${resumedSelection.terminalSelection.decision.sameModelLimitation}`);
    console.log("  Holdout: sealed; release: withheld; feedback to evolution: false");
    console.log(`  Human confirmation mode: ${inputs.evidence.confirmationMode}; no model or automation was recorded as a human confirmer`);
    return;
  }
  await archiveStageAttemptOrFail({
    evidenceDir: outDir,
    trigger: "adaptive",
    expectedBinding: {
      contractSha256: inputs.contract.contractSha256,
      semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
      confirmationMode: "human",
    },
  });
  const chain = await buildLiveEvolutionChain(live, "adaptive");

  // P1 任务 4: on the rebuild track every live prompt must stay S0-descended;
  // the sanitized category lines are the only trace of the frozen B0.
  const baseMutationProposer = createLiveMutationProposer({ provider: chain.mutation });
  const mutationProposer =
    inputs.rebuildFailureCategories.length > 0
      ? {
          producer: baseMutationProposer.producer,
          proposeMutation: (context: Parameters<typeof baseMutationProposer.proposeMutation>[0]) =>
            baseMutationProposer.proposeMutation({
              ...context,
              failureClasses: [...inputs.rebuildFailureCategories, ...context.failureClasses],
            }),
        }
      : baseMutationProposer;

  const progressStartedAtMs = Date.now();
  const adaptiveScoringIdentity = scoringIdentityOfContract({
    contract: inputs.contract,
    items: inputs.publicItems,
  });
  let currentProgressStage = "正在等待根节点评测返回";
  let currentGeneration = 0;
  let currentCandidate = inputs.anchorCandidateId;
  let currentCacheHits = 0;
  let currentCacheMisses = 0;
  const observedEvents: FunnelEvent[] = [];
  const progressHeartbeat = setInterval(() => {
    printAdaptiveLiveProgress({
      startedAtMs: progressStartedAtMs,
      currentStage: currentProgressStage,
      budget: chain.budget,
      generation: currentGeneration,
      candidate: currentCandidate,
      cacheHits: currentCacheHits,
      cacheMisses: currentCacheMisses,
      heartbeat: true,
    });
  }, 15_000);
  console.log("[SkillFoo 进度] 0s · 已启动真实演化；后续将显示阶段、预算与等待心跳。\n");

  let result;
  try {
    result = await runAdaptive({
      policy,
      contract: inputs.contract,
      taskCard: inputs.taskCard,
      publicItems: inputs.publicItems,
      anchor: {
        candidateId: inputs.anchorCandidateId,
        originRoot: inputs.anchorOriginRoot,
        skillMd: inputs.anchorSkillMd,
      },
      seeds: inputs.seedSkills,
      runner: realEvolutionRunner(
        chain.evaluator,
        inputs.runtimeFactory,
        "adaptive",
        currentU1AdaptiveEnvelope.envelope.scenarioAuthorization,
      ),
      scoreRuns: livePublicSemanticScorer(chain.semanticJudge),
      mutationProposer,
      repairProposer:
        policy.maxRefinementsPerCandidate > 0 && policy.earlyRepair !== "off"
          ? createOpenAICompatibleRepairProposer({
              provider: chain.repair,
              capabilityBoundary: inputs.taskCard.capabilityBoundary,
            })
          : undefined,
      budget: chain.budget,
      maxInFlight,
      stopOnPublicGoal: true,
      onEvent: (event) => {
        observedEvents.push(event);
        currentProgressStage = adaptiveProgressStage(event.type);
        if (typeof event.generation === "number") currentGeneration = event.generation;
        if (typeof event.candidateId === "string") currentCandidate = event.candidateId;
        if (Array.isArray(event.roots) && event.roots.every((root) => typeof root === "string")) {
          currentCandidate = event.roots.join(",");
        }
        if (typeof event.cacheHits === "number") currentCacheHits = event.cacheHits;
        if (typeof event.cacheMisses === "number") currentCacheMisses = event.cacheMisses;
        printAdaptiveLiveProgress({
          event,
          startedAtMs: progressStartedAtMs,
          currentStage: currentProgressStage,
          budget: chain.budget,
          generation: currentGeneration,
          candidate: currentCandidate,
          cacheHits: currentCacheHits,
          cacheMisses: currentCacheMisses,
        });
      },
    });
  } catch (e) {
    if (
      e instanceof OpenAICompatibleProviderError ||
      e instanceof ProviderBudgetError ||
      e instanceof SemanticJudgeError ||
      e instanceof U1ScenarioEnvelopeError
    ) {
      console.error(
        e instanceof SemanticJudgeError
          ? `${e.code}: semantic scoring failed; see the desensitized failure artifact`
          : e.message,
      );
      clearInterval(progressHeartbeat);
      await writeAdaptiveFailureArtifact({
        outDir,
        source: {
          kind: "runtime-error",
          error: e,
          events: observedEvents,
          totalWallTimeMs: Date.now() - progressStartedAtMs,
        },
        liveRun: liveRunMetaOf(live, chain),
        budget: chain.budget,
        evidence: inputs.evidence,
        adaptiveBudget: currentU1AdaptiveEnvelope,
        callEnvelope: currentU1AdaptiveEnvelope.envelope,
        scoringIdentity: adaptiveScoringIdentity,
      });
      throw new CliExitError(1);
    }
    throw e;
  } finally {
    clearInterval(progressHeartbeat);
  }

  if (await persistAdaptiveFailureStop({
    outDir,
    result,
    liveRun: liveRunMetaOf(live, chain),
    budget: chain.budget,
    evidence: inputs.evidence,
    adaptiveBudget: currentU1AdaptiveEnvelope,
    callEnvelope: currentU1AdaptiveEnvelope.envelope,
    scoringIdentity: adaptiveScoringIdentity,
  })) {
    console.error("ADAPTIVE_RUN_TERMINAL_FAILURE: Adaptive stopped with a classified failure; see adaptive-failure.json");
    throw new CliExitError(1);
  }

  await mkdir(outDir, { recursive: true });
  const adaptiveBaseArtifact = parseAdaptiveResultArtifact({
    ...result,
    semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
    u1Intake: inputs.u1Intake,
    publicContract: inputs.publicContract,
    liveRun: liveRunMetaOf(live, chain),
    adaptiveBudget: currentU1AdaptiveEnvelope,
    evidence: inputs.evidence,
    ...derivedEvidenceFlagsOf(inputs.evidence),
    explorationOnly: result.explorationOnly || inputs.evidence.explorationOnly,
    scoringIdentity: adaptiveScoringIdentity,
  });
  const adaptiveBaseRaw = `${JSON.stringify(adaptiveBaseArtifact, null, 2)}\n`;
  const adaptiveResultSha256 = sha256Hex(adaptiveBaseRaw);
  await writeFile(
    join(outDir, "adaptive-result.json"),
    adaptiveBaseRaw,
    "utf8",
  );
  await writeFile(
    join(outDir, "adaptive-events.jsonl"),
    result.events.map((event) => JSON.stringify({
      ...event,
      evidence: inputs.evidence,
      ...derivedEvidenceFlagsOf(inputs.evidence),
    })).join("\n") + "\n",
    "utf8",
  );

  let terminalSelection: Awaited<ReturnType<typeof runTerminalPublicSelection>> | null = null;
  if (stageBudgetEnvelope && inputs.contract.selectItemIds) {
    const selectionStage = await runAndPersistPublicSelectionStage({
      dir,
      outDir,
      inputs,
      adaptiveResult: result,
      adaptiveResultSha256,
      stageBudgetEnvelope,
      live,
      maxInFlight,
      mode: "terminal-after-adaptive",
    });
    terminalSelection = selectionStage.terminalSelection;
  }

  console.log("=== Adaptive Run (V3.2, live) ===");
  console.log(`  Contract: ${inputs.contract.contractSha256}`);
  console.log(
    `  Evidence: ${inputs.evidence.track}${inputs.evidence.confirmationMode ? ` (${inputs.evidence.confirmationMode})` : ""}; explorationOnly=${result.explorationOnly || inputs.evidence.explorationOnly}; humanConfirmationBypassed=${inputs.evidence.humanConfirmationBypassed}`,
  );
  console.log(
    `  U1 intake: ${inputs.u1Intake.lane} (track ${inputs.u1Intake.track}) — ${inputs.u1Intake.reportingNote}`,
  );
  console.log(`  Roots: ${inputs.anchorCandidateId}${inputs.seedSkills.length > 0 ? `, ${inputs.seedSkills.map((s) => s.candidateId).join(", ")}` : ""}`);
  console.log(`  Stop reason: ${result.stopReason} — ${result.stopDetail}`);
  if (result.recoverySuggestion) {
    console.log(`  Recovery suggestion: ${result.recoverySuggestion}`);
  }
  console.log(`  Population: anchor ${result.population.anchorCandidateId}, elite ${result.population.eliteId ?? "none"}, diversity ${result.population.diversityId ?? "none"}`);
  for (const entry of result.generations) {
    console.log(
      `  generation ${entry.generation}: ${entry.route} — attempted ${entry.childrenAttempted}, generated ${entry.childrenGenerated}, rejected ${entry.childrenRejected}, screened ${entry.childrenScreened}, promoted ${entry.childrenPromoted} (${entry.wallTimeMs}ms)`,
    );
    for (const lane of entry.lanes) {
      console.log(
        `    ${lane.kind} ${lane.candidateId}: ${lane.status}/${lane.detailStatus}${lane.failureCode ? ` (${lane.failureCode}${lane.findingCodes?.length ? `; ${lane.findingCodes.join(", ")}` : ""})` : ""}`,
      );
    }
  }
  if (result.finalElite?.evaluation) {
    console.log(
      `  Final elite: ${result.finalElite.candidateId} (${result.finalElite.evaluation.publicScore} public points, ${result.finalElite.evaluation.solvedItemIds.length} solved item(s))`,
    );
  }
  if (terminalSelection) {
    console.log(
      `  Starting Reference: ${terminalSelection.decision.startingReferenceId}; Final Public Champion: ${terminalSelection.decision.finalPublicChampionId}; verdict ${terminalSelection.decision.verdict}`,
    );
    console.log(
      `  Public decision: delta ${terminalSelection.decision.scoreDelta}, critical regression ${terminalSelection.decision.criticalRegression}`,
    );
    console.log(`  Same-model limitation: ${terminalSelection.decision.sameModelLimitation}`);
  }
  console.log(
    `  Authorized budget: model ${chain.model}, max output tokens evaluator ${maxOutputTokensBehaviorOf(live.evaluator)} / proposer ${maxOutputTokensBehaviorOf(live.proposer)}, timeout evaluator ${live.evaluator.requestTimeoutMs}ms / proposer ${live.proposer.requestTimeoutMs}ms, logical <= ${live.maxLogicalCalls}, retries <= ${live.maxRetryAttempts}, HTTP ceiling <= ${maxHttpAttemptsOf(live)}`,
  );
  console.log(
    `  Accounting: ${result.accounting.logicalCalls} logical call(s), ${result.accounting.httpAttempts} HTTP attempt(s), ${result.accounting.retryAttempts} retr(y/ies)`,
  );
  console.log(
    `  Parallel timing: wall ${result.totalWallTimeMs}ms, serial-equivalent ${result.serialEquivalentMs}ms, max observed in-flight ${result.maxObservedInFlight} (cap ${maxInFlight})`,
  );
  console.log(`  Role accounting: ${roleAccountingLine(chain.budget)}`);
  const tokens = chain.budget.tokenTelemetry();
  console.log(
    `  Tokens: prompt ${tokens.promptTokens ?? "n/a"}, completion ${tokens.completionTokens ?? "n/a"} (${tokens.responses} sampled response(s))`,
  );
  console.log(`  ExplorationOnly: ${result.explorationOnly}`);
  console.log(`  Artifacts: ${outDir}`);
  console.log("  Holdout: sealed — never entered; no release was created");
}

async function cmdDirectRun(opts: DirectRunOptions): Promise<void> {
  if (!opts.dir) {
    intakeFail(2, "DIRECT_RUN_DIR_REQUIRED: provide --dir <dir> the direct run operates on");
  }
  const requestedDir = resolve(process.cwd(), opts.dir);
  if (!(await dirExists(requestedDir))) {
    intakeFail(2, `DIRECT_RUN_DIR_MISSING: ${requestedDir} does not exist`);
  }
  let formal;
  try {
    formal = await resolvePublicFormalLiveDirectory(requestedDir);
  } catch (error) {
    if (error instanceof FormalEvaluationApprovalError) intakeFail(2, error.message);
    throw error;
  }
  if ("status" in formal) {
    printFormalWaiting(formal);
    return;
  }
  const dir = formal.formalDir;
  const providerName = (opts.provider ?? "").trim().toLowerCase();
  if (providerName !== "deepseek") {
    intakeFail(
      2,
      "DIRECT_RUN_LIVE_ONLY: direct-run is the real-baseline command and authorizes the live deepseek path only",
    );
  }

  const strategy = (opts.strategy ?? "one_shot").trim().toLowerCase();
  if (strategy !== "one_shot") {
    intakeFail(2, "DIRECT_RUN_STRATEGY_INVALID: current U1 Direct requires --strategy one_shot");
  }

  const mode = (opts.mode ?? "standard").trim().toLowerCase();
  if (mode !== "standard") {
    intakeFail(2, "DIRECT_RUN_MODE_INVALID: current U1 Direct requires --mode standard");
  }
  const frozenEvidence = await loadFrozenExecutionEvidence({
    dir,
    command: "DIRECT_RUN",
    noRelease: opts.release === false,
  });
  const stageBudgetEnvelope = await loadCurrentStageBudgetEnvelope({
    dir,
    contract: frozenEvidence.contract,
    opts,
    command: "DIRECT_RUN",
  });
  const live = parseLivePolicyOrFail(
    opts,
    providerName,
    {
      authorizedLogicalCalls: stageBudgetEnvelope.authorized.direct,
      callEnvelope: stageBudgetEnvelope.plan.envelope.direct,
    },
  );
  if (opts.maxInFlight !== undefined && opts.maxInFlight !== 2) {
    intakeFail(
      2,
      `DIRECT_RUN_MAX_IN_FLIGHT_INVALID: current U1 Direct requires exactly 2 (got ${String(opts.maxInFlight)})`,
    );
  }
  const maxInFlight = parseAdaptiveMaxInFlight(opts.maxInFlight);
  const frozenIdentity = await loadCurrentFrozenIdentity({
    dir,
    contract: frozenEvidence.contract,
    command: "DIRECT_RUN",
  });
  await assertSkillMatchesFrozenB0({
    skillMd: opts.skillMd,
    identity: frozenIdentity,
    command: "DIRECT_RUN",
  });
  const realEvolutionInputs = await loadRealEvolutionInputs({
    dir,
    skillMd: opts.skillMd,
    command: "DIRECT_RUN",
    noRelease: opts.release === false,
    runtimeContext: opts.runtimeContext,
  });

  let model = "";
  let baseUrl = "";
  let deepSeekConfig: ReturnType<typeof getDeepSeekConfig>;
  try {
    deepSeekConfig = getDeepSeekConfig();
    model = deepSeekConfig.model;
    baseUrl = deepSeekConfig.baseUrl;
  } catch (e) {
    if (e instanceof DeepSeekConfigError) {
      intakeFail(
        2,
        "DEEPSEEK_API_KEY_MISSING: no DEEPSEEK_API_KEY in the process environment or the V3 root .env; copy .env.example to .env — offline commands still work without a key",
      );
    }
    throw e;
  }

  if (!opts.execute) {
    console.log("=== Direct-run authorization preflight (current U1) ===");
    console.log(`  Mode: \`live\` (direct ${strategy}, standard)`);
    console.log(`  Provider: ${providerName}`);
    console.log(`  Model: ${model}`);
    console.log(`  Base URL: ${baseUrl}`);
    console.log("  API key configured: yes (the value is never printed)");
    console.log(`  Project dir: ${dir}`);
    console.log(
      `  Evidence: ${frozenEvidence.evidence.track} (confirmationMode=${frozenEvidence.evidence.confirmationMode}, humanConfirmationBypassed=${frozenEvidence.evidence.humanConfirmationBypassed})`,
    );
    console.log(
      `  Authorized budget: logical calls <= ${live.maxLogicalCalls}, retries <= ${live.maxRetryAttempts}, per-request timeout evaluator ${live.evaluator.requestTimeoutMs}ms / proposer ${live.proposer.requestTimeoutMs}ms, max output tokens evaluator ${maxOutputTokensBehaviorOf(live.evaluator)} / proposer ${maxOutputTokensBehaviorOf(live.proposer)}`,
    );
    for (const line of roleOutputPreflightLines(live)) console.log(line);
    console.log(
      `  Max HTTP attempts: <= ${maxHttpAttemptsOf(live)} (logical calls ${live.maxLogicalCalls} + run-wide retries ${live.maxRetryAttempts})`,
    );
    console.log(MAX_OUTPUT_TOKENS_NOTE);
    for (const line of stageBudgetPreflightLines(stageBudgetEnvelope, live.maxRetryAttempts)) console.log(line);
    for (const line of runtimeContextPreflightLines(realEvolutionInputs.runtimeFactory)) console.log(line);
    console.log(
      `  U1 intake: ${realEvolutionInputs.u1Intake.lane} (track ${realEvolutionInputs.u1Intake.track}) — ${realEvolutionInputs.u1Intake.reportingNote}`,
    );
    console.log(`  Max in-flight provider calls: ${maxInFlight} (current formal path requires exactly 2)`);
    for (const line of frozenIdentityPreflightLines(frozenIdentity, frozenEvidence.evidence)) console.log(line);
    console.log("  Network: allowed for the authorized model chat only; reference-v1 tools remain zero-network and read-only");
    console.log("  Release: withheld (noRelease=true)");
    console.log("  Holdout: sealed — the direct baseline never enters the release holdout");
    console.log(`  Frozen Direct instruction SHA-256: ${sha256Hex(DIRECT_U1_FROZEN_INSTRUCTION)}`);
    console.log("  Machine calibration: two primary passes with up to two isolated schema-repair calls; no human confirmation is simulated");
    console.log("  Direct context: routed generation-zero source + goal + frozen natural-language instruction only");
    console.log(`  Direct prompt contract: ${DIRECT_U1_PROMPT_CONTRACT_VERSION}`);
    console.log(`  Direct prompt contract SHA-256: ${DIRECT_U1_PROMPT_CONTRACT_SHA256}`);
    console.log("  Baseline runner: wired (runDirectBaseline); re-run with --execute to spend the authorized budget");
    console.log("  Side effects: none — zero network requests, nothing written");
    return;
  }

  {
    const outDir = opts.out ? resolve(process.cwd(), opts.out) : join(dir, "adaptive");
    if (!frozenEvidence.contract.calibrationTripletSha256) {
      intakeFail(2, "DIRECT_RUN_CALIBRATION_TRIPLET_MISSING: the current frozen contract does not bind a calibration triplet");
    }
    const confirmationMode = frozenEvidence.evidence.confirmationMode;
    if (confirmationMode !== "human") {
      intakeFail(2, "DIRECT_RUN_CALIBRATION_CONFIRMATION_MODE_INVALID: public Direct requires formal human 2/2 evidence");
    }
    const calibrationPath = join(outDir, "calibration-evidence.json");
    if (!(await pathExists(calibrationPath))) {
      intakeFail(2, `DIRECT_RUN_CALIBRATION_EVIDENCE_MISSING: run calibration-run --execute first; no passed evidence at ${calibrationPath}`);
    }
    const fingerprintProbe = new OpenAICompatibleProvider(deepSeekConfig, live.evaluator.requestTimeoutMs, {
      maxRetries: 0,
      role: "semantic-judge",
      maxOutputTokens: live.evaluator.maxOutputTokens,
      thinking: thinkingModeOf("semantic-judge"),
    });
    try {
      assertCalibrationEvidenceForAdaptive(
        readIntakeJson(await readFile(calibrationPath, "utf8"), `calibration evidence at ${calibrationPath}`),
        {
          contractSha256: frozenEvidence.contract.contractSha256,
          calibrationTripletSha256: frozenEvidence.contract.calibrationTripletSha256,
          model,
          configFingerprint: fingerprintProbe.configFingerprint(),
          confirmationMode,
        },
      );
    } catch (error) {
      if (error instanceof CalibrationEvidenceError) {
        intakeFail(2, `DIRECT_RUN_${error.code}: ${error.message}`);
      }
      throw error;
    }
    console.log(`  Machine calibration: passed and bound (${calibrationPath})`);

    const inputs = realEvolutionInputs;
    if (!inputs.contract.selectItemIds || !inputs.contract.selectItemsSha256) {
      intakeFail(2, "DIRECT_RUN_SELECT_CONTRACT_MISSING: current Direct requires the frozen terminal public-select partition");
    }
    const adaptiveResultPath = join(outDir, "adaptive-result.json");
    const publicSelectionPath = join(outDir, "public-selection-result.json");
    if (!(await pathExists(adaptiveResultPath)) || !(await pathExists(publicSelectionPath))) {
      intakeFail(2, "DIRECT_RUN_PUBLIC_CHAIN_INCOMPLETE: Adaptive and terminal public-selection evidence must both exist before Direct");
    }
    const adaptiveRaw = await readFile(adaptiveResultPath, "utf8");
    const adaptiveResultSha256 = sha256Hex(adaptiveRaw);
    const publicSelectionRaw = await readFile(publicSelectionPath, "utf8");
    const publicSelectionResultSha256 = sha256Hex(publicSelectionRaw);
    const adaptiveEnvelope = parseAdaptiveResultArtifact(
      readIntakeJson(adaptiveRaw, `Adaptive result at ${adaptiveResultPath}`),
    );
    const publicSelectionEnvelope = readIntakeJson(
      publicSelectionRaw,
      `public-selection result at ${publicSelectionPath}`,
    );
    if (!hasCurrentSemanticResponseBinding(publicSelectionEnvelope)) {
      intakeFail(
        2,
        `DIRECT_RUN_PUBLIC_SELECTION_SEMANTIC_BINDING_DRIFT: terminal public-selection evidence must use ${SEMANTIC_RESPONSE_BINDING_VERSION}`,
      );
    }
    const publicSelection = PublicSelectionResultArtifactSchema.safeParse(publicSelectionEnvelope);
    if (!publicSelection.success) {
      intakeFail(2, "DIRECT_RUN_PUBLIC_SELECTION_DRIFT: terminal public-selection evidence is invalid or bound to different inputs");
    }
  if (inputs.contract.u1ContractVersion === "v2" && publicSelection.data.schemaVersion !== 2) {
    intakeFail(
      2,
      "DIRECT_RUN_PUBLIC_SELECTION_VERSION_DRIFT: current U1 requires relationally validated current public-selection evidence",
      );
    }
    if (
      publicSelection.data.selection.decision.verdict === "not_comparable" ||
      publicSelection.data.selection.decision.comparisonEligible === false ||
      publicSelection.data.selection.decision.startingReferenceId === null ||
      publicSelection.data.selection.decision.finalPublicChampionId === null
    ) {
      intakeFail(
        2,
        "DIRECT_RUN_NOT_COMPARABLE: Direct requires a complete comparison contract and a real Starting Reference, not an existing champion",
      );
    }
    const b0SkillSha256 = sha256Hex(inputs.b0ReferenceSkillMd);
    const directSource = {
      kind: inputs.u1Intake.track === "s0-rebuild" ? "s0" as const : "b0" as const,
      skillSha256: sha256Hex(inputs.anchorSkillMd),
      track: inputs.u1Intake.track,
    };
    if (
      (directSource.track === "b0-repair" && directSource.skillSha256 !== b0SkillSha256) ||
      (directSource.track === "s0-rebuild" && directSource.skillSha256 !== inputs.u1Intake.s0SkillSha256)
    ) {
      intakeFail(2, "DIRECT_RUN_SOURCE_DRIFT: the routed generation-zero Direct source no longer matches its U1 intake evidence");
    }
    const selectedB0 = publicSelection.data.selection.candidateEvaluations.filter(
      (candidate) => candidate.rootKind === "b0",
    );
    if (
      (adaptiveEnvelope as { u1Intake?: { b0EvidenceSha256?: unknown } }).u1Intake?.b0EvidenceSha256 !== b0SkillSha256 ||
      selectedB0.length !== 1 ||
      selectedB0[0].skillSha256 !== b0SkillSha256
    ) {
      intakeFail(
        2,
        "DIRECT_RUN_B0_DRIFT: the current Direct B0 does not match the B0 bound into Adaptive and terminal public-selection evidence",
      );
    }
    const currentEvaluatorConfigFingerprint = new OpenAICompatibleProvider(
      deepSeekConfig,
      live.evaluator.requestTimeoutMs,
      {
        maxRetries: 0,
        role: "evaluator",
        maxOutputTokens: live.evaluator.maxOutputTokens,
        thinking: thinkingModeOf("evaluator"),
      },
    ).configFingerprint();
    const currentSemanticJudgeConfigFingerprint = new OpenAICompatibleProvider(
      deepSeekConfig,
      live.evaluator.requestTimeoutMs,
      {
        maxRetries: 0,
        role: "semantic-judge",
        maxOutputTokens: live.evaluator.maxOutputTokens,
        thinking: thinkingModeOf("semantic-judge"),
      },
    ).configFingerprint();
    const currentDirectProposerConfigFingerprint = new OpenAICompatibleProvider(
      deepSeekConfig,
      live.proposer.requestTimeoutMs,
      {
        maxRetries: 0,
        role: "direct-refine",
        maxOutputTokens: live.proposer.maxOutputTokens,
        thinking: thinkingModeOf("direct-refine"),
      },
    ).configFingerprint();
    if (
      publicSelection.data.adaptiveResultSha256 !== adaptiveResultSha256 ||
      publicSelection.data.contractSha256 !== inputs.contract.contractSha256 ||
      publicSelection.data.selectItemsSha256 !== inputs.contract.selectItemsSha256 ||
      publicSelection.data.provider.model !== model ||
      publicSelection.data.provider.evaluatorConfigFingerprint !== currentEvaluatorConfigFingerprint ||
      publicSelection.data.provider.semanticJudgeConfigFingerprint !== currentSemanticJudgeConfigFingerprint ||
      publicSelection.data.confirmationMode !== confirmationMode ||
      publicSelection.data.sealedAllowed !== false ||
      publicSelection.data.releaseAllowed !== false
    ) {
      intakeFail(2, "DIRECT_RUN_PUBLIC_SELECTION_DRIFT: terminal public-selection evidence is invalid or bound to different inputs");
    }
    const selectItems = await loadTerminalPublicSelectItems({
      dir,
      contract: inputs.contract,
      command: "DIRECT_RUN",
    });
    const directScoringIdentity = scoringIdentityOfContract({
      contract: inputs.contract,
      items: selectItems,
    });
    assertSameScoringIdentity(
      directScoringIdentity,
      adaptiveEnvelope.scoringIdentity,
      "Adaptive to Direct",
    );
    assertSameScoringIdentity(
      directScoringIdentity,
      publicSelection.data.selection.scoringIdentity,
      "public-select to Direct",
    );
    const directInstructionSha256 = sha256Hex(DIRECT_U1_FROZEN_INSTRUCTION);
    const directPromptContractVersion = DIRECT_U1_PROMPT_CONTRACT_VERSION;
    const directPromptContractSha256 = DIRECT_U1_PROMPT_CONTRACT_SHA256;
    const directResultPath = join(outDir, "direct-result.json");
    const directFailurePath = join(outDir, "direct-failure.json");
    assertStageBudgetsFunded(stageBudgetEnvelope.plan, stageBudgetEnvelope.authorized);
    await archiveStageAttemptOrFail({
      evidenceDir: outDir,
      trigger: "direct",
      expectedBinding: {
        contractSha256: inputs.contract.contractSha256,
        semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
        confirmationMode,
        directPromptContractVersion,
        directPromptContractSha256,
      },
    });
    const directLive: LiveRunPolicy = {
      ...live,
      maxLogicalCalls: stageBudgetEnvelope.authorized.direct,
      u1CallEnvelope: stageBudgetEnvelope.plan.envelope.direct,
    };
    const chain = await buildLiveEvolutionChain(directLive, "direct");
    chain.directRefine.setStage("direct");
    chain.evaluator.setStage("direct-public-select");
    chain.semanticJudge.setStage("direct-public-select");
    const directProposer = createOpenAICompatibleU1DirectProposer({ provider: chain.directRefine });
    console.log(`[SkillFoo 进度] Direct 已启动 · proposer 0/1 · select ${selectItems.length} · logical 0/${directLive.maxLogicalCalls}`);
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const accounting = chain.budget.accounting;
      const cache = chain.evaluator.cacheStats();
      console.log(
        `[SkillFoo 仍在运行] ${Math.floor((Date.now() - startedAt) / 1000)}s · Direct public-select · cache ${cache.hits} hit/${cache.misses} miss · logical ${accounting.logicalCalls}/${directLive.maxLogicalCalls}, HTTP ${accounting.httpAttempts}, retry ${accounting.retryAttempts}/${directLive.maxRetryAttempts}`,
      );
    }, 15_000);
    let comparison: ReturnType<typeof buildSafeDirectPublicComparison> | undefined;
    let capabilityRejection: {
      candidateSkillSha256: string;
      findingCodes: string[];
    } | undefined;
    const semanticRecovery = createStageSemanticRecoveryEvidence({ kind: "stage", stage: "direct" });
    try {
      const proposal = await directProposer.propose({
        sourceSkillMd: inputs.anchorSkillMd,
        goal: inputs.taskCard.goal,
        capabilityBoundary: inputs.taskCard.capabilityBoundary,
      });
      // Keep the context-capable provider intact so the shared semantic judge
      // owns the primary/schema-repair attempt identity for Direct as well.
      const semanticProvider = chain.semanticJudge;
      const directResult = await runDirectBaseline({
        strategy: "one_shot",
        contract: inputs.contract,
        publicItems: selectItems,
        baseSkillMd: proposal.skillMd,
        runner: realEvolutionRunner(
          chain.evaluator,
          inputs.runtimeFactory,
          "direct",
          stageBudgetEnvelope.plan.envelope.direct.scenarioAuthorization,
        ),
        scoreRuns: livePublicSemanticScorer(semanticProvider),
        semanticRecovery: semanticRecovery.context,
        budget: chain.budget,
        maxInFlight,
      });
      comparison = buildSafeDirectPublicComparison({
        directSkillMd: directResult.finalSkillMd,
        directEvaluation: directResult.finalEvaluation,
        directAnswerHashes: directResult.finalAnswerHashes,
        selectItems: selectItems.map((item) => ({
          itemId: item.itemId,
          critical: item.rubric?.critical === true,
        })),
        publicSelection: publicSelection.data.selection,
        contract: inputs.contract,
      });
      const directArtifact = DirectResultArtifactSchema.parse({
        schemaVersion: 1,
        semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
        createdAt: new Date().toISOString(),
        status: "completed",
        phase: "direct-public-select",
        contractSha256: inputs.contract.contractSha256,
        scoringIdentity: directScoringIdentity,
        selectItemsSha256: inputs.contract.selectItemsSha256,
        adaptiveResultSha256,
        publicSelectionResultSha256,
        b0SkillSha256,
        directSource,
        directInstructionSha256,
        directPromptContractVersion,
        directPromptContractSha256,
        comparison,
        budget: {
          minimum: stageBaselineEstimate(stageBudgetEnvelope.plan, "direct"),
          authorized: stageBudgetEnvelope.authorized.direct,
          independent: true,
          assumptions: stageBudgetEnvelope.plan.assumptions,
          envelope: stageBudgetEnvelope.plan.envelope.direct,
        },
        accounting: { ...chain.budget.accounting },
        parallelism: {
          configuredMaxInFlight: maxInFlight,
          maxObservedInFlight: directResult.maxObservedInFlight,
          totalWallTimeMs: directResult.totalWallTimeMs,
          serialEquivalentMs: directResult.serialEquivalentMs,
        },
        tokenTelemetry: providerTokenTelemetryEvidenceOf(chain.budget),
        ...stageSemanticRecoveryArtifactFields(semanticRecovery),
        applicationRecovery: directResult.applicationRecovery ?? [],
        cache: chain.evaluator.cacheStats(),
        provider: {
          name: "deepseek",
          model: chain.model,
          evaluatorConfigFingerprint: chain.roleFingerprints.evaluator,
          proposerConfigFingerprint: chain.roleFingerprints["direct-refine"],
          semanticJudgeConfigFingerprint: chain.roleFingerprints["semantic-judge"],
        },
        promptBoundary: {
          inputs: [directSource.kind, "task-goal", "frozen-direct-instruction"],
          adaptivePopulationIncluded: false,
          lineageIncluded: false,
          adaptiveFailureIncluded: false,
          internalScoresIncluded: false,
          sealedIncluded: false,
        },
        ...derivedEvidenceFlagsOf(inputs.evidence),
        feedbackToEvolution: false,
        holdout: "sealed",
        release: "withheld (noRelease=true)",
      });
      await mkdir(outDir, { recursive: true });
      await writeJson(directResultPath, directArtifact);
      if (confirmationMode === "human") {
        const directResultSha256 = sha256Hex(`${JSON.stringify(directArtifact, null, 2)}\n`);
        const frozenDirectCandidate = U1SealedDirectCandidateArtifactSchema.parse({
          schemaVersion: 1,
          kind: "u1-sealed-direct-candidate",
          createdAt: new Date().toISOString(),
          status: "frozen",
          candidateId: "direct",
          contractSha256: inputs.contract.contractSha256,
          scoringIdentity: directScoringIdentity,
          adaptiveResultSha256,
          publicSelectionResultSha256,
          directResultSha256,
          skillSha256: sha256Hex(directResult.finalSkillMd),
          skillMd: directResult.finalSkillMd,
          confirmationMode: "human",
          explorationOnly: false,
          formalEvidence: true,
          sourceStageExecution: "completed",
          sourceCandidateOutcome: "scored",
          feedbackToEvolution: false,
          releaseAllowed: false,
        });
        await writeJson(join(outDir, U1_SEALED_DIRECT_CANDIDATE_FILENAME), frozenDirectCandidate);
      }
    } catch (error) {
      if (
        error instanceof DirectBaselineError &&
        error.code === "DIRECT_U1_BOUNDARY_VIOLATION" &&
        error.safeDetails !== undefined
      ) {
        const elapsedMs = Date.now() - startedAt;
        const directArtifact = DirectResultArtifactSchema.parse({
          schemaVersion: 1,
          semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
          createdAt: new Date().toISOString(),
          status: "completed",
          phase: "direct-public-select",
          contractSha256: inputs.contract.contractSha256,
          scoringIdentity: directScoringIdentity,
          selectItemsSha256: inputs.contract.selectItemsSha256,
          adaptiveResultSha256,
          publicSelectionResultSha256,
          b0SkillSha256,
          directSource,
          directInstructionSha256,
          directPromptContractVersion,
          directPromptContractSha256,
          directStageExecution: "completed",
          directCandidateOutcome: "rejected_by_capability_gate",
          directStatus: "candidate_rejected",
          semanticEvaluation: "not_run",
          semanticLogicalCalls: 0,
          numericComparison: "not_comparable",
          directCandidate: {
            candidateId: "direct",
            skillSha256: error.safeDetails.candidateSkillSha256,
          },
          safeError: {
            code: "DIRECT_U1_BOUNDARY_VIOLATION",
            message: "Direct candidate was rejected by the deterministic U1 capability gate; sensitive request content was not persisted.",
            details: { findings: error.safeDetails.findings },
          },
          budget: {
            minimum: stageBaselineEstimate(stageBudgetEnvelope.plan, "direct"),
            authorized: stageBudgetEnvelope.authorized.direct,
            independent: true,
            assumptions: stageBudgetEnvelope.plan.assumptions,
            envelope: stageBudgetEnvelope.plan.envelope.direct,
          },
          accounting: { ...chain.budget.accounting },
          parallelism: {
            configuredMaxInFlight: maxInFlight,
            maxObservedInFlight: 1,
            totalWallTimeMs: elapsedMs,
            serialEquivalentMs: elapsedMs,
          },
          tokenTelemetry: providerTokenTelemetryEvidenceOf(chain.budget),
          ...stageSemanticRecoveryArtifactFields(semanticRecovery),
          applicationRecovery: [],
          cache: chain.directRefine.cacheStats(),
          provider: {
            name: "deepseek",
            model: chain.model,
            evaluatorConfigFingerprint: chain.roleFingerprints.evaluator,
            proposerConfigFingerprint: chain.roleFingerprints["direct-refine"],
            semanticJudgeConfigFingerprint: chain.roleFingerprints["semantic-judge"],
          },
          promptBoundary: {
            inputs: [directSource.kind, "task-goal", "frozen-direct-instruction"],
            adaptivePopulationIncluded: false,
            lineageIncluded: false,
            adaptiveFailureIncluded: false,
            internalScoresIncluded: false,
            sealedIncluded: false,
          },
          ...derivedEvidenceFlagsOf(inputs.evidence),
          feedbackToEvolution: false,
          holdout: "sealed",
          release: "withheld (noRelease=true)",
        });
        await mkdir(outDir, { recursive: true });
        await rm(join(outDir, U1_SEALED_DIRECT_CANDIDATE_FILENAME), { force: true });
        await writeJson(directResultPath, directArtifact);
        capabilityRejection = {
          candidateSkillSha256: error.safeDetails.candidateSkillSha256,
          findingCodes: error.safeDetails.findings.map((finding) => `${finding.code}:${finding.kind}`),
        };
      } else {
        const dynamicEnvelopeExhaustion = dynamicEnvelopeExhaustionEvidenceOf({
          error,
          envelope: stageBudgetEnvelope.plan.envelope.direct,
          budget: chain.budget,
        });
        const code =
        dynamicEnvelopeExhaustion
          ? "DYNAMIC_ENVELOPE_EXHAUSTED"
          : error instanceof DirectBaselineError
          ? error.code
          : error instanceof DirectPublicComparisonError
            ? error.code
            : error instanceof U1ScenarioEnvelopeError
              ? error.code
            : error instanceof SemanticJudgeError
              ? error.code
              : error instanceof OpenAICompatibleProviderError
                ? error.code
                : error instanceof ProviderBudgetError
                  ? "PROVIDER_BUDGET_EXCEEDED"
                  : "DIRECT_RUN_FAILED";
        await mkdir(outDir, { recursive: true });
        await rm(join(outDir, U1_SEALED_DIRECT_CANDIDATE_FILENAME), { force: true });
        const directFailureArtifact = DirectFailureArtifactSchema.parse({
        schemaVersion: 1,
        semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
        createdAt: new Date().toISOString(),
        status: "failed",
        phase: "direct-public-select",
        adaptiveResultSha256,
        publicSelectionResultSha256,
        contractSha256: inputs.contract.contractSha256,
        scoringIdentity: directScoringIdentity,
        selectItemsSha256: inputs.contract.selectItemsSha256,
        directPromptContractVersion,
        directPromptContractSha256,
        safeError: {
          code,
          message: "Direct stage failed; sensitive request content was not persisted.",
          ...(error instanceof DirectBaselineError && error.safeDetails
            ? { details: error.safeDetails }
            : {}),
        },
        budget: {
          minimum: stageBaselineEstimate(stageBudgetEnvelope.plan, "direct"),
          authorized: stageBudgetEnvelope.authorized.direct,
          independent: true,
          assumptions: stageBudgetEnvelope.plan.assumptions,
          envelope: stageBudgetEnvelope.plan.envelope.direct,
        },
        accounting: { ...chain.budget.accounting },
        tokenTelemetry: providerTokenTelemetryEvidenceOf(chain.budget),
        ...stageSemanticRecoveryArtifactFields(semanticRecovery),
        ...(dynamicEnvelopeExhaustion ? { dynamicEnvelopeExhaustion } : {}),
        applicationRecovery: error instanceof U1ScenarioEnvelopeError
          ? [{
              candidateId: error.skillSha256,
              itemId: error.itemId,
              role: error.role,
              ...error.safeEvidence,
            }]
          : [],
        ...derivedEvidenceFlagsOf(inputs.evidence),
        feedbackToEvolution: false,
        holdout: "sealed",
        release: "withheld (noRelease=true)",
      });
        await writeJson(join(outDir, "direct-failure.json"), directFailureArtifact);
        console.error(`${code}: Direct failed; see the desensitized failure artifact`);
        throw new CliExitError(1);
      }
    } finally {
      clearInterval(heartbeat);
    }
    if (capabilityRejection) {
      try {
        await rm(directFailurePath, { force: true });
      } catch {
        console.warn(
          "DIRECT_RUN_STALE_FAILURE_CLEANUP_FAILED: completed candidate-rejection evidence is committed; stale failure evidence could not be removed and must not supersede it",
        );
      }
      console.log("=== Current U1 Direct Run (candidate rejected) ===");
      console.log(`  Contract: ${inputs.contract.contractSha256}`);
      console.log(`  Direct candidate SHA-256: ${capabilityRejection.candidateSkillSha256}`);
      console.log(`  Candidate outcome: rejected_by_capability_gate (${capabilityRejection.findingCodes.join(", ")})`);
      console.log("  Stage execution: completed; semantic evaluation: not_run; numeric comparison: not_comparable");
      console.log(`  Accounting: ${chain.budget.accounting.logicalCalls} logical, ${chain.budget.accounting.httpAttempts} HTTP, ${chain.budget.accounting.retryAttempts} retry`);
      console.log("  Holdout: sealed; release: withheld; feedback to evolution: false");
      return;
    }
    if (!comparison) {
      intakeFail(1, "DIRECT_RUN_FAILED: Direct completed without a comparable public result");
    }
    try {
      await rm(join(outDir, "direct-failure.json"), { force: true });
    } catch {
      console.warn(
        "DIRECT_RUN_STALE_FAILURE_CLEANUP_FAILED: direct-result.json is committed; stale failure evidence could not be removed and must not supersede it",
      );
    }
    console.log("=== Current U1 Direct Run ===");
    console.log(`  Contract: ${inputs.contract.contractSha256}`);
    console.log(`  Direct candidate SHA-256: ${comparison.directCandidate.skillSha256}`);
    console.log(`  Direct public-select: ${comparison.directCandidate.weightedMean} points; everyGatePassed=${comparison.directCandidate.everyGatePassed}; criticalRegression=${comparison.directCandidate.criticalRegression}`);
    console.log(`  Relative to Starting Reference: ${comparison.relativeToStarting.result} (delta ${comparison.relativeToStarting.scoreDelta})`);
    console.log(`  Relative to Final Public Champion: ${comparison.relativeToFinalPublicChampion.result} (delta ${comparison.relativeToFinalPublicChampion.scoreDelta})`);
    console.log(`  Accounting: ${chain.budget.accounting.logicalCalls} logical, ${chain.budget.accounting.httpAttempts} HTTP, ${chain.budget.accounting.retryAttempts} retry`);
    console.log(`  Same-model limitation: ${comparison.sameModelLimitation}`);
    console.log(`  Human confirmation mode: ${inputs.evidence.confirmationMode}; no model or automation was recorded as a human confirmer`);
    console.log("  Holdout: sealed; release: withheld; feedback to evolution: false");
    return;
  }

}

interface AuditCompareOptions extends LiveAuthorizationFlags {
  dir?: string;
  out?: string;
  execute?: boolean;
  runtimeContext?: string;
}

async function loadSuiteContractForAudit(dir: string): Promise<EvaluationContractV3> {
  const contractPath = evaluationContractV3Path(dir);
  if (!(await pathExists(contractPath))) {
    intakeFail(2, `AUDIT_COMPARE_CONTRACT_MISSING: no current formal contract at ${contractPath}`);
  }
  const parsed = EvaluationContractV3Schema.safeParse(
    readIntakeJson(await readFile(contractPath, "utf8"), `contract at ${contractPath}`),
  );
  if (!parsed.success) {
    intakeFail(2, `AUDIT_COMPARE_CONTRACT_INVALID: the frozen contract at ${contractPath} fails its schema`);
  }
  if (parsed.data.adapterId !== INSTRUCTION_ADAPTER_ID && parsed.data.adapterId !== REFERENCE_ADAPTER_ID) {
    intakeFail(
      2,
      `AUDIT_COMPARE_ADAPTER_MISMATCH: the contract binds unsupported U1 adapter "${parsed.data.adapterId}"`,
    );
  }
  return parsed.data;
}

const U1SealedAdaptiveMetadataSchema = z.object({
  semanticResponseBindingVersion: z.literal(SEMANTIC_RESPONSE_BINDING_VERSION),
  stopReason: AdaptiveComparisonStopReasonSchema,
  candidates: z.array(z.object({
    candidateId: z.string().min(1),
    skillMd: z.string().min(1),
  }).passthrough()).min(2),
  confirmationMode: z.literal("human"),
  explorationOnly: z.literal(false),
  humanConfirmationBypassed: z.literal(false),
  formalEvidence: z.literal(true),
  releaseAllowed: z.literal(false),
  sealedAllowed: z.literal(false),
  scoringIdentity: U1ScoringIdentitySchema,
}).passthrough();

const U1SealedPublicMetadataSchema = z.object({
  schemaVersion: z.literal(2),
  semanticResponseBindingVersion: z.literal(SEMANTIC_RESPONSE_BINDING_VERSION),
  status: z.literal("completed"),
  phase: z.literal("public-select"),
  adaptiveResultSha256: z.string().regex(/^[a-f0-9]{64}$/),
  contractSha256: z.string().regex(/^[a-f0-9]{64}$/),
  selection: SafeTerminalPublicSelectionSchema,
  budget: z.object({ independent: z.literal(true) }).passthrough(),
  confirmationMode: z.literal("human"),
  explorationOnly: z.literal(false),
  humanConfirmationBypassed: z.literal(false),
  formalEvidence: z.literal(true),
  releaseAllowed: z.literal(false),
  feedbackToEvolution: z.literal(false),
  holdout: z.literal("sealed"),
}).passthrough();

interface U1SealedCliLane {
  dir: string;
  taskCardConfirmation: TaskCardConfirmation;
  evaluationReviewConfirmation: EvaluationReviewConfirmation;
}

/** Resolve the isolated formal-human lane before Provider config or sealed-body access. */
async function resolveU1SealedCliLane(
  requestedDir: string,
): Promise<U1SealedCliLane | "waiting"> {
  const projectRoot = formalProjectRootOf(requestedDir);
  const formalDir = formalEvaluationLanePath(projectRoot);
  let verification;
  try {
    verification = await verifyPersistedFormalEvaluationLane(projectRoot, {
      verificationMode: "live-formal",
    });
  } catch (error) {
    if (error instanceof FormalEvaluationApprovalError) intakeFail(2, error.message);
    throw error;
  }
  if (verification.status === "WAITING_FOR_HUMAN_CONFIRMATION") {
    printFormalWaiting(verification);
    return "waiting";
  }
  if (verification.status !== "READY_FOR_FORMAL_EXECUTION") {
    intakeFail(2, "AUDIT_COMPARE_FORMAL_HUMAN_CONFIRMATION_REQUIRED: public U1 sealed execution requires real human 2/2");
  }
  return {
    dir: formalDir,
    taskCardConfirmation: verification.bundle.taskCard.confirmation,
    evaluationReviewConfirmation: verification.bundle.formalReview.confirmation,
  };
}

function assertU1SealedEvidenceMode(
  value: { confirmationMode: string; explorationOnly: boolean; formalEvidence: boolean },
  label: string,
): void {
  if (value.confirmationMode !== "human" || value.explorationOnly || !value.formalEvidence) {
    intakeFail(2, `AUDIT_COMPARE_${label}_EVIDENCE_MODE_INVALID: current sealed evidence must be formal human 2/2`);
  }
}

async function findU1EvidenceDir(dir: string): Promise<string> {
  const evidenceDir = join(dir, "adaptive");
  if (await pathExists(join(evidenceDir, "public-selection-result.json"))) return evidenceDir;
  intakeFail(2, `AUDIT_COMPARE_PUBLIC_SELECTION_MISSING: no current terminal result at ${evidenceDir}`);
}

async function cmdU1SealedAuditCompare(
  opts: AuditCompareOptions,
  requestedDir: string,
): Promise<boolean> {
  const lane = await resolveU1SealedCliLane(requestedDir);
  if (lane === "waiting") return true;
  if (opts.release !== false) {
    intakeFail(2, "AUDIT_COMPARE_U1_NO_RELEASE_REQUIRED: --no-release is mandatory for U1 sealed preflight and execution");
  }
  const contract = await loadSuiteContractForAudit(lane.dir);
  const runtimeFactory = await loadU1RuntimeFactoryOrFail({
    contract,
    runtimeContext: opts.runtimeContext,
    command: "AUDIT_COMPARE",
  });
  const manifestProbe = FrozenContractManifestSchema.safeParse(
    readIntakeJson(
      await readFile(evaluationManifestV3Path(lane.dir), "utf8"),
      `manifest at ${evaluationManifestV3Path(lane.dir)}`,
    ),
  );
  if (
    !manifestProbe.success ||
    manifestProbe.data.contractSha256 !== contract.contractSha256 ||
    manifestProbe.data.taskCardHash !== contract.taskCardHash ||
    manifestProbe.data.evaluationReviewHash !== contract.evaluationReviewHash
  ) {
    intakeFail(2, "AUDIT_COMPARE_U1_MANIFEST_INVALID: formal contract and public holdout manifest are not hash-bound");
  }
  const manifest = manifestProbe.data;
  const evidenceDir = await findU1EvidenceDir(lane.dir);
  const adaptivePath = join(evidenceDir, "adaptive-result.json");
  const publicPath = join(evidenceDir, "public-selection-result.json");
  const publicRaw = await readFile(publicPath, "utf8");
  const publicProbe = U1SealedPublicMetadataSchema.safeParse(
    readIntakeJson(publicRaw, `public-selection result at ${publicPath}`),
  );
  if (!publicProbe.success || publicProbe.data.contractSha256 !== contract.contractSha256) {
    intakeFail(2, "AUDIT_COMPARE_U1_PUBLIC_SELECTION_INVALID: terminal public-selection metadata is invalid or contract-drifted");
  }
  const publicArtifact = PublicSelectionResultArtifactSchema.safeParse(publicProbe.data);
  if (!publicArtifact.success) {
    intakeFail(2, "AUDIT_COMPARE_U1_PUBLIC_SELECTION_INVALID: live formal public-selection evidence fails its complete schema");
  }
  assertU1SealedEvidenceMode(publicArtifact.data, "PUBLIC_SELECTION");
  const sealedScoringIdentity = scoringIdentityOfContract({
    contract,
  });
  assertSameScoringIdentity(
    sealedScoringIdentity,
    publicArtifact.data.selection.scoringIdentity,
    "public-select to sealed",
  );
  const decision = publicArtifact.data.selection.decision;
  const publicDecision: U1PublicDecision = decision.verdict;
  const startingEvaluation = publicArtifact.data.selection.candidateEvaluations.find(
    (candidate) => candidate.candidateId === decision.startingReferenceId,
  );
  const finalEvaluation = publicArtifact.data.selection.candidateEvaluations.find(
    (candidate) => candidate.candidateId === decision.finalPublicChampionId,
  );
  if (!startingEvaluation || !finalEvaluation) {
    intakeFail(2, "AUDIT_COMPARE_U1_PUBLIC_SELECTION_INVALID: decision candidate ids have no frozen evaluation hashes");
  }

  const assumptions: StageBudgetInputs = {
    shortlistCandidates: 4,
    selectItems: manifest.selectItemIds.length,
    holdoutItems: manifest.holdoutItemIds.length,
    semanticBatchSize: 3,
    directProposerCalls: 1,
    ...u1RuntimeEstimationInputs(contract, "AUDIT_COMPARE"),
    budgetMultiplier: parseU1CallEnvelopeMultiplier(opts.callEnvelopeMultiplier, "AUDIT_COMPARE"),
  };
  const noNovel = publicDecision !== "clear_improvement";
  if (noNovel) {
    const result = await runU1SealedAudit({
      verificationMode: "live-formal",
      contract,
      manifest,
      taskCardConfirmation: lane.taskCardConfirmation,
      evaluationReviewConfirmation: lane.evaluationReviewConfirmation,
      formalEvidence: true,
      noRelease: true,
      b0B4: { b0: false, b1: true, b2: false, b3: false, b4: true },
      publicDecision,
      publicScoringIdentity: sealedScoringIdentity,
      startingReferenceSha256: startingEvaluation.skillSha256,
      finalPublicChampionSha256: finalEvaluation.skillSha256,
      candidates: [],
      readCandidateSkill: async () => { throw new Error("unreachable candidate read"); },
      readHoldoutBody: async () => { throw new Error("unreachable sealed-body read"); },
      claimSealedExecution: async () => { throw new Error("unreachable sealed claim"); },
      stageBudgetAssumptions: assumptions,
      authorizedStageBudgets: { publicSelect: 0, direct: 0, sealed: 0 },
      budget: new RunCallBudget({ maxLogicalCalls: 1, maxRetryAttempts: 0 }),
      runner: async () => { throw new Error("unreachable evaluator call"); },
    });
    if (opts.execute) {
      const outDir = opts.out ? resolve(process.cwd(), opts.out) : join(lane.dir, "audit");
      await mkdir(outDir, { recursive: true });
      await writeJson(join(outDir, "audit-compare.json"), {
        ...result,
        verificationMode: "live-formal",
        formalEvidence: true,
      });
    }
    console.log("=== Current U1 Sealed Audit ===");
    console.log("  Status: holdout_not_entered (no novel Final Public Champion)");
    console.log("  Sealed body reads: 0");
    console.log(`  Public decision: ${publicDecision}`);
    for (const line of runtimeContextPreflightLines(runtimeFactory)) console.log(line);
    console.log(`  Side effects: ${opts.execute ? "one desensitized terminal result written; no claim and no Provider call" : "none"}`);
    return true;
  }

  const stageBudgetEnvelope = await loadCurrentStageBudgetEnvelope({
    dir: lane.dir,
    contract,
    opts,
    command: "AUDIT_COMPARE",
  });
  const providerName = (opts.provider ?? "").trim().toLowerCase();
  if (providerName !== "deepseek") {
    intakeFail(2, "AUDIT_COMPARE_LIVE_ONLY: current formal sealed execution authorizes DeepSeek only");
  }
  const sealedLive = parseLivePolicyOrFail(
    opts,
    providerName,
    {
      authorizedLogicalCalls: stageBudgetEnvelope.authorized.sealed,
      callEnvelope: stageBudgetEnvelope.plan.envelope.sealed,
    },
  );
  let sealedModel: string;
  try {
    sealedModel = getDeepSeekConfig().model;
  } catch (error) {
    if (error instanceof DeepSeekConfigError) {
      intakeFail(2, "DEEPSEEK_API_KEY_MISSING: no DEEPSEEK_API_KEY is configured; the key value is never printed");
    }
    throw error;
  }

  if (!opts.execute) {
    const preflightPaths = {
      b0: bootstrapBundlePath(join(lane.dir, "bootstrap")),
      b2: join(evidenceDir, "calibration-evidence.json"),
      b3: adaptivePath,
      directResult: join(evidenceDir, "direct-result.json"),
      directCandidate: join(evidenceDir, U1_SEALED_DIRECT_CANDIDATE_FILENAME),
    };
    const present = {
      b0: await pathExists(preflightPaths.b0),
      b2: await pathExists(preflightPaths.b2),
      b3: await pathExists(preflightPaths.b3),
      directResult: await pathExists(preflightPaths.directResult),
      directCandidate: await pathExists(preflightPaths.directCandidate),
    };
    console.log("=== Current U1 Sealed Audit authorization preflight ===");
    console.log("  Evidence lane: live-formal (formalEvidence=true)");
    console.log(`  B0-B4 metadata: b0=${present.b0 ? "present" : "MISSING"}, b1=bound, b2=${present.b2 ? "present" : "MISSING"}, b3=${present.b3 ? "present" : "MISSING"}, b4=${present.directResult ? "result-present" : "result-MISSING"}`);
    console.log(`  Novel Final Public Champion: yes (${decision.startingReferenceId} -> ${decision.finalPublicChampionId})`);
    console.log(`  Candidate status: Starting Reference frozen-hash, Adaptive frozen-hash, Direct ${present.directCandidate ? "frozen-artifact-present" : "MISSING"}`);
    console.log(`  Provider/model: deepseek / ${sealedModel}`);
    console.log("  API key configured: yes (the value is never printed)");
    for (const line of roleOutputPreflightLines(sealedLive)) console.log(line);
    console.log(MAX_OUTPUT_TOKENS_NOTE);
    for (const line of stageBudgetPreflightLines(stageBudgetEnvelope, sealedLive.maxRetryAttempts)) console.log(line);
    for (const line of runtimeContextPreflightLines(runtimeFactory)) console.log(line);
    console.log(`  Sealed manifest: ${manifest.holdoutItemIds.length} item ids; body reads=0 in preflight`);
    console.log("  Feedback: disabled; generation/repair/release: disabled");
    console.log("  Side effects: none — zero Provider calls, zero writes, sealed body unopened");
    return true;
  }

  const bootstrapPath = bootstrapBundlePath(join(lane.dir, "bootstrap"));
  const bootstrapProbe = (await pathExists(bootstrapPath))
    ? BootstrapBundleSchema.safeParse(readIntakeJson(await readFile(bootstrapPath, "utf8"), `bootstrap at ${bootstrapPath}`))
    : null;
  const b0Complete = Boolean(
    bootstrapProbe?.success &&
    bootstrapProbe.data.contractSha256 === contract.contractSha256 &&
    bootstrapProbe.data.b0.files.length === 1 &&
    bootstrapProbe.data.b0.files[0]?.path === "SKILL.md" &&
    bootstrapProbe.data.s0.files.length === 1 &&
    bootstrapProbe.data.s0.files[0]?.path === "SKILL.md",
  );

  const calibrationPath = join(evidenceDir, "calibration-evidence.json");
  let b2Complete = false;
  if (await pathExists(calibrationPath)) {
    const calibrationUnknown = readIntakeJson(await readFile(calibrationPath, "utf8"), `calibration at ${calibrationPath}`);
    const parsed = LiveCalibrationEvidenceSchema.safeParse(calibrationUnknown);
    b2Complete = Boolean(
      parsed.success && parsed.data.contractSha256 === contract.contractSha256 &&
      parsed.data.confirmationMode === "human" && parsed.data.formalEvidence,
    );
  }

  const adaptiveRaw = await readFile(adaptivePath, "utf8");
  const adaptiveSha256 = sha256Hex(adaptiveRaw);
  const adaptiveProbe = U1SealedAdaptiveMetadataSchema.safeParse(
    readIntakeJson(adaptiveRaw, `Adaptive result at ${adaptivePath}`),
  );
  const b3Complete = Boolean(
    adaptiveProbe.success &&
    publicProbe.data.adaptiveResultSha256 === adaptiveSha256,
  );
  if (!adaptiveProbe.success) {
    intakeFail(2, "AUDIT_COMPARE_U1_ADAPTIVE_INVALID: the frozen Adaptive result has no complete candidate population metadata");
  }
  assertU1SealedEvidenceMode(adaptiveProbe.data, "ADAPTIVE");
  assertSameScoringIdentity(
    sealedScoringIdentity,
    adaptiveProbe.data.scoringIdentity,
    "Adaptive to sealed",
  );
  if (decision.startingReferenceId === null || decision.finalPublicChampionId === null) {
    intakeFail(
      2,
      "AUDIT_COMPARE_U1_NOT_COMPARABLE: sealed audit requires a frozen comparison baseline and public champion",
    );
  }
  const startingCandidate = resolveAdaptiveCandidateBySkillSha256({
    candidates: adaptiveProbe.data.candidates,
    expectedSkillSha256: startingEvaluation.skillSha256,
    preferredCandidateId: decision.startingReferenceId,
  });
  const adaptiveCandidate = resolveAdaptiveCandidateBySkillSha256({
    candidates: adaptiveProbe.data.candidates,
    expectedSkillSha256: finalEvaluation.skillSha256,
    preferredCandidateId: decision.finalPublicChampionId,
  });
  if (!startingCandidate || !adaptiveCandidate) {
    intakeFail(2, "AUDIT_COMPARE_U1_CANDIDATE_BINDING_INVALID: public candidate hashes differ from the frozen Adaptive bytes");
  }
  const startingSkill = startingCandidate.skillMd;
  const adaptiveSkill = adaptiveCandidate.skillMd;

  const directResultPath = join(evidenceDir, "direct-result.json");
  const directCandidatePath = join(evidenceDir, U1_SEALED_DIRECT_CANDIDATE_FILENAME);
  let directSkill: string | undefined;
  let b4Complete = false;
  if ((await pathExists(directResultPath)) && (await pathExists(directCandidatePath))) {
    const directResultRaw = await readFile(directResultPath, "utf8");
    const directCandidateProbe = U1SealedDirectCandidateArtifactSchema.safeParse(
      readIntakeJson(await readFile(directCandidatePath, "utf8"), `frozen Direct candidate at ${directCandidatePath}`),
    );
    const directResultUnknown = readIntakeJson(directResultRaw, `Direct result at ${directResultPath}`);
    const directResultProbe = DirectResultArtifactSchema.safeParse(directResultUnknown);
    const directResultValid = directResultProbe.success &&
      "comparison" in directResultProbe.data &&
      directResultProbe.data.confirmationMode === "human" &&
      directResultProbe.data.formalEvidence;
    if (directResultProbe.success) {
      assertSameScoringIdentity(
        sealedScoringIdentity,
        directResultProbe.data.scoringIdentity,
        "Direct result to sealed",
      );
    }
    if (directCandidateProbe.success) {
      assertU1SealedEvidenceMode(directCandidateProbe.data, "DIRECT_CANDIDATE");
      const candidate = directCandidateProbe.data;
      assertSameScoringIdentity(
        sealedScoringIdentity,
        candidate.scoringIdentity,
        "Direct candidate to sealed",
      );
      b4Complete = Boolean(
        directResultValid &&
        candidate.contractSha256 === contract.contractSha256 &&
        candidate.adaptiveResultSha256 === adaptiveSha256 &&
        candidate.publicSelectionResultSha256 === sha256Hex(publicRaw) &&
        candidate.directResultSha256 === sha256Hex(directResultRaw),
      );
      if (b4Complete) directSkill = candidate.skillMd;
    }
  }

  const candidates: U1SealedCandidateState[] = [
    { label: "starting_reference", status: "frozen", candidateSource: `adaptive:${startingCandidate.candidateId}`, skillSha256: startingEvaluation.skillSha256 },
    { label: "adaptive", status: "frozen", candidateSource: `adaptive:${adaptiveCandidate.candidateId}`, skillSha256: finalEvaluation.skillSha256 },
    directSkill
      ? { label: "direct", status: "frozen", candidateSource: "direct:formal-scored", skillSha256: sha256Hex(directSkill) }
      : { label: "direct", status: "unavailable", reason: "no hash-bound scored Direct candidate" },
  ];
  const candidateSkills: Record<U1SealedCandidateLabel, string | undefined> = {
    starting_reference: startingSkill,
    adaptive: adaptiveSkill,
    direct: directSkill,
  };
  const b0B4 = { b0: b0Complete, b1: true, b2: b2Complete, b3: b3Complete, b4: b4Complete };

  console.log("=== Current U1 Sealed Audit authorization preflight ===");
  console.log("  Evidence lane: live-formal (formalEvidence=true)");
  console.log(`  B0-B4: ${Object.entries(b0B4).map(([stage, complete]) => `${stage}=${complete ? "complete" : "INCOMPLETE"}`).join(", ")}`);
  console.log(`  Novel Final Public Champion: yes (${decision.startingReferenceId} -> ${decision.finalPublicChampionId})`);
  console.log(`  Candidates: Starting Reference frozen, Adaptive frozen, Direct ${directSkill ? "frozen" : "UNAVAILABLE"}`);
  console.log(`  Provider/model: deepseek / ${sealedModel}`);
  console.log("  API key configured: yes (the value is never printed)");
  for (const line of roleOutputPreflightLines(sealedLive)) console.log(line);
  console.log(MAX_OUTPUT_TOKENS_NOTE);
  for (const line of stageBudgetPreflightLines(stageBudgetEnvelope, sealedLive.maxRetryAttempts)) console.log(line);
  for (const line of runtimeContextPreflightLines(runtimeFactory)) console.log(line);
  console.log(`  Sealed manifest: ${manifest.holdoutItemIds.length} item ids; body reads=0 in preflight`);
  console.log("  Feedback: disabled; generation/repair/release: disabled");
  const outDir = opts.out ? resolve(process.cwd(), opts.out) : join(lane.dir, "audit");
  const claimPath = join(outDir, "sealed-execution.claim.json");
  const chain = await buildLiveEvolutionChain({
    ...sealedLive,
    maxLogicalCalls: stageBudgetEnvelope.authorized.sealed,
  }, "sealed");
  chain.evaluator.setStage("holdout");
  chain.semanticJudge.setStage("holdout");
  const runner = realEvolutionRunner(
    chain.evaluator,
    runtimeFactory,
    "sealed",
    stageBudgetEnvelope.plan.envelope.sealed.scenarioAuthorization,
  );
  const scoreRuns = liveSealedSemanticScorer(chain.semanticJudge);
  const sealedBudget = chain.budget;

  let result;
  try {
    result = await runU1SealedAudit({
      verificationMode: "live-formal",
      contract,
      manifest,
      taskCardConfirmation: lane.taskCardConfirmation,
      evaluationReviewConfirmation: lane.evaluationReviewConfirmation,
      formalEvidence: true,
      noRelease: true,
      b0B4,
      publicDecision,
      publicScoringIdentity: sealedScoringIdentity,
      startingReferenceSha256: startingEvaluation.skillSha256,
      finalPublicChampionSha256: finalEvaluation.skillSha256,
      candidates,
      readCandidateSkill: async (label) => {
        const skillMd = candidateSkills[label];
        if (!skillMd) throw new Error(`candidate ${label} is unavailable`);
        return skillMd;
      },
      readHoldoutBody: async () => readIntakeJson(
        await readFile(evaluationHoldoutV3Path(lane.dir), "utf8"),
        `sealed holdout at ${evaluationHoldoutV3Path(lane.dir)}`,
      ),
      claimSealedExecution: async () => {
        await mkdir(outDir, { recursive: true });
        try {
          await writeFile(claimPath, `${JSON.stringify({
            schemaVersion: 1,
            status: "claimed",
            contractSha256: contract.contractSha256,
            publicSelectionResultSha256: sha256Hex(publicRaw),
            candidates: candidates.map((candidate) => candidate.label),
            feedbackToEvolution: false,
            releaseAllowed: false,
          }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
          throw error;
        }
      },
      stageBudgetAssumptions: stageBudgetEnvelope.plan.assumptions,
      authorizedStageBudgets: stageBudgetEnvelope.authorized,
      budget: sealedBudget,
      runner,
      scoreRuns,
    });
  } catch (error) {
    if (error instanceof U1SealedAuditError) intakeFail(2, error.message);
    if (error instanceof OpenAICompatibleProviderError || error instanceof ProviderBudgetError) {
      const sealedEnvelope = stageBudgetEnvelope.plan.envelope.sealed;
      const dynamicEnvelopeExhaustion = dynamicEnvelopeExhaustionEvidenceOf({
        error,
        envelope: sealedEnvelope,
        budget: sealedBudget,
      });
      const failureArtifact = U1SealedFailureArtifactSchema.parse({
          schemaVersion: 2,
          createdAt: new Date().toISOString(),
          status: "failed",
          phase: "sealed-audit",
          contractSha256: contract.contractSha256,
          publicSelectionResultSha256: sha256Hex(publicRaw),
          safeError: {
            code: dynamicEnvelopeExhaustion
              ? "DYNAMIC_ENVELOPE_EXHAUSTED"
              : error instanceof OpenAICompatibleProviderError
                ? error.code
              : error instanceof ProviderBudgetError
                ? "PROVIDER_BUDGET_EXCEEDED"
                : "UNKNOWN_ERROR",
            message: "Sealed audit failed; sensitive request and response content were not persisted.",
          },
          budget: {
            minimum: sealedEnvelope.baselineEstimate,
            authorized: stageBudgetEnvelope.authorized.sealed,
            independent: true,
            assumptions: stageBudgetEnvelope.plan.assumptions,
            envelope: sealedEnvelope,
          },
          accounting: { ...sealedBudget.accounting },
          providerTokenTelemetry: providerTokenTelemetryEvidenceOf(sealedBudget),
          ...(dynamicEnvelopeExhaustion ? { dynamicEnvelopeExhaustion } : {}),
          scoringIdentity: sealedScoringIdentity,
          bodyReads: 1,
          sealedClaimConsumed: true,
          feedbackToEvolution: false,
          generationTriggered: false,
          repairTriggered: false,
          secondSealedAllowed: false,
          applicationRetryAllowed: false,
          releaseAllowed: false,
          verificationMode: "live-formal",
          formalEvidence: true,
          holdout: "sealed_once_no_feedback",
          release: "withheld (noRelease=true)",
      });
      await mkdir(outDir, { recursive: true });
      await writeJson(join(outDir, "audit-compare-failure.json"), failureArtifact);
      console.error(error.message);
      throw new CliExitError(1);
    }
    throw error;
  }
  const completedArtifact = result.status === "holdout_not_entered" || !result.budget
    ? {
        ...result,
        verificationMode: "live-formal",
        formalEvidence: true,
        holdout: "sealed_once_no_feedback",
        release: "withheld (noRelease=true)",
      }
    : U1SealedCompletedArtifactSchema.parse({
    ...result,
    verificationMode: "live-formal",
    formalEvidence: true,
    holdout: "sealed_once_no_feedback",
    release: "withheld (noRelease=true)",
  });
  await writeJson(join(outDir, "audit-compare.json"), completedArtifact);
  if (result.status === "holdout_not_entered") {
    intakeFail(2, "AUDIT_COMPARE_U1_PUBLIC_DECISION_DRIFT: a novel champion changed to a retained decision during sealed execution");
  }
  console.log("=== Current U1 Sealed Audit ===");
  console.log(`  Status: ${result.status}`);
  console.log(`  Candidates: ${result.candidates.map((candidate) => candidate.label).join(", ")}`);
  console.log(`  Sealed body reads: ${result.bodyReads}; second sealed allowed: ${result.secondSealedAllowed}`);
  console.log(`  Accounting: ${result.accounting.logicalCalls} logical, ${result.accounting.httpAttempts} HTTP, ${result.accounting.retryAttempts} retries`);
  console.log("  Feedback/generation/repair/release: disabled");
  return true;
}

async function cmdAuditCompare(opts: AuditCompareOptions): Promise<void> {
  if (!opts.dir) {
    intakeFail(2, "AUDIT_COMPARE_DIR_REQUIRED: provide --dir <caseDir> holding the current formal artifacts");
  }
  const requestedDir = resolve(process.cwd(), opts.dir);
  if (!(await dirExists(requestedDir))) {
    intakeFail(2, `AUDIT_COMPARE_DIR_MISSING: ${requestedDir} does not exist`);
  }
  await cmdU1SealedAuditCompare(opts, requestedDir);
}

// ── Current formal U1 suite report ─────────────────────────────────

interface SuiteReportOptions {
  suite?: string;
}

async function cmdSuiteReport(opts: SuiteReportOptions): Promise<void> {
  if (!opts.suite) {
    intakeFail(2, "SUITE_REPORT_SUITE_REQUIRED: provide --suite <dir> pointing at the current formal suite");
  }
  const suiteDir = resolve(process.cwd(), opts.suite);
  if (!(await dirExists(suiteDir))) {
    intakeFail(2, `SUITE_REPORT_SUITE_MISSING: ${suiteDir} does not exist`);
  }
  const summaryPath = join(suiteDir, "U1_TECHNICAL_SUITE_REPORT.json");
  try {
    const report = await aggregateU1TechnicalSuiteReport({ suiteDir });
    await writeJson(summaryPath, report);
  } catch (e) {
    if (e instanceof Error && /^SUITE_REPORT_[A-Z0-9_]+:/.test(e.message)) {
      console.error(e.message);
      throw new CliExitError(2);
    }
    throw e;
  }
  console.log("=== Current Formal U1 Suite Report ===");
  console.log(`  Report: ${summaryPath}`);
  console.log("  Zero network: aggregation reads run artifacts only");
}

async function cmdDoctor(
  projectDir?: string,
  providerName?: string,
  runtimeContextPath?: string,
): Promise<void> {
  // Current doctor accepts a SKILL.md root only. Retired project manifests no
  // longer select a second runtime path.
  if (projectDir) {
    const absDir = resolveProjectDir(projectDir);
    const hasSkillMd = await pathExists(join(absDir, "SKILL.md"));
    if (hasSkillMd) {
      await cmdDoctorSkill(absDir, runtimeContextPath);
      return;
    }
    console.error(`SKILL_NOT_FOUND: no SKILL.md found under ${absDir}`);
    throw new CliExitError(2);
  } else if (runtimeContextPath !== undefined) {
    console.error("RUNTIME_CONTEXT_NOT_APPLICABLE: --runtime-context requires a SKILL.md directory");
    throw new CliExitError(2);
  }

  let allOk = true;

  // Normalize provider name if provided
  let normalizedProvider: "scripted" | "deepseek" | undefined;
  if (providerName) {
    normalizedProvider = normalizeProviderName(providerName);
  }

  console.log("=== SkillFoo Doctor ===");
  console.log("");

  // Node version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1), 10);
  console.log(`Node.js version: ${nodeVersion}`);
  if (major < 20) {
    console.log("  WARNING: Node.js >= 20 is required.");
    allOk = false;
  } else {
    console.log("  OK: Node.js version meets the >= 20 requirement.");
  }
  console.log("");

  console.log("Skill directory: not supplied (provider diagnostics only).");
  console.log("");

  // Provider credentials
  if (normalizedProvider === "deepseek") {
    console.log("Provider: deepseek");
    const configured = isDeepSeekConfigured();
    console.log(`  API key configured: ${configured ? "yes" : "no"}`);
    if (configured) {
      const config = getDeepSeekConfig();
      console.log(`  Base URL: ${config.baseUrl}`);
      console.log(`  Model: ${config.model}`);
    } else {
      console.log("  Set DEEPSEEK_API_KEY in a local .env file to use the real model provider.");
      console.log("  The API will NOT be called until the key is configured.");
      allOk = false;
    }
    console.log("");
  } else if (normalizedProvider === "scripted" || !normalizedProvider) {
    console.log("Provider: scripted (default)");
    console.log("  OK: No credentials required for the scripted provider.");
    console.log("");
  }

  console.log(allOk ? "Diagnosis: all checks passed." : "Diagnosis: some checks failed. Review the warnings above.");
}

async function cmdProviderCheck(
  providerName: string,
  auth: { allowNetwork?: boolean; confirmRealProvider?: string; release?: boolean; out?: string } = {},
): Promise<void> {
  const normalized = normalizeProviderName(providerName);

  if (normalized === "scripted") {
    throw new CommanderError(
      1,
      "SCRIPTED_NOT_SUPPORTED",
      "provider-check does not support the scripted provider. Use --provider deepseek.",
    );
  }

  // P0 Task 4: provider-check is a REAL network request. An environment
  // variable alone must never trigger it — the same authorization gates as
  // the live eval chains apply, and the zero-network `preflight` command
  // is the recommended first step.
  if (auth.allowNetwork !== true || auth.confirmRealProvider !== LIVE_CONFIRM_PHRASE || auth.release !== false) {
    throw new CommanderError(
      1,
      "PROVIDER_CHECK_AUTH_REQUIRED",
      "PROVIDER_CHECK_AUTH_REQUIRED: provider-check sends one real network request; pass --allow-network, --confirm-real-provider I_UNDERSTAND_REAL_PROVIDER_COSTS and --no-release, or run the zero-network `preflight` command instead.",
    );
  }

  // deepseek: make a single minimal Chat Completions call
  let config;
  try {
    config = getDeepSeekConfig();
  } catch {
    console.log("Provider: deepseek");
    console.log("  API key configured: no");
    console.log("  ERROR: DEEPSEEK_API_KEY is not set. Configure it in .env first.");
    throw new CommanderError(1, "DEEPSEEK_API_KEY_MISSING", "DEEPSEEK_API_KEY is not set.");
  }

  console.log("Provider: deepseek");
  console.log(`  Base URL: ${config.baseUrl}`);
  console.log(`  Model: ${config.model}`);
  console.log("  API key configured: yes");
  console.log("");
  console.log("Performing single connection check...");

  const budget = new RunCallBudget({
    maxLogicalCalls: 1,
    maxRetryAttempts: 0,
    roleRetryReserves: { evaluator: 0 },
  });
  const rawProvider = new OpenAICompatibleProvider(config, 60_000, {
    maxRetries: 0,
    budget,
    role: "evaluator",
  });
  const provider = createBudgetedProvider(rawProvider, budget, "evaluator");
  const messages: ProviderMessage[] = [
    {
      role: "user",
      content: 'Return a JSON object with a single key "status" and value "ok".',
    },
  ];
  const requestFingerprint = sha256Hex(JSON.stringify({
    model: config.model,
    configFingerprint: rawProvider.configFingerprint(),
    messages,
    responseFormat: "json_object",
  }));
  const artifactPath = auth.out ? join(resolve(process.cwd(), auth.out), "provider-check.json") : null;

  try {
    const response = await provider.chat(messages, { responseFormat: "json_object" });

    // Verify the response is valid JSON (but do not print raw model text)
    let parsedResponse: unknown;
    try {
      parsedResponse = JSON.parse(response.content);
    } catch {
      console.log("  ERROR: Provider returned a non-JSON response.");
      throw new CommanderError(1, "PROVIDER_CHECK_NON_JSON_RESPONSE", "Provider returned a non-JSON response.");
    }

    if (artifactPath) {
      await mkdir(dirname(artifactPath), { recursive: true });
      await writeFile(
        artifactPath,
        `${JSON.stringify({
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          stage: "provider-check",
          status: "passed",
          evidenceScope: "connectivity-only",
          provider: {
            name: "deepseek",
            model: config.model,
            configFingerprint: rawProvider.configFingerprint(),
          },
          requestFingerprint,
          resultFingerprint: sha256Hex(JSON.stringify(parsedResponse)),
          accounting: { ...budget.accounting },
          formalEvidence: false,
          releaseAllowed: false,
        }, null, 2)}\n`,
        "utf8",
      );
    }

    console.log("  JSON response received.");
    console.log("");
    console.log("Connection check: PASSED.");
  } catch (e) {
    // Safe error classification — no key, no headers, no raw body
    const safeError = e instanceof CommanderError
      ? e.code
      : classifyProviderError(e instanceof Error ? e.message : String(e));

    if (artifactPath) {
      await mkdir(dirname(artifactPath), { recursive: true });
      await writeFile(
        artifactPath,
        `${JSON.stringify({
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          stage: "provider-check",
          status: "failed",
          evidenceScope: "connectivity-only",
          provider: {
            name: "deepseek",
            model: config.model,
            configFingerprint: rawProvider.configFingerprint(),
          },
          requestFingerprint,
          errorCode: safeError,
          accounting: { ...budget.accounting },
          formalEvidence: false,
          releaseAllowed: false,
        }, null, 2)}\n`,
        "utf8",
      );
    }

    if (e instanceof CommanderError) throw e;

    console.log(`  ERROR: ${safeError}`);
    console.log("");
    console.log("Connection check: FAILED.");
    throw new CommanderError(1, "PROVIDER_CHECK_FAILED", `Provider check failed: ${safeError}`);
  }
}

/** Classify a provider error into a safe, non-sensitive summary. */
function classifyProviderError(msg: string): string {
  if (msg.includes("Request timed out")) return "REQUEST_TIMEOUT";
  if (msg.includes("Network error")) return "NETWORK_ERROR";
  if (msg.includes("HTTP 401")) return "HTTP_401_UNAUTHORIZED";
  if (msg.includes("HTTP 403")) return "HTTP_403_FORBIDDEN";
  if (msg.includes("HTTP 429")) return "HTTP_429_RATE_LIMITED";
  if (msg.match(/HTTP 5\d\d/)) return "HTTP_5XX_SERVER_ERROR";
  if (msg.includes("HTTP 4")) return "HTTP_4XX_CLIENT_ERROR";
  if (msg.includes("Malformed response")) return "MALFORMED_RESPONSE";
  return "UNKNOWN_ERROR";
}

// ── runCli ──────────────────────────────────────────────────────

async function runCliInternal(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";

  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  console.log = (...vals: unknown[]) => { stdout += vals.map(String).join(" ") + "\n"; };
  console.error = (...vals: unknown[]) => { stderr += vals.map(String).join(" ") + "\n"; };
  console.warn = (...vals: unknown[]) => { stderr += vals.map(String).join(" ") + "\n"; };

  const program = new Command();
  program
    .name("skillfoo-v3")
    .description("SkillFoo current U1 bounded SKILL.md evolution CLI")
    .exitOverride();

  program
    .command("doctor")
    .description("Diagnose a current skill directory, runtime context, and Provider configuration.")
    .argument("[projectDir]")
    .option("--provider <value>", "check credentials for a specific provider")
    .option("--runtime-context <path>", "explicit runtime-context.v1.json for a reference skill")
    .action(async (projectDir: string | undefined, opts: { provider?: string; runtimeContext?: string }) => {
      await cmdDoctor(projectDir, opts.provider, opts.runtimeContext);
    });

  program
    .command("intake")
    .description("Create or confirm a 5-minute Task Card: draft first, human confirmation required; secrets are rejected.")
    .option("--from <path>", "read intake input from a JSON file (non-interactive)")
    .option("--goal <text>", "minimal U1 natural-language optimization goal")
    .option("--interactive", "ask only unresolved intent dimensions (0-5; requires --goal)")
    .option("--skill-dir <path>", "pin the source skill directory by its SKILL.md hash (content is never copied)")
    .option("--intent-fixture", "attach offline low-confidence intent fixtures to the draft")
    .option("--confirm <path>", "confirm an existing task-card.draft.json")
    .option("--by <operator>", "operator name recorded on the confirmed card")
    .option("--out <dir>", "directory that receives the task card files", ".")
    .action(async (opts: IntakeOptions) => {
      await cmdIntake(opts);
    });

  program
    .command("eval-draft")
    .description("Compose an evaluation blueprint, generate an offline fixture draft and run the rule curator (fully offline).")
    .requiredOption("--task-card <path>", "task card JSON (confirmed required at freeze time)")
    .option("--out <dir>", "directory that receives the three factory artefacts", ".")
    .action(async (opts: EvalDraftOptions) => {
      await cmdEvalDraft(opts);
    });

  program
    .command("eval-review")
    .description("Generate or confirm the sealed-safe Chinese evaluation summary that binds the Task Card and draft.")
    .requiredOption("--dir <dir>", "directory holding the Task Card and evaluation draft")
    .option("--confirm", "confirm the existing evaluation-review.draft.json")
    .option("--by <operator>", "operator identity recorded on confirmation")
    .action(async (opts: EvalReviewOptions) => {
      await cmdEvalReview(opts);
    });

  program
    .command("eval-freeze")
    .description("Freeze the curated draft into the immutable V3 evaluation contract (public contract + holdout file + hash manifest).")
    .requiredOption("--dir <dir>", "directory holding the task card and the eval-draft artefacts")
    .requiredOption("--adapter <id>", "adapter id declared in the blueprint (e.g. instruction-v1)")
    .option("--runtime-context <path>", "explicit runtime-context.v1.json (required only for reference-v1)")
    .option("--deviation-reason <text>", "required only when isolation constraints force the holdout ratio outside tolerance")
    .action(async (opts: EvalFreezeOptions) => {
      await cmdEvalFreeze(opts);
    });

  program
    .command("bootstrap")
    .description("Dual-root bootstrap (round 1): freeze B0 read-only, scaffold S0 from the confirmed card + frozen contract, emit one bounded candidate per root. Fixture/dry-run by default.")
    .requiredOption("--dir <dir>", "directory holding the confirmed task card and the frozen v3 evaluation contract")
    .requiredOption("--skill-dir <path>", "read-only B0 rough skill directory")
    .requiredOption("--adapter <id>", "adapter id bound to the frozen contract (e.g. instruction-v1)")
    .option("--out <dir>", "output directory for the S0 scaffold and the bootstrap bundle (default: <dir>/bootstrap)")
    .option("--provider <mode>", "execution provider mode (default: fixture; any other mode requires T13 authorization)")
    .option("--release", "request a release path (refused: round 1 is dry-run only)")
    .action(async (opts: BootstrapOptions) => {
      await cmdBootstrap(opts);
    });

  program
    .command("preflight")
    .description("Run the current formal Adaptive input/intake/budget path with execution disabled; zero Provider calls and no writes.")
    .requiredOption("--dir <dir>", "current formal case directory")
    .requiredOption("--skill-md <path>", "formal B0 SKILL.md")
    .option("--runtime-context <path>", "explicit runtime-context.v1.json required by reference-v1")
    .option("--provider <mode>", "deepseek (authorization is validated but no request is sent)", "deepseek")
    .option("--allow-network", "validate the live-network authorization gate; preflight itself stays zero-network")
    .option("--confirm-real-provider <phrase>", `live confirmation phrase; must be exactly ${LIVE_CONFIRM_PHRASE}`)
    .option("--no-release", "withhold any release path (mandatory for live runs)")
    .option("--max-retry-attempts <number>", "live cap on transport retries (0-8)", Number)
    .option("--call-envelope-multiplier <number>", "current U1 B/M/H safety multiplier (finite >=1; default 2.0)", Number)
    .option("--evaluator-max-output-tokens <number>", "optional evaluator max_tokens override; defaults to provider-default observe-only", Number)
    .option("--evaluator-request-timeout-ms <number>", "live evaluator-role per-request timeout in milliseconds (1000-180000)", Number)
    .option("--proposer-max-output-tokens <number>", "optional proposer max_tokens override; defaults to provider-default observe-only", Number)
    .option("--proposer-request-timeout-ms <number>", "live proposer-role per-request timeout in milliseconds (1000-180000)", Number)
    .option("--mode <mode>", "formal execution mode: standard", "standard")
    .option("--early-repair <mode>", "refinement gate: auto (default), off, or force")
    .option("--max-generations <number>", "adaptive generations (1-4; default 2)", Number)
    .option("--max-refinements <number>", "refinements per candidate (0-4; default 1)", Number)
    .option("--min-repair-progress <points>", "minimum public-score improvement in absolute points", Number)
    .option("--stagnation-patience <number>", "consecutive stagnant generations before stop", Number)
    .option("--max-in-flight <number>", "local parallel provider-call cap (current formal U1 requires 2)", Number)
    .action(async (opts: PreflightOptions) => {
      await cmdPreflight(opts);
    });

  program
    .command("provider-check")
    .description("Perform a single minimal DeepSeek connection check. Requires the same live authorization flags; does not create runs or candidates.")
    .requiredOption("--provider <value>", "deepseek only (scripted is not supported)")
    .option("--out <dir>", "write one stable, desensitized connectivity evidence file")
    .option("--allow-network", "authorize the real network request (mandatory)")
    .option("--confirm-real-provider <phrase>", `live confirmation phrase; must be exactly ${LIVE_CONFIRM_PHRASE}`)
    .option("--no-release", "withhold any release path (mandatory)")
    .action(async (opts: { provider: string; out?: string; allowNetwork?: boolean; confirmRealProvider?: string; release?: boolean }) => {
      await cmdProviderCheck(opts.provider, opts);
    });

  program
    .command("calibration-run")
    .description("Run two evaluator-only Good/Borderline/Unsafe primary passes, each with at most one content-free schema repair, and write desensitized gate evidence. Without --execute: zero network requests, nothing written.")
    .requiredOption("--dir <dir>", "directory holding the current frozen contract, draft, review and Task Card")
    .option("--out <dir>", "current formal evidence directory (default: <formal-dir>/adaptive)")
    .option("--provider <mode>", "deepseek only")
    .option("--allow-network", "authorize 2 primary calibration passes plus up to 2 content-free schema-repair calls")
    .option("--confirm-real-provider <phrase>", `live confirmation phrase; must be exactly ${LIVE_CONFIRM_PHRASE}`)
    .option("--no-release", "withhold release (mandatory)")
    .option("--max-retry-attempts <number>", "must be exactly 0", Number)
    .option("--evaluator-max-output-tokens <number>", "optional evaluator max_tokens override; current U1 calibration defaults to provider-default observe-only", Number)
    .option("--evaluator-request-timeout-ms <number>", "evaluator per-request timeout (1000-180000ms)", Number)
    .option("--proposer-max-output-tokens <number>", "optional proposer max_tokens override; calibration never calls it and current U1 defaults to provider-default observe-only", Number)
    .option("--proposer-request-timeout-ms <number>", "required role declaration; calibration never calls it", Number)
    .option("--mode <mode>", "formal execution mode: standard", "standard")
    .option("--execute", "perform the 2 bounded primary passes and any required one-per-pass schema repair, then write gate evidence")
    .action(async (opts: CalibrationRunOptions) => {
      await cmdCalibrationRun(opts);
    });

  program
    .command("adaptive-run")
    .description("Authorize and run the current formal Adaptive population chain; without --execute: zero Provider calls and no writes.")
    .requiredOption("--dir <dir>", "directory the adaptive run operates on")
    .option("--out <dir>", "artifact directory for --execute (default: <formal-dir>/adaptive)")
    .option("--provider <mode>", "deepseek (live; every authorization gate required)")
    .option("--allow-network", "authorize network access for the live provider")
    .option("--confirm-real-provider <phrase>", `live confirmation phrase; must be exactly ${LIVE_CONFIRM_PHRASE}`)
    .option("--no-release", "withhold any release path (mandatory for live runs)")
    .option("--call-envelope-multiplier <number>", "current U1 B/M/H safety multiplier (finite >=1; default 2.0)", Number)
    .option("--max-retry-attempts <number>", "live cap on transport retries (0-8)", Number)
    .option("--evaluator-max-output-tokens <number>", "optional evaluator max_tokens override; current U1 defaults to provider-default observe-only", Number)
    .option("--evaluator-request-timeout-ms <number>", "live evaluator-role per-request timeout in milliseconds (1000-180000)", Number)
    .option("--proposer-max-output-tokens <number>", "optional proposer max_tokens override; current U1 defaults to provider-default observe-only", Number)
    .option("--proposer-request-timeout-ms <number>", "live proposer-role per-request timeout in milliseconds (1000-180000)", Number)
    .option("--mode <mode>", "formal execution mode: standard", "standard")
    .option("--resume-public-select <sha256>", "retry only a previously failed terminal public-select stage, bound to the exact existing adaptive-result.json SHA-256; never reruns Adaptive")
    .option("--early-repair <mode>", "refinement gate: auto (default), off, or force")
    .option("--max-generations <number>", "adaptive generations (1-4; default 2)", Number)
    .option("--max-refinements <number>", "refinements per candidate (0-4; pass explicitly for identical preflight/execute configuration)", Number)
    .option("--min-repair-progress <points>", "minimum public-score improvement in absolute points (0,100]; default 2", Number)
    .option("--stagnation-patience <number>", "consecutive stagnant generations before stop (1-3; default 1)", Number)
    .option("--max-in-flight <number>", "local parallel provider-call cap (1-4; default 2; provider-agnostic)", Number)
    .option("--execute", "run the authorized live evolution (loads the frozen contract/card/draft; spends the authorized budget)")
    .option("--skill-md <path>", "anchor B0 SKILL.md (required for formal preflight and execute)")
    .option("--runtime-context <path>", "explicit runtime-context.v1.json required by a reference-v1 contract")
    .action(async (opts: AdaptiveRunOptions) => {
      await cmdAdaptiveRun(opts);
    });

  program
    .command("direct-run")
    .description("Run the current frozen one-shot Direct public comparison; without --execute: zero Provider calls and no writes.")
    .requiredOption("--dir <dir>", "directory the direct run operates on")
    .option("--out <dir>", "artifact directory for --execute (default: <formal-dir>/adaptive)")
    .option("--strategy <mode>", "current Direct strategy: one_shot", "one_shot")
    .option("--provider <mode>", "deepseek (live; every authorization gate required)")
    .option("--allow-network", "authorize network access for the live provider")
    .option("--confirm-real-provider <phrase>", `live confirmation phrase; must be exactly ${LIVE_CONFIRM_PHRASE}`)
    .option("--no-release", "withhold any release path (mandatory for live runs)")
    .option("--call-envelope-multiplier <number>", "current U1 B/M/H safety multiplier (finite >=1; default 2.0)", Number)
    .option("--max-retry-attempts <number>", "live cap on transport retries (0-8)", Number)
    .option("--evaluator-max-output-tokens <number>", "optional evaluator max_tokens override; current U1 defaults to provider-default observe-only", Number)
    .option("--evaluator-request-timeout-ms <number>", "live evaluator-role per-request timeout in milliseconds (1000-180000)", Number)
    .option("--proposer-max-output-tokens <number>", "optional proposer max_tokens override; current U1 defaults to provider-default observe-only", Number)
    .option("--proposer-request-timeout-ms <number>", "live proposer-role per-request timeout in milliseconds (1000-180000)", Number)
    .option("--mode <mode>", "formal execution mode: standard", "standard")
    .option("--max-in-flight <number>", "local provider-call cap (current formal U1 requires 2)", Number)
    .option("--execute", "run the authorized live baseline (loads the frozen contract/card/draft; spends the authorized budget)")
    .option("--skill-md <path>", "the base SKILL.md the baseline evaluates (required for formal preflight and execute)")
    .option("--runtime-context <path>", "explicit runtime-context.v1.json required by a reference-v1 contract")
    .action(async (opts: DirectRunOptions) => {
      await cmdDirectRun(opts);
    });

  program
    .command("audit-compare")
    .description("Run the current one-shot sealed comparison when the frozen public decision is a qualified novel improvement.")
    .requiredOption("--dir <dir>", "directory holding the case artifacts (adaptive/direct/audit)")
    .option("--out <dir>", "artifact directory for --execute (default: <formal-dir>/audit)")
    .option("--runtime-context <path>", "explicit runtime-context.v1.json required by a reference-v1 contract")
    .option("--provider <mode>", "deepseek (live; every authorization gate required)")
    .option("--allow-network", "authorize network access for the live provider")
    .option("--confirm-real-provider <phrase>", `live confirmation phrase; must be exactly ${LIVE_CONFIRM_PHRASE}`)
    .option("--no-release", "withhold any release path (mandatory for live runs)")
    .option("--call-envelope-multiplier <number>", "current U1 B/M/H safety multiplier (finite >=1; default 2.0)", Number)
    .option("--max-retry-attempts <number>", "live cap on transport retries (0-8)", Number)
    .option("--evaluator-max-output-tokens <number>", "optional evaluator max_tokens override; current U1 defaults to provider-default observe-only", Number)
    .option("--evaluator-request-timeout-ms <number>", "live evaluator-role per-request timeout in milliseconds (1000-180000)", Number)
    .option("--proposer-max-output-tokens <number>", "optional proposer max_tokens override; current U1 defaults to provider-default observe-only", Number)
    .option("--proposer-request-timeout-ms <number>", "live proposer-role per-request timeout in milliseconds (1000-180000)", Number)
    .option("--execute", "run the authorized live comparison (reads the sealed audit file after candidate selection)")
    .action(async (opts: AuditCompareOptions) => {
      await cmdAuditCompare(opts);
    });

  program
    .command("suite-report")
    .description("Aggregate current formal U1 case results into one desensitized suite summary.")
    .requiredOption("--suite <dir>", "path to the current suite directory")
    .action(async (opts: SuiteReportOptions) => {
      await cmdSuiteReport(opts);
    });


  try {
    await program.parseAsync(args, { from: "user" });
    return { stdout, stderr, exitCode: 0 };
  } catch (e) {
    if (e instanceof CliExitError) {
      return { stdout, stderr, exitCode: e.exitCode };
    }
    if (e instanceof CommanderError) {
      stderr += e.message + "\n";
      return { stdout, stderr, exitCode: e.exitCode };
    }
    stderr += (e instanceof Error ? e.message : String(e)) + "\n";
    return { stdout, stderr, exitCode: 1 };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
}

export async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runCliInternal(args);
}

// ── Entry point ─────────────────────────────────────────────────

function scheduleProcessExit(exitCode: number): void {
  process.exitCode = exitCode;
  // Node 24 on Windows can assert if Undici is terminated immediately after a
  // completed fetch, while natural exit can retain its socket for minutes.
  // Give transport cleanup a brief window, then exit only after runCli ended.
  setTimeout(() => process.exit(exitCode), 250);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli(process.argv.slice(2))
    .then((result) => {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      scheduleProcessExit(result.exitCode);
    })
    .catch((err) => {
      console.error(err.message);
      scheduleProcessExit(1);
    });
}
