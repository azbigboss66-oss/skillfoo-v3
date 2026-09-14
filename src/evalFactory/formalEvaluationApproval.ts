import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { calibrationSourceSha256 } from "../evaluation/calibration.js";
import { authorizeEvidenceMode, EvidenceModeError } from "../intake/evidenceMode.js";
import {
  completeTaskCardIntentDetails,
  stableStringify,
  taskCardContentSha256,
} from "../intake/taskCard.js";
import {
  evaluationCurationPath,
  evaluationDraftPath,
  evaluationReviewConfirmedPath,
  evaluationReviewDraftPath,
  evaluationReviewMarkdownPath,
  taskCardConfirmedPath,
  taskCardDraftPath,
} from "../storage/paths.js";
import {
  ConfirmationModeSchema,
  CurationResultSchema,
  EvaluationDraftSchema,
  EvaluationReviewSchema,
  TaskCardSchema,
  U1BDraftItemSchema,
  type ConfirmationMode,
  type CurationResult,
  type DraftItem,
  type EvaluationDraft,
  type EvaluationReview,
  type TaskCard,
} from "../types.js";
import {
  assertEvaluationReviewBindings,
  confirmEvaluationReview,
  createEvaluationReview,
  evaluationDraftContentSha256,
  evaluationReviewConfirmationSha256,
  evaluationReviewContentSha256,
  renderEvaluationReviewZh,
} from "./evaluationReview.js";
import { curationContentSha256 } from "./freezeContract.js";

export const FORMAL_EVALUATION_LANE_DIRNAME = "formal-evidence";
export const FORMAL_EVALUATION_APPROVAL_FILENAME = "formal-evaluation-approval.v3.json";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const ItemBindingSchema = z.object({
  itemId: z.string().trim().min(1),
  split: z.enum(["public", "holdout"]),
  selectionRole: z.enum(["train", "select"]).optional(),
  sourceContentSha256: Sha256Schema,
  formalContentSha256: Sha256Schema,
}).strict();

const ArtifactBindingSchema = z.object({
  taskCardSha256: Sha256Schema,
  taskCardConfirmationSha256: Sha256Schema,
  evaluationDraftSha256: Sha256Schema,
  curationSha256: Sha256Schema,
  evaluationReviewContentSha256: Sha256Schema,
  evaluationReviewDocumentSha256: Sha256Schema,
  evaluationReviewBindingSha256: Sha256Schema,
  itemSetSha256: Sha256Schema,
  calibrationSha256: Sha256Schema,
}).strict();

export const FormalEvaluationApprovalRecordSchema = z.object({
  schemaVersion: z.literal(3),
  kind: z.literal("u1-formal-evaluation-approval"),
  createdAt: z.string().min(1),
  confirmedBy: z.string().trim().min(1),
  confirmationMode: ConfirmationModeSchema,
  humanReviewed: z.boolean(),
  formalEligible: z.boolean(),
  source: ArtifactBindingSchema,
  formal: ArtifactBindingSchema,
  itemBindings: z.array(ItemBindingSchema).min(1),
  calibrationBinding: z.object({
    sourceItemId: z.string().trim().min(1),
    sourceItemSha256: Sha256Schema,
    sourceContentSha256: Sha256Schema,
    formalContentSha256: Sha256Schema,
  }).strict(),
  approvalSha256: Sha256Schema,
}).strict().superRefine((value, ctx) => {
  if (value.humanReviewed !== (value.confirmationMode === "human")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["humanReviewed"],
      message: "humanReviewed is true only for a real human confirmation",
    });
  }
  if (value.formalEligible !== (value.confirmationMode === "human")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["formalEligible"],
      message: "only a real human confirmation is eligible for formal execution",
    });
  }
});

export type FormalEvaluationApprovalRecord = z.infer<typeof FormalEvaluationApprovalRecordSchema>;

export type FormalEvaluationApprovalErrorCode =
  | "FORMAL_TASK_CARD_CONFIRMATION_REQUIRED"
  | "FORMAL_TASK_CARD_INTENT_INCOMPLETE"
  | "FORMAL_REVIEW_CONFIRMATION_REQUIRED"
  | "FORMAL_APPROVAL_OPERATOR_REQUIRED"
  | "FORMAL_APPROVAL_INPUT_INVALID"
  | "FORMAL_APPROVAL_HASH_DRIFT"
  | "FORMAL_APPROVAL_SOURCE_ALREADY_CONFIRMED"
  | "FORMAL_FIXTURE_DIRECTORY_REQUIRED"
  | "FORMAL_FIXTURE_LIVE_FORBIDDEN"
  | "FORMAL_APPROVAL_LANE_EXISTS"
  | "FORMAL_APPROVAL_PERSIST_FAILED";

