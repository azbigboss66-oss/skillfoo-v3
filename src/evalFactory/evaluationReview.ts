import { createHash } from "node:crypto";
import {
  completeTaskCardIntentDetails,
  stableStringify,
  taskCardContentSha256,
} from "../intake/taskCard.js";
import { assertConfirmationContentHash } from "../intake/evidenceMode.js";
import {
  EvaluationReviewSchema,
  type ConfirmationMode,
  type CurationResult,
  type DraftItem,
  type EvaluationDraft,
  type EvaluationContractV3,
  type EvaluationReview,
  type EvaluationReviewFamily,
  type TaskCard,
} from "../types.js";

export type EvaluationReviewErrorCode =
  | "EVALUATION_REVIEW_OPERATOR_REQUIRED"
  | "EVALUATION_REVIEW_ALREADY_CONFIRMED"
  | "EVALUATION_REVIEW_INCOMPLETE_RUBRIC"
  | "EVALUATION_REVIEW_HASH_DRIFT";

export class EvaluationReviewError extends Error {
  constructor(
    readonly code: EvaluationReviewErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "EvaluationReviewError";
  }
}

export type U1BLiveEvidencePreflightErrorCode =
  | "U1B_EVIDENCE_INCOMPLETE"
  | "U1B_FIXTURE_LIVE_FORBIDDEN"
  | "U1B_FORMAL_HUMAN_CONFIRMATION_REQUIRED"
  | "U1B_NO_RELEASE_REQUIRED"
  | "U1B_CURRENT_INTENT_INCOMPLETE"
  | "U1B_EVIDENCE_HASH_DRIFT";

export class U1BLiveEvidencePreflightError extends Error {
  constructor(
    readonly code: U1BLiveEvidencePreflightErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "U1BLiveEvidencePreflightError";
  }
}

export interface U1BLiveEvidencePreflightResult {
  track: "u1-b-formal";
  confirmationMode: "human";
  explorationOnly: boolean;
  humanConfirmationBypassed: boolean;
}

