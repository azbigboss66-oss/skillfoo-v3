import test from "node:test";
import assert from "node:assert/strict";
import { ProviderTokenTelemetryEvidenceSchema } from "../types.js";

const providerTelemetryGroup = (
  stage: string,
  role: string,
  promptTokens: number | null,
  completionTokens: number | null,
) => ({
  tags: { stage, role, model: "deepseek-v4-flash" },
  telemetry: {
    promptTokens,
    promptCacheHitTokens: promptTokens === null ? null : 0,
    promptCacheMissTokens: promptTokens,
    completionTokens,
    responses: 1,
    responsesWithUsage: 1,
    responsesMissingUsage: 0,
  },
});

test("provider token telemetry accepts unknown totals without grouped evidence", () => {
  assert.doesNotThrow(() =>
    ProviderTokenTelemetryEvidenceSchema.parse({
      promptTokens: null,
      promptCacheHitTokens: null,
      promptCacheMissTokens: null,
      completionTokens: null,
      responses: 1,
      responsesWithUsage: 0,
      responsesMissingUsage: 1,
    }),
  );
});

test("provider token telemetry accepts unique groups whose coverage and token totals match", () => {
  assert.doesNotThrow(() =>
    ProviderTokenTelemetryEvidenceSchema.parse({
      promptTokens: 30,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 30,
      completionTokens: 7,
      responses: 2,
      responsesWithUsage: 2,
      responsesMissingUsage: 0,
      byStageRoleModel: [
        providerTelemetryGroup("adaptive", "evaluator", 10, 2),
        providerTelemetryGroup("adaptive", "semantic-judge", 20, 5),
      ],
    }),
  );
});

test("provider token telemetry rejects duplicate stage-role-model groups", () => {
  const duplicate = providerTelemetryGroup("adaptive", "evaluator", 10, 2);
  assert.throws(() =>
    ProviderTokenTelemetryEvidenceSchema.parse({
      promptTokens: 20,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 20,
      completionTokens: 4,
      responses: 2,
      responsesWithUsage: 2,
      responsesMissingUsage: 0,
      byStageRoleModel: [duplicate, duplicate],
    }),
  );
});

test("provider token telemetry rejects grouped response and usage coverage drift", () => {
  assert.throws(() =>
    ProviderTokenTelemetryEvidenceSchema.parse({
      promptTokens: 10,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 10,
      completionTokens: 2,
      responses: 2,
      responsesWithUsage: 1,
      responsesMissingUsage: 1,
      byStageRoleModel: [providerTelemetryGroup("adaptive", "evaluator", 10, 2)],
    }),
  );
});

test("provider token telemetry rejects grouped token totals that differ from the top-level totals", () => {
  assert.throws(() =>
    ProviderTokenTelemetryEvidenceSchema.parse({
      promptTokens: 31,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 30,
      completionTokens: 7,
      responses: 2,
      responsesWithUsage: 2,
      responsesMissingUsage: 0,
      byStageRoleModel: [
        providerTelemetryGroup("adaptive", "evaluator", 10, 2),
        providerTelemetryGroup("adaptive", "semantic-judge", 20, 5),
      ],
    }),
  );
});

test("provider token telemetry propagates unknown grouped token usage instead of inventing a sum", () => {
  assert.doesNotThrow(() =>
    ProviderTokenTelemetryEvidenceSchema.parse({
      promptTokens: null,
      promptCacheHitTokens: null,
      promptCacheMissTokens: null,
      completionTokens: null,
      responses: 2,
      responsesWithUsage: 2,
      responsesMissingUsage: 0,
      byStageRoleModel: [
        providerTelemetryGroup("adaptive", "evaluator", 10, 2),
        providerTelemetryGroup("adaptive", "semantic-judge", null, null),
      ],
    }),
  );
  assert.throws(() =>
    ProviderTokenTelemetryEvidenceSchema.parse({
      promptTokens: 10,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 10,
      completionTokens: 2,
      responses: 2,
      responsesWithUsage: 2,
      responsesMissingUsage: 0,
      byStageRoleModel: [
        providerTelemetryGroup("adaptive", "evaluator", 10, 2),
        providerTelemetryGroup("adaptive", "semantic-judge", null, null),
      ],
    }),
  );
});
