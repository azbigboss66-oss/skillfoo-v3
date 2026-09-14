import type { Provider, ProviderMessage } from "../providers/types.js";
import {
  bindApplicationAttemptProvider,
  recoveryDiagnosticOf,
  safeFindingCodesOf,
  type U1RecoveryContext,
  type U1RecoveryMode,
} from "../evolution/structureRecovery.js";
import { ProviderBudgetError } from "../providers/runBudget.js";
import { sha256Hex } from "../runtime/capabilityAdapter.js";
import {
  U1SkillEditError,
  applyU1SkillEditEnvelope,
  type AppliedU1SkillChange,
} from "../evolution/u1SkillEdit.js";
import {
  analyzeU1CapabilityText,
  U1_INSTRUCTION_ONLY_BOUNDARY,
  type U1CapabilityFinding,
} from "../runtime/u1CapabilityPolicy.js";
import type {
  CapabilityBoundary,
  Producer,
  QualityPriorityRanking,
  TaskCard,
  U1CompleteIntentDetails,
} from "../types.js";
import { completeTaskCardIntentDetails } from "../intake/taskCard.js";
import {
  sanitizeBoundedPublicTrainFeedback,
  type U1MutationTrainFeedback,
} from "../evolution/publicTrainFeedback.js";
export type {
  U1MutationFeedbackDimension,
  U1MutationFeedbackItem,
  U1MutationFeedbackRule,
  U1MutationFeedbackToolTrace,
  U1MutationTrainFeedback,
} from "../evolution/publicTrainFeedback.js";

// ── V3.1 T17: the live (provider-backed) candidate generators ─────
//
// The live counterparts of the fixture proposers. Legacy calls make one
// strict-JSON request. Closure-v2 mutation slots may make exactly one bounded
// application recovery request after a candidate-local contract failure.
// Every response passes the same deterministic validator below; a fixture
// proposal is NEVER substituted for a failed live one.

export class LiveProposalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly findings: readonly U1CapabilityFinding[] = [],
  ) {
    super(message);
    this.name = "LiveProposalError";
  }
}

/**
 * The current U1 mutation gate accepts only the bounded edit/no_change
 * envelope and then applies the absolute execution boundary to the result.
 * Pure function — used by the mutation proposer and directly by tests.
 */
export function validateU1MutationProposal(input: {
  proposalText: string;
  parentSkillMd: string;
  capabilityBoundary?: CapabilityBoundary;
}): AppliedU1SkillChange {
  let result: AppliedU1SkillChange;
  try {
    result = applyU1SkillEditEnvelope(input);
  } catch (error) {
    if (!(error instanceof U1SkillEditError)) throw error;
    const compatibilityCode = error.code === "U1_EDIT_INVALID_JSON"
      ? "LIVE_PROPOSAL_INVALID_JSON"
      : error.code === "U1_EDIT_INVALID"
        ? "LIVE_PROPOSAL_INVALID"
        : error.code === "U1_EDIT_NOOP"
          ? "LIVE_PROPOSAL_NOOP"
          : error.code;
    throw new LiveProposalError(
      compatibilityCode,
      `${compatibilityCode}: ${error.message.replace(/^[A-Z0-9_]+:\s*/u, "")}`,
    );
  }
  if (result.decision === "no_change") return result;
  const findings = analyzeU1CapabilityText(
    result.skillMd,
    input.capabilityBoundary ?? U1_INSTRUCTION_ONLY_BOUNDARY,
  ).findings.filter((finding) => finding.blocking);
  if (findings.length > 0) {
    throw new LiveProposalError(
      "LIVE_MUTATION_U1_BOUNDARY_VIOLATION",
      `LIVE_MUTATION_U1_BOUNDARY_VIOLATION: the mutation result carries unavailable execution forbidden by the frozen U1 boundary (${findings.map((finding) => `${finding.code}:${finding.kind}`).join(", ")}); first finding line ${findings[0].line}: ${findings[0].excerpt}; inherited execution is rejected exactly like newly introduced execution`,
      findings,
    );
  }
  return result;
}

