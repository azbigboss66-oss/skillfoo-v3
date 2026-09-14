import { createHash, randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import {
  LiveCalibrationEvidenceSchema,
  LiveCalibrationFailureEvidenceSchema,
  SEMANTIC_RESPONSE_BINDING_VERSION,
} from "../types.js";

const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{1,127}$/;
const UNRECOGNIZED_ERROR_CODE = "UNRECOGNIZED_ERROR_CODE";
const STAGE_ATTEMPT_SAFE_ERROR_CODES = new Set([
  UNRECOGNIZED_ERROR_CODE,
  "CALIBRATION_CONTRACT_DRIFT",
  "CALIBRATION_PROVIDER_DRIFT",
  "CALIBRATION_RUN_ERROR",
  "DIRECT_PUBLIC_BINDING_INVALID",
  "DIRECT_REFINER_INVALID",
  "DIRECT_REFINER_INVALID_JSON",
  "DIRECT_REFINER_NOOP",
  "DIRECT_REFINER_PROVIDER_FAILED",
  "DIRECT_REFINER_U1_BOUNDARY_VIOLATION",
  "DIRECT_RUN_FAILED",
  "DIRECT_U1_BOUNDARY_VIOLATION",
  "DIRECT_U1_INVALID",
  "DIRECT_U1_INVALID_JSON",
  "DIRECT_U1_PROVIDER_FAILED",
  "HTTP_4XX_CLIENT_ERROR",
  "HTTP_5XX_SERVER_ERROR",
  "LIVE_MUTATION_PROVIDER_FAILED",
  "LIVE_MUTATION_U1_BOUNDARY_VIOLATION",
  "LIVE_PROPOSAL_INVALID_JSON",
  "LIVE_PROPOSAL_FILE_SCOPE_VIOLATION",
  "MUTATION_PROVIDER_FAILED",
  "NO_VALID_CHILD",
  "NETWORK_ERROR",
  "PROVIDER_BUDGET_ERROR",
  "PROVIDER_BUDGET_EXCEEDED",
  "PROVIDER_CHECK_AUTH_REQUIRED",
  "PROVIDER_CHECK_FAILED",
  "PROVIDER_CHECK_NON_JSON_RESPONSE",
  "PROVIDER_EMPTY_RESPONSE",
  "PROVIDER_HTTP_ERROR",
  "PROVIDER_NETWORK_ERROR",
  "PROVIDER_NO_CHOICES",
  "PROVIDER_NON_JSON_BODY",
  "PROVIDER_TIMEOUT",
  "PROVIDER_TRUNCATED_OUTPUT",
  "PROVIDER_UNSUPPORTED_SCHEMA",
  "PUBLIC_SELECTION_FAILED",
  "PUBLIC_SELECTION_ITEM_MISMATCH",
  "PUBLIC_SELECTION_NO_SAFE_ROOT",
  "PUBLIC_SELECTION_NO_VALID_CANDIDATE",
  "PUBLIC_SELECTION_PROVIDER_FAILED",
  "REQUEST_TIMEOUT",
  "SEMANTIC_JUDGE_BATCH_SIZE_INVALID",
  "SEMANTIC_JUDGE_CONTEXT_MISSING",
  "SEMANTIC_JUDGE_DIMENSION_MISMATCH",
  "SEMANTIC_JUDGE_INVALID",
  "SEMANTIC_JUDGE_INVALID_JSON",
  "SEMANTIC_JUDGE_ITEM_MISMATCH",
  "SEMANTIC_JUDGE_ITEM_ORDER_MISMATCH",
  "SEMANTIC_JUDGE_OVERALL_REASON_INVALID",
  "SEMANTIC_JUDGE_PROVIDER_FAILED",
  "SEMANTIC_JUDGE_SPLIT_VIOLATION",
  "STAGE_BUDGET_EXCEEDED",
  "UNKNOWN_ERROR",
]);

export const StageAttemptTriggerSchema = z.enum([
  "calibration",
  "adaptive",
  "public-select",
  "direct",
]);
export type StageAttemptTrigger = z.infer<typeof StageAttemptTriggerSchema>;

const StageAttemptExpectedBindingSchema = z.object({
  contractSha256: z.string().regex(SHA256_RE),
  semanticResponseBindingVersion: z.literal(SEMANTIC_RESPONSE_BINDING_VERSION),
  confirmationMode: z.literal("human"),
  directPromptContractVersion: z.string().regex(SAFE_VERSION_RE).optional(),
  directPromptContractSha256: z.string().regex(SHA256_RE).optional(),
}).strict().superRefine((binding, ctx) => {
  if ((binding.directPromptContractVersion === undefined) !== (binding.directPromptContractSha256 === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Direct prompt version and SHA must be supplied together" });
  }
});
export type StageAttemptArchiveExpectedBinding = z.infer<typeof StageAttemptExpectedBindingSchema>;

const StageAttemptEvidenceFlagsSchema = z.object({
  confirmationMode: z.literal("human"),
  explorationOnly: z.literal(false),
  humanConfirmationBypassed: z.literal(false),
  formalEvidence: z.literal(true),
  sealedAllowed: z.literal(false),
  releaseAllowed: z.literal(false),
}).strict();

const StageAttemptAccountingSchema = z.object({
  certainty: z.enum(["exact", "lower_bound"]),
  logicalCalls: z.number().int().nonnegative(),
  httpAttempts: z.number().int().nonnegative(),
  retryAttempts: z.number().int().nonnegative(),
}).strict();

const StageAttemptTokenTelemetrySchema = z.object({
  certainty: z.enum(["exact", "lower_bound"]),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  responses: z.number().int().nonnegative(),
}).strict();

const StageAttemptArtifactSchema = z.object({
  basename: z.enum([
    "calibration-evidence.json",
    "calibration-failure.json",
    "adaptive-result.json",
    "adaptive-events.jsonl",
    "adaptive-failure.json",
    "public-selection-result.json",
    "public-selection-failure.json",
    "direct-result.json",
    "direct-failure.json",
  ]),
  stage: z.enum(["calibration", "adaptive", "public-select", "direct"]),
  role: z.enum(["accounting-source", "supporting"]),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(SHA256_RE),
  sourceSchemaVersion: z.union([z.literal(1), z.literal(2), z.literal("unavailable")]),
}).strict();

const StageAttemptMeasurementSchema = z.object({
  stage: z.enum(["calibration", "adaptive", "public-select", "direct"]),
  status: z.enum(["completed", "failed"]),
  sourceArtifactSha256: z.string().regex(SHA256_RE),
  accountingScope: z.literal("this_attempt"),
  accountingAvailability: z.enum(["recorded", "unavailable"]),
  accounting: StageAttemptAccountingSchema,
  tokenTelemetry: StageAttemptTokenTelemetrySchema.optional(),
  elapsedTimeMs: z.number().nonnegative().finite().optional(),
  safeErrorCodes: z.array(z.string().regex(SAFE_ERROR_CODE_RE).refine(
    (code) => STAGE_ATTEMPT_SAFE_ERROR_CODES.has(code),
    "error code is not in the archive allowlist",
  )),
}).strict();

export const StageAttemptSummarySchema = z.object({
  schemaVersion: z.literal(1),
  evidenceClass: z.literal("stage-attempt-archive"),
  attemptName: z.string().regex(/^(?:calibration|adaptive|public-select|direct)-attempt-[1-9][0-9]*$/),
  attemptSequence: z.number().int().positive(),
  stage: StageAttemptTriggerSchema,
  status: z.enum(["completed", "failed"]),
  archivedAt: z.string().datetime({ offset: true }),
  accountingScope: z.literal("this_attempt"),
  evidenceFlags: StageAttemptEvidenceFlagsSchema,
  expectedBinding: StageAttemptExpectedBindingSchema,
  sourceBinding: z.object({
    contractSha256: z.string().regex(SHA256_RE),
    contractAvailability: z.literal("complete"),
    semanticResponseBindingVersion: z.literal(SEMANTIC_RESPONSE_BINDING_VERSION),
    semanticBindingAvailability: z.literal("complete"),
    directPromptContractVersion: z.string().regex(SAFE_VERSION_RE).optional(),
    directPromptContractSha256: z.string().regex(SHA256_RE).optional(),
    directPromptContractAvailability: z.literal("complete").optional(),
    compatibility: z.literal("verified"),
  }).strict(),
  artifacts: z.array(StageAttemptArtifactSchema).min(1),
  measurements: z.array(StageAttemptMeasurementSchema).min(1),
}).strict().superRefine((summary, ctx) => {
  const expectedName = `${summary.stage}-attempt-${summary.attemptSequence}`;
  if (summary.attemptName !== expectedName) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "attempt name/sequence mismatch" });
  }
  const basenames = summary.artifacts.map((artifact) => artifact.basename);
  if (new Set(basenames).size !== basenames.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate archived basename" });
  }
  for (const artifact of summary.artifacts) {
    const expectedRole = artifact.basename === "adaptive-events.jsonl" ? "supporting" : "accounting-source";
    if (
      !CANONICALS[summary.stage].includes(artifact.basename) ||
      artifact.stage !== STAGE_OF[artifact.basename] ||
      artifact.role !== expectedRole
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "artifact basename/stage/role/trigger mismatch" });
    }
  }
  const sources = summary.artifacts
    .filter((artifact) => artifact.role === "accounting-source")
    .map((artifact) => ({
      sha256: artifact.sha256,
      stage: artifact.stage,
      status: artifact.basename.endsWith("-failure.json") ? "failed" as const : "completed" as const,
    }));
  const measurementSourceShas = summary.measurements.map((measurement) => measurement.sourceArtifactSha256);
  if (
    summary.measurements.length !== sources.length ||
    new Set(measurementSourceShas).size !== measurementSourceShas.length ||
    sources.some((source) => summary.measurements.filter((measurement) =>
      source.sha256 === measurement.sourceArtifactSha256 &&
      source.stage === measurement.stage &&
      source.status === measurement.status
    ).length !== 1)
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "measurements must uniquely bind source basename stage/status" });
  }
  if (
    summary.status !== (summary.measurements.some((measurement) => measurement.status === "failed") ? "failed" : "completed") ||
    summary.evidenceFlags.confirmationMode !== summary.expectedBinding.confirmationMode
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "summary status/evidence binding mismatch" });
  }
  const expectedDirectPrompt = summary.expectedBinding.directPromptContractVersion !== undefined;
  const sourceDirectPromptFields = [
    summary.sourceBinding.directPromptContractVersion,
    summary.sourceBinding.directPromptContractSha256,
    summary.sourceBinding.directPromptContractAvailability,
  ];
  if (
    sourceDirectPromptFields.some((value) => value !== undefined) !== expectedDirectPrompt ||
    (expectedDirectPrompt && sourceDirectPromptFields.some((value) => value === undefined))
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "summary Direct prompt binding presence mismatch" });
  }
});