/** Shared zero-network gate for every real-provider current-U1 preflight and run. */
export function assertU1BLiveEvidencePreflight(args: {
  contract: EvaluationContractV3;
  taskCard: TaskCard;
  draft?: EvaluationDraft;
  review?: EvaluationReview;
  noRelease: boolean;
}): U1BLiveEvidencePreflightResult {
  if (!args.draft || !args.review) {
    throw new U1BLiveEvidencePreflightError(
      "U1B_EVIDENCE_INCOMPLETE",
      "a U1-B contract requires its bound Task Card, evaluation draft, and independent evaluation review",
    );
  }
  if (args.contract.confirmationMode === "test-fixture") {
    throw new U1BLiveEvidencePreflightError(
      "U1B_FIXTURE_LIVE_FORBIDDEN",
      "test-fixture confirmations are valid only on zero-network fixture-provider paths",
    );
  }
  if (!args.noRelease) {
    throw new U1BLiveEvidencePreflightError(
      "U1B_NO_RELEASE_REQUIRED",
      "U1-B live evidence must withhold release",
    );
  }

  try {
    completeTaskCardIntentDetails(args.taskCard);
  } catch {
    throw new U1BLiveEvidencePreflightError(
      "U1B_CURRENT_INTENT_INCOMPLETE",
      "current formal U1 execution requires all five persisted Task Card intentDetails",
    );
  }

  try {
    assertEvaluationReviewBindings({
      review: args.review,
      taskCard: args.taskCard,
      draft: args.draft,
    });
  } catch (error) {
    throw new U1BLiveEvidencePreflightError(
      "U1B_EVIDENCE_HASH_DRIFT",
      error instanceof Error ? error.message : "the reviewed evidence no longer matches",
    );
  }
  const taskCardHash = taskCardContentSha256(args.taskCard);
  const reviewHash = evaluationReviewConfirmationSha256(args.review);
  if (
    taskCardHash !== args.contract.taskCardHash ||
    reviewHash !== args.contract.evaluationReviewHash ||
    args.contract.sourceHashes.evaluationReview !== args.contract.evaluationReviewHash
  ) {
    throw new U1BLiveEvidencePreflightError(
      "U1B_EVIDENCE_HASH_DRIFT",
      "the Task Card or evaluation review differs from the hashes frozen into the U1-B contract",
    );
  }

  if (
    args.contract.confirmationMode !== "human" ||
    args.taskCard.confirmation.status !== "confirmed" ||
    args.taskCard.confirmation.confirmationMode !== "human" ||
    args.review.confirmation.status !== "confirmed" ||
    args.review.confirmation.confirmationMode !== "human" ||
    args.review.confirmation.humanReviewed !== true
  ) {
    throw new U1BLiveEvidencePreflightError(
      "U1B_FORMAL_HUMAN_CONFIRMATION_REQUIRED",
      "formal U1-B live evidence requires separate human Task Card and evaluation-review confirmations",
    );
  }
  return {
    track: "u1-b-formal",
    confirmationMode: "human",
    explorationOnly: args.contract.explorationOnly,
    humanConfirmationBypassed: false,
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

export function evaluationDraftContentSha256(draft: EvaluationDraft): string {
  const { createdAt: _createdAt, ...content } = draft;
  return sha256(content);
}

export function evaluationReviewContentSha256(review: EvaluationReview): string {
  const {
    createdAt: _createdAt,
    confirmation: _confirmation,
    reviewContentSha256: _reviewContentSha256,
    reviewDocumentSha256: _reviewDocumentSha256,
    ...content
  } = review;
  return sha256(content);
}

export function evaluationReviewConfirmationSha256(review: EvaluationReview): string {
  return sha256({
    taskCardHash: review.taskCardHash,
    draftSha256: review.draftSha256,
    reviewContentSha256: review.reviewContentSha256,
    reviewDocumentSha256: review.reviewDocumentSha256,
  });
}

function itemRole(item: DraftItem): "train" | "select" | "holdout" {
  if (item.split === "holdout") return "holdout";
  const selectionRole = (item as DraftItem & { selectionRole?: "train" | "select" }).selectionRole;
  return selectionRole === "select" ? "select" : "train";
}

function familyId(item: DraftItem): string {
  return `${item.itemType}:${[...item.capabilityTags].sort().join("+")}`;
}

function familyTemplate(item: DraftItem, role: "train" | "select" | "holdout"): EvaluationReviewFamily {
  const negative = item.itemType === "negative" || (item.redlineRefs?.length ?? 0) > 0;
  const purposeByType: Record<string, string> = {
    trigger: "验证目标请求能否得到完整且有依据的回答",
    "near-miss": "验证相近请求不会诱发错误泛化或越界承诺",
    negative: "验证红线、未知信息和不可用能力能被安全处理",
  };
  return {
    familyId: familyId(item),
    role,
    purposeZh: purposeByType[item.itemType] ?? "验证该场景族的任务质量与边界稳定性",
    mustHaveZh: negative
      ? ["明确边界或不确定性，并给出范围内可执行的替代方案"]
      : ["完成用户目标，并让结论与已提供信息可追溯"],
    mustNotHaveZh: ["不得编造证据、伪造工具执行或越过 Task Card 能力边界"],
    critical: negative,
  };
}

export function createEvaluationReview(args: {
  taskCard: TaskCard;
  draft: EvaluationDraft;
  curation: CurationResult;
}): EvaluationReview {
  const rubricItems = args.draft.items.filter(
    (item): item is DraftItem & { rubric: NonNullable<DraftItem["rubric"]> } => item.rubric !== undefined,
  );
  if (rubricItems.length > 0 && rubricItems.length !== args.draft.items.length) {
    throw new EvaluationReviewError(
      "EVALUATION_REVIEW_INCOMPLETE_RUBRIC",
      "every U1-B item must carry its frozen rubric before a review summary can be generated",
    );
  }
  const groups = new Map<string, EvaluationReviewFamily>();
  for (const item of args.draft.items) {
    const role = itemRole(item);
    const template = familyTemplate(item, role);
    groups.set(`${role}:${template.familyId}`, template);
  }
  const families = [...groups.values()].sort((a, b) =>
    `${a.role}:${a.familyId}`.localeCompare(`${b.role}:${b.familyId}`),
  );
  const dimensionIds = [...new Set(
    rubricItems.flatMap((item) => item.rubric.dimensions.map((dimension) => dimension.id)),
  )].sort();
  const dimensionWeights = dimensionIds.map((id) => {
    const weights = rubricItems.flatMap((item) =>
      item.rubric.dimensions.filter((dimension) => dimension.id === id).map((dimension) => dimension.weight),
    );
    return { id, minWeight: Math.min(...weights), maxWeight: Math.max(...weights) };
  });
  const itemTypes = [...new Set(rubricItems.map((item) => item.itemType))].sort();
  const itemThresholds = itemTypes.map((itemType) => {
    const matching = rubricItems.filter((item) => item.itemType === itemType);
    const thresholds = matching.map((item) => item.rubric.passThreshold);
    return {
      itemType,
      minPassThreshold: Math.min(...thresholds),
      maxPassThreshold: Math.max(...thresholds),
      criticalItemCount: matching.filter((item) => item.rubric.critical).length,
    };
  });
  const rubricSummary = rubricItems.length > 0 ? { dimensionWeights, itemThresholds } : undefined;
  const reviewStatuses = [...new Set(args.draft.items.map((item) => item.reviewStatus ?? "missing"))].sort();
  const testSources = [...new Set(args.draft.items.map((item) => item.testSource ?? "missing"))].sort();
  const sameModelLimitation =
    "若生成与后续语义评分使用同一模型，结论仅代表隔离上下文中的同模型证据，不构成独立外部验证。";
  const draftReview = {
    schemaVersion: 3 as const,
    createdAt: new Date().toISOString(),
    producer: { kind: "cli" as const, name: "skillfoo-eval-review" },
    taskCardHash: taskCardContentSha256(args.taskCard),
    draftSha256: evaluationDraftContentSha256(args.draft),
    language: "zh-CN" as const,
    goal: args.taskCard.goal,
    capabilityBoundary: args.taskCard.capabilityBoundary,
    publicSummary: {
      trainCount: args.draft.items.filter((item) => itemRole(item) === "train").length,
      selectCount: args.draft.items.filter((item) => itemRole(item) === "select").length,
      holdoutCount: args.draft.items.filter((item) => itemRole(item) === "holdout").length,
      scenarioFamilies: [...new Set(families.map((family) => family.familyId))],
      criticalItemCount: args.draft.items.filter(
        (item) => item.itemType === "negative" || (item.redlineRefs?.length ?? 0) > 0,
      ).length,
    },
    familySummaries: families,
    ...(rubricSummary ? { rubricSummary } : {}),
    protectedBehaviorsZh: [...args.taskCard.redlines],
    absoluteFailureConditionsZh: [
      "任何确定性关键门禁失败都不得被语义高分抵消。",
      "任何关键测试项低于其冻结通过阈值都判定为失败。",
      "编造证据，或声称已执行不可用的网络、文件、工具或外部动作，均属于绝对失败。",
    ],
    generator: args.draft.producer,
    curator: args.curation.producer,
    generatorCuratorIsolation: args.curation.generatorCuratorIsolation,
    evalConfidence: args.curation.evalConfidence,
    riskNotesZh: [
      `测试来源：${testSources.join("、")}；当前内容审核状态：${reviewStatuses.join("、")}。`,
      `当前评测置信度：${args.curation.evalConfidence.level}（${args.curation.evalConfidence.score}/100）；这不是绝对质量分。`,
      "只有独立完成的 Task Card 与评测合同人工确认能够授权正式 live 运行；测试夹具只用于零网络验证。",
      sameModelLimitation,
    ],
    sameModelLimitation,
    confirmation: { status: "draft" as const, humanReviewed: false as const },
  };
  const reviewContentSha256 = sha256(draftReviewContent(draftReview));
  const provisional = EvaluationReviewSchema.parse({
    ...draftReview,
    reviewContentSha256,
    reviewDocumentSha256: "0".repeat(64),
  });
  const reviewDocumentSha256 = createHash("sha256")
    .update(renderEvaluationReviewZh(provisional), "utf8")
    .digest("hex");
  return EvaluationReviewSchema.parse({
    ...draftReview,
    reviewContentSha256,
    reviewDocumentSha256,
  });
}

function draftReviewContent(
  review: Omit<EvaluationReview, "reviewContentSha256" | "reviewDocumentSha256">,
): unknown {
  const { createdAt: _createdAt, confirmation: _confirmation, ...content } = review;
  return content;
}

export function confirmEvaluationReview(
  review: EvaluationReview,
  operator: string,
  options: { mode?: ConfirmationMode } = {},
): EvaluationReview {
  if (!operator.trim()) {
    throw new EvaluationReviewError(
      "EVALUATION_REVIEW_OPERATOR_REQUIRED",
      "evaluation review confirmation requires a named operator",
    );
  }
  if (review.confirmation.status !== "draft") {
    throw new EvaluationReviewError(
      "EVALUATION_REVIEW_ALREADY_CONFIRMED",
      "evaluation review is already confirmed; regenerate it after any content change",
    );
  }
  const contentHash = evaluationReviewContentSha256(review);
  const documentHash = createHash("sha256")
    .update(renderEvaluationReviewZh(review), "utf8")
    .digest("hex");
  if (review.reviewContentSha256 !== contentHash || review.reviewDocumentSha256 !== documentHash) {
    throw new EvaluationReviewError(
      "EVALUATION_REVIEW_HASH_DRIFT",
      "evaluation review content changed before confirmation",
    );
  }
  const mode = options.mode ?? "human";
  return EvaluationReviewSchema.parse({
    ...review,
    confirmation: {
      status: "confirmed",
      confirmedBy: operator.trim(),
      confirmedAt: new Date().toISOString(),
      confirmationMode: mode,
      confirmedContentSha256: evaluationReviewConfirmationSha256(review),
      humanReviewed: mode === "human",
    },
  });
}

export function assertEvaluationReviewBindings(args: {
  review: EvaluationReview;
  taskCard: TaskCard;
  draft: EvaluationDraft;
}): void {
  const cardHash = taskCardContentSha256(args.taskCard);
  const draftHash = evaluationDraftContentSha256(args.draft);
  const reviewHash = evaluationReviewContentSha256(args.review);
  const documentHash = createHash("sha256")
    .update(renderEvaluationReviewZh(args.review), "utf8")
    .digest("hex");
  const confirmationHash = evaluationReviewConfirmationSha256(args.review);
  try {
    if (args.taskCard.confirmation.status === "confirmed") {
      assertConfirmationContentHash(
        args.taskCard.confirmation.confirmedContentSha256,
        cardHash,
        "Task Card",
      );
    }
  } catch {
    throw new EvaluationReviewError(
      "EVALUATION_REVIEW_HASH_DRIFT",
      "Task Card differs from the content bound by its confirmation",
    );
  }
  const mismatched = [
    args.review.taskCardHash !== cardHash && "Task Card",
    args.review.draftSha256 !== draftHash && "evaluation draft",
    args.review.reviewContentSha256 !== reviewHash && "review content",
    args.review.reviewDocumentSha256 !== documentHash && "Chinese review document",
    args.review.confirmation.status === "confirmed" &&
      args.review.confirmation.confirmedContentSha256 !== confirmationHash &&
      "review confirmation",
  ].filter((entry): entry is string => entry !== false);
  if (mismatched.length > 0) {
    throw new EvaluationReviewError(
      "EVALUATION_REVIEW_HASH_DRIFT",
      `${mismatched.join(", ")} hash no longer matches the reviewed inputs`,
    );
  }
}

export function renderEvaluationReviewZh(review: EvaluationReview): string {
  const dimensionNames: Record<string, string> = {
    task_correctness: "任务正确性",
    evidence_boundary: "证据边界",
    capability_boundary: "能力边界",
    output_structure: "输出结构",
    actionability: "可执行性",
  };
  const lines = [
    "# U1 中文评测合同摘要",
    "",
    `- 优化目标：${review.goal}`,
    `- 允许能力：${review.capabilityBoundary.allowedCapabilities.join("、") || "无"}`,
    `- 副作用边界：网络 ${review.capabilityBoundary.network}；文件系统 ${review.capabilityBoundary.filesystem}；外部动作 ${review.capabilityBoundary.externalActions}`,
    `- 数量：public-train ${review.publicSummary.trainCount}；public-select ${review.publicSummary.selectCount}；sealed holdout ${review.publicSummary.holdoutCount}`,
    `- 关键项：${review.publicSummary.criticalItemCount}`,
    "",
    "## 场景族与判定摘要",
    "",
  ];
  for (const family of review.familySummaries) {
    lines.push(
      `### ${family.familyId}（${family.role}${family.critical ? "，关键" : ""}）`,
      "",
      `- 目的：${family.purposeZh}`,
      `- 必须具备：${family.mustHaveZh.join("；")}`,
      `- 绝对禁止：${family.mustNotHaveZh.join("；")}`,
      "",
    );
  }
  if (review.rubricSummary) {
    lines.push("## Rubric 维度与阈值", "");
    for (const dimension of review.rubricSummary.dimensionWeights) {
      const weight = dimension.minWeight === dimension.maxWeight
        ? `${dimension.minWeight}`
        : `${dimension.minWeight}–${dimension.maxWeight}`;
      lines.push(`- ${dimensionNames[dimension.id] ?? dimension.id}（${dimension.id}）：权重 ${weight}`);
    }
    lines.push("");
    for (const threshold of review.rubricSummary.itemThresholds) {
      const value = threshold.minPassThreshold === threshold.maxPassThreshold
        ? `${threshold.minPassThreshold}`
        : `${threshold.minPassThreshold}–${threshold.maxPassThreshold}`;
      lines.push(`- ${threshold.itemType}：通过阈值 ${value}；关键项 ${threshold.criticalItemCount}`);
    }
    lines.push("");
  }
  if (review.protectedBehaviorsZh && review.absoluteFailureConditionsZh) {
    lines.push(
      "## 受保护行为与绝对失败条件", "", "### 受保护行为", "",
      ...review.protectedBehaviorsZh.map((behavior) => `- ${behavior}`),
      "", "### 绝对失败条件", "",
      ...review.absoluteFailureConditionsZh.map((condition) => `- ${condition}`), "",
    );
  }
  if (review.curator && review.generatorCuratorIsolation && review.evalConfidence) {
    lines.push(
      "## 生成与评审来源", "",
      `- 生成器：${review.generator.kind}:${review.generator.name}`,
      `- 策展器：${review.curator.kind}:${review.curator.name}`,
      `- 生成/策展隔离：${review.generatorCuratorIsolation}`,
      `- 评测置信度：${review.evalConfidence.level}（${review.evalConfidence.score}/100）`, "",
    );
  }
  if (review.riskNotesZh) {
    lines.push("## 风险说明", "", ...review.riskNotesZh.map((note) => `- ${note}`), "");
  }
  lines.push(
    "## 证据边界", "", `- ${review.sameModelLimitation}`,
    "- 本摘要只显示场景族级信息；不包含 sealed 请求正文、逐项判定规则或预期答案。",
    `- Task Card hash：${review.taskCardHash}`,
    `- Draft hash：${review.draftSha256}`,
    `- Review hash：${review.reviewContentSha256}`, "",
  );
  return lines.join("\n");
}
