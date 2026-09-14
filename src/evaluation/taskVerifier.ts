import {
  U1TaskVerifierSchema,
  type RunTranscript,
  type U1RuleResult,
  type U1TaskVerifier,
  type U1TaskVerifierRule,
} from "../types.js";

function finalAnswerRecord(transcript: RunTranscript): Record<string, unknown> | null {
  const answer = transcript.parsedFinalAnswer;
  return answer !== null && typeof answer === "object" && !Array.isArray(answer)
    ? answer as Record<string, unknown>
    : null;
}

function answerText(transcript: RunTranscript): string {
  const answer = transcript.parsedFinalAnswer;
  if (answer === undefined || answer === null) return "";
  return typeof answer === "string" ? answer : JSON.stringify(answer);
}

function actualValueType(value: unknown): "string" | "number" | "boolean" | "object" | "array" | "other" {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "other";
}

function containsLogicalId(value: unknown, logicalId: string): boolean {
  if (typeof value === "string") {
    if (value === logicalId) return true;
    const escaped = logicalId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-zA-Z0-9._-])${escaped}($|[^a-zA-Z0-9._-])`).test(value);
  }
  if (Array.isArray(value)) return value.some((entry) => containsLogicalId(entry, logicalId));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) => containsLogicalId(entry, logicalId));
  }
  return false;
}

function ruleEffectEvidence(rule: U1TaskVerifierRule): Pick<U1RuleResult, "effect" | "dimension" | "weight"> {
  return {
    effect: rule.effect,
    ...(rule.effect === "quality" ? { dimension: rule.dimension, weight: rule.weight } : {}),
  };
}

function passed(rule: U1TaskVerifierRule): U1RuleResult {
  return {
    ruleId: rule.ruleId,
    passed: true,
    reason: "task verifier rule passed",
    ...ruleEffectEvidence(rule),
  };
}

function failed(
  rule: U1TaskVerifierRule,
  failureCode: NonNullable<U1RuleResult["failureCode"]>,
): U1RuleResult {
  return {
    ruleId: rule.ruleId,
    passed: false,
    failureCode,
    reason: "task verifier rule failed; private answer and expected content are not persisted",
    ...ruleEffectEvidence(rule),
  };
}

function verifyRule(transcript: RunTranscript, rule: U1TaskVerifierRule): U1RuleResult {
  const record = finalAnswerRecord(transcript);
  if (rule.kind === "output_field") {
    if (!record || !Object.prototype.hasOwnProperty.call(record, rule.field)) {
      return failed(rule, "TASK_VERIFIER_OUTPUT_FIELD_MISSING");
    }
    return actualValueType(record[rule.field]) === rule.valueType
      ? passed(rule)
      : failed(rule, "TASK_VERIFIER_OUTPUT_TYPE_MISMATCH");
  }
  if (rule.kind === "exact_value") {
    if (!record || !Object.prototype.hasOwnProperty.call(record, rule.field)) {
      return failed(rule, "TASK_VERIFIER_OUTPUT_FIELD_MISSING");
    }
    return Object.is(record[rule.field], rule.expected)
      ? passed(rule)
      : failed(rule, "TASK_VERIFIER_VALUE_MISMATCH");
  }
  if (rule.kind === "numeric_value") {
    if (!record || !Object.prototype.hasOwnProperty.call(record, rule.field)) {
      return failed(rule, "TASK_VERIFIER_OUTPUT_FIELD_MISSING");
    }
    const actual = record[rule.field];
    return typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - rule.expected) <= rule.tolerance
      ? passed(rule)
      : failed(rule, "TASK_VERIFIER_VALUE_MISMATCH");
  }
  if (rule.kind === "required_content" || rule.kind === "forbidden_content") {
    const rawText = answerText(transcript);
    const text = rule.caseSensitive ? rawText : rawText.toLocaleLowerCase("en-US");
    const expected = rule.caseSensitive ? rule.value : rule.value.toLocaleLowerCase("en-US");
    const present = text.includes(expected);
    if (rule.kind === "required_content") {
      return present ? passed(rule) : failed(rule, "TASK_VERIFIER_REQUIRED_CONTENT_MISSING");
    }
    return present ? failed(rule, "TASK_VERIFIER_FORBIDDEN_CONTENT_PRESENT") : passed(rule);
  }
  if (rule.kind === "evidence_reference") {
    return containsLogicalId(transcript.parsedFinalAnswer, rule.logicalId)
      ? passed(rule)
      : failed(rule, "TASK_VERIFIER_EVIDENCE_REFERENCE_MISSING");
  }
  const traceExists = transcript.toolEvents.some((event) =>
    event.success && event.toolName === rule.tool && event.args.id === rule.logicalId
  );
  return traceExists
    ? passed(rule)
    : failed(rule, "TASK_VERIFIER_TOOL_TRACE_MISSING");
}

/**
 * Execute the one built-in, declarative U1 verifier. It has no filesystem,
 * command, plugin, network or model callback surface; it evaluates only the
 * completed answer and the already-recorded tool trace.
 */
export function evaluateTaskVerifier(
  transcript: RunTranscript,
  verifier: U1TaskVerifier,
): U1RuleResult[] {
  const frozen = U1TaskVerifierSchema.parse(verifier);
  return frozen.rules.map((rule) => verifyRule(transcript, rule));
}
