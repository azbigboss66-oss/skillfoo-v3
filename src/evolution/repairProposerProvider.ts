import type { ProviderMessage, ProviderResponse } from "../providers/types.js";
import { OpenAICompatibleProviderError } from "../providers/openaiCompatible.js";
import { ProviderBudgetError } from "../providers/runBudget.js";
import { sha256Hex } from "../runtime/capabilityAdapter.js";
import {
  analyzeU1CapabilityText,
  U1_INSTRUCTION_ONLY_BOUNDARY,
} from "../runtime/u1CapabilityPolicy.js";
import type { CapabilityBoundary, FrontierTicket } from "../types.js";
import {
  proposerTaskContextLines,
  type PromptCardFacts,
  type U1LanePurpose,
} from "../bootstrap/liveBootstrapProposer.js";
import { RepairFrontierError, type FrontierRepairProposer, type RepairProposal } from "./repairFrontier.js";
import { applyU1SkillEditEnvelope, U1SkillEditError } from "./u1SkillEdit.js";
import {
  sanitizeBoundedPublicTrainFeedback,
  type U1MutationTrainFeedback,
} from "./publicTrainFeedback.js";
import {
  bindApplicationAttemptProvider,
  recoveryDiagnosticOf,
  type U1RecoveryMode,
  type U1AttemptContextProvider,
} from "./structureRecovery.js";

// ── P0 Task 3: the real (provider-backed) frontier repair proposer ──
//
// The live counterpart of createFixtureRepairProposer: one strict-JSON
// chat call that receives ONLY the ticket's minimal failure reason and
// the current SKILL.md, and must answer the authoritative U1 edit/no_change envelope.
// Anything else — invalid JSON/schema/anchors/bounds, or a provider
// failure — throws a desensitized RepairFrontierError so the funnel
// settles the candidate as safe_non_elite. A fixture repair is NEVER
// substituted for a failed live one.

function systemPrompt(input: {
  boundary: CapabilityBoundary;
  authorizedToolLogicalIds: readonly string[];
}): string {
  const allowed = input.boundary.allowedCapabilities.length > 0
    ? input.boundary.allowedCapabilities.join(", ")
    : "none";
  const toolIds = input.authorizedToolLogicalIds.length > 0
    ? input.authorizedToolLogicalIds.join(", ")
    : "none";
  return [
    "You are a skill repair assistant inside a controlled evaluation harness.",
    "The proposer itself has no runtime tools. The candidate may describe only the contract-authorized capabilities and logical IDs listed below.",
    `Authorized capabilities: ${allowed}. Authorized adapter/tool logical IDs: ${toolIds}.`,
    "Do not introduce arbitrary execution, commands, paths, URLs, plugins, network, filesystem, or shell usage beyond that boundary.",
    "You may edit only the supplied parent SKILL.md.",
    "Respond with EXACTLY one JSON object, no prose, no markdown fences:",
    '{"hypothesis":"<one sentence>","decision":"no_change"}',
    "or",
    '{"hypothesis":"<one sentence>","decision":"edit","edits":[{"op":"replace_exact","oldText":"<unique exact parent text>","newText":"<replacement>"}]}',
    "Allowed edit ops are replace_exact, insert_after, and delete_exact only; optional path, when present, must equal SKILL.md.",
    "Use 1 to 4 edits. Every anchor must occur exactly once in the immutable parent and may be used only once.",
    "Net growth may not exceed max(1200 characters, 25% of the parent length). Never return the full document.",
    "Keep candidate text user-facing. Never add provenance, contract hashes, gate/split/budget identities, or hidden-test commentary.",
    "Use no_change when the bounded failure evidence does not justify a safe targeted edit.",
  ].join("\n");
}

function userPrompt(
  ticket: FrontierTicket,
  skillMd: string,
  trainFeedback: U1MutationTrainFeedback,
  taskContext?: {
    taskCard: PromptCardFacts;
    lanePurpose: U1LanePurpose;
    failureClasses: readonly string[];
  },
): string {
  return [
    ...(taskContext
      ? [
          "# Confirmed task and lane",
          ...proposerTaskContextLines(taskContext),
          "",
        ]
      : []),
    "# Failure to repair (minimal reason)",
    ticket.minimalFailureReason,
    "",
    "# Current SKILL.md (the only editable file)",
    skillMd,
    "",
    "# Public-train failures (maximum 6)",
    ...(trainFeedback.failures.length > 0
      ? trainFeedback.failures.map((entry) => JSON.stringify(entry))
      : ["(none)"]),
    "",
    "# Public-train successes to preserve (maximum 2)",
    ...(trainFeedback.successes.length > 0
      ? trainFeedback.successes.map((entry) => JSON.stringify(entry))
      : ["(none)"]),
    "",
    `Editable files: ${ticket.editableFiles.join(", ")}. Apply one bounded repair to the listed execution evidence.`,
    "Return the JSON object now.",
  ].join("\n");
}

