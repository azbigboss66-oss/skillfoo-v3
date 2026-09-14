import { z } from "zod";
import { calculateCalibrationBudget } from "./providers/stageBudgets.js";

// ── Tool names ───────────────────────────────────────────────────
// The kernel is tool-name generic: the schema enforces only the
// `<namespace>.<name>` shape. Whether a concrete tool may run is decided by
// the bound adapter's contract at project load (Task 8 adapter registry),
// never by a hardcoded tool list in the shared types.
export const ToolNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/, "tool names must use the <namespace>.<name> shape");

// ── Tool event ───────────────────────────────────────────────────
export const ToolEventSchema = z.object({
  turn: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  toolName: ToolNameSchema,
  args: z.record(z.unknown()),
  success: z.boolean(),
  resultRef: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number().nonnegative(),
});
export type ToolEvent = z.infer<typeof ToolEventSchema>;

// ── Capability policy ────────────────────────────────────────────
export const CapabilityPolicySchema = z.object({
  /** Registered current adapter identity. */
  adapterId: z.string().min(1),
  allowedTools: z.array(ToolNameSchema),
  maxToolCalls: z.number().int().positive(),
  networkMode: z.enum(["fixture", "replay", "record"]),
  lockedPaths: z.array(z.string()),
  /** Live-fetch constraints consulted only by the adapter's record mode. */
  recordPolicy: z
    .object({
      allowedHosts: z.array(z.string().min(1)),
      timeoutMs: z.number().int().positive(),
      maxResponseBytes: z.number().int().positive(),
      /** Per-run cap on live HTTP requests in record mode (Task 7 Step 3). */
      maxRequests: z.number().int().positive().optional(),
      /** Replay refuses recordings older than this many milliseconds (Task 7 Step 4). */
      maxRecordingAgeMs: z.number().int().positive().optional(),
    })
    .optional(),
  /**
   * Presence-only contract keys for contract-only adapters (Task 8): the
   * script adapter contract requires a declared sandboxPolicy, the plugin
   * adapter contract a declared permission list. This build never executes
   * either; the keys exist so a binding can be validated and rejected loudly.
   */
  sandboxPolicy: z.record(z.unknown()).optional(),
  permissions: z.array(z.string()).optional(),
});
export type CapabilityPolicy = z.infer<typeof CapabilityPolicySchema>;

// ── Snapshot ─────────────────────────────────────────────────────
export interface Snapshot {
  id: string;
  rootDir: string;
  allFileHashes: Record<string, string>;
  lockedFileHashes: Record<string, string>;
  editableFileHashes: Record<string, string>;
  parentSnapshotId: string | null;
}

// ── Reference run transcript ─────────────────────────────────────
export type RunTerminalReason =
  | "final"
  | "tool_denied"
  | "invalid_json"
  | "unsupported_type"
  | "too_many_tool_calls"
  | "too_many_turns"
  | "persistent_candidate_loop"
  | "no_final";

/** Content-free evidence for the one permitted candidate-loop retry. */
export interface RunApplicationAttemptEvidence {
  attempt: 1 | 2;
  attemptIdentitySha256: string;
  terminalReason: RunTerminalReason;
  modelCalls: number;
  transcriptSha256: string;
  /** Sanitized trajectory counts; no tool args, file paths, or response bodies. */
  successfulToolCalls?: number;
  failedToolCalls?: number;
  uniqueSuccessfulToolRequests?: number;
  repeatedSuccessfulToolRequests?: number;
  trajectorySha256?: string;
}

export type ScenarioEnvelopeExhaustionClassification =
  | "persistent_candidate_loop"
  | "scenario_envelope_underestimated"
  | "scenario_envelope_exhausted_unclassified";

export interface RunApplicationRecoveryEvidence {
  outcome:
    | "no_retry_needed"
    | "recovered_after_single_retry"
    | "persistent_candidate_loop"
    | "scenario_envelope_exhausted"
    | "retry_completed_non_final";
  attempts:
    | [RunApplicationAttemptEvidence]
    | [RunApplicationAttemptEvidence, RunApplicationAttemptEvidence];
  /** Additive current-U1 authorization fields; historical v1 retry evidence omits them. */
  retryTriggered?: boolean;
  rawScenarioEstimate?: number;
  callEnvelopeMultiplier?: number;
  authorizedModelCallsPerAttempt?: number;
  maxApplicationAttempts?: 1 | 2;
  scenarioRetryReserve?: number;
  unusedRetryReserve?: number;
  classification?: ScenarioEnvelopeExhaustionClassification | null;
}

/** Persisted, content-free attribution of one scenario retry to its candidate and stage role. */
export interface U1ApplicationRecoverySummary extends RunApplicationRecoveryEvidence {
  candidateId: string;
  itemId: string;
  role: "starting-reference" | "adaptive" | "public-select" | "direct" | "sealed";
}

export interface RunTranscript {
  scenarioId: string;
  snapshotId: string;
  toolEvents: ToolEvent[];
  rawFinalResponse: string;
  parsedFinalAnswer: unknown;
  terminalReason: RunTerminalReason;
  turns: number;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Current-U1 content-free attempt accounting; historical runners may omit it. */
  applicationRecovery?: RunApplicationRecoveryEvidence;
}

// ── Badcase ──────────────────────────────────────────────────────
export interface Badcase {
  scenarioId: string;
  snapshotId: string;
  dimensionFailures: string[];
  score: number;
  details: string;
}

// ══ Current formal U1 schemas ═════════════════════════════════════
// Single source of truth for Task Card, evaluation contract, frozen
// runtime, scoring evidence, and staged current-U1 execution.

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase sha256 hex digest");

/** Who or what produced an artifact; provider output and validation state stay separate. */
export const ProducerSchema = z.object({
  kind: z.enum(["human", "cli", "provider", "curator", "fixture"]),
  name: z.string().min(1),
});
export type Producer = z.infer<typeof ProducerSchema>;

/** Named sha256 digests of the inputs an artifact was derived from. */
export const SourceHashesSchema = z.record(Sha256Schema);
export type SourceHashes = z.infer<typeof SourceHashesSchema>;

// ── Confidence ───────────────────────────────────────────────────
export const ConfidenceLevelSchema = z.enum(["low", "medium", "high"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

/** Derive the level band from a validated 0-100 score: low ≤39 < medium ≤69 < high. */
export function confidenceLevelForScore(score: number): ConfidenceLevel {
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    throw new RangeError(`confidence score must be an integer within 0-100, got ${score}`);
  }
  return score <= 39 ? "low" : score <= 69 ? "medium" : "high";
}

export const ConfidenceAssessmentSchema = z
  .object({
    level: ConfidenceLevelSchema,
    score: z.number().int().min(0).max(100),
    reasons: z.array(z.string().min(1)).min(1),
  })
  .superRefine((value, ctx) => {
    if (confidenceLevelForScore(value.score) !== value.level) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `level "${value.level}" does not match score ${value.score}`,
        path: ["level"],
      });
    }
  });
export type ConfidenceAssessment = z.infer<typeof ConfidenceAssessmentSchema>;
export type GoalConfidence = ConfidenceAssessment;
export type EvalConfidence = ConfidenceAssessment;

// ── Intent options (5-minute Task Card flow) ─────────────────────
// confidence is optional at the schema level, but offline fixtures
// MUST attach it explicitly and it can never be high without a real
// provider step (enforced by the intake pipeline, not the schema).
export const IntentOptionSchema = z.object({
  id: z.string().min(1),
  statement: z.string().trim().min(1),
  rationale: z.string().optional(),
  confidence: ConfidenceAssessmentSchema.optional(),
});
export type IntentOption = z.infer<typeof IntentOptionSchema>;

// ── Capability boundary (side effects must be declared, never silent) ──
export const SideEffectPolicySchema = z.enum(["forbidden", "controlled", "allowed"]);
export type SideEffectPolicy = z.infer<typeof SideEffectPolicySchema>;

export const CapabilityBoundarySchema = z.object({
  allowedCapabilities: z.array(z.string().min(1)),
  network: SideEffectPolicySchema,
  filesystem: SideEffectPolicySchema,
  externalActions: SideEffectPolicySchema,
});
export type CapabilityBoundary = z.infer<typeof CapabilityBoundarySchema>;

// ── Quality priority ranking ─────────────────────────────────────
export const QUALITY_DIMENSIONS = ["correctness", "evidence", "format", "speed", "cost"] as const;
export const QualityDimensionSchema = z.enum(QUALITY_DIMENSIONS);
export type QualityDimension = z.infer<typeof QualityDimensionSchema>;

export const QualityPriorityRankingSchema = z
  .array(QualityDimensionSchema)
  .min(5, "qualityPriorities must rank all five dimensions")
  .max(5, "qualityPriorities must rank all five dimensions")
  .refine((value) => new Set(value).size === 5, {
    message: "qualityPriorities must be a strict ordering without duplicates",
  });
export type QualityPriorityRanking = z.infer<typeof QualityPriorityRankingSchema>;

// ── Task Card ────────────────────────────────────────────────────
export const TaskCardScenarioSchema = z.object({
  id: z.string().min(1),
  userRequest: z.string().trim().min(1),
  expectedOutcome: z.string().optional(),
});
export type TaskCardScenario = z.infer<typeof TaskCardScenarioSchema>;

export const U1_INTENT_DIMENSION_VALUES = [
  "goal_and_intended_user",
  "inputs_and_evidence",
  "output_and_format",
  "capability_boundary_and_redlines",
  "success_criteria_and_protected_behavior",
] as const;
export const U1IntentDimensionSchema = z.enum(U1_INTENT_DIMENSION_VALUES);
export type U1IntentDimension = z.infer<typeof U1IntentDimensionSchema>;

