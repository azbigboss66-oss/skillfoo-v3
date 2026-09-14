import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTaskVerifier } from "./taskVerifier.js";
import { U1TaskVerifierSchema, type RunTranscript, type U1TaskVerifier } from "../types.js";

function transcript(answer: unknown, toolEvents: RunTranscript["toolEvents"] = []): RunTranscript {
  return {
    scenarioId: "verifier-fixture",
    snapshotId: "fixture",
    toolEvents,
    rawFinalResponse: JSON.stringify({ type: "final", answer }),
    parsedFinalAnswer: answer,
    terminalReason: "final",
    turns: 1,
    durationMs: 1,
  };
}

const verifier: U1TaskVerifier = {
  version: "u1-task-verifier-v3",
  rules: [
    { ruleId: "summary-field", kind: "output_field", field: "summary", valueType: "string", effect: "quality", dimension: "output_structure", weight: 1 },
    { ruleId: "status-value", kind: "exact_value", field: "status", expected: "bounded", effect: "hard_contract" },
    { ruleId: "amount-value", kind: "numeric_value", field: "amount", expected: 100, tolerance: 0.5, effect: "hard_contract" },
    { ruleId: "required-boundary", kind: "required_content", value: "evidence-bound", caseSensitive: false, effect: "quality", dimension: "evidence_boundary", weight: 1 },
    { ruleId: "forbidden-claim", kind: "forbidden_content", value: "I browsed the web", caseSensitive: false, effect: "quality", dimension: "capability_boundary", weight: 1 },
    { ruleId: "reference-citation", kind: "evidence_reference", resourceKind: "reference", logicalId: "guide", effect: "hard_contract" },
    { ruleId: "reference-trace", kind: "successful_tool_trace", tool: "reference.read", logicalId: "guide", effect: "hard_contract" },
  ],
};

function successfulReferenceTrace(): RunTranscript["toolEvents"][number] {
  return {
    turn: 1,
    sequence: 0,
    toolName: "reference.read",
    args: { id: "guide" },
    success: true,
    resultRef: "runtime-context:reference:guide",
    durationMs: 1,
  };
}

test("task verifier accepts one fully compliant output and real successful logical-id trace", () => {
  const results = evaluateTaskVerifier(transcript({
    summary: "Evidence-bound conclusion using guide",
    status: "bounded",
    amount: 100.25,
    evidence: ["guide"],
  }, [successfulReferenceTrace()]), verifier);
  assert.equal(results.length, verifier.rules.length);
  assert.ok(results.every((result) => result.passed));
});

test("task verifier classifies structure, numeric, evidence, trace and content failures without answer text", () => {
  const privateText = "PRIVATE-FIXTURE-CONTENT";
  const results = evaluateTaskVerifier(transcript({
    summary: 7,
    status: "wrong",
    amount: 102,
    note: `I browsed the web ${privateText}`,
  }), verifier);
  const failures = new Map(results.filter((result) => !result.passed).map((result) => [result.ruleId, result.failureCode]));
  assert.equal(failures.get("summary-field"), "TASK_VERIFIER_OUTPUT_TYPE_MISMATCH");
  assert.equal(failures.get("status-value"), "TASK_VERIFIER_VALUE_MISMATCH");
  assert.equal(failures.get("amount-value"), "TASK_VERIFIER_VALUE_MISMATCH");
  assert.equal(failures.get("required-boundary"), "TASK_VERIFIER_REQUIRED_CONTENT_MISSING");
  assert.equal(failures.get("forbidden-claim"), "TASK_VERIFIER_FORBIDDEN_CONTENT_PRESENT");
  assert.equal(failures.get("reference-citation"), "TASK_VERIFIER_EVIDENCE_REFERENCE_MISSING");
  assert.equal(failures.get("reference-trace"), "TASK_VERIFIER_TOOL_TRACE_MISSING");
  assert.doesNotMatch(JSON.stringify(results), new RegExp(privateText));
});