export class FormalEvaluationApprovalError extends Error {
  constructor(
    readonly code: FormalEvaluationApprovalErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "FormalEvaluationApprovalError";
  }
}

export interface FormalEvaluationApprovalInputs {
  taskCard: TaskCard;
  draft: EvaluationDraft;
  curation: CurationResult;
  /** The exact unconfirmed Chinese review the user inspected. */
  review: EvaluationReview;
}

export interface FormalEvaluationApprovalOptions {
  operator: string;
  confirmationMode: ConfirmationMode;
  /** Used only to confine test-fixture artefacts to the OS temporary tree. */
  projectDir: string;
  /** Must be false for test-fixture approval. Human approval itself is zero-network too. */
  liveProvider: boolean;
}

export interface FormalEvaluationApprovalBundle extends FormalEvaluationApprovalInputs {
  formalDraft: EvaluationDraft;
  formalCuration: CurationResult;
  formalReview: EvaluationReview;
  record: FormalEvaluationApprovalRecord;
}

export interface PersistedFormalEvaluationApproval {
  directory: string;
  taskCard: string;
  draft: string;
  curation: string;
  review: string;
  reviewMarkdown: string;
  approval: string;
}

export interface FormalHumanConfirmationWaiting {
  status: "WAITING_FOR_HUMAN_CONFIRMATION";
  confirmations: {
    completed: 0 | 1;
    required: 2;
    missing: Array<"task_card" | "evaluation_review">;
  };
  formalEvidence: false;
  effects: { fetches: 0; providerCalls: 0; writes: 0 };
}

export interface FormalHumanConfirmationReady {
  status: "READY_FOR_FORMAL_EXECUTION";
  confirmations: {
    completed: 2;
    required: 2;
    missing: [];
  };
  formalEvidence: true;
  taskCardSha256: string;
  evaluationReviewBindingSha256: string;
  effects: { fetches: 0; providerCalls: 0; writes: 0 };
}

export type FormalHumanConfirmationGate =
  | FormalHumanConfirmationWaiting
  | FormalHumanConfirmationReady;

export interface PersistedFormalLaneVerificationOptions {
  /** `live-formal` is the public default; fixture verification is zero-network and temp-only. */
  verificationMode?: "live-formal" | "test-fixture";
}

export interface PersistedLiveFormalLaneReady {
  status: "READY_FOR_FORMAL_EXECUTION";
  confirmationMode: "human";
  formalEvidence: true;
  approvalSha256: string;
  bundle: FormalEvaluationApprovalBundle;
  effects: { fetches: 0; providerCalls: 0; writes: 0 };
}

export interface PersistedFixtureLaneVerified {
  status: "FIXTURE_BINDINGS_VERIFIED";
  confirmationMode: "test-fixture";
  formalEvidence: false;
  approvalSha256: string;
  bundle: FormalEvaluationApprovalBundle;
  effects: { fetches: 0; providerCalls: 0; writes: 0 };
}

export type PersistedFormalLaneVerification =
  | FormalHumanConfirmationWaiting
  | PersistedLiveFormalLaneReady
  | PersistedFixtureLaneVerified;

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function approvalContentSha256(record: Omit<FormalEvaluationApprovalRecord, "approvalSha256">): string {
  return sha256(record);
}

function itemBindings(source: DraftItem[], formal: DraftItem[]): FormalEvaluationApprovalRecord["itemBindings"] {
  const formalById = new Map(formal.map((item) => [item.itemId, item]));
  return source.map((item) => {
    const formalItem = formalById.get(item.itemId);
    if (!formalItem) {
      throw new FormalEvaluationApprovalError(
        "FORMAL_APPROVAL_INPUT_INVALID",
        `formal draft is missing item ${item.itemId}`,
      );
    }
    return {
      itemId: item.itemId,
      split: item.split,
      ...(item.selectionRole ? { selectionRole: item.selectionRole } : {}),
      sourceContentSha256: sha256(item),
      formalContentSha256: sha256(formalItem),
    };
  });
}

function itemSetSha256(items: DraftItem[]): string {
  return sha256(items.map((item) => ({ itemId: item.itemId, contentSha256: sha256(item) })));
}

function calibrationSha256(draft: EvaluationDraft): string {
  if (!draft.calibration) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_INPUT_INVALID",
      "U1 formal approval requires the frozen Good/Borderline/Unsafe calibration triplet",
    );
  }
  return sha256(draft.calibration);
}

