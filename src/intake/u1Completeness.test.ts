import test from "node:test";
import assert from "node:assert/strict";
import {
  U1_INTENT_DIMENSIONS,
  analyzeU1Completeness,
  type U1IntentDimension,
} from "./u1Completeness.js";

const GOAL = "为一线销售把已有商机信息整理成可核验的下一步建议。";

function completeDetails(): Record<U1IntentDimension, string> {
  return {
    goal_and_intended_user: "一线销售需要把零散商机信息转成下一步建议。",
    inputs_and_evidence: "仅使用用户粘贴的商机、客户和日期信息，未知内容必须标记未知。",
    output_and_format: "输出简短的判断、证据缺口和按优先级排序的下一步。",
    capability_boundary_and_redlines: "只做文本分析；不得联网、读文件、调用工具或声称已执行动作。",
    success_criteria_and_protected_behavior: "建议必须可执行且可追溯；保留不确定性和原 Skill 的安全拒绝。",
  };
}

test("a complete five-dimension intent asks zero questions", () => {
  const result = analyzeU1Completeness({ goal: GOAL, details: completeDetails() });

  assert.equal(result.status, "complete");
  assert.deepEqual(result.missingDimensions, []);
  assert.deepEqual(result.questions, []);
  assert.equal(result.questionCount, 0);
  assert.match(result.goalSha256, /^[0-9a-f]{64}$/);
});

test("one missing dimension asks only that question", () => {
  const details = completeDetails();
  delete (details as Partial<Record<U1IntentDimension, string>>).output_and_format;
  const result = analyzeU1Completeness({ goal: GOAL, details });

  assert.equal(result.status, "needs_clarification");
  assert.deepEqual(result.missingDimensions, ["output_and_format"]);
  assert.deepEqual(result.questions.map((entry) => entry.dimension), ["output_and_format"]);
});

test("an already asked unanswered dimension is not asked twice", () => {
  const details = completeDetails();
  delete (details as Partial<Record<U1IntentDimension, string>>).inputs_and_evidence;
  const first = analyzeU1Completeness({ goal: GOAL, details });
  const second = analyzeU1Completeness({
    goal: GOAL,
    details,
    clarifications: [{ ...first.questions[0], answer: "" }],
  });

  assert.deepEqual(second.questions, []);
  assert.equal(second.status, "needs_clarification");
  assert.equal(second.questionCount, 1);
});

test("question planning is capped at five and prioritizes capability conflicts", () => {
  const result = analyzeU1Completeness({ goal: GOAL });

  assert.equal(result.questions.length, 5);
  assert.equal(result.questions[0].dimension, "capability_boundary_and_redlines");
  assert.deepEqual(new Set(result.questions.map((entry) => entry.dimension)), new Set(U1_INTENT_DIMENSIONS));
});

test("five unanswered material questions stop as intent_incomplete", () => {
  const planned = analyzeU1Completeness({ goal: GOAL });
  const result = analyzeU1Completeness({
    goal: GOAL,
    clarifications: planned.questions.map((question) => ({ ...question, answer: "" })),
  });

  assert.equal(result.status, "intent_incomplete");
  assert.equal(result.questionCount, 5);
  assert.deepEqual(result.questions, []);
  assert.equal(result.missingDimensions.length, 5);
});

test("clarification answers fill dimensions without changing the verbatim goal hash", () => {
  const planned = analyzeU1Completeness({ goal: GOAL });
  const result = analyzeU1Completeness({
    goal: GOAL,
    clarifications: planned.questions.map((question) => ({
      ...question,
      answer: completeDetails()[question.dimension],
    })),
  });

  assert.equal(result.status, "complete");
  assert.equal(result.answeredDimensions.length, 5);
  assert.equal(result.goalSha256, analyzeU1Completeness({ goal: GOAL }).goalSha256);
});