type ContextAwareProvider = Provider & {
  withContext?: (context: {
    scenarioId: string;
    snapshotId: string;
    frozenEvidenceSha256?: string;
  }) => Provider;
  setContext?: (scenarioId: string, snapshotId: string) => void;
};

export interface PromptCardFacts {
  goal: string;
  redlines: string[];
  capabilityBoundary: CapabilityBoundary;
  intentDetails: U1CompleteIntentDetails;
  qualityPriorities: QualityPriorityRanking;
  scenarios: Array<{ id: string; userRequest: string; expectedOutcome?: string }>;
}

export type U1LanePurpose =
  | "exploit_known_failures"
  | "diversify_alternative"
  | "repair_incompatible_b0";

/** One canonical, proposer-safe Task Card projection shared by mutation and repair. */
export function promptCardFactsOf(
  card: TaskCard,
  options: {
    requireComplete?: boolean;
    /** Only confirmed public-train scenario ids may enter proposer prompts. */
    allowedScenarioIds?: readonly string[];
  } = {},
): PromptCardFacts {
  const complete = options.requireComplete !== false
    ? completeTaskCardIntentDetails(card)
    : {
        goal_and_intended_user: card.intentDetails?.goal_and_intended_user ?? card.goal,
        inputs_and_evidence: card.intentDetails?.inputs_and_evidence ?? "",
        output_and_format: card.intentDetails?.output_and_format ?? "",
        capability_boundary_and_redlines: card.intentDetails?.capability_boundary_and_redlines ?? (card.redlines ?? []).join("; "),
        success_criteria_and_protected_behavior: card.intentDetails?.success_criteria_and_protected_behavior ??
          "",
      };
  const allowedScenarioIds = options.allowedScenarioIds
    ? new Set(options.allowedScenarioIds)
    : null;
  return {
    goal: card.goal,
    redlines: [...(card.redlines ?? [])],
    capabilityBoundary: card.capabilityBoundary,
    intentDetails: complete,
    qualityPriorities: [...(card.qualityPriorities ?? [])],
    scenarios: (card.scenarios ?? [])
      .filter((scenario) => allowedScenarioIds === null || allowedScenarioIds.has(scenario.id))
      .map((scenario) => ({
      id: scenario.id,
      userRequest: scenario.userRequest,
      ...(scenario.expectedOutcome ? { expectedOutcome: scenario.expectedOutcome } : {}),
      })),
  };
}

function boundedFailureClasses(values: readonly string[]): string[] {
  return [...new Set(values)]
    .filter((value) => /^[a-zA-Z0-9._:-]{1,96}$/u.test(value))
    .sort()
    .slice(0, 12);
}

/** Shared task/lane rendering; it deliberately contains no contract, split or budget identity. */
export function proposerTaskContextLines(input: {
  taskCard: PromptCardFacts;
  lanePurpose: U1LanePurpose;
  failureClasses: readonly string[];
}): string[] {
  const { taskCard } = input;
  return [
    `Goal: ${taskCard.goal}`,
    `Lane purpose: ${input.lanePurpose}`,
    `Goal and intended user: ${taskCard.intentDetails.goal_and_intended_user}`,
    `Inputs and evidence: ${taskCard.intentDetails.inputs_and_evidence}`,
    `Output and format: ${taskCard.intentDetails.output_and_format}`,
    `Capability boundary and redlines: ${taskCard.intentDetails.capability_boundary_and_redlines}`,
    `Success criteria and protected behavior: ${taskCard.intentDetails.success_criteria_and_protected_behavior}`,
    `Quality priorities: ${taskCard.qualityPriorities.join(" > ")}`,
    "Confirmed scenarios and outcomes:",
    ...taskCard.scenarios.map((scenario) =>
      `- ${scenario.id}: ${scenario.userRequest}${scenario.expectedOutcome ? ` | expected: ${scenario.expectedOutcome}` : ""}`
    ),
    "Redlines:",
    ...taskCard.redlines.map((line) => `- ${line}`),
    `Capability boundary: ${JSON.stringify(taskCard.capabilityBoundary)}`,
    `Failure classes: ${boundedFailureClasses(input.failureClasses).join(", ") || "(none)"}`,
  ];
}