function isStrictlyWithin(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

function assertFixtureBoundary(options: FormalEvaluationApprovalOptions): void {
  if (options.confirmationMode !== "test-fixture") return;
  if (options.liveProvider) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_FIXTURE_LIVE_FORBIDDEN",
      "test-fixture approval cannot authorize or accompany a live Provider path",
    );
  }
  if (!isStrictlyWithin(tmpdir(), options.projectDir)) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_FIXTURE_DIRECTORY_REQUIRED",
      "test-fixture approval artefacts may exist only under the OS temporary directory",
    );
  }
}

function validateApprovalInputs(input: FormalEvaluationApprovalInputs): void {
  const cardHash = taskCardContentSha256(input.taskCard);
  const draftHash = evaluationDraftContentSha256(input.draft);
  if (
    input.curation.verdict !== "accepted" ||
    input.curation.sourceHashes.taskCard !== cardHash ||
    input.curation.sourceHashes.draft !== draftHash
  ) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_INPUT_INVALID",
      "the accepted curation must bind exactly the supplied Task Card and evaluation draft",
    );
  }
  if (input.review.confirmation.status !== "draft") {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_SOURCE_ALREADY_CONFIRMED",
      "the atomic approval action consumes the displayed review draft; an existing confirmation cannot be promoted or overwritten",
    );
  }
  try {
    assertEvaluationReviewBindings({
      review: input.review,
      taskCard: input.taskCard,
      draft: input.draft,
    });
  } catch (error) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_HASH_DRIFT",
      error instanceof Error ? error.message : "the Chinese review no longer binds the supplied inputs",
    );
  }
  if (
    stableStringify(input.review.curator ?? null) !== stableStringify(input.curation.producer) ||
    input.review.generatorCuratorIsolation !== input.curation.generatorCuratorIsolation ||
    stableStringify(input.review.evalConfidence ?? null) !== stableStringify(input.curation.evalConfidence)
  ) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_INPUT_INVALID",
      "the Chinese review does not bind the supplied curation provenance and confidence",
    );
  }
  const seen = new Set<string>();
  for (const item of input.draft.items) {
    if (seen.has(item.itemId)) {
      throw new FormalEvaluationApprovalError(
        "FORMAL_APPROVAL_INPUT_INVALID",
        `duplicate item id ${item.itemId} cannot enter an atomic approval record`,
      );
    }
    seen.add(item.itemId);
    if (!U1BDraftItemSchema.safeParse(item).success) {
      throw new FormalEvaluationApprovalError(
        "FORMAL_APPROVAL_INPUT_INVALID",
        `item ${item.itemId} is not a complete U1 evaluation item`,
      );
    }
    if (item.reviewStatus === "human-confirmed") {
      throw new FormalEvaluationApprovalError(
        "FORMAL_APPROVAL_SOURCE_ALREADY_CONFIRMED",
        `item ${item.itemId} was already labelled human-confirmed; use the unsigned reviewed draft instead of hand-editing it`,
      );
    }
  }
  if (!input.draft.calibration) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_INPUT_INVALID",
      "the evaluation draft has no calibration triplet",
    );
  }
  if (input.draft.calibration.reviewStatus === "human-confirmed") {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_SOURCE_ALREADY_CONFIRMED",
      "the calibration was already labelled human-confirmed; use the unsigned reviewed draft",
    );
  }
  const sourceItem = input.draft.items.find((item) => item.itemId === input.draft.calibration?.sourceItemId);
  if (!sourceItem || calibrationSourceSha256(sourceItem) !== input.draft.calibration.sourceItemSha256) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_HASH_DRIFT",
      "the calibration source item no longer matches the calibration binding",
    );
  }
}

/**
 * Create every formal approval artefact in memory as one immutable bundle.
 * The development draft/curation/review are never modified; the separate
 * formal draft receives the human-confirmed item/calibration status and new
 * hashes automatically, so no operator edits evaluation-draft.json by hand.
 */