export type StageAttemptSummary = z.infer<typeof StageAttemptSummarySchema>;

export type StageAttemptArchiveErrorCode =
  | "STAGE_ATTEMPT_ARCHIVE_INPUT_INVALID"
  | "STAGE_ATTEMPT_ARCHIVE_FILE_SET_INVALID"
  | "STAGE_ATTEMPT_ARCHIVE_ARTIFACT_INVALID"
  | "STAGE_ATTEMPT_ARCHIVE_BINDING_INVALID"
  | "STAGE_ATTEMPT_ARCHIVE_COLLISION"
  | "STAGE_ATTEMPT_ARCHIVE_WRITE_FAILED"
  | "STAGE_ATTEMPT_ARCHIVE_VERIFY_FAILED"
  | "STAGE_ATTEMPT_ARCHIVE_CANONICAL_DRIFT"
  | "STAGE_ATTEMPT_ARCHIVE_RENAME_FAILED"
  | "STAGE_ATTEMPT_ARCHIVE_CANONICAL_REMOVE_FAILED"
  | "STAGE_ATTEMPT_ARCHIVE_ROLLBACK_FAILED";

export class StageAttemptArchiveError extends Error {
  constructor(readonly code: StageAttemptArchiveErrorCode) {
    super(code);
    this.name = "StageAttemptArchiveError";
  }
}