/** C4c: the structural subset of EvaluationContractV3 used by the prompts. */
export interface PromptContractFacts {
  allowedCapabilities: string[];
  adapterId?: string;
  /** Contract-authorized logical tool identifiers; never inferred from arbitrary model text. */
  authorizedToolLogicalIds?: string[];
}

export interface MutationProposalContext {
  eliteSkillMd: string;
  diversitySkillMd: string;
  failureClasses: string[];
  lanePurpose: U1LanePurpose;
  /** Structured public-train evidence only; public-select, sealed and dependency bodies are forbidden. */
  trainFeedback?: U1MutationTrainFeedback;
  /** Frozen confirmed card; its goal/redlines/boundary bind every mutation. */
  taskCard: PromptCardFacts;
  /** Frozen contract metadata only; no train/select/holdout item text enters the prompt. */
  contract: PromptContractFacts;
  /** Present only when the current Adaptive path authorizes one bounded recovery. */
  recovery?: U1RecoveryContext;
}

export interface LiveMutationProposer {
  producer: Producer;
  proposeMutation(context: MutationProposalContext): Promise<{
    hypothesis: string;
    skillMd: string;
    /** Present on the authoritative U1 provider path; optional for historical test/fixture proposers. */
    decision?: "edit" | "no_change";
    appliedEdits?: number;
  }>;
}

export const MUTATION_SYSTEM_PROMPT = [
  "You are a skill mutation assistant inside a controlled evaluation harness.",
  "The proposer itself has no runtime tools. The candidate may describe only",
  "capabilities and logical-id tool calls explicitly authorized in the user message.",
  "Never invent arbitrary network, filesystem, shell, plugin, path, URL, or command access.",
  "You may edit only the supplied parent SKILL.md. Never return a full document.",
  "Return EXACTLY one JSON object, no prose and no markdown fence.",
  'If no justified change exists: {"hypothesis":"<reason>","decision":"no_change"}',
  "Otherwise return decision edit with 1 to 4 exact edits:",
  '{"hypothesis":"<reason>","decision":"edit","edits":[{"op":"replace_exact","oldText":"<unique exact parent text>","newText":"<replacement>"}]}',
  "Allowed ops are replace_exact, insert_after and delete_exact.",
  "Each oldText or anchor must occur exactly once in the parent. Optional path",
  'must be exactly "SKILL.md". Net growth may not exceed max(1200 chars, 25%).',
  "Keep candidate text user-facing. Never add provenance, contract hashes, gate/split/budget identities, or hidden-test commentary.",
  "Preserve the stated execution boundary and never invent an unlisted capability.",
].join("\n");

/**
 * Only confirmed-card and PUBLIC contract facts reach the mutation prompt;
 * the holdout split is sealed and never serialized here.
 */
export function mutationUserPrompt(context: MutationProposalContext): string {
  const card = context.taskCard;
  const feedback = sanitizeBoundedPublicTrainFeedback({
    feedback: context.trainFeedback,
  });
  return [
    "# Task",
    ...proposerTaskContextLines({
      taskCard: card,
      lanePurpose: context.lanePurpose,
      failureClasses: context.failureClasses,
    }),
    `Adapter: ${context.contract.adapterId ?? "unspecified"}`,
    `Allowed capabilities: ${context.contract.allowedCapabilities.join(", ") || "(none)"}`,
    `Authorized tool logical ids: ${[
      ...new Set([
        ...(context.contract.authorizedToolLogicalIds ?? []),
      ]),
    ].join(", ") || "(none)"}`,
    "",
    "# Parent SKILL.md (the only edit base)",
    context.eliteSkillMd,
    "",
    "# Inspiration SKILL.md (read-only alternative)",
    context.diversitySkillMd,
    "",
    "# Train failures (maximum 6)",
    ...(feedback.failures.length > 0
      ? feedback.failures.map((entry) => JSON.stringify(entry))
      : ["(none)"]),
    "",
    "# Train successes to preserve (maximum 2)",
    ...(feedback.successes.length > 0
      ? feedback.successes.map((entry) => JSON.stringify(entry))
      : ["(none)"]),
    "",
    "Return one bounded edit or no_change now.",
  ].join("\n");
}