test("claiming a declared tool result without a successful trace still fails", () => {
  const result = evaluateTaskVerifier(transcript({ summary: "used guide" }, [{
    ...successfulReferenceTrace(),
    success: false,
    error: "controlled refusal",
  }]), {
    version: "u1-task-verifier-v3",
    rules: [{ ruleId: "trace", kind: "successful_tool_trace", tool: "reference.read", logicalId: "guide", effect: "hard_contract" }],
  });
  assert.equal(result[0].failureCode, "TASK_VERIFIER_TOOL_TRACE_MISSING");
});

test("evidence references require the exact frozen logical id, not a substring lookalike", () => {
  const result = evaluateTaskVerifier(transcript({ evidence: ["guidepost"] }), {
    version: "u1-task-verifier-v3",
    rules: [{ ruleId: "reference", kind: "evidence_reference", resourceKind: "reference", logicalId: "guide", effect: "hard_contract" }],
  });
  assert.equal(result[0].failureCode, "TASK_VERIFIER_EVIDENCE_REFERENCE_MISSING");
});

test("task verifier schema rejects arbitrary scripts, expressions, duplicate ids and undeclared tools", () => {
  for (const invalid of [
    { version: "u1-task-verifier-v3", rules: [{ ruleId: "x", kind: "javascript", code: "return true", effect: "hard_contract" }] },
    { version: "u1-task-verifier-v3", rules: [{ ruleId: "x", kind: "successful_tool_trace", tool: "script.run", logicalId: "x", effect: "hard_contract" }] },
    { version: "u1-task-verifier-v3", rules: [
      { ruleId: "x", kind: "output_field", field: "a", valueType: "string", effect: "hard_contract" },
      { ruleId: "x", kind: "output_field", field: "b", valueType: "string", effect: "hard_contract" },
    ] },
  ]) {
    assert.equal(U1TaskVerifierSchema.safeParse(invalid).success, false);
  }
});

test("current verifier effects are explicit and preserved in result evidence", () => {
  const current: U1TaskVerifier = {
    version: "u1-task-verifier-v3",
    rules: [
      {
        ruleId: "amount-contract",
        kind: "numeric_value",
        field: "amount",
        expected: 100,
        tolerance: 0,
        effect: "hard_contract",
      },
      {
        ruleId: "bounded-quality",
        kind: "required_content",
        value: "bounded",
        caseSensitive: false,
        effect: "quality",
        dimension: "output_structure",
        weight: 2,
      },
    ],
  };
  const results = evaluateTaskVerifier(transcript({ amount: 99, summary: "unbounded" }), current);
  assert.deepEqual(
    results.map(({ ruleId, effect, dimension, weight }) => ({ ruleId, effect, dimension, weight })),
    [
      { ruleId: "amount-contract", effect: "hard_contract", dimension: undefined, weight: undefined },
      { ruleId: "bounded-quality", effect: "quality", dimension: "output_structure", weight: 2 },
    ],
  );
});

test("current schema rejects hard substring rules and malformed quality bindings", () => {
  const invalid = [
    {
      version: "u1-task-verifier-v3",
      rules: [{ ruleId: "hard-substring", kind: "forbidden_content", value: "claim", caseSensitive: false, effect: "hard_safety" }],
    },
    {
      version: "u1-task-verifier-v3",
      rules: [{ ruleId: "missing-dimension", kind: "output_field", field: "summary", valueType: "string", effect: "quality", weight: 1 }],
    },
    {
      version: "u1-task-verifier-v3",
      rules: [{ ruleId: "missing-weight", kind: "output_field", field: "summary", valueType: "string", effect: "quality", dimension: "output_structure" }],
    },
    {
      version: "u1-task-verifier-v3",
      rules: [{ ruleId: "hard-with-quality-fields", kind: "output_field", field: "summary", valueType: "string", effect: "hard_contract", dimension: "output_structure", weight: 1 }],
    },
  ];
  assert.ok(invalid.every((entry) => !U1TaskVerifierSchema.safeParse(entry).success));
});