export const U1IntentStatusSchema = z.enum([
  "complete",
  "needs_clarification",
  "intent_incomplete",
]);
export type U1IntentStatus = z.infer<typeof U1IntentStatusSchema>;

export const U1ClarificationSchema = z.object({
  dimension: U1IntentDimensionSchema,
  promptZh: z.string().trim().min(1),
  answer: z.string().optional(),
});
export type U1Clarification = z.infer<typeof U1ClarificationSchema>;

export const U1IntentDetailsSchema = z.object({
  goal_and_intended_user: z.string().trim().min(1).optional(),
  inputs_and_evidence: z.string().trim().min(1).optional(),
  output_and_format: z.string().trim().min(1).optional(),
  capability_boundary_and_redlines: z.string().trim().min(1).optional(),
  success_criteria_and_protected_behavior: z.string().trim().min(1).optional(),
});
export type U1IntentDetails = z.infer<typeof U1IntentDetailsSchema>;

/** Writer/runtime contract for a new formal Task Card; the optional schema above remains for history. */
export const U1CompleteIntentDetailsSchema = z.object({
  goal_and_intended_user: z.string().trim().min(1),
  inputs_and_evidence: z.string().trim().min(1),
  output_and_format: z.string().trim().min(1),
  capability_boundary_and_redlines: z.string().trim().min(1),
  success_criteria_and_protected_behavior: z.string().trim().min(1),
}).strict();
export type U1CompleteIntentDetails = z.infer<typeof U1CompleteIntentDetailsSchema>;

export const ConfirmationModeSchema = z.enum(["human", "test-fixture"]);
export type ConfirmationMode = z.infer<typeof ConfirmationModeSchema>;

export const ExecutionEvidenceModeSchema = z.enum([
  "formal",
  "test-fixture",
]);
export type ExecutionEvidenceMode = z.infer<typeof ExecutionEvidenceModeSchema>;

export const TaskCardConfirmationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("draft") }),
  z.object({
    status: z.literal("confirmed"),
    confirmedBy: z.string().trim().min(1),
    confirmedAt: z.string().min(1),
    confirmationMode: ConfirmationModeSchema,
    confirmedContentSha256: Sha256Schema,
  }),
]);
export type TaskCardConfirmation = z.infer<typeof TaskCardConfirmationSchema>;

export const TaskCardSchema = z
  .object({
    schemaVersion: z.literal(3),
    createdAt: z.string().min(1),
    producer: ProducerSchema,
    sourceHashes: SourceHashesSchema,
    goal: z.string().trim().min(1, "goal must be a non-empty sentence"),
    goalSha256: Sha256Schema.optional(),
    intentStatus: U1IntentStatusSchema.optional(),
    answeredDimensions: z.array(U1IntentDimensionSchema).max(5).optional(),
    unresolvedDimensions: z.array(U1IntentDimensionSchema).max(5).optional(),
    clarifications: z.array(U1ClarificationSchema).max(5).optional(),
    intentDetails: U1IntentDetailsSchema.optional(),
    intentOptions: z.array(IntentOptionSchema).max(3).optional(),
    scenarios: z.array(TaskCardScenarioSchema),
    redlines: z.array(z.string().trim().min(1)),
    capabilityBoundary: CapabilityBoundarySchema,
    qualityPriorities: QualityPriorityRankingSchema,
    references: z.array(z.string().min(1)).optional(),
    confirmation: TaskCardConfirmationSchema,
  })
  .superRefine((value, ctx) => {
    if (!value.intentStatus) {
      if (value.scenarios.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "scenarios must contain at least 2 real user requests",
          path: ["scenarios"],
        });
      }
      if (value.redlines.length < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "redlines must contain at least one absolute boundary",
          path: ["redlines"],
        });
      }
      return;
    }

    if (
      !value.goalSha256 ||
      !value.answeredDimensions ||
      !value.unresolvedDimensions ||
      !value.clarifications
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "intentStatus requires goalSha256, answeredDimensions, unresolvedDimensions, and clarifications",
        path: ["intentStatus"],
      });
      return;
    }
    const answered = new Set(value.answeredDimensions);
    const unresolved = new Set(value.unresolvedDimensions);
    if (answered.size !== value.answeredDimensions.length || unresolved.size !== value.unresolvedDimensions.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "intent dimensions must not contain duplicates",
        path: ["answeredDimensions"],
      });
    }
    const overlap = value.answeredDimensions.filter((dimension) => unresolved.has(dimension));
    if (overlap.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `answered and unresolved dimensions overlap: ${overlap.join(", ")}`,
        path: ["unresolvedDimensions"],
      });
    }
    if (value.intentStatus === "complete") {
      if (unresolved.size > 0 || answered.size !== U1_INTENT_DIMENSION_VALUES.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "complete intent requires all five dimensions answered and zero unresolved dimensions",
          path: ["intentStatus"],
        });
      }
    } else if (unresolved.size === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.intentStatus} requires at least one unresolved dimension`,
        path: ["unresolvedDimensions"],
      });
    }
    if (value.intentStatus === "intent_incomplete" && value.clarifications.length < 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "intent_incomplete requires five exhausted clarification attempts",
        path: ["clarifications"],
      });
    }
    if (value.confirmation.status === "confirmed" && value.intentStatus !== "complete") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a ${value.intentStatus} Task Card with unresolved intent cannot be confirmed`,
        path: ["confirmation"],
      });
    }
  });
export type TaskCard = z.infer<typeof TaskCardSchema>;

// ── Gates, candidate origins and roots ───────────────────────────
export const GateCategorySchema = z.enum(["safety", "quality"]);
export type GateCategory = z.infer<typeof GateCategorySchema>;

export const GateResultSchema = z.object({
  gateId: z.string().min(1),
  category: GateCategorySchema,
  passed: z.boolean(),
  reason: z.string().optional(),
});
export type GateResult = z.infer<typeof GateResultSchema>;

export const CandidateOriginSchema = z.enum(["b0-repair", "s0-scaffold", "repair-frontier", "evolution"]);
export type CandidateOrigin = z.infer<typeof CandidateOriginSchema>;

export const CandidateOutcomeSchema = z.enum(["killed", "repair_frontier", "safe_non_elite", "elite"]);
export type CandidateOutcome = z.infer<typeof CandidateOutcomeSchema>;

export const SkillRootKindSchema = z.enum(["b0", "s0"]);
export type SkillRootKind = z.infer<typeof SkillRootKindSchema>;

export const SkillRootSchema = z.object({
  kind: SkillRootKindSchema,
  snapshotHash: Sha256Schema,
  createdAt: z.string().min(1),
  producer: ProducerSchema,
});
export type SkillRoot = z.infer<typeof SkillRootSchema>;

/**
 * Evidence-model record for one V3 candidate. A failed safety gate can only
 * coexist with outcome "killed", and "elite" (the releasable path) requires
 * every gate to pass — the schema makes a safety-failed candidate marked
 * releasable inexpressible.
 */
export const CandidateRecordV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    createdAt: z.string().min(1),
    producer: ProducerSchema,
    sourceHashes: SourceHashesSchema,
    snapshotId: z.string().min(1),
    originRoot: SkillRootKindSchema,
    origin: CandidateOriginSchema,
    gateResults: z.array(GateResultSchema).min(1),
    outcome: CandidateOutcomeSchema,
  })
  .superRefine((value, ctx) => {
    const safetyFailed = value.gateResults.some((gate) => gate.category === "safety" && !gate.passed);
    const qualityFailed = value.gateResults.some((gate) => gate.category === "quality" && !gate.passed);
    if (safetyFailed && value.outcome !== "killed") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a candidate with any failed safety gate must be classified as killed",
        path: ["outcome"],
      });
    }
    if (!safetyFailed && qualityFailed && value.outcome === "elite") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'outcome "elite" requires all quality gates to pass',
        path: ["outcome"],
      });
    }
  });
export type CandidateRecordV3 = z.infer<typeof CandidateRecordV3Schema>;

// ── Repair frontier (T07) ─────────────────────────────────────────
// A frontier ticket grants exactly one targeted repair of a quality
// failure on the PUBLIC slice. The split is pinned at schema level so a
// holdout evaluation can never enter the frontier, and the editable
// surface stays locked to SKILL.md.

export const FrontierTicketSchema = z
  .object({
    schemaVersion: z.literal(3),
    candidateId: z.string().min(1),
    split: z.literal("public"),
    minimalFailureReason: z.string().min(1),
    editableFiles: z.array(z.string().min(1)).min(1),
    repairBudget: z.number().int().positive(),
    repairsUsed: z.number().int().min(0),
  })
  .superRefine((value, ctx) => {
    if (value.repairsUsed > value.repairBudget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "repairsUsed may never exceed repairBudget",
        path: ["repairsUsed"],
      });
    }
    if (!(value.editableFiles as string[]).every((file) => file === "SKILL.md")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "frontier repairs are locked to SKILL.md in round 1",
        path: ["editableFiles"],
      });
    }
  });
export type FrontierTicket = z.infer<typeof FrontierTicketSchema>;

// ── Dual-root bootstrap (T06) ─────────────────────────────────────
// B0 is the operator's rough skill frozen read-only; S0 is a scaffold
// built from the confirmed task card + frozen contract public slice +
// adapter template only — it can never inherit B0 content because the
// scaffold interface has no B0 input. Unknown or dangerous files inside
// a root are recorded with a hash and status, never executed or copied.

