// The current Direct control evaluates one independently generated SKILL.md
// once on the frozen public-select contract. It has no population, lineage,
// Adaptive feedback, or self-refinement branch.

import { sha256Hex } from "../runtime/capabilityAdapter.js";
import {
  analyzeU1CapabilityText,
  type U1CapabilityFindingCode,
  type U1CapabilityFindingKind,
} from "../runtime/u1CapabilityPolicy.js";
import { applyContractGates, contractItemPassed, type InstructionBatchScorer, type InstructionGateInput } from "../runtime/instructionAdapter.js";
import type { RunCallAccounting, RunCallBudget } from "../providers/runBudget.js";
import type { Provider, ProviderMessage } from "../providers/types.js";
import { mapBoundedStable, type ParallelTiming } from "../runtime/parallel.js";
import type { CapabilityBoundary, EvaluationContractV3, Producer, U1ApplicationRecoverySummary } from "../types.js";
import type { AdaptiveEvaluation } from "./adaptiveRun.js";
import type { FunnelEvalItem, FunnelEvent, FunnelScenarioRunner } from "./funnel.js";
import { scoringIdentityOfContract } from "../evaluation/u1Rubric.js";
import type { U1RecoveryContext } from "./structureRecovery.js";

export class DirectBaselineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly safeDetails?: {
      candidateSkillSha256: string;
      findings: DirectU1SafeFinding[];
    },
  ) {
    super(message);
    this.name = "DirectBaselineError";
  }
}

export interface DirectU1SafeFinding {
  code: U1CapabilityFindingCode;
  kind: Extract<U1CapabilityFindingKind, "execution_instruction" | "false_execution_claim">;
  line: number;
  evidenceSha256: string;
  excerpt: "[redacted capability clause]";
}

export interface DirectBaselineResult {
  strategy: "one_shot";
  stopReason: "completed";
  stopDetail: string;
  finalSkillMd: string;
  finalEvaluation: AdaptiveEvaluation;
  finalAnswerHashes: Array<{ itemId: string; answerSha256: string }>;
  accounting: RunCallAccounting;
  events: FunnelEvent[];
  totalWallTimeMs: number;
  serialEquivalentMs: number;
  maxObservedInFlight: number;
  /** Content-free evidence for the one permitted per item loop retry. */
  applicationRecovery?: U1ApplicationRecoverySummary[];
}

export interface DirectBaselineArgs {
  strategy: "one_shot";
  contract: EvaluationContractV3;
  publicItems: FunnelEvalItem[];
  baseSkillMd: string;
  runner: FunnelScenarioRunner;
  scoreRuns?: InstructionBatchScorer;
  /** Mandatory one-shot JSON schema recovery for each Direct semantic batch. */
  semanticRecovery: U1RecoveryContext;
  budget: RunCallBudget;
  /** Maximum independent public-item evaluations allowed at once. */
  maxInFlight?: number;
  now?: () => string;
}

/**
 * Run the one-shot Direct baseline. A failure leaves no honest Direct result
 * and therefore propagates to the stage-level desensitized failure artifact.
 */