export interface ArchiveSupersededStageAttemptInput {
  evidenceDir: string;
  trigger: StageAttemptTrigger;
  expectedBinding: StageAttemptArchiveExpectedBinding;
  now?: () => string;
  /** @internal Deterministic fault injection for filesystem contract tests. */
  testFault?: "write" | "rename" | "remove" | "collision" | "drift";
}

export type ArchiveSupersededStageAttemptResult =
  | { kind: "none" }
  | {
      kind: "archived";
      attemptName: string;
      attemptSequence: number;
      recoveredCommittedArchive: boolean;
    };

type CanonicalBasename = StageAttemptSummary["artifacts"][number]["basename"];
type MeasurementStage = StageAttemptSummary["measurements"][number]["stage"];
type JsonObject = Record<string, unknown>;

const CANONICALS: Record<StageAttemptTrigger, readonly CanonicalBasename[]> = {
  calibration: ["calibration-evidence.json", "calibration-failure.json"],
  adaptive: [
    "adaptive-result.json",
    "adaptive-events.jsonl",
    "adaptive-failure.json",
    "public-selection-result.json",
    "public-selection-failure.json",
  ],
  "public-select": ["public-selection-result.json", "public-selection-failure.json"],
  direct: ["direct-result.json", "direct-failure.json"],
};

const STAGE_OF: Record<CanonicalBasename, MeasurementStage> = {
  "calibration-evidence.json": "calibration",
  "calibration-failure.json": "calibration",
  "adaptive-result.json": "adaptive",
  "adaptive-events.jsonl": "adaptive",
  "adaptive-failure.json": "adaptive",
  "public-selection-result.json": "public-select",
  "public-selection-failure.json": "public-select",
  "direct-result.json": "direct",
  "direct-failure.json": "direct",
};

const RESULT_BASENAMES = new Set<CanonicalBasename>([
  "calibration-evidence.json",
  "adaptive-result.json",
  "public-selection-result.json",
  "direct-result.json",
]);

interface SourceSnapshot {
  basename: CanonicalBasename;
  bytes: Buffer;
  sha256: string;
  raw: JsonObject | null;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function objectOf(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function nestedObject(raw: JsonObject, key: string): JsonObject | null {
  return objectOf(raw[key]);
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function safeErrorCodes(raw: JsonObject): string[] {
  const nested = nestedObject(raw, "safeError");
  const values = [raw.errorCode, raw.code, nested?.code];
  return [...new Set(values.flatMap((value) => {
    if (typeof value !== "string") return [];
    return [SAFE_ERROR_CODE_RE.test(value) && STAGE_ATTEMPT_SAFE_ERROR_CODES.has(value)
      ? value
      : UNRECOGNIZED_ERROR_CODE];
  }))];
}

function evidenceFlagsOf(raw: JsonObject): StageAttemptSummary["evidenceFlags"] | null {
  const evidence = nestedObject(raw, "evidence");
  const confirmationMode = raw.confirmationMode ?? evidence?.confirmationMode;
  const explorationOnly = raw.explorationOnly ?? evidence?.explorationOnly;
  const humanConfirmationBypassed = raw.humanConfirmationBypassed ?? evidence?.humanConfirmationBypassed;
  const formalEvidence = raw.formalEvidence;
  const sealedAllowed = raw.sealedAllowed;
  const releaseAllowed = raw.releaseAllowed;
  const parsed = StageAttemptEvidenceFlagsSchema.safeParse({
    confirmationMode,
    explorationOnly,
    humanConfirmationBypassed,
    formalEvidence,
    sealedAllowed,
    releaseAllowed,
  });
  return parsed.success ? parsed.data : null;
}

function observedContract(raw: JsonObject): string | null {
  if (typeof raw.contractSha256 === "string" && SHA256_RE.test(raw.contractSha256)) {
    return raw.contractSha256;
  }
  const events = Array.isArray(raw.events) ? raw.events.map(objectOf).filter((event): event is JsonObject => event !== null) : [];
  const runStarts = events.filter((event) => event.type === "run_start");
  if (runStarts.length === 1 && typeof runStarts[0].contractSha256 === "string" && SHA256_RE.test(runStarts[0].contractSha256)) {
    return runStarts[0].contractSha256;
  }
  return null;
}

function observedDirectPromptBinding(raw: JsonObject): { version: string; sha256: string } | null {
  const version = raw.directPromptContractVersion;
  const sha256 = raw.directPromptContractSha256;
  if (version === undefined && sha256 === undefined) return null;
  if (
    typeof version !== "string" || !SAFE_VERSION_RE.test(version) ||
    typeof sha256 !== "string" || !SHA256_RE.test(sha256)
  ) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_ARTIFACT_INVALID");
  }
  return { version, sha256 };
}

function accountingOf(raw: JsonObject): {
  availability: "recorded" | "unavailable";
  accounting: StageAttemptSummary["measurements"][number]["accounting"];
} {
  const direct = nestedObject(raw, "accounting");
  const observation = nestedObject(raw, "observation");
  const observed = observation === null ? null : nestedObject(observation, "lastObservedAccounting");
  const source = direct ?? observed;
  if (source === null) {
    return {
      availability: "unavailable",
      accounting: { certainty: "lower_bound", logicalCalls: 0, httpAttempts: 0, retryAttempts: 0 },
    };
  }
  const logicalCalls = nonNegativeInteger(source.logicalCalls);
  const httpAttempts = nonNegativeInteger(source.httpAttempts);
  const retryAttempts = nonNegativeInteger(source.retryAttempts);
  if (logicalCalls === null || httpAttempts === null || retryAttempts === null) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_ARTIFACT_INVALID");
  }
  if (
    source.certainty !== undefined &&
    source.certainty !== "exact" &&
    source.certainty !== "lower_bound" &&
    source.certainty !== "lower-bound"
  ) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_ARTIFACT_INVALID");
  }
  const qualifier = observation?.accountingQualifier;
  const lowerBound = source.certainty === "lower_bound" || source.certainty === "lower-bound" ||
    (typeof qualifier === "string" && /lower[-_ ]bound/i.test(qualifier));
  return {
    availability: "recorded",
    accounting: {
      certainty: lowerBound ? "lower_bound" : "exact",
      logicalCalls,
      httpAttempts,
      retryAttempts,
    },
  };
}