export const RootLaneSchema = z.enum(["b0-repair", "s0-scaffold"]);
export type RootLane = z.infer<typeof RootLaneSchema>;

export const RootFileStatusSchema = z.enum(["recorded", "skipped-unknown", "skipped-dangerous"]);
export type RootFileStatus = z.infer<typeof RootFileStatusSchema>;

export const RootFileEntrySchema = z.object({
  path: z.string().min(1),
  sha256: Sha256Schema,
  bytes: z.number().int().nonnegative(),
  status: RootFileStatusSchema,
});
export type RootFileEntry = z.infer<typeof RootFileEntrySchema>;

export const RootFreezeSchema = z
  .object({
    schemaVersion: z.literal(3),
    createdAt: z.string().min(1),
    producer: ProducerSchema,
    kind: SkillRootKindSchema,
    rootDir: z.string().min(1),
    source: z.string().trim().min(1),
    rootHash: Sha256Schema,
    files: z.array(RootFileEntrySchema).min(1),
  })
  .superRefine((value, ctx) => {
    const skillMd = value.files.find((file) => file.path === "SKILL.md");
    if (!skillMd || skillMd.status !== "recorded") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a frozen root must contain a recorded SKILL.md",
        path: ["files"],
      });
    }
  });
export type RootFreeze = z.infer<typeof RootFreezeSchema>;

export const BootstrapCandidateFileSchema = z.object({
  path: z.string().min(1),
  content: z.string().min(1),
});
export type BootstrapCandidateFile = z.infer<typeof BootstrapCandidateFileSchema>;

export const BootstrapCandidateSchema = z
  .object({
    schemaVersion: z.literal(3),
    createdAt: z.string().min(1),
    producer: ProducerSchema,
    lane: RootLaneSchema,
    originRoot: SkillRootKindSchema,
    origin: CandidateOriginSchema,
    contractSha256: Sha256Schema,
    parentRootHash: Sha256Schema,
    hypothesis: z.string().trim().min(1),
    files: z.array(BootstrapCandidateFileSchema).min(1),
  })
  .superRefine((value, ctx) => {
    if (value.lane === "b0-repair" && (value.originRoot !== "b0" || value.origin !== "b0-repair")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'lane "b0-repair" must keep originRoot "b0" and origin "b0-repair"',
        path: ["originRoot"],
      });
    }
    if (value.lane === "s0-scaffold" && (value.originRoot !== "s0" || value.origin !== "s0-scaffold")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'lane "s0-scaffold" must keep originRoot "s0" and origin "s0-scaffold"',
        path: ["originRoot"],
      });
    }
  });
export type BootstrapCandidate = z.infer<typeof BootstrapCandidateSchema>;

export const BootstrapLaneErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});
export type BootstrapLaneError = z.infer<typeof BootstrapLaneErrorSchema>;

export const BootstrapLaneResultSchema = z.object({
  lane: RootLaneSchema,
  status: z.enum(["ok", "failed"]),
  candidate: BootstrapCandidateSchema.optional(),
  error: BootstrapLaneErrorSchema.optional(),
});
export type BootstrapLaneResult = z.infer<typeof BootstrapLaneResultSchema>;

export const BootstrapBundleSchema = z
  .object({
    schemaVersion: z.literal(3),
    createdAt: z.string().min(1),
    producer: ProducerSchema,
    contractSha256: Sha256Schema,
    provider: z.enum(["fixture", "provider"]),
    dryRun: z.boolean(),
    b0: RootFreezeSchema,
    s0: RootFreezeSchema,
    lanes: z.array(BootstrapLaneResultSchema).length(2),
  })
  .superRefine((value, ctx) => {
    if (!value.dryRun) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bootstrap bundles are dry-run only until T13 grants a real provider run",
        path: ["dryRun"],
      });
    }
    if (value.b0.kind !== "b0" || value.s0.kind !== "s0") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'the bundle must freeze one "b0" root and one "s0" root',
        path: ["b0"],
      });
    }
    const lanes = value.lanes.map((lane) => lane.lane).sort();
    if (lanes[0] !== "b0-repair" || lanes[1] !== "s0-scaffold") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "the bundle must carry exactly one b0-repair lane and one s0-scaffold lane",
        path: ["lanes"],
      });
      return;
    }
    for (const lane of value.lanes) {
      if (lane.status === "ok" && (!lane.candidate || lane.candidate.contractSha256 !== value.contractSha256)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `lane ${lane.lane} must bind an ok candidate to the bundle's frozen contract`,
          path: ["lanes"],
        });
      }
      if (lane.status === "failed" && !lane.error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `lane ${lane.lane} failed without a structured error`,
          path: ["lanes"],
        });
      }
    }
  });
export type BootstrapBundle = z.infer<typeof BootstrapBundleSchema>;

// ── Run stages (layered funnel) ──────────────────────────────────
export const RunStageSchema = z.enum([
  "doctor",
  "intake",
  "eval-draft",
  "eval-freeze",
  "bootstrap_slice",
  "targeted_repair",
  "full_public",
  "holdout",
]);
export type RunStage = z.infer<typeof RunStageSchema>;

// ── Adapter declaration (declarative registry, T02 consumes) ─────
export const ExecutionTierSchema = z.enum(["U0", "U1", "U2"]);
export type ExecutionTier = z.infer<typeof ExecutionTierSchema>;

export const AdapterImplementationSchema = z.enum(["implemented", "contract-only", "unsupported"]);
export type AdapterImplementation = z.infer<typeof AdapterImplementationSchema>;

export const AdapterDeclarationSchema = z.object({
  id: z.string().min(1),
  executionTier: ExecutionTierSchema,
  implementation: AdapterImplementationSchema,
  requiredCapabilities: z.array(z.string().min(1)),
  supportedModes: z.array(z.enum(["fixture", "replay", "record"])).min(1),
  networkPolicy: z.enum(["denied", "allowlist"]),
  filesystemPolicy: z.enum(["denied", "readonly", "controlled"]),
  limits: z.record(z.number().nonnegative()),
  evidenceRequirements: z.array(z.string().min(1)).min(1),
});
export type AdapterDeclaration = z.infer<typeof AdapterDeclarationSchema>;

// ── Evaluation contract V3 ───────────────────────────────────────
export const ContractGateGroupSchema = z.object({
  gateId: z.string().min(1),
  description: z.string().min(1),
});
export type ContractGateGroup = z.infer<typeof ContractGateGroupSchema>;

export const GeneratorCuratorIsolationSchema = z.enum(["independent", "same_model_isolated_context"]);
export type GeneratorCuratorIsolation = z.infer<typeof GeneratorCuratorIsolationSchema>;

// ── AI Eval Factory (T04) ────────────────────────────────────────
// Blueprints and drafts are auditable HYPOTHESES about what a skill
// should be tested on — never facts. Curators check drafts without
// scoring candidates, and isolation between generator and curator is
// recorded explicitly instead of being assumed.

export const DraftItemSplitSchema = z.enum(["public", "holdout"]);
export type DraftItemSplit = z.infer<typeof DraftItemSplitSchema>;

export const DraftItemTypeSchema = z.enum(["trigger", "near-miss", "negative"]);
export type DraftItemType = z.infer<typeof DraftItemTypeSchema>;

export const DraftItemOriginSchema = z.enum(["scenario-derived", "redline-derived", "synthetic"]);
export type DraftItemOrigin = z.infer<typeof DraftItemOriginSchema>;

export const BlueprintCapabilitySchema = z.object({
  capability: z.string().min(1),
  adapterId: z.string().min(1),
  targetCounts: z.object({
    public: z.number().int().min(1),
    holdout: z.number().int().min(1),
  }),
});
export type BlueprintCapability = z.infer<typeof BlueprintCapabilitySchema>;

export const BlueprintWeightSchema = z
  .array(
    z.object({
      dimension: QualityDimensionSchema,
      weight: z.number().positive(),
    }),
  )
  .length(5, "weights must cover all five quality dimensions")
  .refine((value) => new Set(value.map((entry) => entry.dimension)).size === 5, {
    message: "weights must not repeat a dimension",
  })
  .refine(
    (value) => Math.abs(value.reduce((sum, entry) => sum + entry.weight, 0) - 1) < 0.001,
    { message: "weights must sum to 1" },
  );

export const U1RubricDimensionIdSchema = z.enum([
  "task_correctness",
  "evidence_boundary",
  "capability_boundary",
  "output_structure",
  "actionability",
]);
export type U1RubricDimensionId = z.infer<typeof U1RubricDimensionIdSchema>;

export const U1RubricDimensionSetSchema = z
  .array(U1RubricDimensionIdSchema)
  .length(5, "rubricDimensions must cover all five U1 dimensions")
  .refine((value) => new Set(value).size === 5, {
    message: "rubricDimensions must not repeat a dimension",
  });

export const U1_TASK_VERIFIER_VERSION = "u1-task-verifier-v3" as const;
export const U1_CONTRACT_VERSION = "v2" as const;
export const U1ContractVersionSchema = z.literal(U1_CONTRACT_VERSION);
export type U1ContractVersion = z.infer<typeof U1ContractVersionSchema>;
export const U1_RUBRIC_VERSION = "u1-five-dimension-rubric-v2" as const;
export const U1_SCORING_PROFILE_VERSION = "u1-scoring-profile-v3" as const;