export function approveEvaluationForFormalFreeze(
  rawInput: FormalEvaluationApprovalInputs,
  options: FormalEvaluationApprovalOptions,
): FormalEvaluationApprovalBundle {
  const operator = options.operator.trim();
  if (!operator) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_OPERATOR_REQUIRED",
      "formal evaluation approval requires the real operator identity",
    );
  }
  assertFixtureBoundary(options);
  const input: FormalEvaluationApprovalInputs = {
    taskCard: TaskCardSchema.parse(rawInput.taskCard),
    draft: EvaluationDraftSchema.parse(rawInput.draft),
    curation: CurationResultSchema.parse(rawInput.curation),
    review: EvaluationReviewSchema.parse(rawInput.review),
  };
  if (input.taskCard.confirmation.status !== "confirmed") {
    throw new FormalEvaluationApprovalError(
      "FORMAL_TASK_CARD_CONFIRMATION_REQUIRED",
      "the first, separate Task Card confirmation is still missing",
    );
  }
  try {
    completeTaskCardIntentDetails(input.taskCard);
  } catch {
    throw new FormalEvaluationApprovalError(
      "FORMAL_TASK_CARD_INTENT_INCOMPLETE",
      "the confirmed Task Card does not persist all five current intentDetails",
    );
  }
  if (input.taskCard.confirmation.confirmationMode !== options.confirmationMode) {
    const fixtureInLive = input.taskCard.confirmation.confirmationMode === "test-fixture" && options.confirmationMode === "human";
    throw new FormalEvaluationApprovalError(
      fixtureInLive ? "FORMAL_FIXTURE_LIVE_FORBIDDEN" : "FORMAL_TASK_CARD_CONFIRMATION_REQUIRED",
      "the Task Card confirmation mode does not match this approval lane",
    );
  }
  validateApprovalInputs(input);

  const formalDraft = EvaluationDraftSchema.parse({
    ...input.draft,
    items: input.draft.items.map((item) => ({ ...item, reviewStatus: "human-confirmed" as const })),
    calibration: input.draft.calibration
      ? { ...input.draft.calibration, reviewStatus: "human-confirmed" as const }
      : undefined,
  });
  const cardHash = taskCardContentSha256(input.taskCard);
  const formalDraftHash = evaluationDraftContentSha256(formalDraft);
  const formalCuration = CurationResultSchema.parse({
    ...input.curation,
    sourceHashes: {
      ...input.curation.sourceHashes,
      taskCard: cardHash,
      draft: formalDraftHash,
    },
  });
  const formalReviewDraft = createEvaluationReview({
    taskCard: input.taskCard,
    draft: formalDraft,
    curation: formalCuration,
  });
  const formalReview = confirmEvaluationReview(formalReviewDraft, operator, {
    mode: options.confirmationMode,
  });
  try {
    authorizeEvidenceMode({
      executionMode: options.confirmationMode === "human" ? "formal" : "test-fixture",
      taskConfirmationMode: input.taskCard.confirmation.confirmationMode,
      evaluationConfirmationMode: formalReview.confirmation.status === "confirmed"
        ? formalReview.confirmation.confirmationMode
        : undefined,
      liveProvider: options.liveProvider,
    });
  } catch (error) {
    if (error instanceof EvidenceModeError && error.code === "FIXTURE_LIVE_PROVIDER_FORBIDDEN") {
      throw new FormalEvaluationApprovalError("FORMAL_FIXTURE_LIVE_FORBIDDEN", error.message);
    }
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_INPUT_INVALID",
      error instanceof Error ? error.message : "the approval evidence mode is invalid",
    );
  }

  const bindings = itemBindings(input.draft.items, formalDraft.items);
  const sourceCalibrationHash = calibrationSha256(input.draft);
  const formalCalibrationHash = calibrationSha256(formalDraft);
  const sourceRecord = {
    taskCardSha256: cardHash,
    taskCardConfirmationSha256: sha256(input.taskCard.confirmation),
    evaluationDraftSha256: evaluationDraftContentSha256(input.draft),
    curationSha256: curationContentSha256(input.curation),
    evaluationReviewContentSha256: evaluationReviewContentSha256(input.review),
    evaluationReviewDocumentSha256: input.review.reviewDocumentSha256,
    evaluationReviewBindingSha256: evaluationReviewConfirmationSha256(input.review),
    itemSetSha256: itemSetSha256(input.draft.items),
    calibrationSha256: sourceCalibrationHash,
  };
  const formalRecord = {
    taskCardSha256: cardHash,
    taskCardConfirmationSha256: sha256(input.taskCard.confirmation),
    evaluationDraftSha256: formalDraftHash,
    curationSha256: curationContentSha256(formalCuration),
    evaluationReviewContentSha256: evaluationReviewContentSha256(formalReview),
    evaluationReviewDocumentSha256: formalReview.reviewDocumentSha256,
    evaluationReviewBindingSha256: evaluationReviewConfirmationSha256(formalReview),
    itemSetSha256: itemSetSha256(formalDraft.items),
    calibrationSha256: formalCalibrationHash,
  };
  const confirmedAt = formalReview.confirmation.status === "confirmed"
    ? formalReview.confirmation.confirmedAt
    : new Date().toISOString();
  const recordContent = {
    schemaVersion: 3 as const,
    kind: "u1-formal-evaluation-approval" as const,
    createdAt: confirmedAt,
    confirmedBy: operator,
    confirmationMode: options.confirmationMode,
    humanReviewed: options.confirmationMode === "human",
    formalEligible: options.confirmationMode === "human",
    source: sourceRecord,
    formal: formalRecord,
    itemBindings: bindings,
    calibrationBinding: {
      sourceItemId: input.draft.calibration!.sourceItemId,
      sourceItemSha256: input.draft.calibration!.sourceItemSha256,
      sourceContentSha256: sourceCalibrationHash,
      formalContentSha256: formalCalibrationHash,
    },
  };
  const record = FormalEvaluationApprovalRecordSchema.parse({
    ...recordContent,
    approvalSha256: approvalContentSha256(recordContent),
  });
  const bundle: FormalEvaluationApprovalBundle = {
    ...input,
    formalDraft,
    formalCuration,
    formalReview,
    record,
  };
  assertFormalEvaluationApprovalBindings(bundle);
  return bundle;
}