function tokensOf(raw: JsonObject): StageAttemptSummary["measurements"][number]["tokenTelemetry"] {
  const tokenTelemetry = nestedObject(raw, "tokenTelemetry");
  if (tokenTelemetry === null) return undefined;
  if (
    tokenTelemetry.certainty !== undefined &&
    tokenTelemetry.certainty !== "exact" &&
    tokenTelemetry.certainty !== "lower_bound"
  ) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_ARTIFACT_INVALID");
  }
  const responses = nonNegativeInteger(tokenTelemetry.responses);
  const promptTokens = nonNegativeInteger(tokenTelemetry.promptTokens);
  const completionTokens = nonNegativeInteger(tokenTelemetry.completionTokens);
  if (responses === null) return undefined;
  return {
    certainty: tokenTelemetry.certainty === "lower_bound" || promptTokens === null || completionTokens === null
      ? "lower_bound"
      : "exact",
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    responses,
  };
}

function elapsedOf(raw: JsonObject): number | undefined {
  const parallelism = nestedObject(raw, "parallelism");
  for (const value of [raw.totalWallTimeMs, raw.wallTimeMs, parallelism?.totalWallTimeMs]) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readSnapshots(evidenceDir: string, trigger: StageAttemptTrigger): Promise<SourceSnapshot[]> {
  const snapshots: SourceSnapshot[] = [];
  for (const basename of CANONICALS[trigger]) {
    const path = join(evidenceDir, basename);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_FILE_SET_INVALID");
    }
    if (basename === "adaptive-events.jsonl") {
      const lines = bytes.toString("utf8").split("\n").filter((line) => line.trim().length > 0);
      try {
        if (lines.length === 0 || lines.some((line) => objectOf(JSON.parse(line) as unknown) === null)) throw new Error();
      } catch {
        throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_ARTIFACT_INVALID");
      }
      snapshots.push({ basename, bytes, sha256: digest(bytes), raw: null });
      continue;
    }
    let raw: JsonObject | null;
    try {
      raw = objectOf(JSON.parse(bytes.toString("utf8")) as unknown);
    } catch {
      raw = null;
    }
    if (raw === null) throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_ARTIFACT_INVALID");
    snapshots.push({ basename, bytes, sha256: digest(bytes), raw });
  }
  return snapshots;
}

function validateFileSet(trigger: StageAttemptTrigger, snapshots: SourceSnapshot[]): void {
  const names = new Set(snapshots.map((snapshot) => snapshot.basename));
  const exactlyOne = (left: CanonicalBasename, right: CanonicalBasename): boolean => names.has(left) !== names.has(right);
  if (snapshots.length === 0) return;
  if (trigger === "calibration" && !exactlyOne("calibration-evidence.json", "calibration-failure.json")) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_FILE_SET_INVALID");
  }
  if (trigger === "public-select" && !exactlyOne("public-selection-result.json", "public-selection-failure.json")) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_FILE_SET_INVALID");
  }
  if (trigger === "direct" && !exactlyOne("direct-result.json", "direct-failure.json")) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_FILE_SET_INVALID");
  }
  if (trigger === "adaptive") {
    const result = names.has("adaptive-result.json");
    const events = names.has("adaptive-events.jsonl");
    const failure = names.has("adaptive-failure.json");
    const publicResult = names.has("public-selection-result.json");
    const publicFailure = names.has("public-selection-failure.json");
    if (
      (result ? !events || failure : events || !failure) ||
      (publicResult && publicFailure) ||
      (failure && (publicResult || publicFailure))
    ) {
      throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_FILE_SET_INVALID");
    }
    if (result && (publicResult || publicFailure)) {
      const adaptive = snapshots.find((snapshot) => snapshot.basename === "adaptive-result.json")!;
      const downstream = snapshots.find((snapshot) =>
        snapshot.basename === "public-selection-result.json" || snapshot.basename === "public-selection-failure.json"
      )!;
      const downstreamAdaptiveSha = downstream.raw?.adaptiveResultSha256;
      if (
        (downstream.basename === "public-selection-result.json" && downstreamAdaptiveSha !== adaptive.sha256) ||
        (downstream.basename === "public-selection-failure.json" &&
          downstreamAdaptiveSha !== undefined && downstreamAdaptiveSha !== adaptive.sha256)
      ) {
        throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_BINDING_INVALID");
      }
    }
  }
}

