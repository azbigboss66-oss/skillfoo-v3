export interface U1MutationFeedbackRule {
  ruleId: string;
  kind: string;
  passed: boolean;
  effect?: string;
  dimension?: string;
  failureCode?: string;
  field?: string;
  expectedType?: string;
  actualType?: string;
  scope?: "item-local";
}

export interface U1MutationFeedbackDimension {
  id: string;
  score: number;
  reason: string;
}

export interface U1MutationFeedbackToolTrace {
  toolName: string;
  logicalId?: string;
  success: boolean;
}

export interface U1MutationFeedbackItem {
  itemId: string;
  itemType: string;
  family?: string;
  input: string;
  terminalReason: string;
  /** Historical input compatibility only; the current sanitizer never emits answer bodies. */
  parsedAnswer?: unknown;
  score?: number;
  rules?: U1MutationFeedbackRule[];
  dimensions?: U1MutationFeedbackDimension[];
  toolTrace?: U1MutationFeedbackToolTrace[];
}

export interface U1MutationTrainFeedback {
  failures: U1MutationFeedbackItem[];
  successes: U1MutationFeedbackItem[];
}

/**
 * The single proposer-facing projection for public-train evidence. It keeps
 * the fixed 6/2 bound, copies only the declared fields, and preserves the
 * answer-body prohibition: no adapter is allowed to place candidate output or
 * dependency content in a proposer prompt.
 */
export function sanitizeBoundedPublicTrainFeedback(input: {
  feedback?: U1MutationTrainFeedback;
}): U1MutationTrainFeedback {
  const boundedReason = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : value.slice(0, 240);
  const sanitize = (item: U1MutationFeedbackItem): U1MutationFeedbackItem => ({
    itemId: item.itemId,
    itemType: item.itemType,
    ...(item.family ? { family: item.family } : {}),
    input: item.input,
    terminalReason: item.terminalReason,
    ...(item.score !== undefined ? { score: item.score } : {}),
    ...(item.rules
      ? {
          rules: item.rules.map((rule) => ({
            ruleId: rule.ruleId,
            kind: rule.kind,
            passed: rule.passed,
            ...(rule.effect !== undefined ? { effect: rule.effect } : {}),
            ...(rule.dimension !== undefined ? { dimension: rule.dimension } : {}),
            ...(rule.failureCode !== undefined ? { failureCode: rule.failureCode } : {}),
            ...(rule.field !== undefined ? { field: rule.field } : {}),
            ...(rule.expectedType !== undefined ? { expectedType: rule.expectedType } : {}),
            ...(rule.actualType !== undefined ? { actualType: rule.actualType } : {}),
            ...(rule.scope !== undefined ? { scope: rule.scope } : {}),
          })),
        }
      : {}),
    ...(item.dimensions
      ? {
          dimensions: item.dimensions.map((dimension) => ({
            id: dimension.id,
            score: dimension.score,
            reason: boundedReason(dimension.reason) ?? "",
          })),
        }
      : {}),
    ...(item.toolTrace
      ? {
          toolTrace: item.toolTrace.map((event) => ({
            toolName: event.toolName,
            ...(event.logicalId !== undefined ? { logicalId: event.logicalId } : {}),
            success: event.success,
          })),
        }
      : {}),
  });
  return {
    failures: (input.feedback?.failures ?? []).slice(0, 6).map(sanitize),
    successes: (input.feedback?.successes ?? []).slice(0, 2).map(sanitize),
  };
}