/** Recompute every approval binding. Any item, calibration or review drift fails closed. */
export function assertFormalEvaluationApprovalBindings(bundle: FormalEvaluationApprovalBundle): void {
  const parsedRecord = FormalEvaluationApprovalRecordSchema.safeParse(bundle.record);
  if (!parsedRecord.success) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_HASH_DRIFT",
      "the formal approval record no longer matches its schema",
    );
  }
  const record = parsedRecord.data;
  try {
    assertEvaluationReviewBindings({
      review: bundle.review,
      taskCard: bundle.taskCard,
      draft: bundle.draft,
    });
    assertEvaluationReviewBindings({
      review: bundle.formalReview,
      taskCard: bundle.taskCard,
      draft: bundle.formalDraft,
    });
  } catch (error) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_HASH_DRIFT",
      error instanceof Error ? error.message : "an evaluation review binding drifted",
    );
  }
  if (
    bundle.taskCard.confirmation.status !== "confirmed" ||
    bundle.review.confirmation.status !== "draft" ||
    bundle.taskCard.confirmation.confirmationMode !== record.confirmationMode ||
    bundle.formalReview.confirmation.status !== "confirmed" ||
    bundle.formalReview.confirmation.confirmationMode !== record.confirmationMode ||
    bundle.formalReview.confirmation.humanReviewed !== record.humanReviewed ||
    bundle.formalReview.confirmation.confirmedBy !== record.confirmedBy ||
    bundle.formalReview.confirmation.confirmedAt !== record.createdAt ||
    bundle.formalDraft.items.some((item) => item.reviewStatus !== "human-confirmed") ||
    bundle.formalDraft.calibration?.reviewStatus !== "human-confirmed"
  ) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_HASH_DRIFT",
      "confirmation modes or formal item/calibration review states drifted",
    );
  }
  const expectedSource = {
    taskCardSha256: taskCardContentSha256(bundle.taskCard),
    taskCardConfirmationSha256: sha256(bundle.taskCard.confirmation),
    evaluationDraftSha256: evaluationDraftContentSha256(bundle.draft),
    curationSha256: curationContentSha256(bundle.curation),
    evaluationReviewContentSha256: evaluationReviewContentSha256(bundle.review),
    evaluationReviewDocumentSha256: bundle.review.reviewDocumentSha256,
    evaluationReviewBindingSha256: evaluationReviewConfirmationSha256(bundle.review),
    itemSetSha256: itemSetSha256(bundle.draft.items),
    calibrationSha256: calibrationSha256(bundle.draft),
  };
  const expectedFormal = {
    taskCardSha256: taskCardContentSha256(bundle.taskCard),
    taskCardConfirmationSha256: sha256(bundle.taskCard.confirmation),
    evaluationDraftSha256: evaluationDraftContentSha256(bundle.formalDraft),
    curationSha256: curationContentSha256(bundle.formalCuration),
    evaluationReviewContentSha256: evaluationReviewContentSha256(bundle.formalReview),
    evaluationReviewDocumentSha256: bundle.formalReview.reviewDocumentSha256,
    evaluationReviewBindingSha256: evaluationReviewConfirmationSha256(bundle.formalReview),
    itemSetSha256: itemSetSha256(bundle.formalDraft.items),
    calibrationSha256: calibrationSha256(bundle.formalDraft),
  };
  const expectedItems = itemBindings(bundle.draft.items, bundle.formalDraft.items);
  const expectedCalibration = {
    sourceItemId: bundle.draft.calibration!.sourceItemId,
    sourceItemSha256: bundle.draft.calibration!.sourceItemSha256,
    sourceContentSha256: calibrationSha256(bundle.draft),
    formalContentSha256: calibrationSha256(bundle.formalDraft),
  };
  const { approvalSha256, ...approvalContent } = record;
  const drifted =
    stableStringify(record.source) !== stableStringify(expectedSource) ||
    stableStringify(record.formal) !== stableStringify(expectedFormal) ||
    stableStringify(record.itemBindings) !== stableStringify(expectedItems) ||
    stableStringify(record.calibrationBinding) !== stableStringify(expectedCalibration) ||
    approvalSha256 !== approvalContentSha256(approvalContent);
  if (drifted) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_HASH_DRIFT",
      "Task Card, draft, curation, Chinese review, item, calibration, or approval hash no longer matches",
    );
  }
  if (
    bundle.formalCuration.sourceHashes.taskCard !== expectedFormal.taskCardSha256 ||
    bundle.formalCuration.sourceHashes.draft !== expectedFormal.evaluationDraftSha256 ||
    bundle.formalReview.draftSha256 !== expectedFormal.evaluationDraftSha256
  ) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_HASH_DRIFT",
      "the formal curation/review does not bind the separate formal draft",
    );
  }
}