const ArchivedStageRecoveryDiagnosticSchema = z.object({
  subject: z.object({
    kind: z.literal("stage"),
    stage: z.enum(["public-select", "direct"]),
  }).strict(),
  attempt: z.union([z.literal(1), z.literal(2)]),
  failureCode: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  findingCodes: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/)),
  responseLength: z.number().int().nonnegative(),
  finishReason: z.enum(["stop", "length", "content_filter", "tool_calls", "other"]).nullable(),
  responseSha256: z.string().regex(SHA256_RE),
}).strict();

function currentStageRecoveryEvidenceValid(
  raw: JsonObject,
  stage: "public-select" | "direct",
  completed: boolean,
): boolean {
  const budget = nestedObject(raw, "budget");
  const envelope = budget === null ? null : nestedObject(budget, "envelope");
  const accounting = nestedObject(raw, "accounting");
  const reserve = nonNegativeInteger(envelope?.existingRecoveryReserve);
  const logicalCalls = nonNegativeInteger(accounting?.logicalCalls);
  const actual = nonNegativeInteger(raw.actualApplicationRecoveryAttempts);
  const diagnostics = z.array(ArchivedStageRecoveryDiagnosticSchema).safeParse(raw.structureRecoveryDiagnostics);
  if (reserve === null || logicalCalls === null || actual === null || !diagnostics.success) return false;
  if (diagnostics.data.some((entry) => entry.subject.stage !== stage)) return false;
  const rejectedPrimary = diagnostics.data.filter((entry) => entry.attempt === 1).length;
  const rejectedRepair = diagnostics.data.filter((entry) => entry.attempt === 2).length;
  return actual === rejectedPrimary &&
    rejectedPrimary <= 1 &&
    actual <= reserve &&
    actual <= logicalCalls &&
    rejectedRepair <= rejectedPrimary &&
    (completed ? rejectedRepair === 0 : rejectedRepair <= 1);
}

function validateAccountingSourceShape(snapshot: SourceSnapshot): void {
  if (snapshot.raw === null) return;
  const raw = snapshot.raw;
  const expectedFailure = snapshot.basename.endsWith("-failure.json");
  const status = raw.status;
  if (
    (expectedFailure && status !== "failed") ||
    (!expectedFailure && snapshot.basename !== "adaptive-result.json" && status !== "completed" && status !== "passed")
  ) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_ARTIFACT_INVALID");
  }
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1 && raw.schemaVersion !== 2) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_ARTIFACT_INVALID");
  }
  const accounting = nestedObject(raw, "accounting");
  const safeError = nestedObject(raw, "safeError");
  const objectKeysPresent = (...keys: string[]): boolean => keys.every((key) => nestedObject(raw, key) !== null);
  const hashKeysValid = (...keys: string[]): boolean => keys.every(
    (key) => typeof raw[key] === "string" && SHA256_RE.test(raw[key] as string),
  );
  let knownShape = false;
  if (snapshot.basename === "calibration-evidence.json") {
    knownShape = LiveCalibrationEvidenceSchema.safeParse(raw).success;
  } else if (snapshot.basename === "calibration-failure.json") {
    knownShape = LiveCalibrationFailureEvidenceSchema.safeParse(raw).success;
  } else if (snapshot.basename === "adaptive-result.json") {
    const events = Array.isArray(raw.events) ? raw.events.map(objectOf).filter((event): event is JsonObject => event !== null) : [];
    knownShape = typeof raw.stopReason === "string" &&
      Array.isArray(raw.candidates) && raw.candidates.length >= 2 &&
      objectKeysPresent("population", "accounting", "u1Intake", "publicContract", "liveRun", "evidence") &&
      Array.isArray(raw.generations) && Array.isArray(raw.pinnedItemIds) &&
      events.filter((event) => event.type === "run_start").length === 1;
  } else if (snapshot.basename === "adaptive-failure.json") {
    knownShape = raw.schemaVersion === 1 && status === "failed" && raw.phase === "adaptive-run" &&
      safeError !== null && Array.isArray(raw.events) &&
      objectKeysPresent("accounting", "liveRun", "evidence");
  } else if (snapshot.basename === "public-selection-result.json") {
    knownShape = raw.schemaVersion === 2 &&
      status === "completed" && raw.phase === "public-select" &&
      hashKeysValid("contractSha256", "selectItemsSha256", "adaptiveResultSha256") &&
      objectKeysPresent("selection", "budget", "accounting", "provider") &&
      currentStageRecoveryEvidenceValid(raw, "public-select", true);
  } else if (snapshot.basename === "public-selection-failure.json") {
    knownShape = raw.schemaVersion === 1 && status === "failed" && raw.phase === "public-select" &&
      hashKeysValid("contractSha256", "selectItemsSha256", "adaptiveResultSha256") &&
      safeError !== null && currentStageRecoveryEvidenceValid(raw, "public-select", false);
  } else if (snapshot.basename === "direct-result.json") {
    const isScored = nestedObject(raw, "comparison") !== null;
    const isCapabilityRejected = raw.directCandidateOutcome === "rejected_by_capability_gate" &&
      nestedObject(raw, "directCandidate") !== null;
    knownShape = raw.schemaVersion === 1 && status === "completed" && raw.phase === "direct-public-select" &&
      hashKeysValid(
        "contractSha256",
        "selectItemsSha256",
        "adaptiveResultSha256",
        "publicSelectionResultSha256",
        "b0SkillSha256",
        "directInstructionSha256",
      ) && (isScored || isCapabilityRejected) &&
      objectKeysPresent("budget", "accounting", "parallelism", "provider", "promptBoundary") &&
      currentStageRecoveryEvidenceValid(raw, "direct", true);
  } else if (snapshot.basename === "direct-failure.json") {
    knownShape = raw.schemaVersion === 1 && status === "failed" && raw.phase === "direct-public-select" &&
      safeError !== null && accounting !== null && currentStageRecoveryEvidenceValid(raw, "direct", false);
  }
  if (!knownShape) throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_ARTIFACT_INVALID");
}