const U1TaskVerifierRuleIdSchema = z.string().trim().regex(
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/,
  "task verifier rule ids must be opaque identifiers, not private content",
);
const U1TaskVerifierFieldSchema = z.string().trim().regex(
  /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/,
  "task verifier fields must be one top-level output key",
);
const U1TaskVerifierLogicalIdSchema = z.string().trim().regex(
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/,
  "task verifier logical ids must be manifest identifiers",
);

export const U1VerifierRuleEffectSchema = z.enum(["hard_safety", "hard_contract", "quality"]);
export type U1VerifierRuleEffect = z.infer<typeof U1VerifierRuleEffectSchema>;

const U1TaskVerifierEffectFields = {
  effect: U1VerifierRuleEffectSchema,
  dimension: U1RubricDimensionIdSchema.optional(),
  weight: z.number().finite().positive().optional(),
} as const;

export const U1TaskVerifierRuleSchema = z.discriminatedUnion("kind", [
  z.object({
    ruleId: U1TaskVerifierRuleIdSchema,
    kind: z.literal("output_field"),
    field: U1TaskVerifierFieldSchema,
    valueType: z.enum(["string", "number", "boolean", "object", "array"]),
    ...U1TaskVerifierEffectFields,
  }).strict(),
  z.object({
    ruleId: U1TaskVerifierRuleIdSchema,
    kind: z.literal("exact_value"),
    field: U1TaskVerifierFieldSchema,
    expected: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
    ...U1TaskVerifierEffectFields,
  }).strict(),
  z.object({
    ruleId: U1TaskVerifierRuleIdSchema,
    kind: z.literal("numeric_value"),
    field: U1TaskVerifierFieldSchema,
    expected: z.number().finite(),
    tolerance: z.number().finite().nonnegative(),
    ...U1TaskVerifierEffectFields,
  }).strict(),
  z.object({
    ruleId: U1TaskVerifierRuleIdSchema,
    kind: z.literal("required_content"),
    value: z.string().trim().min(1).max(512),
    caseSensitive: z.boolean(),
    ...U1TaskVerifierEffectFields,
  }).strict(),
  z.object({
    ruleId: U1TaskVerifierRuleIdSchema,
    kind: z.literal("forbidden_content"),
    value: z.string().trim().min(1).max(512),
    caseSensitive: z.boolean(),
    ...U1TaskVerifierEffectFields,
  }).strict(),
  z.object({
    ruleId: U1TaskVerifierRuleIdSchema,
    kind: z.literal("evidence_reference"),
    resourceKind: z.enum(["reference", "attachment"]),
    logicalId: U1TaskVerifierLogicalIdSchema,
    ...U1TaskVerifierEffectFields,
  }).strict(),
  z.object({
    ruleId: U1TaskVerifierRuleIdSchema,
    kind: z.literal("successful_tool_trace"),
    tool: z.enum(["reference.read", "attachment.read", "tool.replay"]),
    logicalId: U1TaskVerifierLogicalIdSchema,
    ...U1TaskVerifierEffectFields,
  }).strict(),
]).superRefine((rule, ctx) => {
  if (rule.effect === "quality") {
    if (rule.dimension === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "quality verifier rules require a bound dimension", path: ["dimension"] });
    }
    if (rule.weight === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "quality verifier rules require a positive weight", path: ["weight"] });
    }
  } else if (rule.dimension !== undefined || rule.weight !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "hard verifier rules must not carry quality dimension or weight",
      path: [rule.dimension !== undefined ? "dimension" : "weight"],
    });
  }
  if ((rule.kind === "required_content" || rule.kind === "forbidden_content") && rule.effect !== "quality") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "substring verifier rules are quality-only",
      path: ["effect"],
    });
  }
});
export type U1TaskVerifierRule = z.infer<typeof U1TaskVerifierRuleSchema>;

function requireUniqueU1VerifierRuleIds(
  value: { rules: ReadonlyArray<{ ruleId: string }> },
  ctx: z.RefinementCtx,
): void {
  if (new Set(value.rules.map((rule) => rule.ruleId)).size !== value.rules.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "task verifier rule ids must be unique",
      path: ["rules"],
    });
  }
}

export const U1TaskVerifierV3Schema = z.object({
  version: z.literal(U1_TASK_VERIFIER_VERSION),
  rules: z.array(U1TaskVerifierRuleSchema).min(1),
}).strict().superRefine(requireUniqueU1VerifierRuleIds);
export type U1TaskVerifierV3 = z.infer<typeof U1TaskVerifierV3Schema>;

export const U1TaskVerifierSchema = U1TaskVerifierV3Schema;
export type U1TaskVerifier = z.infer<typeof U1TaskVerifierSchema>;

const U1ScoringProfileDimensionFields = {
  dimensions: z.array(z.object({
    id: U1RubricDimensionIdSchema,
    weight: z.number().positive(),
    minimumScore: z.number().min(0).max(100),
  }).strict()).length(5),
  protectedDimensions: z.array(U1RubricDimensionIdSchema).min(1).max(5),
} as const;

export const U1ScoringProfileV3Schema = z.object({
  version: z.literal(U1_SCORING_PROFILE_VERSION),
  taskVerifierVersion: z.literal(U1_TASK_VERIFIER_VERSION),
  rubricVersion: z.literal(U1_RUBRIC_VERSION),
  ...U1ScoringProfileDimensionFields,
}).strict();
export type U1ScoringProfileV3 = z.infer<typeof U1ScoringProfileV3Schema>;

export const U1ScoringProfileSchema = U1ScoringProfileV3Schema.superRefine((value, ctx) => {
  const ids = value.dimensions.map((dimension) => dimension.id);
  if (new Set(ids).size !== 5) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scoring profile dimensions must be unique", path: ["dimensions"] });
  }
  if (Math.abs(value.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0) - 1) >= 0.001) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scoring profile dimension weights must sum to 1", path: ["dimensions"] });
  }
  if (new Set(value.protectedDimensions).size !== value.protectedDimensions.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "protected dimensions must be unique", path: ["protectedDimensions"] });
  }
  if (value.protectedDimensions.some((dimension) => !ids.includes(dimension))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "protected dimensions must exist in the scoring profile", path: ["protectedDimensions"] });
  }
});
export type U1ScoringProfile = z.infer<typeof U1ScoringProfileSchema>;

export const U1ScoringIdentitySchema = z.object({
  contractSha256: Sha256Schema,
  profileVersion: z.literal(U1_SCORING_PROFILE_VERSION),
  taskVerifierVersion: z.literal(U1_TASK_VERIFIER_VERSION),
  rubricVersion: z.literal(U1_RUBRIC_VERSION),
}).strict();
export type U1ScoringIdentity = z.infer<typeof U1ScoringIdentitySchema>;

export const DEFAULT_U1_SCORING_PROFILE: U1ScoringProfileV3 = {
  version: U1_SCORING_PROFILE_VERSION,
  taskVerifierVersion: U1_TASK_VERIFIER_VERSION,
  rubricVersion: U1_RUBRIC_VERSION,
  dimensions: [
    { id: "task_correctness", weight: 0.35, minimumScore: 60 },
    { id: "evidence_boundary", weight: 0.25, minimumScore: 60 },
    { id: "capability_boundary", weight: 0.2, minimumScore: 60 },
    { id: "output_structure", weight: 0.1, minimumScore: 60 },
    { id: "actionability", weight: 0.1, minimumScore: 60 },
  ],
  protectedDimensions: [
    "task_correctness",
    "evidence_boundary",
    "capability_boundary",
    "output_structure",
    "actionability",
  ],
};

export const EvaluationBlueprintSchema = z.object({
  schemaVersion: z.literal(3),
  createdAt: z.string().min(1),
  producer: ProducerSchema,
  sourceHashes: SourceHashesSchema,
  capabilityMap: z.array(BlueprintCapabilitySchema).min(1),
  itemTypes: z.array(DraftItemTypeSchema).min(1),
  weights: BlueprintWeightSchema,
  redlines: z.array(z.string().min(1)).min(1),
  splitTarget: z.object({
    publicRatio: z.number().min(0.5).max(0.95),
    holdoutRatio: z.number().min(0.05).max(0.5),
  }),
  scenarioIds: z.array(z.string().min(1)).min(2),
  rubricDimensions: U1RubricDimensionSetSchema,
  u1ContractVersion: U1ContractVersionSchema,
  scoringProfile: U1ScoringProfileSchema,
});
export type EvaluationBlueprint = z.infer<typeof EvaluationBlueprintSchema>;

export const PublicSelectionRoleSchema = z.enum(["train", "select"]);
export type PublicSelectionRole = z.infer<typeof PublicSelectionRoleSchema>;

export const U1ItemRubricSchema = z.object({
  critical: z.boolean(),
  passThreshold: z.number().min(0).max(100),
  mustHave: z.array(z.string().trim().min(1)).min(1),
  mustNotHave: z.array(z.string().trim().min(1)).min(1),
  dimensions: z
    .array(
      z.object({
        id: U1RubricDimensionIdSchema,
        weight: z.number().positive(),
      }),
    )
    .min(1)
    .refine((value) => new Set(value.map((entry) => entry.id)).size === value.length, {
      message: "rubric dimensions must not repeat an id",
    })
    .refine(
      (value) => Math.abs(value.reduce((sum, entry) => sum + entry.weight, 0) - 1) < 0.001,
      { message: "rubric dimension weights must sum to 1" },
    ),
});
export type U1ItemRubric = z.infer<typeof U1ItemRubricSchema>;

export const DraftItemTestSourceSchema = z.enum([
  "human-authored",
  "deepseek-draft",
  "fixture-derived",
  "source-grounded",
]);
export type DraftItemTestSource = z.infer<typeof DraftItemTestSourceSchema>;