export const LIVE_MUTATION_PRODUCER_NAME = "openai-compatible-targeted-mutation";

const FORMAT_RECOVERY_CODES = new Set([
  "LIVE_PROPOSAL_INVALID_JSON",
  "LIVE_PROPOSAL_INVALID",
]);

const CONSTRAINED_RECOVERY_CODES = new Set([
  "LIVE_PROPOSAL_NOOP",
  "U1_EDIT_SCOPE_VIOLATION",
  "U1_EDIT_LIMIT_EXCEEDED",
  "U1_EDIT_ANCHOR_NOT_UNIQUE",
  "U1_EDIT_OVERLAP",
  "U1_EDIT_RESULT_EMPTY",
  "U1_EDIT_GOVERNANCE_METADATA_FORBIDDEN",
  "U1_EDIT_GROWTH_LIMIT_EXCEEDED",
  "LIVE_MUTATION_U1_BOUNDARY_VIOLATION",
]);

function recoveryModeOf(error: unknown): Exclude<U1RecoveryMode, "primary" | "schema-repair"> | null {
  if (!(error instanceof LiveProposalError)) return null;
  if (FORMAT_RECOVERY_CODES.has(error.code)) return "format-repair";
  if (CONSTRAINED_RECOVERY_CODES.has(error.code)) return "constrained-reproposal";
  return null;
}

function mutationRequestFingerprint(messages: readonly ProviderMessage[]): string {
  return sha256Hex(JSON.stringify({ messages, responseFormat: "json_object" }));
}

function mutationRecoveryMessages(input: {
  original: readonly ProviderMessage[];
  failure: LiveProposalError;
  mode: "format-repair" | "constrained-reproposal";
}): ProviderMessage[] {
  const findingCodes = safeFindingCodesOf(input.failure.findings);
  const recoveryInstruction = input.mode === "format-repair"
    ? [
        "This is the single allowed format-repair attempt.",
        "Return exactly one strict edit or no_change JSON object using the original schema.",
        "Never return a full SKILL.md, prose, markdown fence, commentary, or an additional key.",
      ]
    : [
        "This is the single allowed constrained re-proposal attempt.",
        "Return a valid bounded exact edit, or no_change when no safe edit is justified.",
        "Preserve the exact authorized capability and logical-id boundary in the original user message; do not add an unlisted execution surface.",
        "Never return a full SKILL.md or an additional key.",
      ];
  return [
    ...input.original.map((message) => ({ ...message })),
    {
      role: "system",
      content: [
        ...recoveryInstruction,
        `Failure code: ${input.failure.code}`,
        `Finding codes: ${findingCodes.join(", ") || "(none)"}`,
        "The rejected response is intentionally unavailable. Do not quote, reconstruct, or discuss it.",
      ].join("\n"),
    },
  ];
}