function buildSummary(args: {
  snapshots: SourceSnapshot[];
  trigger: StageAttemptTrigger;
  expectedBinding: StageAttemptArchiveExpectedBinding;
  attemptName: string;
  attemptSequence: number;
  archivedAt: string;
}): StageAttemptSummary {
  const sources = args.snapshots.filter((snapshot) => snapshot.raw !== null);
  sources.forEach(validateAccountingSourceShape);
  const flags = sources.map((snapshot) => evidenceFlagsOf(snapshot.raw!));
  if (flags.some((entry) => entry === null)) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_ARTIFACT_INVALID");
  }
  const firstFlags = flags[0]!;
  if (
    firstFlags.confirmationMode !== args.expectedBinding.confirmationMode ||
    flags.some((entry) => JSON.stringify(entry) !== JSON.stringify(firstFlags))
  ) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_BINDING_INVALID");
  }

  const observedContracts = sources.map((snapshot) => observedContract(snapshot.raw!));
  const observedVersions = sources.map((snapshot) => snapshot.raw!.semanticResponseBindingVersion);
  if (
    observedContracts.some((value) => value !== args.expectedBinding.contractSha256) ||
    observedVersions.some((value) => value !== SEMANTIC_RESPONSE_BINDING_VERSION)
  ) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_BINDING_INVALID");
  }
  const expectsDirectPrompt = args.expectedBinding.directPromptContractVersion !== undefined &&
    args.expectedBinding.directPromptContractSha256 !== undefined;
  if (expectsDirectPrompt && args.trigger !== "direct") {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_BINDING_INVALID");
  }
  const observedDirectPrompts = expectsDirectPrompt
    ? sources.map((snapshot) => observedDirectPromptBinding(snapshot.raw!))
    : [];
  if (expectsDirectPrompt && observedDirectPrompts.some((value) =>
    value === null ||
    value.version !== args.expectedBinding.directPromptContractVersion ||
    value.sha256 !== args.expectedBinding.directPromptContractSha256
  )) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_BINDING_INVALID");
  }

  const measurements: StageAttemptSummary["measurements"] = sources.map((snapshot) => {
    const measured = accountingOf(snapshot.raw!);
    const tokenTelemetry = tokensOf(snapshot.raw!);
    const elapsedTimeMs = elapsedOf(snapshot.raw!);
    return {
      stage: STAGE_OF[snapshot.basename],
      status: RESULT_BASENAMES.has(snapshot.basename) ? "completed" : "failed",
      sourceArtifactSha256: snapshot.sha256,
      accountingScope: "this_attempt",
      accountingAvailability: measured.availability,
      accounting: measured.accounting,
      ...(tokenTelemetry === undefined ? {} : { tokenTelemetry }),
      ...(elapsedTimeMs === undefined ? {} : { elapsedTimeMs }),
      safeErrorCodes: safeErrorCodes(snapshot.raw!),
    };
  });
  const summary: StageAttemptSummary = {
    schemaVersion: 1,
    evidenceClass: "stage-attempt-archive",
    attemptName: args.attemptName,
    attemptSequence: args.attemptSequence,
    stage: args.trigger,
    status: measurements.some((measurement) => measurement.status === "failed") ? "failed" : "completed",
    archivedAt: args.archivedAt,
    accountingScope: "this_attempt",
    evidenceFlags: firstFlags,
    expectedBinding: args.expectedBinding,
    sourceBinding: {
      contractSha256: args.expectedBinding.contractSha256,
      contractAvailability: "complete",
      semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
      semanticBindingAvailability: "complete",
      ...(expectsDirectPrompt
        ? {
            directPromptContractVersion: args.expectedBinding.directPromptContractVersion!,
            directPromptContractSha256: args.expectedBinding.directPromptContractSha256!,
            directPromptContractAvailability: "complete" as const,
          }
        : {}),
      compatibility: "verified",
    },
    artifacts: args.snapshots.map((snapshot) => ({
      basename: snapshot.basename,
      stage: STAGE_OF[snapshot.basename],
      role: snapshot.raw === null ? "supporting" : "accounting-source",
      bytes: snapshot.bytes.byteLength,
      sha256: snapshot.sha256,
      sourceSchemaVersion: snapshot.raw?.schemaVersion === 1 || snapshot.raw?.schemaVersion === 2
        ? snapshot.raw.schemaVersion
        : "unavailable",
    })),
    measurements,
  };
  const parsed = StageAttemptSummarySchema.safeParse(summary);
  if (!parsed.success) throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_ARTIFACT_INVALID");
  return parsed.data;
}

