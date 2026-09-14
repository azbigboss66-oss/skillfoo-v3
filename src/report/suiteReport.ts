import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  DEFAULT_U1_SCORING_PROFILE,
  LiveCalibrationEvidenceSchema,
  LiveCalibrationFailureEvidenceSchema,
  SEMANTIC_RESPONSE_BINDING_VERSION,
} from "../types.js";
import {
  DIRECT_U1_PROMPT_CONTRACT_SHA256,
  DIRECT_U1_PROMPT_CONTRACT_VERSION,
} from "../evolution/directBaseline.js";
import { calculateCalibrationBudget } from "../providers/stageBudgets.js";
import { PublicSelectionResultArtifactSchema } from "../evolution/publicSelectionResume.js";

type JsonRecord = Record<string, unknown>;
type StageStatus = "completed" | "failed" | "not_run";
type StageName = "calibration" | "adaptive" | "publicSelect" | "direct" | "sealed";

const CURRENT_SUITE = "u1-current-formal" as const;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,127}$/;
const FORMAL_DIRECTORY = "formal-evidence";
const STAGE_DIRECTORY = "adaptive";

export interface CurrentStageAccounting {
  logicalCalls: number;
  httpAttempts: number;
  transportRetryAttempts: number;
}

export interface CurrentTokenTelemetry {
  promptTokens: number | null;
  promptCacheHitTokens: number | null;
  promptCacheMissTokens: number | null;
  completionTokens: number | null;
  responses: number | null;
  responsesWithUsage: number | null;
  responsesMissingUsage: number | null;
}

export interface CurrentSemanticRecovery {
  reserve: number;
  actual: number;
  diagnosticsObserved: number;
}

export interface CurrentStageBudget {
  baselineEstimate: number;
  authorizedLogicalCalls: number;
  independent: true;
  existingRecoveryReserve: number;
}

export interface CurrentStageReport {
  status: StageStatus;
  artifactPath: string | null;
  errorCode: string | null;
  accounting: CurrentStageAccounting;
  tokens: CurrentTokenTelemetry;
  elapsedMs: number | null;
  cache: { hits: number; misses: number; stores: number } | null;
  budget: CurrentStageBudget | null;
  semanticRecovery: CurrentSemanticRecovery;
}

export interface CurrentFormalCaseReport {
  caseId: string;
  order: number;
  contractSha256: string;
  formalEvidence: {
    confirmationMode: "human";
    humanConfirmations: { required: 2; completed: 2 };
    humanConfirmationBypassed: false;
  };
  scoringIdentity: {
    profileVersion: typeof DEFAULT_U1_SCORING_PROFILE.version;
    taskVerifierVersion: typeof DEFAULT_U1_SCORING_PROFILE.taskVerifierVersion;
    rubricVersion: typeof DEFAULT_U1_SCORING_PROFILE.rubricVersion;
  };
  stages: Record<StageName, CurrentStageReport>;
  publicDecision: {
    verdict: "clear_improvement" | "start_reference_retained" | "candidate_rejected" | "not_comparable" | null;
    startingReferenceId: string | null;
    finalPublicChampionId: string | null;
    scoreDelta: number | null;
    criticalRegression: boolean | null;
  };
  directComparison: {
    status: "completed" | "candidate_rejected" | "failed" | "not_run";
    relativeToStarting: "higher_public_score" | "tied_public_score" | "lower_public_score" | "candidate_rejected" | null;
    scoreDelta: number | null;
  };
  sealed: {
    status: "holdout_not_entered" | "sealed_confirmed" | "sealed_rejected" | "failed" | "not_run";
    bodyReads: 0 | 1;
    applicationRecoveryReserve: 0;
    applicationRecoveryAttempts: 0;
  };
  releaseStatus: "release_withheld";
}

export interface U1TechnicalSuiteReport {
  schemaVersion: 1;
  reportKind: "u1-current-formal";
  suite: typeof CURRENT_SUITE;
  createdAt: string;
  evidenceBoundary: {
    confirmationMode: "human";
    humanConfirmationsPerCase: { required: 2; completed: 2 };
    humanConfirmationBypassed: false;
    holdoutContentReadByReporter: false;
    releaseStatus: "release_withheld";
  };
  scoringIdentity: {
    profileVersion: typeof DEFAULT_U1_SCORING_PROFILE.version;
    taskVerifierVersion: typeof DEFAULT_U1_SCORING_PROFILE.taskVerifierVersion;
    rubricVersion: typeof DEFAULT_U1_SCORING_PROFILE.rubricVersion;
  };
  directPromptContract: {
    version: typeof DIRECT_U1_PROMPT_CONTRACT_VERSION;
    sha256: typeof DIRECT_U1_PROMPT_CONTRACT_SHA256;
  };
  calibrationBudget: {
    primaryPasses: 2;
    schemaRecoveryReserve: 2;
    authorizedLogicalCalls: 4;
  };
  cases: CurrentFormalCaseReport[];
  totals: {
    accounting: CurrentStageAccounting;
    semanticSchemaRepairs: number;
    tokens: CurrentTokenTelemetry;
  };
  sameModelLimitation: string;
}