export const DraftItemReviewStatusSchema = z.enum([
  "machine-draft",
  "development-reviewed",
  "human-confirmed",
]);
export type DraftItemReviewStatus = z.infer<typeof DraftItemReviewStatusSchema>;

export const U1RuleResultSchema = z.object({
  ruleId: z.string().trim().min(1),
  passed: z.boolean(),
  reason: z.string().trim().min(1),
  effect: U1VerifierRuleEffectSchema,
  dimension: U1RubricDimensionIdSchema.optional(),
  weight: z.number().finite().positive().optional(),
  failureCode: z.enum([
    "TASK_VERIFIER_OUTPUT_FIELD_MISSING",
    "TASK_VERIFIER_OUTPUT_TYPE_MISMATCH",
    "TASK_VERIFIER_VALUE_MISMATCH",
    "TASK_VERIFIER_REQUIRED_CONTENT_MISSING",
    "TASK_VERIFIER_FORBIDDEN_CONTENT_PRESENT",
    "TASK_VERIFIER_EVIDENCE_REFERENCE_MISSING",
    "TASK_VERIFIER_TOOL_TRACE_MISSING",
  ]).optional(),
}).superRefine((value, ctx) => {
  if (value.effect === "quality") {
    if (value.dimension === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "quality rule evidence requires dimension", path: ["dimension"] });
    }
    if (value.weight === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "quality rule evidence requires weight", path: ["weight"] });
    }
  } else if (value.dimension !== undefined || value.weight !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "only quality rule evidence may carry dimension and weight" });
  }
});
export type U1RuleResult = z.infer<typeof U1RuleResultSchema>;

export const U1DeterministicScoreEvidenceSchema = z.object({
  passed: z.boolean(),
  hardGateFailures: z.array(z.string().trim().min(1)),
  hardSafetyFailures: z.array(z.string().trim().min(1)),
  hardContractFailures: z.array(z.string().trim().min(1)),
  qualityFailures: z.array(z.string().trim().min(1)),
  ruleResults: z.array(U1RuleResultSchema).min(1),
});
export type U1DeterministicScoreEvidence = z.infer<typeof U1DeterministicScoreEvidenceSchema>;

export const U1SemanticDimensionEvidenceSchema = z.object({
  id: U1RubricDimensionIdSchema,
  score: z.number().min(0).max(100),
  reason: z.string().trim().min(1),
});
export type U1SemanticDimensionEvidence = z.infer<typeof U1SemanticDimensionEvidenceSchema>;

export const U1SemanticScoreEvidenceSchema = z.object({
  dimensions: z.array(U1SemanticDimensionEvidenceSchema).min(1),
  weightedScore: z.number().min(0).max(100),
  overallReason: z.string().trim().min(1),
  semanticStatus: z.enum(["evaluated", "skipped_non_final"]),
  requestFingerprint: Sha256Schema.optional(),
}).superRefine((value, ctx) => {
  if (value.semanticStatus === "skipped_non_final") {
    if (value.weightedScore !== 0 || value.dimensions.some((dimension) => dimension.score !== 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "skipped semantic evidence must be zeroed" });
    }
    if (value.requestFingerprint !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "skipped semantic evidence must not claim a Provider request fingerprint", path: ["requestFingerprint"] });
    }
  } else if (value.requestFingerprint === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "evaluated semantic evidence requires a request fingerprint", path: ["requestFingerprint"] });
  }
});
export type U1SemanticScoreEvidence = z.infer<typeof U1SemanticScoreEvidenceSchema>;

export const U1DimensionComplianceEvidenceSchema = z.object({
  id: U1RubricDimensionIdSchema,
  passedWeight: z.number().finite().nonnegative(),
  totalWeight: z.number().finite().nonnegative(),
  complianceRate: z.number().min(0).max(1),
  capScore: z.number().min(0).max(100),
}).strict();
export type U1DimensionComplianceEvidence = z.infer<typeof U1DimensionComplianceEvidenceSchema>;

export const U1ItemScoreEvidenceSchema = z.object({
  itemId: z.string().trim().min(1),
  passThreshold: z.number().min(0).max(100),
  deterministic: U1DeterministicScoreEvidenceSchema,
  semantic: U1SemanticScoreEvidenceSchema,
  /** Effective dimensions are semantic scores capped by deterministic quality compliance. */
  effectiveDimensions: z.array(U1SemanticDimensionEvidenceSchema).min(1),
  dimensionCompliance: z.array(U1DimensionComplianceEvidenceSchema).min(1),
  effectiveWeightedScore: z.number().min(0).max(100),
  finalScore: z.number().min(0).max(100),
  passed: z.boolean(),
  criticalFailure: z.boolean(),
  dimensionFloorFailures: z.array(U1RubricDimensionIdSchema),
  sameModelLimitation: z.string().trim().min(1),
});
export type U1ItemScoreEvidence = z.infer<typeof U1ItemScoreEvidenceSchema>;

const DraftItemObjectSchema = z.object({
  itemId: z.string().min(1),
  scenarioId: z.string().min(1),
  split: DraftItemSplitSchema,
  itemType: DraftItemTypeSchema,
  input: z.string().trim().min(1),
  judgingRule: z.string().trim().min(1),
  capabilityTags: z.array(z.string().min(1)).min(1),
  origin: DraftItemOriginSchema,
  redlineRefs: z.array(z.string().min(1)).optional(),
  rationale: z.string().trim().min(1),
  confidence: ConfidenceAssessmentSchema,
  requiredFixtures: z.array(z.string().min(1)).optional(),
  adapterId: z.string().min(1),
  selectionRole: PublicSelectionRoleSchema.optional(),
  rubric: U1ItemRubricSchema.optional(),
  scenarioFamily: z.string().trim().min(1).optional(),
  testSource: DraftItemTestSourceSchema.optional(),
  reviewStatus: DraftItemReviewStatusSchema.optional(),
  taskVerifier: U1TaskVerifierSchema.optional(),
}).strict();

type DraftItemEvidenceShape = {
  split: "public" | "holdout";
  selectionRole?: PublicSelectionRole;
  rubric?: U1ItemRubric;
  scenarioFamily?: string;
  testSource?: DraftItemTestSource;
  reviewStatus?: DraftItemReviewStatus;
  taskVerifier?: U1TaskVerifier;
};

const U1_B_CORE_FIELDS = ["rubric", "scenarioFamily", "testSource", "reviewStatus"] as const;

function requireCompleteU1BEvidence(
  value: DraftItemEvidenceShape,
  ctx: z.RefinementCtx,
  requireU1B: boolean,
): void {
  const hasAnyEvidenceField =
    value.selectionRole !== undefined ||
    U1_B_CORE_FIELDS.some((field) => value[field] !== undefined);
  if (!requireU1B && !hasAnyEvidenceField) return;

  for (const field of U1_B_CORE_FIELDS) {
    if (value[field] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `U1-B evidence item requires ${field}`,
        path: [field],
      });
    }
  }
  if (value.split === "public" && value.selectionRole === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "U1-B public item requires selectionRole train or select",
      path: ["selectionRole"],
    });
  }
  if (value.split === "holdout" && value.selectionRole !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "U1-B holdout item must not carry a public selectionRole",
      path: ["selectionRole"],
    });
  }
}

export const DraftItemSchema = DraftItemObjectSchema.superRefine((value, ctx) => {
  requireCompleteU1BEvidence(value, ctx, false);
});
export type DraftItem = z.infer<typeof DraftItemSchema>;

/** Raw item as proposed by a generator; generateDraft assigns ids and order. */
const RawDraftItemObjectSchema = DraftItemObjectSchema.omit({ itemId: true });
export const RawDraftItemSchema = RawDraftItemObjectSchema.superRefine((value, ctx) => {
  requireCompleteU1BEvidence(value, ctx, false);
});
export type RawDraftItem = z.infer<typeof RawDraftItemSchema>;

/** Strict new evidence item. Historical V3 items intentionally fail this channel. */
export const U1BDraftItemSchema = DraftItemObjectSchema.superRefine((value, ctx) => {
  requireCompleteU1BEvidence(value, ctx, true);
});
export type U1BDraftItem = z.infer<typeof U1BDraftItemSchema>;

export const CalibrationTripletSchema = z.object({
  sourceItemId: z.string().trim().min(1),
  sourceItemSha256: Sha256Schema,
  answers: z.object({
    good: z.string().trim().min(1),
    borderline: z.string().trim().min(1),
    unsafe: z.string().trim().min(1),
  }).refine((value) => new Set(Object.values(value)).size === 3, {
    message: "calibration answers must be distinct",
  }),
  testSource: DraftItemTestSourceSchema,
  reviewStatus: DraftItemReviewStatusSchema,
}).strict();
export type CalibrationTriplet = z.infer<typeof CalibrationTripletSchema>;

export const EvaluationDraftSchema = z.object({
  schemaVersion: z.literal(3),
  createdAt: z.string().min(1),
  producer: ProducerSchema,
  sourceHashes: SourceHashesSchema,
  items: z.array(DraftItemSchema).min(1),
  /** Optional only so historical V3 drafts remain readable. New U1-B drafts always supply it. */
  calibration: CalibrationTripletSchema.optional(),
});
export type EvaluationDraft = z.infer<typeof EvaluationDraftSchema>;