async function verifyArchiveDirectory(path: string, expected: StageAttemptSummary): Promise<void> {
  let summary: StageAttemptSummary;
  try {
    summary = StageAttemptSummarySchema.parse(JSON.parse(await readFile(join(path, "attempt-summary.json"), "utf8")));
  } catch {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_VERIFY_FAILED");
  }
  if (JSON.stringify(summary) !== JSON.stringify(expected)) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_VERIFY_FAILED");
  }
  for (const artifact of summary.artifacts) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(path, artifact.basename));
    } catch {
      throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_VERIFY_FAILED");
    }
    if (bytes.byteLength !== artifact.bytes || digest(bytes) !== artifact.sha256) {
      throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_VERIFY_FAILED");
    }
  }
  const entries = (await readdir(path)).sort();
  const expectedEntries = [...summary.artifacts.map((artifact) => artifact.basename), "attempt-summary.json"].sort();
  if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_VERIFY_FAILED");
  }
}

/** Read-only verifier used by reporters; archived raw paths remain internal. */
export async function readVerifiedStageAttemptSummary(attemptDir: string): Promise<StageAttemptSummary> {
  let summary: StageAttemptSummary;
  try {
    summary = StageAttemptSummarySchema.parse(JSON.parse(
      await readFile(join(attemptDir, "attempt-summary.json"), "utf8"),
    ));
  } catch {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_VERIFY_FAILED");
  }
  if (basename(attemptDir) !== summary.attemptName) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_VERIFY_FAILED");
  }
  await verifyArchiveDirectory(attemptDir, summary);
  const snapshots = await readSnapshots(attemptDir, summary.stage);
  validateFileSet(summary.stage, snapshots);
  const rebuilt = buildSummary({
    snapshots,
    trigger: summary.stage,
    expectedBinding: summary.expectedBinding,
    attemptName: summary.attemptName,
    attemptSequence: summary.attemptSequence,
    archivedAt: summary.archivedAt,
  });
  if (JSON.stringify(rebuilt) !== JSON.stringify(summary)) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_VERIFY_FAILED");
  }
  return summary;
}

async function assertCanonicalUnchanged(evidenceDir: string, trigger: StageAttemptTrigger, snapshots: SourceSnapshot[]): Promise<void> {
  const byName = new Map(snapshots.map((snapshot) => [snapshot.basename, snapshot]));
  for (const basename of CANONICALS[trigger]) {
    const expected = byName.get(basename);
    const path = join(evidenceDir, basename);
    if (expected === undefined) {
      if (await exists(path)) throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_CANONICAL_DRIFT");
      continue;
    }
    let current: Buffer;
    try {
      current = await readFile(path);
    } catch {
      throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_CANONICAL_DRIFT");
    }
    if (current.byteLength !== expected.bytes.byteLength || digest(current) !== expected.sha256) {
      throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_CANONICAL_DRIFT");
    }
  }
}

async function restoreCanonical(evidenceDir: string, snapshots: SourceSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    const path = join(evidenceDir, snapshot.basename);
    if (await exists(path)) {
      const current = await readFile(path);
      if (digest(current) !== snapshot.sha256) {
        throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_ROLLBACK_FAILED");
      }
      continue;
    }
    await writeFile(path, snapshot.bytes, { flag: "wx" });
    const restored = await readFile(path);
    if (digest(restored) !== snapshot.sha256) {
      throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_ROLLBACK_FAILED");
    }
  }
}

async function clearCanonical(evidenceDir: string, snapshots: SourceSnapshot[], injectRemoveFault: boolean): Promise<void> {
  try {
    if (injectRemoveFault) throw new Error("injected remove failure");
    for (const snapshot of snapshots) {
      await rm(join(evidenceDir, snapshot.basename));
    }
  } catch {
    try {
      await restoreCanonical(evidenceDir, snapshots);
    } catch (error) {
      if (error instanceof StageAttemptArchiveError) throw error;
      throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_ROLLBACK_FAILED");
    }
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_CANONICAL_REMOVE_FAILED");
  }
}

async function attemptDirectories(attemptsDir: string, trigger: StageAttemptTrigger): Promise<Array<{ name: string; sequence: number }>> {
  let entries;
  try {
    entries = await readdir(attemptsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const matcher = new RegExp(`^${trigger}-attempt-([1-9][0-9]*)$`);
  return entries.flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const match = matcher.exec(entry.name);
    return match === null ? [] : [{ name: entry.name, sequence: Number(match[1]) }];
  }).sort((left, right) => left.sequence - right.sequence);
}