export const LIVE_REPAIR_PRODUCER_NAME = "openai-compatible-frontier-repair";

const FORMAT_RECOVERY_CODES = new Set([
  "REPAIR_PROPOSAL_INVALID_JSON",
  "U1_EDIT_INVALID",
]);

const CONSTRAINED_RECOVERY_CODES = new Set([
  "REPAIR_PROPOSAL_NOOP",
  "U1_EDIT_SCOPE_VIOLATION",
  "U1_EDIT_LIMIT_EXCEEDED",
  "U1_EDIT_ANCHOR_NOT_UNIQUE",
  "U1_EDIT_OVERLAP",
  "U1_EDIT_RESULT_EMPTY",
  "U1_EDIT_GOVERNANCE_METADATA_FORBIDDEN",
  "U1_EDIT_GROWTH_LIMIT_EXCEEDED",
  "REPAIR_PROPOSAL_U1_BOUNDARY_VIOLATION",
]);

function recoveryModeOf(error: unknown): Exclude<U1RecoveryMode, "primary" | "schema-repair"> | null {
  if (!(error instanceof RepairFrontierError)) return null;
  if (FORMAT_RECOVERY_CODES.has(error.code)) return "format-repair";
  if (CONSTRAINED_RECOVERY_CODES.has(error.code)) return "constrained-reproposal";
  return null;
}

function repairRequestFingerprint(messages: readonly ProviderMessage[]): string {
  return sha256Hex(JSON.stringify({ messages, responseFormat: "json_object" }));
}

function recoveryMessages(input: {
  original: readonly ProviderMessage[];
  failure: RepairFrontierError;
  mode: "format-repair" | "constrained-reproposal";
}): ProviderMessage[] {
  const instructions = input.mode === "format-repair"
    ? [
        "This is the single allowed format-repair attempt.",
        "Return exactly one strict edit or no_change JSON object using the original schema.",
        "Never return a full SKILL.md, prose, a markdown fence, commentary, or an additional key.",
      ]
    : [
        "This is the single allowed constrained re-proposal attempt.",
        "Return one valid bounded exact edit, or no_change when no safe edit is justified.",
        "Preserve the exact capability and logical-id boundary from the original request.",
        "Never return a full SKILL.md or an additional key.",
      ];
  return [
    ...input.original.map((message) => ({ ...message })),
    {
      role: "system",
      content: [
        ...instructions,
        `Failure code: ${input.failure.code}`,
        "The rejected response is intentionally unavailable. Do not quote, reconstruct, or discuss it.",
      ].join("\n"),
    },
  ];
}

async function callRepairProvider(input: {
  provider: U1AttemptContextProvider;
  messages: ProviderMessage[];
  originalRequestFingerprint: string;
  attempt: 1 | 2;
  mode: "primary" | "format-repair" | "constrained-reproposal";
  bindAttempt: boolean;
}): Promise<ProviderResponse> {
  const provider = input.bindAttempt
      ? bindApplicationAttemptProvider({
        provider: input.provider,
        operation: "repair-proposer",
        originalRequestFingerprint: input.originalRequestFingerprint,
        attempt: input.attempt,
        mode: input.mode,
      })
    : input.provider;
  try {
    return await provider.chat(input.messages, { responseFormat: "json_object" });
  } catch (error) {
    if (error instanceof ProviderBudgetError && error.kind === "logical_calls") throw error;
    if (error instanceof OpenAICompatibleProviderError) {
      // This provider error class is itself a fixed safe projection: its
      // contract excludes request/response bodies, URLs and credentials while
      // retaining the stable provider code and bounded diagnostics.
      throw new RepairFrontierError(
        "REPAIR_PROPOSER_PROVIDER_FAILED",
        `REPAIR_PROPOSER_PROVIDER_FAILED: ${error.code}: ${error.message}`,
      );
    }
    // retry_attempts is reached only after the same request encountered a
    // bounded transport failure. It remains fatal, but is not a logical-budget
    // stop and never enters application-level structure recovery.
    throw new RepairFrontierError(
      "REPAIR_PROPOSER_PROVIDER_FAILED",
      "REPAIR_PROPOSER_PROVIDER_FAILED: the bounded repair provider call failed; request and response content were not persisted",
    );
  }
}