export async function runDirectBaseline(args: DirectBaselineArgs): Promise<DirectBaselineResult> {
  scoringIdentityOfContract({
    contract: args.contract,
    items: args.publicItems,
  });
  const runWallStartedAtMs = Date.now();
  const now = args.now ?? (() => new Date().toISOString());
  const maxInFlight = args.maxInFlight ?? 1;
  const parallelTimings: ParallelTiming[] = [];
  let maxObservedInFlight = 0;
  const events: FunnelEvent[] = [];
  const emit = (type: string, payload: Record<string, unknown> = {}): void => {
    events.push({ at: now(), type, ...payload });
  };

  const items = args.publicItems;
  const evaluate = async (skillMd: string): Promise<{
    evaluation: AdaptiveEvaluation;
    answerHashes: Array<{ itemId: string; answerSha256: string }>;
  }> => {
    const snapshotId = sha256Hex(skillMd).slice(0, 12);
    const batch = await mapBoundedStable(items, maxInFlight, async (item): Promise<InstructionGateInput> => {
      const transcript = await args.runner({ item, skillMd, snapshotId });
      return {
        item: {
          itemId: item.itemId,
          split: "public",
          itemType: item.itemType,
          scenarioId: item.scenarioId, input: item.input, judgingRule: item.judgingRule, ...(item.redlineRefs ? { redlineRefs: item.redlineRefs } : {}),
          rubric: item.rubric,
          taskVerifier: item.taskVerifier,
        },
        transcript,
      };
    });
    const runs = batch.values;
    parallelTimings.push(...batch.timings);
    maxObservedInFlight = Math.max(maxObservedInFlight, batch.maxObservedInFlight);
    const scored = args.scoreRuns
      ? await args.scoreRuns({
          contract: args.contract,
          runs,
          recovery: args.semanticRecovery,
        })
      : applyContractGates({ contract: args.contract, runs });
    const safetyFailures = scored.gateResults.filter((g) => g.category === "safety" && !g.passed).length;
    const qualityFailures = scored.gateResults.filter((g) => g.category === "quality" && !g.passed).length;
    const outcome: AdaptiveEvaluation["outcome"] =
      safetyFailures > 0 ? "killed" : qualityFailures > 0 ? "safe_non_elite" : "elite";
    const applicationRecoveries = runs.flatMap((run) =>
      run.transcript.applicationRecovery
        ? [{ itemId: run.item.itemId, ...run.transcript.applicationRecovery }]
        : [],
    );
    return {
      evaluation: {
        publicScore: scored.publicScore,
        solvedItemIds: scored.itemScores.filter(contractItemPassed).map((entry) => entry.itemId),
        itemScores: scored.itemScores,
        gateResults: scored.gateResults,
        safetyFailures,
        qualityFailures,
        outcome,
        ...(applicationRecoveries.length > 0 ? { applicationRecoveries } : {}),
      },
      answerHashes: runs.map((run) => ({
        itemId: run.item.itemId,
        answerSha256: sha256Hex(JSON.stringify(run.transcript.parsedFinalAnswer ?? null)),
      })),
    };
  };

  emit("run_start", {
    strategy: args.strategy,
    publicItems: items.length,
    maxInFlight,
  });

  const baseEvaluated = await evaluate(args.baseSkillMd);
  const finalEvaluation = baseEvaluated.evaluation;
  emit("variant_evaluated", {
    variantIndex: 0,
    publicScore: finalEvaluation.publicScore,
    outcome: finalEvaluation.outcome,
  });
  const applicationRecovery: U1ApplicationRecoverySummary[] =
    (finalEvaluation.applicationRecoveries ?? []).map((entry) => ({
      ...entry,
      candidateId: "direct",
      role: "direct",
    }));
  emit("run_end", {
    stopReason: "completed",
    finalVariantIndex: 0,
    finalPublicScore: finalEvaluation.publicScore,
    logicalCalls: args.budget.accounting.logicalCalls,
  });

  return {
    strategy: args.strategy,
    stopReason: "completed",
    stopDetail: "direct-one_shot completed; the independent candidate was evaluated once",
    finalSkillMd: args.baseSkillMd,
    finalEvaluation,
    finalAnswerHashes: baseEvaluated.answerHashes,
    accounting: args.budget.accounting,
    events,
    totalWallTimeMs: Date.now() - runWallStartedAtMs,
    serialEquivalentMs: parallelTimings.reduce((sum, timing) => sum + timing.durationMs, 0),
    maxObservedInFlight,
    ...(applicationRecovery.length > 0 ? { applicationRecovery } : {}),
  };
}

// ── V3.2 U1-B frozen natural-language Direct candidate ───────────

export const DIRECT_U1_FROZEN_INSTRUCTION = "这是我的 Skill，按目标帮我改好；自检后给最终版本。";
export const DIRECT_U1_PRODUCER_NAME = "openai-compatible-u1-direct";
export const DIRECT_U1_PROMPT_CONTRACT_VERSION = "u1-direct-capability-self-check-v1";

const DIRECT_U1_RESPONSE_FORMAT = "json_object" as const;
const DIRECT_U1_GOAL_HEADER = "# Goal";
const DIRECT_U1_SOURCE_HEADER = "# Routed generation-zero SKILL.md";
const DIRECT_U1_REQUEST_HEADER = "# Request";

function buildU1DirectUserFrame(goal: string, sourceSkillMd: string): string {
  return [
    DIRECT_U1_GOAL_HEADER,
    goal,
    "",
    DIRECT_U1_SOURCE_HEADER,
    sourceSkillMd,
    "",
    DIRECT_U1_REQUEST_HEADER,
    DIRECT_U1_FROZEN_INSTRUCTION,
  ].join("\n");
}

export interface U1DirectProposer {
  producer: Producer;
  propose(context: {
    sourceSkillMd: string;
    goal: string;
    capabilityBoundary: CapabilityBoundary;
  }): Promise<{ skillMd: string }>;
}