async function findCommittedRecovery(args: {
  evidenceDir: string;
  attemptsDir: string;
  trigger: StageAttemptTrigger;
  expectedBinding: StageAttemptArchiveExpectedBinding;
  snapshots: SourceSnapshot[];
}): Promise<{ summary: StageAttemptSummary; snapshots: SourceSnapshot[] } | null> {
  if (args.snapshots.length === 0) return null;
  const current = new Map(args.snapshots.map((snapshot) => [snapshot.basename, snapshot.sha256]));
  const dirs = (await attemptDirectories(args.attemptsDir, args.trigger)).reverse();
  for (const dir of dirs) {
    const attemptDir = join(args.attemptsDir, dir.name);
    if (!await exists(join(attemptDir, "attempt-summary.json"))) continue;
    let summary: StageAttemptSummary;
    try {
      summary = await readVerifiedStageAttemptSummary(attemptDir);
    } catch {
      throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_VERIFY_FAILED");
    }
    if (
      summary.stage !== args.trigger ||
      JSON.stringify(summary.expectedBinding) !== JSON.stringify(args.expectedBinding)
    ) continue;
    const archived = new Map(summary.artifacts.map((artifact) => [artifact.basename, artifact.sha256]));
    const everyPresentMatches = [...current].every(([basename, sha256]) => archived.get(basename) === sha256);
    const noUnexpectedCanonical = CANONICALS[args.trigger].every((basename) => !current.has(basename) || archived.has(basename));
    if (everyPresentMatches && noUnexpectedCanonical) return { summary, snapshots: args.snapshots };
  }
  return null;
}

/**
 * Archive only the fixed canonical files owned by a known live stage.
 *
 * The directory transaction assumes one writer for an evidence directory. On
 * Windows/OneDrive, callers must not run two stage writers against the same
 * directory concurrently; this module intentionally does not invent a lock
 * service. It does detect directory collisions and canonical SHA drift.
 */
export async function archiveSupersededStageAttempt(
  input: ArchiveSupersededStageAttemptInput,
): Promise<ArchiveSupersededStageAttemptResult> {
  const trigger = StageAttemptTriggerSchema.safeParse(input.trigger);
  const expectedBinding = StageAttemptExpectedBindingSchema.safeParse(input.expectedBinding);
  if (!trigger.success || !expectedBinding.success || typeof input.evidenceDir !== "string" || input.evidenceDir.length === 0) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_INPUT_INVALID");
  }
  const hasDirectPromptBinding = expectedBinding.data.directPromptContractVersion !== undefined;
  if ((trigger.data === "direct") !== hasDirectPromptBinding) {
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_INPUT_INVALID");
  }
  const attemptsDir = join(input.evidenceDir, "attempts");
  const snapshots = await readSnapshots(input.evidenceDir, trigger.data);
  const recovery = await findCommittedRecovery({
    evidenceDir: input.evidenceDir,
    attemptsDir,
    trigger: trigger.data,
    expectedBinding: expectedBinding.data,
    snapshots,
  });
  if (recovery !== null) {
    await clearCanonical(input.evidenceDir, recovery.snapshots, input.testFault === "remove");
    return {
      kind: "archived",
      attemptName: recovery.summary.attemptName,
      attemptSequence: recovery.summary.attemptSequence,
      recoveredCommittedArchive: true,
    };
  }
  validateFileSet(trigger.data, snapshots);
  if (snapshots.length === 0) return { kind: "none" };

  await mkdir(attemptsDir, { recursive: true });
  const existing = await attemptDirectories(attemptsDir, trigger.data);
  const attemptSequence = (existing.at(-1)?.sequence ?? 0) + 1;
  const attemptName = `${trigger.data}-attempt-${attemptSequence}`;
  const finalDir = join(attemptsDir, attemptName);
  if (await exists(finalDir)) throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_COLLISION");
  const tempDir = join(attemptsDir, `.${attemptName}.tmp-${randomBytes(6).toString("hex")}`);
  const archivedAt = (input.now ?? (() => new Date().toISOString()))();
  const summary = buildSummary({
    snapshots,
    trigger: trigger.data,
    expectedBinding: expectedBinding.data,
    attemptName,
    attemptSequence,
    archivedAt,
  });

  let committed = false;
  try {
    await mkdir(tempDir, { recursive: false });
    if (input.testFault === "write") {
      throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_WRITE_FAILED");
    }
    for (const snapshot of snapshots) {
      await writeFile(join(tempDir, snapshot.basename), snapshot.bytes, { flag: "wx" });
    }
    await writeFile(
      join(tempDir, "attempt-summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await verifyArchiveDirectory(tempDir, summary);
    if (input.testFault === "drift") {
      await writeFile(join(input.evidenceDir, snapshots[0].basename), Buffer.concat([snapshots[0].bytes, Buffer.from(" ")]));
    }
    await assertCanonicalUnchanged(input.evidenceDir, trigger.data, snapshots);
    if (input.testFault === "rename") {
      throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_RENAME_FAILED");
    }
    if (input.testFault === "collision") await mkdir(finalDir, { recursive: false });
    if (await exists(finalDir)) throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_COLLISION");
    try {
      await rename(tempDir, finalDir);
    } catch {
      throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_RENAME_FAILED");
    }
    committed = true;
    await verifyArchiveDirectory(finalDir, summary);
  } catch (error) {
    if (!committed) await rm(tempDir, { recursive: true, force: true });
    if (error instanceof StageAttemptArchiveError) throw error;
    throw new StageAttemptArchiveError("STAGE_ATTEMPT_ARCHIVE_WRITE_FAILED");
  }

  await clearCanonical(input.evidenceDir, snapshots, input.testFault === "remove");
  return {
    kind: "archived",
    attemptName,
    attemptSequence,
    recoveredCommittedArchive: false,
  };
}