function validateRepairResponse(input: {
  content: string;
  parentSkillMd: string;
  capabilityBoundary: CapabilityBoundary;
}): RepairProposal {
  let applied: RepairProposal;
  try {
    applied = applyU1SkillEditEnvelope({
      proposalText: input.content,
      parentSkillMd: input.parentSkillMd,
    });
  } catch (error) {
    if (error instanceof U1SkillEditError) {
      const code = error.code === "U1_EDIT_INVALID_JSON"
        ? "REPAIR_PROPOSAL_INVALID_JSON"
        : error.code === "U1_EDIT_NOOP"
          ? "REPAIR_PROPOSAL_NOOP"
          : error.code;
      throw new RepairFrontierError(
        code,
        `${code}: the live repair proposal violated the bounded U1 edit protocol (${error.code})`,
      );
    }
    throw error;
  }
  if (applied.decision === "no_change") return applied;
  const findings = analyzeU1CapabilityText(applied.skillMd, input.capabilityBoundary)
    .findings.filter((finding) => finding.blocking);
  if (findings.length > 0) {
    throw new RepairFrontierError(
      "REPAIR_PROPOSAL_U1_BOUNDARY_VIOLATION",
      `REPAIR_PROPOSAL_U1_BOUNDARY_VIOLATION: the repair carries unavailable execution (${findings.map((finding) => `${finding.code}:${finding.kind}`).join(", ")}); first finding line ${findings[0].line}: ${findings[0].excerpt}`,
    );
  }
  return applied;
}

/**
 * Build the live repair proposer. `provider` should be the same
 * caching + budget chain used for evaluation, so the single repair call
 * is billed, cached, and capped like every other model call.
 */
export function createOpenAICompatibleRepairProposer(args: {
  provider: U1AttemptContextProvider;
  capabilityBoundary?: CapabilityBoundary;
  authorizedToolLogicalIds?: readonly string[];
}): FrontierRepairProposer {
  return {
    producer: { kind: "provider", name: LIVE_REPAIR_PRODUCER_NAME },
    async proposeTargetedRepair(context): Promise<RepairProposal> {
      const boundary = args.capabilityBoundary ?? U1_INSTRUCTION_ONLY_BOUNDARY;
      const feedback = sanitizeBoundedPublicTrainFeedback({
        feedback: context.trainFeedback,
      });
      const messages: ProviderMessage[] = [
        {
          role: "system",
          content: systemPrompt({
            boundary,
            authorizedToolLogicalIds: context.authorizedToolLogicalIds ?? args.authorizedToolLogicalIds ?? [],
          }),
        },
        {
          role: "user",
          content: userPrompt(
            context.ticket,
            context.skillMd,
            feedback,
            context.taskCard && context.lanePurpose
              ? {
                  taskCard: context.taskCard,
                  lanePurpose: context.lanePurpose,
                  failureClasses: context.failureClasses ?? [],
                }
              : undefined,
          ),
        },
      ];
      const originalRequestFingerprint = repairRequestFingerprint(messages);
      if (!context.recovery) {
        args.provider.setContext?.("frontier-repair", sha256Hex(context.skillMd).slice(0, 12));
      }
      const primaryResponse = await callRepairProvider({
        provider: args.provider,
        messages,
        originalRequestFingerprint,
        attempt: 1,
        mode: "primary",
        bindAttempt: context.recovery !== undefined,
      });
      try {
        return validateRepairResponse({
          content: primaryResponse.content,
          parentSkillMd: context.skillMd,
          capabilityBoundary: boundary,
        });
      } catch (error) {
        const mode = recoveryModeOf(error);
        if (!context.recovery || mode === null || !(error instanceof RepairFrontierError)) throw error;
        context.recovery.hooks.onDiagnostic(recoveryDiagnosticOf({
          subject: context.recovery.subject,
          attempt: 1,
          failureCode: error.code,
          response: primaryResponse,
        }));
        context.recovery.hooks.onApplicationRecoveryAttempt({
          subject: context.recovery.subject,
          operation: "repair-proposer",
          attempt: 2,
          mode,
          requestFingerprintSha256: originalRequestFingerprint,
        });
        const secondMessages = recoveryMessages({ original: messages, failure: error, mode });
        const secondResponse = await callRepairProvider({
          provider: args.provider,
          messages: secondMessages,
          originalRequestFingerprint,
          attempt: 2,
          mode,
          bindAttempt: true,
        });
        try {
          return validateRepairResponse({
            content: secondResponse.content,
            parentSkillMd: context.skillMd,
            capabilityBoundary: boundary,
          });
        } catch (secondError) {
          if (secondError instanceof RepairFrontierError && recoveryModeOf(secondError) !== null) {
            context.recovery.hooks.onDiagnostic(recoveryDiagnosticOf({
              subject: context.recovery.subject,
              attempt: 2,
              failureCode: secondError.code,
              response: secondResponse,
            }));
          }
          throw secondError;
        }
      }
    },
  };
}
