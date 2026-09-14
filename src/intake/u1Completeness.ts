import { createHash } from "node:crypto";
import {
  U1_INTENT_DIMENSION_VALUES,
  type U1Clarification,
  type U1IntentDetails,
  type U1IntentDimension,
  type U1IntentStatus,
} from "../types.js";

export type { U1IntentDimension } from "../types.js";

export const U1_INTENT_DIMENSIONS: readonly U1IntentDimension[] = U1_INTENT_DIMENSION_VALUES;

const QUESTION_PRIORITY: readonly U1IntentDimension[] = [
  "capability_boundary_and_redlines",
  "goal_and_intended_user",
  "inputs_and_evidence",
  "output_and_format",
  "success_criteria_and_protected_behavior",
];

const QUESTION_ZH: Record<U1IntentDimension, string> = {
  goal_and_intended_user: "这个 Skill 最终服务谁，他们要完成什么目标？",
  inputs_and_evidence: "可用输入和证据有哪些；遇到缺失或不确定信息时必须怎样处理？",
  output_and_format: "最终必须输出什么内容，格式或结构有什么硬性要求？",
  capability_boundary_and_redlines: "允许与禁止哪些能力或外部动作；绝对不能越过哪些红线？",
  success_criteria_and_protected_behavior: "怎样算优化成功；原 Skill 中哪些正确或安全行为必须保留？",
};

export interface U1CompletenessInput {
  goal: string;
  details?: U1IntentDetails;
  clarifications?: U1Clarification[];
}

export interface U1CompletenessResult {
  status: U1IntentStatus;
  answeredDimensions: U1IntentDimension[];
  missingDimensions: U1IntentDimension[];
  questions: Array<{ dimension: U1IntentDimension; promptZh: string }>;
  questionCount: number;
  goalSha256: string;
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function analyzeU1Completeness(
  input: U1CompletenessInput,
  maxQuestions = 5,
): U1CompletenessResult {
  if (!Number.isInteger(maxQuestions) || maxQuestions < 1 || maxQuestions > 5) {
    throw new Error(`U1_COMPLETENESS_INVALID_MAX_QUESTIONS: expected 1..5, got ${maxQuestions}`);
  }
  const clarifications = input.clarifications ?? [];
  if (clarifications.length > maxQuestions) {
    throw new Error(`U1_COMPLETENESS_QUESTION_LIMIT: received ${clarifications.length}, max ${maxQuestions}`);
  }
  const answered = new Set<U1IntentDimension>();
  for (const dimension of U1_INTENT_DIMENSIONS) {
    if (nonEmpty(input.details?.[dimension])) answered.add(dimension);
  }
  for (const clarification of clarifications) {
    if (nonEmpty(clarification.answer)) answered.add(clarification.dimension);
  }
  const missingDimensions = U1_INTENT_DIMENSIONS.filter((dimension) => !answered.has(dimension));
  const asked = new Set(clarifications.map((entry) => entry.dimension));
  const remaining = Math.max(0, maxQuestions - clarifications.length);
  const questions = QUESTION_PRIORITY
    .filter((dimension) => !answered.has(dimension) && !asked.has(dimension))
    .slice(0, remaining)
    .map((dimension) => ({ dimension, promptZh: QUESTION_ZH[dimension] }));

  let status: U1IntentStatus = "needs_clarification";
  if (missingDimensions.length === 0) status = "complete";
  else if (clarifications.length >= maxQuestions) status = "intent_incomplete";

  return {
    status,
    answeredDimensions: U1_INTENT_DIMENSIONS.filter((dimension) => answered.has(dimension)),
    missingDimensions,
    questions,
    questionCount: clarifications.length,
    goalSha256: createHash("sha256").update(input.goal, "utf8").digest("hex"),
  };
}