export function formalEvaluationLanePath(projectDir: string): string {
  return join(resolve(projectDir), FORMAL_EVALUATION_LANE_DIRNAME);
}

export function formalEvaluationApprovalPath(projectDir: string): string {
  return join(formalEvaluationLanePath(projectDir), FORMAL_EVALUATION_APPROVAL_FILENAME);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Persist the whole approval bundle by one directory rename; an existing formal lane is never overwritten. */
export async function persistFormalEvaluationApproval(
  projectDir: string,
  bundle: FormalEvaluationApprovalBundle,
): Promise<PersistedFormalEvaluationApproval> {
  assertFormalEvaluationApprovalBindings(bundle);
  if (bundle.record.confirmationMode === "test-fixture" && !isStrictlyWithin(tmpdir(), projectDir)) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_FIXTURE_DIRECTORY_REQUIRED",
      "test-fixture approval artefacts may be persisted only under the OS temporary directory",
    );
  }
  const root = resolve(projectDir);
  const finalDir = formalEvaluationLanePath(root);
  if (await pathExists(finalDir)) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_LANE_EXISTS",
      `refusing to overwrite the existing formal approval lane at ${finalDir}`,
    );
  }
  await mkdir(root, { recursive: true });
  const staging = join(root, `.formal-approval-tmp-${randomBytes(8).toString("hex")}`);
  try {
    await mkdir(staging);
    // Sequential staging avoids a rejected Promise racing cleanup while a
    // sibling write is still open on Windows/OneDrive.
    await writeFile(taskCardConfirmedPath(staging), `${JSON.stringify(bundle.taskCard, null, 2)}\n`, "utf8");
    await writeFile(evaluationDraftPath(staging), `${JSON.stringify(bundle.formalDraft, null, 2)}\n`, "utf8");
    await writeFile(evaluationCurationPath(staging), `${JSON.stringify(bundle.formalCuration, null, 2)}\n`, "utf8");
    await writeFile(evaluationReviewConfirmedPath(staging), `${JSON.stringify(bundle.formalReview, null, 2)}\n`, "utf8");
    await writeFile(evaluationReviewMarkdownPath(staging), renderEvaluationReviewZh(bundle.formalReview), "utf8");
    await writeFile(join(staging, FORMAL_EVALUATION_APPROVAL_FILENAME), `${JSON.stringify(bundle.record, null, 2)}\n`, "utf8");
    await rename(staging, finalDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof FormalEvaluationApprovalError) throw error;
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_PERSIST_FAILED",
      error instanceof Error ? error.message : "failed to commit the formal approval lane",
    );
  }
  return {
    directory: finalDir,
    taskCard: taskCardConfirmedPath(finalDir),
    draft: evaluationDraftPath(finalDir),
    curation: evaluationCurationPath(finalDir),
    review: evaluationReviewConfirmedPath(finalDir),
    reviewMarkdown: evaluationReviewMarkdownPath(finalDir),
    approval: join(finalDir, FORMAL_EVALUATION_APPROVAL_FILENAME),
  };
}

