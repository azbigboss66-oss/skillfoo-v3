import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ConfidenceAssessmentSchema,
  QUALITY_DIMENSIONS,
  QualityPriorityRankingSchema,
  SideEffectPolicySchema,
  TaskCardSchema,
  U1CompleteIntentDetailsSchema,
  U1_INTENT_DIMENSION_VALUES,
  type CapabilityBoundary,
  type ConfirmationMode,
  type ConfidenceAssessment,
  type IntentOption,
  type QualityPriorityRanking,
  type TaskCard,
  type U1CompleteIntentDetails,
  type U1Clarification,
  type U1IntentDetails,
} from "../types.js";
import { analyzeU1Completeness } from "./u1Completeness.js";

// ── T03: 5-minute Task Card intake ────────────────────────────────
//
// The human supplies high-information constraints only (goal, real
// requests, red lines, capability boundary). The card is a draft
// until an operator explicitly confirms it. Offline intent fixtures
// are ALWAYS low confidence, and token-like input is rejected without
// ever echoing the secret back.

export type IntakeErrorCode =
  | "INVALID_INTAKE_INPUT"
  | "TOKEN_LIKE_INPUT"
  | "CONFIRMATION_REQUIRES_OPERATOR"
  | "CONFIRMATION_REQUIRES_COMPLETE_INTENT"
  | "ALREADY_CONFIRMED";

export class IntakeError extends Error {
  readonly code: IntakeErrorCode;
  constructor(code: IntakeErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "IntakeError";
    this.code = code;
  }
}

// ── Secret rejection ─────────────────────────────────────────────