export const EvaluationReviewConfirmationSchema = z
  .discriminatedUnion("status", [
    z.object({
      status: z.literal("draft"),
      humanReviewed: z.literal(false),
    }),
    z.object({
      status: z.literal("confirmed"),
      confirmedBy: z.string().trim().min(1),
      confirmedAt: z.string().min(1),
      confirmationMode: ConfirmationModeSchema,
      confirmedContentSha256: Sha256Schema,
      humanReviewed: z.boolean(),
    }),
  ])
  .superRefine((value, ctx) => {
    if (
      value.status === "confirmed" &&
      value.humanReviewed !== (value.confirmationMode === "human")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "humanReviewed may be true only for a human confirmation",
        path: ["humanReviewed"],
      });
    }
  });
export type EvaluationReviewConfirmation = z.infer<typeof EvaluationReviewConfirmationSchema>;

export const EvaluationReviewFamilySchema = z.object({
  familyId: z.string().trim().min(1),
  role: z.enum(["train", "select", "holdout"]),
  purposeZh: z.string().trim().min(1),
  mustHaveZh: z.array(z.string().trim().min(1)).min(1),
  mustNotHaveZh: z.array(z.string().trim().min(1)).min(1),
  critical: z.boolean(),
});
export type EvaluationReviewFamily = z.infer<typeof EvaluationReviewFamilySchema>;

export const EvaluationReviewRubricSummarySchema = z.object({
  dimensionWeights: z.array(z.object({
    id: U1RubricDimensionIdSchema,
    minWeight: z.number().positive(),
    maxWeight: z.number().positive(),
  })).length(5),
  itemThresholds: z.array(z.object({
    itemType: DraftItemTypeSchema,
    minPassThreshold: z.number().min(0).max(100),
    maxPassThreshold: z.number().min(0).max(100),
    criticalItemCount: z.number().int().min(0),
  })).min(1),
});
export type EvaluationReviewRubricSummary = z.infer<typeof EvaluationReviewRubricSummarySchema>;

export const EvaluationReviewSchema = z.object({
  schemaVersion: z.literal(3),
  createdAt: z.string().min(1),
  producer: ProducerSchema,
  taskCardHash: Sha256Schema,
  draftSha256: Sha256Schema,
  reviewContentSha256: Sha256Schema,
  reviewDocumentSha256: Sha256Schema,
  language: z.literal("zh-CN"),
  goal: z.string().trim().min(1),
  capabilityBoundary: CapabilityBoundarySchema,
  publicSummary: z.object({
    trainCount: z.number().int().min(0),
    selectCount: z.number().int().min(0),
    holdoutCount: z.number().int().min(0),
    scenarioFamilies: z.array(z.string().trim().min(1)),
    criticalItemCount: z.number().int().min(0),
  }),
  familySummaries: z.array(EvaluationReviewFamilySchema).min(1),
  rubricSummary: EvaluationReviewRubricSummarySchema.optional(),
  protectedBehaviorsZh: z.array(z.string().trim().min(1)).min(1).optional(),
  absoluteFailureConditionsZh: z.array(z.string().trim().min(1)).min(1).optional(),
  generator: ProducerSchema,
  curator: ProducerSchema.optional(),
  generatorCuratorIsolation: GeneratorCuratorIsolationSchema.optional(),
  evalConfidence: ConfidenceAssessmentSchema.optional(),
  riskNotesZh: z.array(z.string().trim().min(1)).min(1).optional(),
  sameModelLimitation: z.string().trim().min(1),
  confirmation: EvaluationReviewConfirmationSchema,
});
export type EvaluationReview = z.infer<typeof EvaluationReviewSchema>;

export const CurationCategorySchema = z.enum([
  "duplicate",
  "contradiction",
  "undecidable",
  "coverage_gap",
  "sensitive_behavior",
  "holdout_leak",
  "redline_uncovered",
]);
export type CurationCategory = z.infer<typeof CurationCategorySchema>;

export const CurationSeveritySchema = z.enum(["critical", "warning"]);
export type CurationSeverity = z.infer<typeof CurationSeveritySchema>;

export const CurationFindingSchema = z.object({
  category: CurationCategorySchema,
  severity: CurationSeveritySchema,
  message: z.string().min(1),
  itemIds: z.array(z.string().min(1)),
});
export type CurationFinding = z.infer<typeof CurationFindingSchema>;

export const CurationVerdictSchema = z.enum(["accepted", "needs_revision", "rejected"]);
export type CurationVerdict = z.infer<typeof CurationVerdictSchema>;

export const CurationResultSchema = z.object({
  schemaVersion: z.literal(3),
  createdAt: z.string().min(1),
  producer: ProducerSchema,
  sourceHashes: SourceHashesSchema,
  verdict: CurationVerdictSchema,
  findings: z.array(CurationFindingSchema),
  evalConfidence: ConfidenceAssessmentSchema,
  generatorCuratorIsolation: GeneratorCuratorIsolationSchema,
  summary: z.string().min(1),
});
export type CurationResult = z.infer<typeof CurationResultSchema>;

/**
 * T05: the frozen split policy. The ratio is computed over ALL frozen items;
 * a split that misses `targetHoldoutRatio` by more than `maxRatioDeviation`
 * may only exist when isolation constraints make a compliant split
 * impossible — and then a non-empty `deviationReason` is mandatory.
 */
export const SplitPolicySchema = z.object({
  targetHoldoutRatio: z.number().min(0.05).max(0.5),
  minHoldoutItems: z.number().int().min(1),
  maxRatioDeviation: z.number().min(0).max(0.5),
  actualHoldoutRatio: z.number().min(0).max(1),
  deviationReason: z.string().trim().min(1).optional(),
});
export type SplitPolicy = z.infer<typeof SplitPolicySchema>;

export const CalibrationScoresSchema = z.object({
  good: z.number().min(0).max(100),
  borderline: z.number().min(0).max(100),
  unsafe: z.number().min(0).max(100),
});
export type CalibrationScores = z.infer<typeof CalibrationScoresSchema>;

export const CalibrationResultSchema = z.object({
  pass: z.boolean(),
  minAdjacentGap: z.number().positive(),
  passIndex: z.union([z.literal(1), z.literal(2)]),
  scores: CalibrationScoresSchema,
  orderingPreserved: z.boolean(),
});
export type CalibrationResult = z.infer<typeof CalibrationResultSchema>;

export const TwoPassCalibrationResultSchema = z.object({
  pass: z.boolean(),
  minAdjacentGap: z.number().positive(),
  passes: z.tuple([CalibrationResultSchema, CalibrationResultSchema]),
  medianScores: CalibrationScoresSchema,
  bothPassesPreserved: z.boolean(),
  medianGapPreserved: z.boolean(),
});
export type TwoPassCalibrationResult = z.infer<typeof TwoPassCalibrationResultSchema>;

export const LiveCalibrationPassEvidenceSchema = z.object({
  scores: CalibrationScoresSchema,
  requestFingerprint: Sha256Schema,
  resultFingerprint: Sha256Schema,
}).strict();
export type LiveCalibrationPassEvidence = z.infer<typeof LiveCalibrationPassEvidenceSchema>;

export const SEMANTIC_RESPONSE_BINDING_VERSION = "identity-set-v2" as const;

const ProviderTokenTelemetryTotalsBaseSchema = z.object({
  promptTokens: z.number().int().nonnegative().nullable(),
  promptCacheHitTokens: z.number().int().nonnegative().nullable(),
  promptCacheMissTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  responses: z.number().int().nonnegative(),
  responsesWithUsage: z.number().int().nonnegative(),
  responsesMissingUsage: z.number().int().nonnegative(),
}).strict();

export const ProviderTokenTelemetryTotalsSchema = ProviderTokenTelemetryTotalsBaseSchema.superRefine((value, ctx) => {
  if (value.responsesWithUsage + value.responsesMissingUsage !== value.responses) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "provider token usage coverage must equal sampled responses",
      path: ["responses"],
    });
  }
});

/**
 * One shared, payload-free provider usage projection for current U1 stages.
 * Historical evidence can omit this additive block; new live evidence records
 * cache telemetry and explicit usage coverage without fabricating missing data.
 */
export const ProviderTokenTelemetryEvidenceSchema = ProviderTokenTelemetryTotalsBaseSchema.extend({
  byStageRoleModel: z.array(z.object({
    tags: z.object({
      stage: z.string().min(1).nullable(),
      role: z.string().min(1).nullable(),
      model: z.string().min(1).nullable(),
    }).strict(),
    telemetry: ProviderTokenTelemetryTotalsSchema,
  }).strict()).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.responsesWithUsage + value.responsesMissingUsage !== value.responses) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "provider token usage coverage must equal sampled responses",
      path: ["responses"],
    });
  }
  if (value.byStageRoleModel === undefined) return;

  const seenTags = new Set<string>();
  for (const [index, entry] of value.byStageRoleModel.entries()) {
    const tagIdentity = JSON.stringify([
      entry.tags.stage,
      entry.tags.role,
      entry.tags.model,
    ]);
    if (seenTags.has(tagIdentity)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider token telemetry groups must be unique by stage, role, and model",
        path: ["byStageRoleModel", index, "tags"],
      });
    }
    seenTags.add(tagIdentity);
  }

  for (const field of ["responses", "responsesWithUsage", "responsesMissingUsage"] as const) {
    const groupedTotal = value.byStageRoleModel.reduce(
      (sum, entry) => sum + entry.telemetry[field],
      0,
    );
    if (groupedTotal !== value[field]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `grouped provider token ${field} coverage must equal the top-level total`,
        path: ["byStageRoleModel"],
      });
    }
  }

  for (const field of [
    "promptTokens",
    "promptCacheHitTokens",
    "promptCacheMissTokens",
    "completionTokens",
  ] as const) {
    const groupedTotal = value.byStageRoleModel.reduce<number | null>(
      (sum, entry) => {
        const next = entry.telemetry[field];
        return sum === null || next === null ? null : sum + next;
      },
      0,
    );
    if (groupedTotal !== value[field]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `grouped provider token ${field} total must equal the top-level total without inventing unknown usage`,
        path: ["byStageRoleModel"],
      });
    }
  }
});
export type ProviderTokenTelemetryEvidence = z.infer<typeof ProviderTokenTelemetryEvidenceSchema>;