interface SuiteCaseBinding {
  id: string;
  order: number;
  directory: string;
  contractSha256: string;
}

interface ArtifactChoice {
  raw: JsonRecord;
  name: string;
  reportPath: string;
}

function recordOf(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableCounter(value: unknown): number | null {
  return value === null ? null : nonNegativeInteger(value);
}

function safeCode(value: unknown): string | null {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : null;
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

async function readJson(path: string, code: string): Promise<JsonRecord> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(`${code}: required current formal artifact is missing`);
    }
    throw error;
  }
  try {
    const parsed = recordOf(JSON.parse(text));
    if (parsed === null) throw new Error("not an object");
    return parsed;
  } catch {
    throw new Error(`${code}: current formal artifact is not a JSON object`);
  }
}

async function readOptionalJson(path: string, code: string): Promise<JsonRecord | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  try {
    const parsed = recordOf(JSON.parse(text));
    if (parsed === null) throw new Error("not an object");
    return parsed;
  } catch {
    throw new Error(`${code}: current stage artifact is not a JSON object`);
  }
}

function caseDirectory(suiteDir: string, directory: string): string {
  const normalized = directory.replace(/\\/g, "/");
  if (
    normalized.length === 0 ||
    isAbsolute(directory) ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("SUITE_REPORT_CASE_DIRECTORY_INVALID: case directories must be non-empty relative paths without traversal");
  }
  const suiteRoot = resolve(suiteDir);
  const candidate = resolve(suiteRoot, directory);
  const rel = relative(suiteRoot, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..\\`) || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error("SUITE_REPORT_CASE_DIRECTORY_INVALID: case directory escapes the current suite root");
  }
  return candidate;
}

function parseSuiteManifest(raw: JsonRecord): SuiteCaseBinding[] {
  if (raw.schemaVersion !== 1 || raw.suite !== CURRENT_SUITE || !Array.isArray(raw.cases)) {
    throw new Error(`SUITE_REPORT_MANIFEST_INVALID: expected schemaVersion=1 and suite=${CURRENT_SUITE}`);
  }
  if (raw.cases.length !== 3) {
    throw new Error("SUITE_REPORT_CASE_COUNT_INVALID: the current formal suite requires exactly three cases");
  }
  const cases = raw.cases.map((value, index): SuiteCaseBinding => {
    const entry = recordOf(value);
    const id = entry?.id;
    const order = nonNegativeInteger(entry?.order);
    const directory = entry?.directory ?? id;
    const contractSha256 = entry?.contractSha256;
    if (
      typeof id !== "string" || !SAFE_ID.test(id) ||
      order !== index + 1 ||
      typeof directory !== "string" ||
      typeof contractSha256 !== "string" || !SHA256.test(contractSha256)
    ) {
      throw new Error("SUITE_REPORT_CASE_BINDING_INVALID: cases require safe unique ids, orders 1..3, relative directories, and contract SHA-256 bindings");
    }
    return { id, order, directory, contractSha256 };
  });
  if (new Set(cases.map((entry) => entry.id)).size !== cases.length ||
      new Set(cases.map((entry) => entry.directory)).size !== cases.length) {
    throw new Error("SUITE_REPORT_CASE_BINDING_INVALID: case ids and directories must be unique");
  }
  return cases;
}

function assertCurrentScoringIdentity(value: unknown, contractSha256: string, code: string): void {
  const identity = recordOf(value);
  if (
    identity?.contractSha256 !== contractSha256 ||
    identity.profileVersion !== DEFAULT_U1_SCORING_PROFILE.version ||
    identity.taskVerifierVersion !== DEFAULT_U1_SCORING_PROFILE.taskVerifierVersion ||
    identity.rubricVersion !== DEFAULT_U1_SCORING_PROFILE.rubricVersion
  ) {
    throw new Error(`${code}: artifact does not carry the current scoring identity`);
  }
}

function assertFormalFlags(value: JsonRecord, code: string): void {
  if (
    value.confirmationMode !== "human" ||
    value.humanConfirmationBypassed !== false ||
    value.formalEvidence !== true
  ) {
    throw new Error(`${code}: live stage evidence must be formal human evidence with no bypass`);
  }
}

async function assertFormalCase(caseDir: string, expectedContractSha256: string): Promise<void> {
  const formalDir = join(caseDir, FORMAL_DIRECTORY);
  const [manifest, contract, card, review, approval] = await Promise.all([
    readJson(join(formalDir, "evaluation-manifest.v3.json"), "SUITE_REPORT_FORMAL_MANIFEST_INVALID"),
    readJson(join(formalDir, "evaluation-contract.v3.json"), "SUITE_REPORT_FORMAL_CONTRACT_INVALID"),
    readJson(join(formalDir, "task-card.confirmed.json"), "SUITE_REPORT_TASK_CARD_INVALID"),
    readJson(join(formalDir, "evaluation-review.confirmed.json"), "SUITE_REPORT_EVALUATION_REVIEW_INVALID"),
    readJson(join(formalDir, "formal-evaluation-approval.v3.json"), "SUITE_REPORT_FORMAL_APPROVAL_INVALID"),
  ]);
  const taskConfirmation = recordOf(card.confirmation);
  const reviewConfirmation = recordOf(review.confirmation);
  const formalApproval = recordOf(approval.formal);
  const scoringProfile = recordOf(contract.scoringProfile);
  if (
    manifest.schemaVersion !== 3 ||
    manifest.contractSha256 !== expectedContractSha256 ||
    manifest.confirmationMode !== "human" ||
    manifest.humanConfirmationBypassed !== false ||
    !Array.isArray(manifest.trainItemIds) || manifest.trainItemIds.length !== 8 ||
    !Array.isArray(manifest.selectItemIds) || manifest.selectItemIds.length !== 6 ||
    !Array.isArray(manifest.holdoutItemIds) || manifest.holdoutItemIds.length !== 3 ||
    contract.schemaVersion !== 3 ||
    contract.contractSha256 !== expectedContractSha256 ||
    contract.confirmationMode !== "human" ||
    contract.humanConfirmationBypassed !== false ||
    scoringProfile?.version !== DEFAULT_U1_SCORING_PROFILE.version ||
    scoringProfile.taskVerifierVersion !== DEFAULT_U1_SCORING_PROFILE.taskVerifierVersion ||
    scoringProfile.rubricVersion !== DEFAULT_U1_SCORING_PROFILE.rubricVersion ||
    taskConfirmation?.status !== "confirmed" ||
    taskConfirmation.confirmationMode !== "human" ||
    taskConfirmation.confirmedContentSha256 !== manifest.taskCardHash ||
    reviewConfirmation?.status !== "confirmed" ||
    reviewConfirmation.confirmationMode !== "human" ||
    reviewConfirmation.humanReviewed !== true ||
    reviewConfirmation.confirmedContentSha256 !== manifest.evaluationReviewHash ||
    approval.kind !== "u1-formal-evaluation-approval" ||
    approval.confirmationMode !== "human" ||
    approval.humanReviewed !== true ||
    approval.formalEligible !== true ||
    formalApproval === null ||
    formalApproval.taskCardSha256 !== manifest.taskCardHash ||
    formalApproval.evaluationReviewBindingSha256 !== manifest.evaluationReviewHash
  ) {
    throw new Error("SUITE_REPORT_FORMAL_BINDING_INVALID: case is not a current human 2/2 formal contract bound to 8/6/3 splits");
  }
}

async function chooseArtifact(args: {
  stageDir: string;
  caseId: string;
  resultName: string;
  failureName: string;
  code: string;
}): Promise<ArtifactChoice | null> {
  const [result, failure] = await Promise.all([
    readOptionalJson(join(args.stageDir, args.resultName), args.code),
    readOptionalJson(join(args.stageDir, args.failureName), args.code),
  ]);
  if (result !== null && failure !== null) {
    throw new Error(`${args.code}: current result and failure artifacts are mutually exclusive`);
  }
  const raw = result ?? failure;
  if (raw === null) return null;
  const name = result !== null ? args.resultName : args.failureName;
  return {
    raw,
    name,
    reportPath: `${args.caseId}/${FORMAL_DIRECTORY}/${STAGE_DIRECTORY}/${name}`,
  };
}

function emptyTokens(): CurrentTokenTelemetry {
  return {
    promptTokens: null,
    promptCacheHitTokens: null,
    promptCacheMissTokens: null,
    completionTokens: null,
    responses: null,
    responsesWithUsage: null,
    responsesMissingUsage: null,
  };
}

function tokenTelemetryOf(raw: JsonRecord): CurrentTokenTelemetry {
  const liveRun = recordOf(raw.liveRun);
  const telemetry = recordOf(raw.providerTokenTelemetry) ??
    recordOf(raw.tokenTelemetry) ??
    recordOf(liveRun?.providerTokenTelemetry) ??
    recordOf(liveRun?.tokenTelemetry);
  if (telemetry === null) return emptyTokens();
  return {
    promptTokens: nullableCounter(telemetry.promptTokens),
    promptCacheHitTokens: nullableCounter(telemetry.promptCacheHitTokens),
    promptCacheMissTokens: nullableCounter(telemetry.promptCacheMissTokens),
    completionTokens: nullableCounter(telemetry.completionTokens),
    responses: nullableCounter(telemetry.responses),
    responsesWithUsage: nullableCounter(telemetry.responsesWithUsage),
    responsesMissingUsage: nullableCounter(telemetry.responsesMissingUsage),
  };
}

function accountingOf(raw: JsonRecord | null): CurrentStageAccounting {
  const accounting = recordOf(raw?.accounting);
  return {
    logicalCalls: nonNegativeInteger(accounting?.logicalCalls) ?? 0,
    httpAttempts: nonNegativeInteger(accounting?.httpAttempts) ?? 0,
    transportRetryAttempts: nonNegativeInteger(accounting?.retryAttempts) ?? 0,
  };
}

function cacheOf(raw: JsonRecord): CurrentStageReport["cache"] {
  const cache = recordOf(raw.cache) ?? recordOf(recordOf(raw.liveRun)?.cache);
  const hits = nonNegativeInteger(cache?.hits);
  const misses = nonNegativeInteger(cache?.misses);
  const stores = nonNegativeInteger(cache?.stores);
  return hits === null || misses === null || stores === null ? null : { hits, misses, stores };
}

function elapsedOf(raw: JsonRecord): number | null {
  return finiteNumber(raw.totalWallTimeMs) ??
    finiteNumber(recordOf(raw.parallelism)?.totalWallTimeMs) ??
    finiteNumber(raw.wallTimeMs);
}

function currentBudgetOf(raw: JsonRecord, required: boolean, code: string): CurrentStageBudget | null {
  const budget = recordOf(raw.budget);
  const envelope = recordOf(budget?.envelope);
  if (budget === null || envelope === null) {
    if (required) throw new Error(`${code}: current public/Direct evidence requires its independent dynamic budget`);
    return null;
  }
  const minimum = nonNegativeInteger(budget.minimum);
  const authorized = nonNegativeInteger(budget.authorized);
  const baseline = nonNegativeInteger(envelope.baselineEstimate);
  const envelopeAuthorized = nonNegativeInteger(envelope.authorizedLogicalCalls);
  const recoveryReserve = nonNegativeInteger(envelope.existingRecoveryReserve);
  if (
    budget.independent !== true ||
    minimum === null || minimum < 1 ||
    authorized === null || authorized < 1 ||
    baseline !== minimum || envelopeAuthorized !== authorized ||
    recoveryReserve === null
  ) {
    throw new Error(`${code}: current dynamic budget binding is invalid`);
  }
  return {
    baselineEstimate: baseline,
    authorizedLogicalCalls: authorized,
    independent: true,
    existingRecoveryReserve: recoveryReserve,
  };
}

function semanticRecoveryOf(raw: JsonRecord, budget: CurrentStageBudget, code: string): CurrentSemanticRecovery {
  const actual = nonNegativeInteger(raw.actualApplicationRecoveryAttempts);
  const diagnosticsObserved = Array.isArray(raw.structureRecoveryDiagnostics)
    ? raw.structureRecoveryDiagnostics.length
    : 0;
  if (actual === null || actual > budget.existingRecoveryReserve) {
    throw new Error(`${code}: application schema recovery does not fit the current stage reserve`);
  }
  return { reserve: budget.existingRecoveryReserve, actual, diagnosticsObserved };
}

function errorCodeOf(raw: JsonRecord): string | null {
  return safeCode(raw.code) ?? safeCode(recordOf(raw.safeError)?.code);
}

function stageReport(args: {
  status: StageStatus;
  artifact: ArtifactChoice | null;
  budget: CurrentStageBudget | null;
  recovery: CurrentSemanticRecovery;
}): CurrentStageReport {
  const raw = args.artifact?.raw ?? null;
  return {
    status: args.status,
    artifactPath: args.artifact?.reportPath ?? null,
    errorCode: raw === null ? null : errorCodeOf(raw),
    accounting: accountingOf(raw),
    tokens: raw === null ? emptyTokens() : tokenTelemetryOf(raw),
    elapsedMs: raw === null ? null : elapsedOf(raw),
    cache: raw === null ? null : cacheOf(raw),
    budget: args.budget,
    semanticRecovery: args.recovery,
  };
}

function zeroRecovery(): CurrentSemanticRecovery {
  return { reserve: 0, actual: 0, diagnosticsObserved: 0 };
}

async function calibrationStage(stageDir: string, caseId: string, contractSha256: string): Promise<CurrentStageReport> {
  const artifact = await chooseArtifact({
    stageDir,
    caseId,
    resultName: "calibration-evidence.json",
    failureName: "calibration-failure.json",
    code: "SUITE_REPORT_CALIBRATION_INVALID",
  });
  const plan = calculateCalibrationBudget();
  const budget: CurrentStageBudget = {
    baselineEstimate: plan.primaryPasses,
    authorizedLogicalCalls: plan.authorizedLogicalCalls,
    independent: true,
    existingRecoveryReserve: plan.schemaRecoveryReserve,
  };
  if (plan.primaryPasses !== 2 || plan.schemaRecoveryReserve !== 2 || plan.authorizedLogicalCalls !== 4) {
    throw new Error("SUITE_REPORT_CALIBRATION_BUDGET_INVALID: current calibration must authorize 2 primary passes plus 2 schema repairs (H=4)");
  }
  if (artifact === null) return stageReport({ status: "not_run", artifact, budget, recovery: { reserve: 2, actual: 0, diagnosticsObserved: 0 } });
  const passed = LiveCalibrationEvidenceSchema.safeParse(artifact.raw);
  const failed = LiveCalibrationFailureEvidenceSchema.safeParse(artifact.raw);
  const parsed = passed.success ? passed.data : failed.success ? failed.data : null;
  if (parsed === null || parsed.contractSha256 !== contractSha256) {
    throw new Error("SUITE_REPORT_CALIBRATION_INVALID: calibration artifact is not current formal-human evidence for this contract");
  }
  return stageReport({
    status: passed.success ? "completed" : "failed",
    artifact,
    budget,
    recovery: {
      reserve: 2,
      actual: parsed.actualApplicationRecoveryAttempts,
      diagnosticsObserved: parsed.structureRecoveryDiagnostics.length,
    },
  });
}

async function adaptiveStage(stageDir: string, caseId: string, contractSha256: string): Promise<CurrentStageReport> {
  const artifact = await chooseArtifact({
    stageDir,
    caseId,
    resultName: "adaptive-result.json",
    failureName: "adaptive-failure.json",
    code: "SUITE_REPORT_ADAPTIVE_INVALID",
  });
  if (artifact === null) return stageReport({ status: "not_run", artifact, budget: null, recovery: zeroRecovery() });
  const raw = artifact.raw;
  assertFormalFlags(raw, "SUITE_REPORT_ADAPTIVE_INVALID");
  if (raw.semanticResponseBindingVersion !== SEMANTIC_RESPONSE_BINDING_VERSION) {
    throw new Error("SUITE_REPORT_ADAPTIVE_INVALID: adaptive artifact uses a retired semantic response identity");
  }
  assertCurrentScoringIdentity(raw.scoringIdentity, contractSha256, "SUITE_REPORT_ADAPTIVE_INVALID");
  const status = artifact.name === "adaptive-result.json" ? "completed" : "failed";
  if (status === "completed" && (typeof raw.stopReason !== "string" || !/^[a-z0-9_]+$/.test(raw.stopReason))) {
    throw new Error("SUITE_REPORT_ADAPTIVE_INVALID: completed Adaptive evidence requires a safe stop reason");
  }
  const adaptiveBudget = recordOf(raw.adaptiveBudget);
  const envelope = recordOf(adaptiveBudget?.envelope);
  const budget = envelope === null ? null : {
    baselineEstimate: nonNegativeInteger(envelope.baselineEstimate) ?? 0,
    authorizedLogicalCalls: nonNegativeInteger(envelope.authorizedLogicalCalls) ?? 0,
    independent: true as const,
    existingRecoveryReserve: nonNegativeInteger(envelope.existingRecoveryReserve) ?? 0,
  };
  const recovery = budget && nonNegativeInteger(raw.actualApplicationRecoveryAttempts) !== null
    ? semanticRecoveryOf(raw, budget, "SUITE_REPORT_ADAPTIVE_INVALID")
    : zeroRecovery();
  return stageReport({ status, artifact, budget, recovery });
}

async function publicStage(stageDir: string, caseId: string, contractSha256: string): Promise<{
  stage: CurrentStageReport;
  decision: CurrentFormalCaseReport["publicDecision"];
}> {
  const artifact = await chooseArtifact({
    stageDir,
    caseId,
    resultName: "public-selection-result.json",
    failureName: "public-selection-failure.json",
    code: "SUITE_REPORT_PUBLIC_SELECTION_INVALID",
  });
  const emptyDecision: CurrentFormalCaseReport["publicDecision"] = {
    verdict: null,
    startingReferenceId: null,
    finalPublicChampionId: null,
    scoreDelta: null,
    criticalRegression: null,
  };
  if (artifact === null) return { stage: stageReport({ status: "not_run", artifact, budget: null, recovery: zeroRecovery() }), decision: emptyDecision };
  const raw = artifact.raw;
  assertFormalFlags(raw, "SUITE_REPORT_PUBLIC_SELECTION_INVALID");
  if (
    raw.schemaVersion !== 2 ||
    raw.semanticResponseBindingVersion !== SEMANTIC_RESPONSE_BINDING_VERSION ||
    raw.phase !== "public-select" ||
    raw.contractSha256 !== contractSha256
  ) {
    throw new Error("SUITE_REPORT_PUBLIC_SELECTION_INVALID: public-select artifact is not the current schema for this contract");
  }
  const selection = recordOf(raw.selection);
  const identity = selection?.scoringIdentity ?? raw.scoringIdentity;
  assertCurrentScoringIdentity(identity, contractSha256, "SUITE_REPORT_PUBLIC_SELECTION_INVALID");
  const budget = currentBudgetOf(raw, true, "SUITE_REPORT_PUBLIC_SELECTION_INVALID")!;
  const recovery = semanticRecoveryOf(raw, budget, "SUITE_REPORT_PUBLIC_SELECTION_INVALID");
  if (accountingOf(raw).logicalCalls > budget.authorizedLogicalCalls) {
    throw new Error("SUITE_REPORT_PUBLIC_SELECTION_INVALID: public-select accounting exceeds its independent budget");
  }
  const failed = artifact.name === "public-selection-failure.json";
  if (failed) return { stage: stageReport({ status: "failed", artifact, budget, recovery }), decision: emptyDecision };
  if (raw.status !== "completed") {
    throw new Error("SUITE_REPORT_PUBLIC_SELECTION_INVALID: result artifact must be completed");
  }
  const currentArtifact = PublicSelectionResultArtifactSchema.safeParse(raw);
  if (!currentArtifact.success) {
    throw new Error("SUITE_REPORT_PUBLIC_SELECTION_INVALID: completed public-select result fails current relational validation");
  }
  const decision = currentArtifact.data.selection.decision;
  return {
    stage: stageReport({ status: "completed", artifact, budget, recovery }),
    decision: {
      verdict: decision.verdict,
      startingReferenceId: typeof decision.startingReferenceId === "string" && SAFE_ID.test(decision.startingReferenceId)
        ? decision.startingReferenceId
        : null,
      finalPublicChampionId: typeof decision.finalPublicChampionId === "string" && SAFE_ID.test(decision.finalPublicChampionId)
        ? decision.finalPublicChampionId
        : null,
      scoreDelta: finiteNumber(decision.scoreDelta),
      criticalRegression: decision.criticalRegression,
    },
  };
}

const DIRECT_RESULTS = new Set(["higher_public_score", "tied_public_score", "lower_public_score", "candidate_rejected"]);

async function directStage(stageDir: string, caseId: string, contractSha256: string): Promise<{
  stage: CurrentStageReport;
  comparison: CurrentFormalCaseReport["directComparison"];
}> {
  const artifact = await chooseArtifact({
    stageDir,
    caseId,
    resultName: "direct-result.json",
    failureName: "direct-failure.json",
    code: "SUITE_REPORT_DIRECT_INVALID",
  });
  const empty: CurrentFormalCaseReport["directComparison"] = { status: "not_run", relativeToStarting: null, scoreDelta: null };
  if (artifact === null) return { stage: stageReport({ status: "not_run", artifact, budget: null, recovery: zeroRecovery() }), comparison: empty };
  const raw = artifact.raw;
  assertFormalFlags(raw, "SUITE_REPORT_DIRECT_INVALID");
  if (
    raw.schemaVersion !== 1 ||
    raw.semanticResponseBindingVersion !== SEMANTIC_RESPONSE_BINDING_VERSION ||
    raw.phase !== "direct-public-select" ||
    raw.contractSha256 !== contractSha256 ||
    raw.directPromptContractVersion !== DIRECT_U1_PROMPT_CONTRACT_VERSION ||
    raw.directPromptContractSha256 !== DIRECT_U1_PROMPT_CONTRACT_SHA256
  ) {
    throw new Error("SUITE_REPORT_DIRECT_INVALID: Direct artifact is not the current frozen Direct schema for this contract");
  }
  assertCurrentScoringIdentity(raw.scoringIdentity, contractSha256, "SUITE_REPORT_DIRECT_INVALID");
  const budget = currentBudgetOf(raw, true, "SUITE_REPORT_DIRECT_INVALID")!;
  const recovery = semanticRecoveryOf(raw, budget, "SUITE_REPORT_DIRECT_INVALID");
  if (accountingOf(raw).logicalCalls > budget.authorizedLogicalCalls) {
    throw new Error("SUITE_REPORT_DIRECT_INVALID: Direct accounting exceeds its independent budget");
  }
  const failed = artifact.name === "direct-failure.json";
  if (failed) {
    return {
      stage: stageReport({ status: "failed", artifact, budget, recovery }),
      comparison: { status: "failed", relativeToStarting: null, scoreDelta: null },
    };
  }
  if (raw.status !== "completed") {
    throw new Error("SUITE_REPORT_DIRECT_INVALID: Direct result artifact must be completed");
  }
  const comparison = recordOf(raw.comparison);
  const relative = recordOf(comparison?.relativeToStarting);
  const capabilityRejected = raw.directStatus === "candidate_rejected" || raw.directCandidateOutcome === "rejected_by_capability_gate";
  const result = capabilityRejected
    ? "candidate_rejected"
    : typeof relative?.result === "string" && DIRECT_RESULTS.has(relative.result)
      ? relative.result as CurrentFormalCaseReport["directComparison"]["relativeToStarting"]
      : null;
  return {
    stage: stageReport({ status: "completed", artifact, budget, recovery }),
    comparison: {
      status: capabilityRejected ? "candidate_rejected" : "completed",
      relativeToStarting: result,
      scoreDelta: finiteNumber(relative?.scoreDelta),
    },
  };
}

async function sealedStage(stageDir: string, caseId: string, contractSha256: string): Promise<{
  stage: CurrentStageReport;
  sealed: CurrentFormalCaseReport["sealed"];
}> {
  const artifact = await chooseArtifact({
    stageDir,
    caseId,
    resultName: "audit-compare.json",
    failureName: "audit-compare-failure.json",
    code: "SUITE_REPORT_SEALED_INVALID",
  });
  const notRun: CurrentFormalCaseReport["sealed"] = {
    status: "not_run",
    bodyReads: 0,
    applicationRecoveryReserve: 0,
    applicationRecoveryAttempts: 0,
  };
  if (artifact === null) return { stage: stageReport({ status: "not_run", artifact, budget: null, recovery: zeroRecovery() }), sealed: notRun };
  const raw = artifact.raw;
  const actualRecovery = nonNegativeInteger(raw.actualApplicationRecoveryAttempts) ?? 0;
  const diagnostics = Array.isArray(raw.structureRecoveryDiagnostics) ? raw.structureRecoveryDiagnostics.length : 0;
  const envelope = recordOf(recordOf(raw.budget)?.envelope);
  const reserve = envelope === null ? 0 : nonNegativeInteger(envelope.existingRecoveryReserve);
  if (actualRecovery !== 0 || diagnostics !== 0 || (reserve !== null && reserve !== 0)) {
    throw new Error("SUITE_REPORT_SEALED_RECOVERY_FORBIDDEN: sealed evidence cannot contain application schema recovery");
  }
  if (raw.contractSha256 !== contractSha256 || raw.formalEvidence !== true || raw.verificationMode !== "live-formal") {
    throw new Error("SUITE_REPORT_SEALED_INVALID: sealed artifact is not bound to the current formal contract");
  }
  if (raw.scoringIdentity !== undefined) {
    assertCurrentScoringIdentity(raw.scoringIdentity, contractSha256, "SUITE_REPORT_SEALED_INVALID");
  }
  if (artifact.name === "audit-compare-failure.json") {
    if (raw.status !== "failed" || raw.bodyReads !== 1 || raw.applicationRetryAllowed !== false) {
      throw new Error("SUITE_REPORT_SEALED_INVALID: sealed failure must preserve one-shot evidence");
    }
    return {
      stage: stageReport({ status: "failed", artifact, budget: null, recovery: zeroRecovery() }),
      sealed: { status: "failed", bodyReads: 1, applicationRecoveryReserve: 0, applicationRecoveryAttempts: 0 },
    };
  }
  if (raw.status === "holdout_not_entered") {
    if (raw.bodyReads !== 0) throw new Error("SUITE_REPORT_SEALED_INVALID: holdout_not_entered must record zero body reads");
    return {
      stage: stageReport({ status: "completed", artifact, budget: null, recovery: zeroRecovery() }),
      sealed: { status: "holdout_not_entered", bodyReads: 0, applicationRecoveryReserve: 0, applicationRecoveryAttempts: 0 },
    };
  }
  if (
    (raw.status !== "sealed_confirmed" && raw.status !== "sealed_rejected") ||
    raw.bodyReads !== 1 ||
    raw.applicationRetryAllowed !== false ||
    raw.secondSealedAllowed !== false
  ) {
    throw new Error("SUITE_REPORT_SEALED_INVALID: completed sealed evidence must remain one-shot");
  }
  const budget = currentBudgetOf(raw, true, "SUITE_REPORT_SEALED_INVALID");
  return {
    stage: stageReport({ status: "completed", artifact, budget, recovery: zeroRecovery() }),
    sealed: {
      status: raw.status,
      bodyReads: 1,
      applicationRecoveryReserve: 0,
      applicationRecoveryAttempts: 0,
    },
  };
}

function sumAccounting(stages: readonly CurrentStageReport[]): CurrentStageAccounting {
  return stages.reduce<CurrentStageAccounting>((sum, stage) => ({
    logicalCalls: sum.logicalCalls + stage.accounting.logicalCalls,
    httpAttempts: sum.httpAttempts + stage.accounting.httpAttempts,
    transportRetryAttempts: sum.transportRetryAttempts + stage.accounting.transportRetryAttempts,
  }), { logicalCalls: 0, httpAttempts: 0, transportRetryAttempts: 0 });
}

function sumNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0);
}

function sumTokens(stages: readonly CurrentStageReport[]): CurrentTokenTelemetry {
  return {
    promptTokens: sumNullable(stages.map((stage) => stage.tokens.promptTokens)),
    promptCacheHitTokens: sumNullable(stages.map((stage) => stage.tokens.promptCacheHitTokens)),
    promptCacheMissTokens: sumNullable(stages.map((stage) => stage.tokens.promptCacheMissTokens)),
    completionTokens: sumNullable(stages.map((stage) => stage.tokens.completionTokens)),
    responses: sumNullable(stages.map((stage) => stage.tokens.responses)),
    responsesWithUsage: sumNullable(stages.map((stage) => stage.tokens.responsesWithUsage)),
    responsesMissingUsage: sumNullable(stages.map((stage) => stage.tokens.responsesMissingUsage)),
  };
}

async function aggregateCase(suiteDir: string, binding: SuiteCaseBinding): Promise<CurrentFormalCaseReport> {
  const caseDir = caseDirectory(suiteDir, binding.directory);
  await assertFormalCase(caseDir, binding.contractSha256);
  const stageDir = join(caseDir, FORMAL_DIRECTORY, STAGE_DIRECTORY);
  const [calibration, adaptive, publicResult, directResult, sealedResult] = await Promise.all([
    calibrationStage(stageDir, binding.id, binding.contractSha256),
    adaptiveStage(stageDir, binding.id, binding.contractSha256),
    publicStage(stageDir, binding.id, binding.contractSha256),
    directStage(stageDir, binding.id, binding.contractSha256),
    sealedStage(stageDir, binding.id, binding.contractSha256),
  ]);
  return {
    caseId: binding.id,
    order: binding.order,
    contractSha256: binding.contractSha256,
    formalEvidence: {
      confirmationMode: "human",
      humanConfirmations: { required: 2, completed: 2 },
      humanConfirmationBypassed: false,
    },
    scoringIdentity: {
      profileVersion: DEFAULT_U1_SCORING_PROFILE.version,
      taskVerifierVersion: DEFAULT_U1_SCORING_PROFILE.taskVerifierVersion,
      rubricVersion: DEFAULT_U1_SCORING_PROFILE.rubricVersion,
    },
    stages: {
      calibration,
      adaptive,
      publicSelect: publicResult.stage,
      direct: directResult.stage,
      sealed: sealedResult.stage,
    },
    publicDecision: publicResult.decision,
    directComparison: directResult.comparison,
    sealed: sealedResult.sealed,
    releaseStatus: "release_withheld",
  };
}

/**
 * Aggregate exactly three current formal-human U1 cases. This reader never
 * opens holdout bodies and never copies prompts, responses, confirmation
 * identities, absolute paths, or artifact prose into the public report.
 */
export async function aggregateU1TechnicalSuiteReport(args: {
  suiteDir: string;
  now?: () => string;
}): Promise<U1TechnicalSuiteReport> {
  const manifest = parseSuiteManifest(await readJson(
    join(args.suiteDir, "SUITE_MANIFEST.json"),
    "SUITE_REPORT_MANIFEST_INVALID",
  ));
  const cases: CurrentFormalCaseReport[] = [];
  for (const binding of manifest) {
    cases.push(await aggregateCase(args.suiteDir, binding));
  }
  const stages = cases.flatMap((entry) => Object.values(entry.stages));
  const calibration = calculateCalibrationBudget();
  return {
    schemaVersion: 1,
    reportKind: "u1-current-formal",
    suite: CURRENT_SUITE,
    createdAt: (args.now ?? (() => new Date().toISOString()))(),
    evidenceBoundary: {
      confirmationMode: "human",
      humanConfirmationsPerCase: { required: 2, completed: 2 },
      humanConfirmationBypassed: false,
      holdoutContentReadByReporter: false,
      releaseStatus: "release_withheld",
    },
    scoringIdentity: {
      profileVersion: DEFAULT_U1_SCORING_PROFILE.version,
      taskVerifierVersion: DEFAULT_U1_SCORING_PROFILE.taskVerifierVersion,
      rubricVersion: DEFAULT_U1_SCORING_PROFILE.rubricVersion,
    },
    directPromptContract: {
      version: DIRECT_U1_PROMPT_CONTRACT_VERSION,
      sha256: DIRECT_U1_PROMPT_CONTRACT_SHA256,
    },
    calibrationBudget: {
      primaryPasses: calibration.primaryPasses,
      schemaRecoveryReserve: calibration.schemaRecoveryReserve,
      authorizedLogicalCalls: calibration.authorizedLogicalCalls,
    },
    cases,
    totals: {
      accounting: sumAccounting(stages),
      semanticSchemaRepairs: stages.reduce((sum, stage) => sum + stage.semanticRecovery.actual, 0),
      tokens: sumTokens(stages),
    },
    sameModelLimitation:
      "Proposer and semantic evaluation may use the same provider/model family. Strict schemas, deterministic verification and separated public, Direct and sealed stages reduce but do not eliminate circular self-validation; current model evidence is not independent human evaluation or proof of general effectiveness.",
  };
}