const TOKEN_LIKE_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "OpenAI-style API key (sk-…)", regex: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { label: "GitHub token (ghp_/gho_/ghu_/ghs_/ghr_…)", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { label: "GitHub fine-grained token (github_pat_…)", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { label: "Slack token (xox…-…)", regex: /\bxox[bporsa]-[A-Za-z0-9-]{10,}/ },
  { label: "AWS access key id (AKIA…)", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "private key block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

interface TokenHit {
  path: string;
  label: string;
}

/**
 * Walk an unknown JSON value and find the first token-like string.
 * Reports only the field path and the pattern label — never the value.
 */
function findTokenLike(value: unknown, path: string): TokenHit | null {
  if (typeof value === "string") {
    for (const { label, regex } of TOKEN_LIKE_PATTERNS) {
      if (regex.test(value)) return { path: path || "(root)", label };
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findTokenLike(value[i], path ? `${path}[${i}]` : `[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const hit = findTokenLike(child, path ? `${path}.${key}` : key);
      if (hit) return hit;
    }
  }
  return null;
}

// ── Input validation ─────────────────────────────────────────────

const IntakeScenarioSchema = z
  .object({
    userRequest: z.string().trim().min(1),
    expectedOutcome: z.string().trim().min(1).optional(),
  })
  .strict();

const IntakeCapabilityBoundarySchema = z
  .object({
    allowedCapabilities: z.array(z.string().trim().min(1)),
    network: SideEffectPolicySchema,
    filesystem: SideEffectPolicySchema,
    externalActions: SideEffectPolicySchema,
  })
  .strict();

const IntakeInputSchema = z
  .object({
    goal: z.string().trim().min(1),
    scenarios: z.array(IntakeScenarioSchema).min(2),
    redlines: z.array(z.string().trim().min(1)).min(1),
    capabilityBoundary: IntakeCapabilityBoundarySchema,
    intentDetails: U1CompleteIntentDetailsSchema,
    qualityPriorities: QualityPriorityRankingSchema.optional(),
    references: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

export interface TaskCardScenarioInput {
  id: string;
  userRequest: string;
  expectedOutcome?: string;
}

export interface TaskCardInput {
  goal: string;
  scenarios: TaskCardScenarioInput[];
  redlines: string[];
  capabilityBoundary: CapabilityBoundary;
  intentDetails: U1CompleteIntentDetails;
  qualityPriorities: QualityPriorityRanking;
  references?: string[];
}

const DEFAULT_QUALITY_PRIORITIES: QualityPriorityRanking = [...QUALITY_DIMENSIONS];

/**
 * Validate and normalize raw intake input. Secrets are scanned first so a
 * token hidden anywhere in the payload is rejected even if the surrounding
 * shape is invalid; the error never echoes the offending value.
 */
export function parseTaskCardInput(raw: unknown): TaskCardInput {
  const tokenHit = findTokenLike(raw, "");
  if (tokenHit) {
    throw new IntakeError(
      "TOKEN_LIKE_INPUT",
      `refusing to record intake input: ${tokenHit.label} detected at "${tokenHit.path}"; ` +
        "task cards must never contain secrets — remove the credential and retry",
    );
  }

  const result = IntakeInputSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new IntakeError(
      "INVALID_INTAKE_INPUT",
      `intake input does not match the task card shape (${issues})`,
    );
  }
  const data = result.data;

  const input: TaskCardInput = {
    goal: data.goal,
    scenarios: data.scenarios.map((scenario, index) => ({
      id: `s${index + 1}`,
      userRequest: scenario.userRequest,
      ...(scenario.expectedOutcome ? { expectedOutcome: scenario.expectedOutcome } : {}),
    })),
    redlines: [...data.redlines],
    capabilityBoundary: {
      allowedCapabilities: [...data.capabilityBoundary.allowedCapabilities],
      network: data.capabilityBoundary.network,
      filesystem: data.capabilityBoundary.filesystem,
      externalActions: data.capabilityBoundary.externalActions,
    },
    intentDetails: { ...data.intentDetails },
    qualityPriorities: data.qualityPriorities
      ? [...data.qualityPriorities]
      : [...DEFAULT_QUALITY_PRIORITIES],
  };
  if (data.references && data.references.length > 0) {
    input.references = [...data.references];
  }
  return input;
}

// ── Hashing ──────────────────────────────────────────────────────

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Deterministic JSON serialization: recursively key-sorted, no whitespace. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/**
 * Content identity of a task card. Excludes createdAt (wall clock) and
 * confirmation (state, not content): the same human input always yields
 * the same digest, and confirming a card does not change its identity.
 */
export function taskCardContentSha256(card: TaskCard): string {
  return sha256Hex(
    stableStringify({
      schemaVersion: card.schemaVersion,
      producer: card.producer,
      sourceHashes: card.sourceHashes,
      goal: card.goal,
      ...(card.goalSha256 ? { goalSha256: card.goalSha256 } : {}),
      ...(card.intentStatus ? { intentStatus: card.intentStatus } : {}),
      ...(card.answeredDimensions ? { answeredDimensions: card.answeredDimensions } : {}),
      ...(card.unresolvedDimensions ? { unresolvedDimensions: card.unresolvedDimensions } : {}),
      ...(card.clarifications ? { clarifications: card.clarifications } : {}),
      ...(card.intentDetails ? { intentDetails: card.intentDetails } : {}),
      intentOptions: card.intentOptions ?? null,
      scenarios: card.scenarios,
      redlines: card.redlines,
      capabilityBoundary: card.capabilityBoundary,
      qualityPriorities: card.qualityPriorities,
      references: card.references ?? null,
    }),
  );
}

// ── Offline intent fixtures ──────────────────────────────────────

export interface FixtureIntentOption extends IntentOption {
  confidence: ConfidenceAssessment;
}

function lowConfidence(reasons: string[]): ConfidenceAssessment {
  return ConfidenceAssessmentSchema.parse({ level: "low", score: 20, reasons });
}

/**
 * Mechanical, offline intent candidates derived from the input itself.
 * They exist so the confirmation flow has something to react to without
 * a provider — and they can never claim more than low confidence.
 */
export function fixtureIntentOptions(input: TaskCardInput): FixtureIntentOption[] {
  return [
    {
      id: "fixture-goal-verbatim",
      statement: input.goal,
      rationale: "mechanical restatement of the stated goal; no interpretation attempted",
      confidence: lowConfidence([
        "offline fixture: generated without any model call",
        "restates the human input without validating the intent",
      ]),
    },
    {
      id: "fixture-scenario-derived",
      statement: `Fulfil real requests such as: ${input.scenarios[0].userRequest}`,
      rationale: `derived from scenario ${input.scenarios[0].id} only; the other scenarios were not examined`,
      confidence: lowConfidence([
        "offline fixture: no model was involved",
        "generalizes from a single scenario, unvalidated",
      ]),
    },
  ];
}

// ── Draft creation ───────────────────────────────────────────────

export interface CreateTaskCardDraftOptions {
  /** Legacy skill directory: only its SKILL.md sha256 enters the card, never content. */
  skillDir?: string;
  /** Attach offline low-confidence intent fixtures to the draft. */
  intentFixture?: boolean;
}

export async function createTaskCardDraft(
  input: TaskCardInput,
  options: CreateTaskCardDraftOptions = {},
): Promise<{ card: TaskCard; contentSha256: string }> {
  const sourceHashes: Record<string, string> = {
    intakeInput: sha256Hex(stableStringify(input)),
  };
  if (options.skillDir) {
    // Dual-root rule: B0 is pinned by digest only. The legacy skill's
    // text never flows into the card or the S0 scaffold.
    const skillMd = await readFile(join(options.skillDir, "SKILL.md"), "utf8");
    sourceHashes.skillMd = sha256Hex(skillMd);
  }

  const card = TaskCardSchema.parse({
    schemaVersion: 3,
    createdAt: new Date().toISOString(),
    producer: { kind: "cli", name: "skillfoo-intake" },
    sourceHashes,
    goal: input.goal,
    goalSha256: sha256Hex(input.goal),
    intentStatus: "complete",
    answeredDimensions: [...U1_INTENT_DIMENSION_VALUES],
    unresolvedDimensions: [],
    clarifications: [],
    intentDetails: input.intentDetails,
    ...(options.intentFixture ? { intentOptions: fixtureIntentOptions(input) } : {}),
    scenarios: input.scenarios,
    redlines: input.redlines,
    capabilityBoundary: input.capabilityBoundary,
    qualityPriorities: input.qualityPriorities,
    ...(input.references ? { references: input.references } : {}),
    confirmation: { status: "draft" },
  });

  return { card, contentSha256: taskCardContentSha256(card) };
}

export interface CreateGoalTaskCardDraftOptions {
  skillDir?: string;
  details?: U1IntentDetails;
  clarifications?: U1Clarification[];
}

/** Return the complete five-part intent used by every new formal U1 writer. */
export function completeTaskCardIntentDetails(card: TaskCard): U1CompleteIntentDetails {
  const parsed = U1CompleteIntentDetailsSchema.safeParse(card.intentDetails);
  if (!parsed.success) {
    throw new IntakeError(
      "CONFIRMATION_REQUIRES_COMPLETE_INTENT",
      "the current Task Card must persist all five intentDetails before confirmation or formal execution",
    );
  }
  return parsed.data;
}

/**
 * Merge only explicit operator-authored intent text. Clarification answers
 * override the same dimension; no inferred/default business meaning is added.
 */
export function materializeTaskCardIntentDetails(
  details: U1IntentDetails | undefined,
  clarifications: readonly U1Clarification[] = [],
): U1CompleteIntentDetails | undefined {
  const merged: U1IntentDetails = { ...(details ?? {}) };
  for (const clarification of clarifications) {
    const answer = clarification.answer?.trim();
    if (answer) merged[clarification.dimension] = answer;
  }
  const parsed = U1CompleteIntentDetailsSchema.safeParse(merged);
  return parsed.success ? parsed.data : undefined;
}

/** Create a zero-network natural-language intake draft without inventing missing business facts. */
export async function createGoalTaskCardDraft(
  goal: string,
  options: CreateGoalTaskCardDraftOptions = {},
): Promise<{ card: TaskCard; contentSha256: string }> {
  const tokenHit = findTokenLike({ goal, details: options.details, clarifications: options.clarifications }, "");
  if (tokenHit) {
    throw new IntakeError(
      "TOKEN_LIKE_INPUT",
      `refusing to record intake input: ${tokenHit.label} detected at "${tokenHit.path}"; task cards must never contain secrets — remove the credential and retry`,
    );
  }
  if (goal.trim().length === 0) {
    throw new IntakeError("INVALID_INTAKE_INPUT", "goal must be a non-empty natural-language sentence");
  }
  const completeness = analyzeU1Completeness({
    goal,
    details: options.details,
    clarifications: options.clarifications,
  });
  const materializedIntent = materializeTaskCardIntentDetails(
    options.details,
    options.clarifications,
  );
  const sourceHashes: Record<string, string> = {
    intakeInput: sha256Hex(stableStringify({ goal, details: options.details ?? null, clarifications: options.clarifications ?? [] })),
  };
  if (options.skillDir) {
    const skillMd = await readFile(join(options.skillDir, "SKILL.md"), "utf8");
    sourceHashes.skillMd = sha256Hex(skillMd);
  }
  const card = TaskCardSchema.parse({
    schemaVersion: 3,
    createdAt: new Date().toISOString(),
    producer: { kind: "cli", name: "skillfoo-intake" },
    sourceHashes,
    goal,
    goalSha256: completeness.goalSha256,
    intentStatus: completeness.status,
    answeredDimensions: completeness.answeredDimensions,
    unresolvedDimensions: completeness.missingDimensions,
    clarifications: options.clarifications ?? [],
    ...(materializedIntent
      ? { intentDetails: materializedIntent }
      : options.details
        ? { intentDetails: options.details }
        : {}),
    scenarios: [],
    redlines: [],
    capabilityBoundary: {
      allowedCapabilities: ["instruction"],
      network: "forbidden",
      filesystem: "forbidden",
      externalActions: "forbidden",
    },
    qualityPriorities: [...DEFAULT_QUALITY_PRIORITIES],
    confirmation: { status: "draft" },
  });
  return { card, contentSha256: taskCardContentSha256(card) };
}

// ── Confirmation ─────────────────────────────────────────────────

/**
 * Flip a draft card to confirmed. The hash is computed over the draft's
 * content, so the confirmed card keeps the identity of what the operator
 * reviewed — confirmation changes state, not content.
 */
export function confirmTaskCard(
  card: TaskCard,
  operator: string,
  options: { mode?: ConfirmationMode } = {},
): { card: TaskCard; cardSha256: string } {
  const trimmed = operator.trim();
  if (trimmed.length === 0) {
    throw new IntakeError(
      "CONFIRMATION_REQUIRES_OPERATOR",
      "confirmation requires a named operator (--by <name>); anonymous confirmation is not auditable",
    );
  }
  if (card.confirmation.status !== "draft") {
    throw new IntakeError(
      "ALREADY_CONFIRMED",
      "this task card is already confirmed; regenerate a draft to change the content",
    );
  }
  if (card.intentStatus && (card.intentStatus !== "complete" || (card.unresolvedDimensions?.length ?? 0) > 0)) {
    throw new IntakeError(
      "CONFIRMATION_REQUIRES_COMPLETE_INTENT",
      `cannot confirm a ${card.intentStatus} Task Card; resolve every material intent dimension first`,
    );
  }
  completeTaskCardIntentDetails(card);
  const cardSha256 = taskCardContentSha256(card);
  const confirmed: TaskCard = {
    ...card,
    confirmation: {
      status: "confirmed",
      confirmedBy: trimmed,
      confirmedAt: new Date().toISOString(),
      confirmationMode: options.mode ?? "human",
      confirmedContentSha256: cardSha256,
    },
  };
  return { card: confirmed, cardSha256 };
}