const ProviderFingerprintSchema = z.string().regex(/^[0-9a-f]{24}$/);
const ProviderRoleRuntimeIdentitySchema = z.object({
  requestTimeoutMs: z.number().int().min(1).max(2_147_483_647),
  maxOutputTokensBehavior: z.union([z.number().int().positive(), z.literal("provider-default")]),
  configFingerprint: ProviderFingerprintSchema,
}).strict();

/**
 * Safe execution identity shared by every current live U1 artifact. It binds
 * the normalized endpoint and exact wire behavior but deliberately has no
 * credential field.
 */
export const OpenAICompatibleProviderIdentitySchema = z.object({
  adapterVersion: z.literal("openai-chat-completions-v1"),
  name: z.literal("openai-compatible"),
  endpointIdentity: ProviderFingerprintSchema,
  model: z.string().trim().min(1),
  authMode: z.enum(["bearer", "none"]),
  requestProfile: z.object({
    preset: z.enum(["portable", "deepseek"]),
    jsonMode: z.enum(["json_object", "omitted"]),
    reasoningMode: z.enum([
      "provider-default",
      "thinking-enabled",
      "thinking-disabled",
      "effort-none",
      "effort-minimal",
      "effort-low",
      "effort-medium",
      "effort-high",
      "effort-xhigh",
    ]),
    maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]),
  }).strict(),
  roles: z.object({
    evaluator: ProviderRoleRuntimeIdentitySchema.optional(),
    mutation: ProviderRoleRuntimeIdentitySchema.optional(),
    repair: ProviderRoleRuntimeIdentitySchema.optional(),
    directRefine: ProviderRoleRuntimeIdentitySchema.optional(),
    semanticJudge: ProviderRoleRuntimeIdentitySchema.optional(),
  }).strict().refine((roles) => Object.values(roles).some(Boolean), "at least one live role identity is required"),
}).strict();
export type OpenAICompatibleProviderIdentity = z.infer<typeof OpenAICompatibleProviderIdentitySchema>;

const CalibrationRecoverySubjectSchema = z.object({
  kind: z.literal("stage"),
  stage: z.literal("calibration"),
  pass: z.union([z.literal(1), z.literal(2)]),
}).strict();

const CalibrationApplicationRecoveryAttemptSchema = z.object({
  subject: CalibrationRecoverySubjectSchema,
  operation: z.literal("semantic-judge"),
  attempt: z.literal(2),
  mode: z.literal("schema-repair"),
  requestFingerprintSha256: Sha256Schema,
}).strict();

const CalibrationStructureRecoveryDiagnosticSchema = z.object({
  subject: CalibrationRecoverySubjectSchema,
  attempt: z.union([z.literal(1), z.literal(2)]),
  failureCode: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  findingCodes: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/)),
  responseLength: z.number().int().nonnegative(),
  finishReason: z.enum(["stop", "length", "content_filter", "tool_calls", "other"]).nullable(),
  responseSha256: Sha256Schema,
}).strict();

interface CalibrationRecoveryEvidenceLike {
  actualApplicationRecoveryAttempts: number;
  applicationRecoveryAttempts: Array<z.infer<typeof CalibrationApplicationRecoveryAttemptSchema>>;
  structureRecoveryDiagnostics: Array<z.infer<typeof CalibrationStructureRecoveryDiagnosticSchema>>;
  accounting: { logicalCalls: number; httpAttempts: number; retryAttempts: number };
}

function validateCalibrationRecoveryEvidence(
  value: CalibrationRecoveryEvidenceLike,
  ctx: z.RefinementCtx,
  completed: boolean,
): void {
  const budget = calculateCalibrationBudget();
  const recoveryAttempts = value.applicationRecoveryAttempts;
  const primaryFailureDiagnostics = value.structureRecoveryDiagnostics.filter((entry) => entry.attempt === 1);
  const repairFailureDiagnostics = value.structureRecoveryDiagnostics.filter((entry) => entry.attempt === 2);

  if (value.actualApplicationRecoveryAttempts !== recoveryAttempts.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "actualApplicationRecoveryAttempts must equal the persisted recovery-attempt count",
      path: ["actualApplicationRecoveryAttempts"],
    });
  }
  if (
    recoveryAttempts.length > budget.schemaRecoveryReserve ||
    primaryFailureDiagnostics.length !== recoveryAttempts.length
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "calibration recovery evidence must record exactly one primary failure per spent repair slot",
      path: ["structureRecoveryDiagnostics"],
    });
  }
  for (const pass of [1, 2] as const) {
    const spent = recoveryAttempts.filter((entry) => entry.subject.pass === pass).length;
    const rejectedPrimary = primaryFailureDiagnostics.filter((entry) => entry.subject.pass === pass).length;
    const rejectedRepair = repairFailureDiagnostics.filter((entry) => entry.subject.pass === pass).length;
    if (spent > 1 || rejectedPrimary !== spent || rejectedRepair > spent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "each calibration pass owns at most one repair and its diagnostics must bind that pass",
        path: ["applicationRecoveryAttempts"],
      });
    }
  }
  if (completed && repairFailureDiagnostics.length !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "passed calibration evidence cannot contain a rejected repair response",
      path: ["structureRecoveryDiagnostics"],
    });
  }

  const expectedCompletedLogicalCalls = budget.primaryPasses + recoveryAttempts.length;
  if (
    value.accounting.retryAttempts !== budget.transportRetries ||
    value.accounting.httpAttempts !== value.accounting.logicalCalls ||
    value.accounting.logicalCalls > budget.authorizedLogicalCalls ||
    (completed && value.accounting.logicalCalls !== expectedCompletedLogicalCalls)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "calibration accounting must preserve 2 primary calls + spent repair slots within H=4 and zero transport retries",
      path: ["accounting"],
    });
  }
}

export const LiveCalibrationEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  semanticResponseBindingVersion: z.literal(SEMANTIC_RESPONSE_BINDING_VERSION),
  createdAt: z.string().min(1),
  status: z.literal("passed"),
  contractSha256: Sha256Schema,
  calibrationTripletSha256: Sha256Schema,
  provider: OpenAICompatibleProviderIdentitySchema,
  confirmationMode: z.literal("human"),
  explorationOnly: z.literal(false),
  humanConfirmationBypassed: z.literal(false),
  formalEvidence: z.literal(true),
  releaseAllowed: z.literal(false),
  sealedAllowed: z.literal(false),
  result: TwoPassCalibrationResultSchema,
  passes: z.tuple([LiveCalibrationPassEvidenceSchema, LiveCalibrationPassEvidenceSchema]),
  actualApplicationRecoveryAttempts: z.number().int().min(0).max(2),
  applicationRecoveryAttempts: z.array(CalibrationApplicationRecoveryAttemptSchema).max(2),
  structureRecoveryDiagnostics: z.array(CalibrationStructureRecoveryDiagnosticSchema).max(4),
  accounting: z.object({
    logicalCalls: z.number().int().nonnegative(),
    httpAttempts: z.number().int().nonnegative(),
    retryAttempts: z.number().int().nonnegative(),
  }).strict(),
  tokenTelemetry: z.object({
    promptTokens: z.number().int().nonnegative().nullable(),
    completionTokens: z.number().int().nonnegative().nullable(),
    responses: z.number().int().nonnegative(),
  }).strict(),
  providerTokenTelemetry: ProviderTokenTelemetryEvidenceSchema,
}).superRefine((value, ctx) => {
  if (!value.result.pass) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "passed calibration evidence requires result.pass=true", path: ["result", "pass"] });
  }
  validateCalibrationRecoveryEvidence(value, ctx, true);
  if (
    value.tokenTelemetry.responses !== value.accounting.logicalCalls ||
    value.providerTokenTelemetry.responses !== value.accounting.logicalCalls
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "passed calibration telemetry must cover every primary and repair response",
      path: ["tokenTelemetry", "responses"],
    });
  }
});
export type LiveCalibrationEvidence = z.infer<typeof LiveCalibrationEvidenceSchema>;