async function callMutationProvider(input: {
  provider: ContextAwareProvider;
  messages: ProviderMessage[];
  originalRequestFingerprint: string;
  attempt: 1 | 2;
  mode: "primary" | "format-repair" | "constrained-reproposal";
  bindAttempt: boolean;
}): Promise<Awaited<ReturnType<Provider["chat"]>>> {
  const provider = input.bindAttempt
    ? bindApplicationAttemptProvider({
        provider: input.provider,
        operation: "mutation-proposer",
        originalRequestFingerprint: input.originalRequestFingerprint,
        attempt: input.attempt,
        mode: input.mode,
      })
    : input.provider;
  try {
    return await provider.chat(input.messages, { responseFormat: "json_object" });
  } catch (error) {
    if (error instanceof ProviderBudgetError && error.kind === "logical_calls") throw error;
    if (error instanceof ProviderBudgetError) {
      // A retry reserve can be exhausted only after this same provider call
      // already produced a retryable transport failure. Preserve that system
      // failure class instead of misreporting it as an Adaptive logical-budget
      // defect; this remains fatal and never enters application recovery.
      throw new LiveProposalError(
        "LIVE_MUTATION_PROVIDER_FAILED",
        "LIVE_MUTATION_PROVIDER_FAILED: the mutation provider exhausted its bounded transport retries; request and response content were not persisted",
      );
    }
    throw new LiveProposalError(
      "LIVE_MUTATION_PROVIDER_FAILED",
      `LIVE_MUTATION_PROVIDER_FAILED: the live mutation proposer call failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The live targeted-mutation lane used by the adaptive population (T18). */
export function createLiveMutationProposer(args: {
  provider: ContextAwareProvider;
}): LiveMutationProposer {
  return {
    producer: { kind: "provider", name: LIVE_MUTATION_PRODUCER_NAME },
    async proposeMutation(context: MutationProposalContext) {
      const messages: ProviderMessage[] = [
        { role: "system", content: MUTATION_SYSTEM_PROMPT },
        { role: "user", content: mutationUserPrompt(context) },
      ];
      const originalRequestFingerprint = mutationRequestFingerprint(messages);
      if (!context.recovery) {
        const snapshotId = sha256Hex(context.eliteSkillMd).slice(0, 12);
        args.provider.setContext?.("targeted-mutation", snapshotId);
      }
      const primaryResponse = await callMutationProvider({
        provider: args.provider,
        messages,
        originalRequestFingerprint,
        attempt: 1,
        mode: "primary",
        bindAttempt: context.recovery !== undefined,
      });
      try {
        return validateU1MutationProposal({
          proposalText: primaryResponse.content,
          parentSkillMd: context.eliteSkillMd,
          capabilityBoundary: context.taskCard.capabilityBoundary,
        });
      } catch (error) {
        const mode = recoveryModeOf(error);
        if (!context.recovery || mode === null || !(error instanceof LiveProposalError)) throw error;
        context.recovery.hooks.onDiagnostic(recoveryDiagnosticOf({
          subject: context.recovery.subject,
          attempt: 1,
          failureCode: error.code,
          findings: error.findings,
          response: primaryResponse,
        }));
        context.recovery.hooks.onApplicationRecoveryAttempt({
          subject: context.recovery.subject,
          operation: "mutation-proposer",
          attempt: 2,
          mode,
          requestFingerprintSha256: originalRequestFingerprint,
        });
        const recoveryMessages = mutationRecoveryMessages({ original: messages, failure: error, mode });
        const recoveryResponse = await callMutationProvider({
          provider: args.provider,
          messages: recoveryMessages,
          originalRequestFingerprint,
          attempt: 2,
          mode,
          bindAttempt: true,
        });
        try {
          return validateU1MutationProposal({
            proposalText: recoveryResponse.content,
            parentSkillMd: context.eliteSkillMd,
            capabilityBoundary: context.taskCard.capabilityBoundary,
          });
        } catch (recoveryError) {
          if (recoveryError instanceof LiveProposalError && recoveryModeOf(recoveryError) !== null) {
            context.recovery.hooks.onDiagnostic(recoveryDiagnosticOf({
              subject: context.recovery.subject,
              attempt: 2,
              failureCode: recoveryError.code,
              findings: recoveryError.findings,
              response: recoveryResponse,
            }));
          }
          throw recoveryError;
        }
      }
    },
  };
}