/** Pure live-formal gate. It cannot fetch, call a Provider or write an output. */
function inspectFormalHumanConfirmationGate(args: {
  taskCard?: TaskCard;
  draft?: EvaluationDraft;
  review?: EvaluationReview;
}): FormalHumanConfirmationGate {
  const cardMode = args.taskCard?.confirmation.status === "confirmed"
    ? args.taskCard.confirmation.confirmationMode
    : undefined;
  const reviewMode = args.review?.confirmation.status === "confirmed"
    ? args.review.confirmation.confirmationMode
    : undefined;
  if (cardMode === "test-fixture" || reviewMode === "test-fixture") {
    throw new FormalEvaluationApprovalError(
      "FORMAL_FIXTURE_LIVE_FORBIDDEN",
      "test-fixture confirmation cannot satisfy the live formal path",
    );
  }
  const taskConfirmed = cardMode === "human";
  const reviewConfirmed =
    reviewMode === "human" &&
    args.review?.confirmation.status === "confirmed" &&
    args.review.confirmation.humanReviewed === true;
  const missing: Array<"task_card" | "evaluation_review"> = [];
  if (!taskConfirmed) missing.push("task_card");
  if (!reviewConfirmed) missing.push("evaluation_review");
  if (missing.length > 0) {
    return {
      status: "WAITING_FOR_HUMAN_CONFIRMATION",
      confirmations: {
        completed: (2 - missing.length) as 0 | 1,
        required: 2,
        missing,
      },
      formalEvidence: false,
      effects: { fetches: 0, providerCalls: 0, writes: 0 },
    };
  }
  if (!args.taskCard || !args.draft || !args.review) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_REVIEW_CONFIRMATION_REQUIRED",
      "two confirmation flags exist but their bound Task Card, draft, or review is missing",
    );
  }
  try {
    assertEvaluationReviewBindings({ review: args.review, taskCard: args.taskCard, draft: args.draft });
  } catch (error) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_HASH_DRIFT",
      error instanceof Error ? error.message : "the formal review binding drifted",
    );
  }
  return {
    status: "READY_FOR_FORMAL_EXECUTION",
    confirmations: { completed: 2, required: 2, missing: [] },
    formalEvidence: true,
    taskCardSha256: taskCardContentSha256(args.taskCard),
    evaluationReviewBindingSha256: evaluationReviewConfirmationSha256(args.review),
    effects: { fetches: 0, providerCalls: 0, writes: 0 },
  };
}

function waitingForPersistedApproval(completed: 0 | 1): FormalHumanConfirmationWaiting {
  return {
    status: "WAITING_FOR_HUMAN_CONFIRMATION",
    confirmations: {
      completed,
      required: 2,
      missing: completed === 0
        ? ["task_card", "evaluation_review"]
        : ["evaluation_review"],
    },
    formalEvidence: false,
    effects: { fetches: 0, providerCalls: 0, writes: 0 },
  };
}

async function readOptionalArtifact(path: string, label: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_HASH_DRIFT",
      `cannot read ${label}: ${error instanceof Error ? error.message : "unknown read failure"}`,
    );
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_HASH_DRIFT",
      `${label} is not valid JSON`,
    );
  }
}

function parsePersistedArtifact<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_HASH_DRIFT",
      `${label} no longer matches its frozen schema`,
    );
  }
  return parsed.data;
}

/**
 * Read-only verification of the persisted approval chain. This deliberately
 * names only source/formal approval artefacts: evaluation-contract and sealed
 * holdout paths are neither constructed nor read here.
 *
 * A pair of confirmation flags is insufficient. READY is returned only after
 * the approval record exists, every source/formal artefact is reconstructed,
 * and `assertFormalEvaluationApprovalBindings` succeeds.
 */