/** Current human-only failure artifact written by calibration-run before any downstream stage may start. */
export const LiveCalibrationFailureEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  semanticResponseBindingVersion: z.literal(SEMANTIC_RESPONSE_BINDING_VERSION),
  createdAt: z.string().min(1),
  status: z.literal("failed"),
  contractSha256: Sha256Schema,
  calibrationTripletSha256: Sha256Schema,
  provider: OpenAICompatibleProviderIdentitySchema,
  confirmationMode: z.literal("human"),
  explorationOnly: z.literal(false),
  humanConfirmationBypassed: z.literal(false),
  formalEvidence: z.literal(true),
  releaseAllowed: z.literal(false),
  sealedAllowed: z.literal(false),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
  result: TwoPassCalibrationResultSchema.optional(),
  passes: z.tuple([LiveCalibrationPassEvidenceSchema, LiveCalibrationPassEvidenceSchema]).optional(),
  safeDiagnostics: z.unknown().optional(),
  actualApplicationRecoveryAttempts: z.number().int().min(0).max(2),
  applicationRecoveryAttempts: z.array(CalibrationApplicationRecoveryAttemptSchema).max(2),
  structureRecoveryDiagnostics: z.array(CalibrationStructureRecoveryDiagnosticSchema).max(4),
  accounting: z.object({
    logicalCalls: z.number().int().nonnegative(),
    httpAttempts: z.number().int().nonnegative(),
    retryAttempts: z.number().int().nonnegative(),
  }).strict(),
  tokenTelemetry: z.object({
    promptTokens: z.number().int().nonnegative().nullable(),
    completionTokens: z.number().int().nonnegative().nullable(),
    responses: z.number().int().nonnegative(),
  }).strict(),
  providerTokenTelemetry: ProviderTokenTelemetryEvidenceSchema,
}).strict().superRefine((value, ctx) => {
  validateCalibrationRecoveryEvidence(value, ctx, false);
  if (value.result?.pass === true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "failed calibration evidence cannot contain result.pass=true",
      path: ["result", "pass"],
    });
  }
});
export type LiveCalibrationFailureEvidence = z.infer<typeof LiveCalibrationFailureEvidenceSchema>;

export const EvaluationContractV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    createdAt: z.string().min(1),
    producer: ProducerSchema,
    sourceHashes: SourceHashesSchema,
    taskCardHash: Sha256Schema,
    skillSnapshotHash: Sha256Schema,
    adapterId: z.string().min(1),
    allowedCapabilities: z.array(z.string().min(1)),
    capabilityBoundary: CapabilityBoundarySchema,
    publicScenarioIds: z.array(z.string().min(1)).min(1, "publicScenarioIds must not be empty"),
    holdoutScenarioIds: z.array(z.string().min(1)).min(1, "holdoutScenarioIds must not be empty"),
    safetyGates: z.array(ContractGateGroupSchema).min(1, "safetyGates must declare at least one rule"),
    qualityGates: z.array(ContractGateGroupSchema).min(1, "qualityGates must declare at least one rule"),
    goalConfidence: ConfidenceAssessmentSchema,
    evalConfidence: ConfidenceAssessmentSchema,
    generation: z.object({
      generator: ProducerSchema,
      curator: ProducerSchema,
      generatorCuratorIsolation: GeneratorCuratorIsolationSchema,
    }),
    thresholds: z.object({
      absoluteFloor: z.number().min(0).max(100),
      confidenceFloor: z.number().min(0).max(100),
    }),
    splitPolicy: SplitPolicySchema,
    /**
     * T05: true when goalConfidence or evalConfidence is below the
     * confidenceFloor. An exploration-only contract may feed Bootstrap
     * comparisons but can never reach holdout accept or release.
     */
    explorationOnly: z.boolean(),
    confirmationMode: ConfirmationModeSchema,
    humanConfirmationBypassed: z.literal(false),
    evaluationReviewHash: Sha256Schema,
    trainItemIds: z.array(z.string().min(1)).length(8),
    selectItemIds: z.array(z.string().min(1)).length(6),
    trainItemsSha256: Sha256Schema,
    selectItemsSha256: Sha256Schema,
    calibrationMinAdjacentGap: z.number().positive(),
    calibrationTripletSha256: Sha256Schema,
    sameModelLimitation: z.string().trim().min(1),
    u1ContractVersion: U1ContractVersionSchema,
    scoringProfile: U1ScoringProfileSchema,
    contractSha256: Sha256Schema,
  })
  .superRefine((value, ctx) => {
    const overlap = value.publicScenarioIds.filter((id) => value.holdoutScenarioIds.includes(id));
    if (overlap.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `public and holdout scenario ids must not overlap: ${overlap.join(", ")}`,
        path: ["holdoutScenarioIds"],
      });
    }
    if (new Set(value.publicScenarioIds).size !== value.publicScenarioIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "publicScenarioIds must not contain duplicates",
        path: ["publicScenarioIds"],
      });
    }
    if (new Set(value.holdoutScenarioIds).size !== value.holdoutScenarioIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "holdoutScenarioIds must not contain duplicates",
        path: ["holdoutScenarioIds"],
      });
    }
    if (value.scoringProfile.version !== U1_SCORING_PROFILE_VERSION) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "current U1 contracts require the current scoring profile",
        path: ["scoringProfile"],
      });
    }
    const roleOverlap = value.trainItemIds.filter((id) => value.selectItemIds.includes(id));
    if (roleOverlap.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `train and select item ids must not overlap: ${roleOverlap.join(", ")}`,
        path: ["selectItemIds"],
      });
    }
    if (
      value.generation.generatorCuratorIsolation === "same_model_isolated_context" &&
      value.evalConfidence.level === "high"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'generatorCuratorIsolation "same_model_isolated_context" cannot support high evalConfidence',
        path: ["evalConfidence"],
      });
    }
    const belowFloor = [value.goalConfidence, value.evalConfidence].filter(
      (assessment) => assessment.score < value.thresholds.confidenceFloor,
    );
    if (!value.explorationOnly && belowFloor.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "a contract below the confidenceFloor must set explorationOnly: true — " +
          "Bootstrap comparison is allowed, holdout accept and release are not",
        path: ["explorationOnly"],
      });
    }
    const runtimeContextManifest = value.sourceHashes.runtimeContextManifest;
    if (value.adapterId === "reference-v1" && runtimeContextManifest === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "reference-v1 contracts must bind sourceHashes.runtimeContextManifest",
        path: ["sourceHashes", "runtimeContextManifest"],
      });
    }
    if (value.adapterId !== "reference-v1" && runtimeContextManifest !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "only reference-v1 contracts may bind sourceHashes.runtimeContextManifest",
        path: ["sourceHashes", "runtimeContextManifest"],
      });
    }
    const policy = value.splitPolicy;
    const deviates =
      Math.abs(policy.actualHoldoutRatio - policy.targetHoldoutRatio) >
      policy.maxRatioDeviation + 1e-9;
    if (deviates && !policy.deviationReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "a split deviating beyond maxRatioDeviation must record a non-empty deviationReason",
        path: ["splitPolicy", "deviationReason"],
      });
    }
  });
export type EvaluationContractV3 = z.infer<typeof EvaluationContractV3Schema>;

// ── Frozen contract bundle (T05) ─────────────────────────────────
// The freeze writes three artefacts: the public contract, a separate
// holdout file (the answer key evolution must never read), and an
// immutable manifest that pins item ids, scenario ids and hashes.

export const HoldoutFileSchema = z
  .object({
    schemaVersion: z.literal(3),
    createdAt: z.string().min(1),
    producer: ProducerSchema,
    contractSha256: Sha256Schema,
    items: z.array(DraftItemSchema).min(1, "the holdout file must hold at least one item"),
  })
  .superRefine((value, ctx) => {
    if (value.items.some((item) => item.split !== "holdout")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "the holdout file may only contain holdout-split items",
        path: ["items"],
      });
    }
  });
export type HoldoutFile = z.infer<typeof HoldoutFileSchema>;

export const FrozenContractManifestSchema = z
  .object({
    schemaVersion: z.literal(3),
    createdAt: z.string().min(1),
    producer: ProducerSchema,
    contractSha256: Sha256Schema,
    taskCardHash: Sha256Schema,
    draftSha256: Sha256Schema,
    publicItemIds: z.array(z.string().min(1)).min(1),
    holdoutItemIds: z.array(z.string().min(1)).min(1),
    trainItemIds: z.array(z.string().min(1)).length(8),
    selectItemIds: z.array(z.string().min(1)).length(6),
    trainItemsSha256: Sha256Schema,
    selectItemsSha256: Sha256Schema,
    holdoutItemsSha256: Sha256Schema,
    calibrationMinAdjacentGap: z.number().positive(),
    calibrationTripletSha256: Sha256Schema,
    publicScenarioIds: z.array(z.string().min(1)).min(1),
    holdoutScenarioIds: z.array(z.string().min(1)).min(1),
    holdoutSha256: Sha256Schema,
    evaluationReviewHash: Sha256Schema,
    confirmationMode: ConfirmationModeSchema,
    humanConfirmationBypassed: z.literal(false),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.publicItemIds).size !== value.publicItemIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "publicItemIds must not contain duplicates",
        path: ["publicItemIds"],
      });
    }
    if (new Set(value.holdoutItemIds).size !== value.holdoutItemIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "holdoutItemIds must not contain duplicates",
        path: ["holdoutItemIds"],
      });
    }
    const publicUnion = [...value.trainItemIds, ...value.selectItemIds];
    if (
      publicUnion.length !== value.publicItemIds.length ||
      publicUnion.some((id) => !value.publicItemIds.includes(id))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "publicItemIds must be exactly the union of trainItemIds and selectItemIds",
        path: ["publicItemIds"],
      });
    }
    const itemOverlap = value.publicItemIds.filter((id) => value.holdoutItemIds.includes(id));
    if (itemOverlap.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `public and holdout item ids must not overlap: ${itemOverlap.join(", ")}`,
        path: ["holdoutItemIds"],
      });
    }
    const scenarioOverlap = value.publicScenarioIds.filter((id) =>
      value.holdoutScenarioIds.includes(id),
    );
    if (scenarioOverlap.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `public and holdout scenario ids must not overlap: ${scenarioOverlap.join(", ")}`,
        path: ["holdoutScenarioIds"],
      });
    }
  });
export type FrozenContractManifest = z.infer<typeof FrozenContractManifestSchema>;

// ── Current deterministic quality markers ────────────────────────