const U1_DIRECT_SYSTEM_PROMPT = [
  "You rewrite exactly one SKILL.md inside the instruction-only U1 scope.",
  "You have no tools: do not access a network, filesystem, shell, plugin, database, or external action.",
  "The generated SKILL.md must not instruct the model, host, or user to perform any network, filesystem, shell, plugin, message, contact, or external action.",
  "Before returning, self-check every clause of the final SKILL.md for unavailable execution.",
  "Rewrite every affirmative claim or imperative instruction to browse or fetch the web, call an API, read, write, or open files, run commands, scripts, or plugins, or send messages or contact people.",
  "Use only instruction-only fallbacks: mark outside evidence unverified; ask the user to paste needed content; provide questions, conditions, options, a checklist, or a draft.",
  "Never claim that an unavailable action happened. Keep actionability inside analysis of user-supplied text.",
  "Return exactly one JSON object and nothing else:",
  '{"skillMd":"<the complete final SKILL.md>"}',
  "The skillMd value must be the complete replacement document and may only describe instruction behavior available without tools.",
].join("\n");

function buildU1DirectMessages(goal: string, sourceSkillMd: string): ProviderMessage[] {
  return [
    { role: "system", content: U1_DIRECT_SYSTEM_PROMPT },
    { role: "user", content: buildU1DirectUserFrame(goal, sourceSkillMd) },
  ];
}

const DIRECT_U1_MESSAGE_TEMPLATE = buildU1DirectMessages("{{GOAL}}", "{{SOURCE_SKILL_MD}}");

/**
 * Hash only the generic, content-free Direct request frame. Case goals and
 * source Skill bodies are deliberately excluded so every U1 case shares one
 * auditable prompt contract.
 */
export const DIRECT_U1_PROMPT_CONTRACT_SHA256 = sha256Hex(JSON.stringify({
  version: DIRECT_U1_PROMPT_CONTRACT_VERSION,
  messages: DIRECT_U1_MESSAGE_TEMPLATE,
  responseFormat: DIRECT_U1_RESPONSE_FORMAT,
  responseShape: {
    type: "object",
    ownKeys: ["skillMd"],
    additionalProperties: false,
    skillMd: "non-empty-string",
  },
}));

function safeDirectFindings(
  findings: ReturnType<typeof analyzeU1CapabilityText>["findings"],
): DirectU1SafeFinding[] {
  return findings.map((finding) => ({
    code: finding.code,
    kind: finding.kind as DirectU1SafeFinding["kind"],
    line: finding.line,
    evidenceSha256: sha256Hex(finding.evidence),
    excerpt: "[redacted capability clause]",
  }));
}

/**
 * One frozen, natural-language Direct generation. Its context is deliberately
 * limited to the routed generation-zero source, the task goal, and the exact frozen instruction. The Task
 * Card capability object remains a post-generation validator, not a prompt.
 */
export function createOpenAICompatibleU1DirectProposer(args: {
  provider: Provider & { setContext?: (scenarioId: string, snapshotId: string) => void };
}): U1DirectProposer {
  return {
    producer: { kind: "provider", name: DIRECT_U1_PRODUCER_NAME },
    async propose(context) {
      args.provider.setContext?.("u1-direct", sha256Hex(context.sourceSkillMd).slice(0, 12));
      const messages = buildU1DirectMessages(context.goal, context.sourceSkillMd);

      let content: string;
      try {
        content = (await args.provider.chat(messages, { responseFormat: DIRECT_U1_RESPONSE_FORMAT })).content;
      } catch (error) {
        throw new DirectBaselineError(
          "DIRECT_U1_PROVIDER_FAILED",
          `DIRECT_U1_PROVIDER_FAILED: the bounded Direct generation call failed: ${error instanceof Error ? error.message : "provider error"}`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(content) as unknown;
      } catch {
        throw new DirectBaselineError(
          "DIRECT_U1_INVALID_JSON",
          "DIRECT_U1_INVALID_JSON: the Direct generation did not return a JSON object",
        );
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length !== 1 ||
        Object.keys(parsed)[0] !== "skillMd" ||
        typeof (parsed as { skillMd?: unknown }).skillMd !== "string" ||
        !(parsed as { skillMd: string }).skillMd.trim()
      ) {
        throw new DirectBaselineError(
          "DIRECT_U1_INVALID",
          "DIRECT_U1_INVALID: the Direct generation must return one non-empty complete skillMd string",
        );
      }
      const skillMd = (parsed as { skillMd: string }).skillMd;
      const findings = analyzeU1CapabilityText(skillMd, context.capabilityBoundary)
        .findings.filter((finding) => finding.blocking);
      if (findings.length > 0) {
        throw new DirectBaselineError(
          "DIRECT_U1_BOUNDARY_VIOLATION",
          `DIRECT_U1_BOUNDARY_VIOLATION: generated SKILL.md requests unavailable execution (${findings.map((finding) => `${finding.code}:${finding.kind}`).join(", ")})`,
          {
            candidateSkillSha256: sha256Hex(skillMd),
            findings: safeDirectFindings(findings),
          },
        );
      }
      return { skillMd };
    },
  };
}