export async function verifyPersistedFormalEvaluationLane(
  projectDir: string,
  options: PersistedFormalLaneVerificationOptions = {},
): Promise<PersistedFormalLaneVerification> {
  const mode = options.verificationMode ?? "live-formal";
  const root = resolve(projectDir);
  if (mode === "test-fixture" && !isStrictlyWithin(tmpdir(), root)) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_FIXTURE_DIRECTORY_REQUIRED",
      "persisted test-fixture approval may be verified only under the OS temporary directory",
    );
  }

  const confirmedCardRaw = await readOptionalArtifact(taskCardConfirmedPath(root), "source Task Card confirmation");
  const draftCardRaw = confirmedCardRaw === undefined
    ? await readOptionalArtifact(taskCardDraftPath(root), "source Task Card draft")
    : undefined;
  const cardRaw = confirmedCardRaw ?? draftCardRaw;
  if (cardRaw === undefined) return waitingForPersistedApproval(0);
  const taskCard = parsePersistedArtifact(TaskCardSchema, cardRaw, "source Task Card");
  const cardMode = taskCard.confirmation.status === "confirmed"
    ? taskCard.confirmation.confirmationMode
    : undefined;
  if (mode === "live-formal" && cardMode === "test-fixture") {
    throw new FormalEvaluationApprovalError(
      "FORMAL_FIXTURE_LIVE_FORBIDDEN",
      "test-fixture Task Card confirmation cannot enter live formal verification",
    );
  }
  const expectedMode: ConfirmationMode = mode === "live-formal" ? "human" : "test-fixture";
  if (cardMode !== expectedMode) return waitingForPersistedApproval(0);

  // The approval record is the second-confirmation authority. Do not inspect
  // a standalone confirmed review first and accidentally count its flag.
  const approvalRaw = await readOptionalArtifact(
    formalEvaluationApprovalPath(root),
    "formal evaluation approval record",
  );
  if (approvalRaw === undefined) return waitingForPersistedApproval(1);
  const record = parsePersistedArtifact(
    FormalEvaluationApprovalRecordSchema,
    approvalRaw,
    "formal evaluation approval record",
  );
  if (record.confirmationMode !== expectedMode) {
    if (mode === "live-formal" && record.confirmationMode === "test-fixture") {
      throw new FormalEvaluationApprovalError(
        "FORMAL_FIXTURE_LIVE_FORBIDDEN",
        "test-fixture approval record cannot enter live formal verification",
      );
    }
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_HASH_DRIFT",
      "the persisted approval mode does not match the selected verification lane",
    );
  }

  const lane = formalEvaluationLanePath(root);
  const sourceDraftRaw = await readOptionalArtifact(evaluationDraftPath(root), "source evaluation draft");
  const sourceCurationRaw = await readOptionalArtifact(evaluationCurationPath(root), "source evaluation curation");
  const sourceReviewRaw = await readOptionalArtifact(evaluationReviewDraftPath(root), "source Chinese evaluation review");
  const formalCardRaw = await readOptionalArtifact(taskCardConfirmedPath(lane), "formal Task Card confirmation");
  const formalDraftRaw = await readOptionalArtifact(evaluationDraftPath(lane), "formal evaluation draft");
  const formalCurationRaw = await readOptionalArtifact(evaluationCurationPath(lane), "formal evaluation curation");
  const formalReviewRaw = await readOptionalArtifact(evaluationReviewConfirmedPath(lane), "formal Chinese evaluation review confirmation");
  if (
    sourceDraftRaw === undefined ||
    sourceCurationRaw === undefined ||
    sourceReviewRaw === undefined ||
    formalCardRaw === undefined ||
    formalDraftRaw === undefined ||
    formalCurationRaw === undefined ||
    formalReviewRaw === undefined
  ) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_HASH_DRIFT",
      "the approval record exists but one or more bound source/formal artefacts are missing",
    );
  }

  const formalCard = parsePersistedArtifact(TaskCardSchema, formalCardRaw, "formal Task Card");
  if (stableStringify(formalCard) !== stableStringify(taskCard)) {
    throw new FormalEvaluationApprovalError(
      "FORMAL_APPROVAL_HASH_DRIFT",
      "source and formal Task Card artefacts differ",
    );
  }
  const bundle: FormalEvaluationApprovalBundle = {
    taskCard,
    draft: parsePersistedArtifact(EvaluationDraftSchema, sourceDraftRaw, "source evaluation draft"),
    curation: parsePersistedArtifact(CurationResultSchema, sourceCurationRaw, "source evaluation curation"),
    review: parsePersistedArtifact(EvaluationReviewSchema, sourceReviewRaw, "source Chinese evaluation review"),
    formalDraft: parsePersistedArtifact(EvaluationDraftSchema, formalDraftRaw, "formal evaluation draft"),
    formalCuration: parsePersistedArtifact(CurationResultSchema, formalCurationRaw, "formal evaluation curation"),
    formalReview: parsePersistedArtifact(EvaluationReviewSchema, formalReviewRaw, "formal Chinese evaluation review"),
    record,
  };
  assertFormalEvaluationApprovalBindings(bundle);

  if (mode === "test-fixture") {
    return {
      status: "FIXTURE_BINDINGS_VERIFIED",
      confirmationMode: "test-fixture",
      formalEvidence: false,
      approvalSha256: record.approvalSha256,
      bundle,
      effects: { fetches: 0, providerCalls: 0, writes: 0 },
    };
  }
  const gate = inspectFormalHumanConfirmationGate({
    taskCard: formalCard,
    draft: bundle.formalDraft,
    review: bundle.formalReview,
  });
  if (gate.status !== "READY_FOR_FORMAL_EXECUTION") {
    return gate;
  }
  return {
    status: "READY_FOR_FORMAL_EXECUTION",
    confirmationMode: "human",
    formalEvidence: true,
    approvalSha256: record.approvalSha256,
    bundle,
    effects: { fetches: 0, providerCalls: 0, writes: 0 },
  };
}
