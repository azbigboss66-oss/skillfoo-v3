import type { FrontierTicket, GateResult, Producer } from "../types.js";
import { FrontierTicketSchema } from "../types.js";
import type { U1MutationTrainFeedback } from "./publicTrainFeedback.js";
import type { PromptCardFacts, U1LanePurpose } from "../bootstrap/liveBootstrapProposer.js";
import type { U1RecoveryContext } from "./structureRecovery.js";
import { classifyGateOutcome, type GateClassification } from "./gateClassifier.js";
import { applyU1SkillEditEnvelope, type AppliedU1SkillChange } from "./u1SkillEdit.js";

export class RepairFrontierError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RepairFrontierError";
  }
}

/** Round 1 locks the frontier repair surface to SKILL.md only. */
export const FRONTIER_EDITABLE_FILES: readonly string[] = ["SKILL.md"];

/** Exactly one targeted repair per frontier ticket. */
export const FRONTIER_REPAIR_BUDGET = 1;

export interface CapabilityGap {
  capability: string;
  floor: number;
  score: number;
}

/**
 * The single most actionable reason a frontier candidate failed, in
 * priority order: the first failed quality gate, then a failed critical
 * scenario, then the widest capability gap. Gate ids, scenario verdicts
 * and numbers only — never candidate content.
 */
export function minimalFailureReasonOf(input: {
  qualityFailures: GateResult[];
  criticalScenariosPassed: boolean;
  capabilityGaps: CapabilityGap[];
}): string {
  const [firstGate, ...restGates] = input.qualityFailures;
  if (firstGate) {
    const more = restGates.length > 0 ? ` (+${restGates.length} more failed quality gate(s))` : "";
    return `quality gate ${firstGate.gateId} failed${firstGate.reason ? `: ${firstGate.reason}` : ""}${more}`;
  }
  if (!input.criticalScenariosPassed) {
    return "critical scenario(s) failed on the public slice";
  }
  if (input.capabilityGaps.length > 0) {
    const widest = [...input.capabilityGaps].sort(
      (a, b) => b.floor - b.score - (a.floor - a.score),
    )[0];
    return `capability ${widest.capability} ${widest.score} below floor ${widest.floor}`;
  }
  return "unknown quality failure";
}

export interface RepairProposal {
  hypothesis: string;
  skillMd: string;
  /** Additive for U1; absent on historical/custom V2-compatible proposers. */
  decision?: AppliedU1SkillChange["decision"];
  appliedEdits?: number;
}

export interface FrontierRepairProposer {
  producer: Producer;
  proposeTargetedRepair(context: {
    ticket: FrontierTicket;
    skillMd: string;
    trainFeedback?: U1MutationTrainFeedback;
    adapterId?: string;
    /** Present on the current U1 path; optional only for historical/custom proposers. */
    taskCard?: PromptCardFacts;
    lanePurpose?: U1LanePurpose;
    failureClasses?: string[];
    authorizedToolLogicalIds?: string[];
    recovery?: U1RecoveryContext;
  }): Promise<RepairProposal>;
}

/**
 * Offline deterministic proposer: appends one targeted section that restates
 * the minimal failure reason as an explicit instruction. It adds no tool, no
 * script and no network step — the repaired candidate is still judged by the
 * same gates on the same public slice.
 */
export function createFixtureRepairProposer(): FrontierRepairProposer {
  return {
    producer: { kind: "fixture", name: "frontier-fixture-repair" },
    async proposeTargetedRepair(context) {
      const section = [
        "",
        "## Targeted repair (frontier, round 1)",
        "",
        "This section was appended by the fixture repair lane in response to one recorded failure.",
        "It changes no capability boundary and adds no tool, script, or network step.",
        "",
        `- Failure being repaired: ${context.ticket.minimalFailureReason}`,
        "- The skill must satisfy the frozen contract's quality gates on the same public slice.",
        "",
      ].join("\n");
      return applyU1SkillEditEnvelope({
        parentSkillMd: context.skillMd,
        proposalText: JSON.stringify({
          hypothesis:
            "fixture targeted repair round 1: restate the minimal failure reason as an explicit instruction without widening any boundary",
          decision: "edit",
          edits: [{ op: "insert_after", anchor: context.skillMd, text: `\n${section}` }],
        }),
      });
    },
  };
}

function assertTicketRepairable(ticket: FrontierTicket): void {
  const parsed = FrontierTicketSchema.safeParse(ticket);
  if (!parsed.success) {
    throw new RepairFrontierError(
      "REPAIR_TICKET_INVALID",
      `the frontier ticket is invalid (${parsed.error.issues.map((issue) => issue.message).join("; ")})`,
    );
  }
  if (ticket.repairsUsed >= ticket.repairBudget) {
    throw new RepairFrontierError(
      "REPAIR_BUDGET_EXHAUSTED",
      `candidate ${ticket.candidateId} already consumed ${ticket.repairsUsed} of ${ticket.repairBudget} allowed repair(s); no further repair is permitted`,
    );
  }
}

/**
 * Consume the ticket: run the proposer, validate the proposal, and return the
 * ticket with repairsUsed incremented. The proposal may only rewrite files
 * listed in the ticket's editableFiles — SKILL.md in round 1.
 */
export async function planTargetedRepair(args: {
  ticket: FrontierTicket;
  skillMd: string;
  proposer?: FrontierRepairProposer;
}): Promise<{ proposal: RepairProposal; ticket: FrontierTicket; producer: Producer }> {
  assertTicketRepairable(args.ticket);
  const proposer = args.proposer ?? createFixtureRepairProposer();
  const proposal = await proposer.proposeTargetedRepair({ ticket: args.ticket, skillMd: args.skillMd });
  if (!proposal.hypothesis?.trim() || !proposal.skillMd?.trim()) {
    throw new RepairFrontierError(
      "REPAIR_PROPOSAL_INVALID",
      "the repair proposer must return a non-empty hypothesis and SKILL.md content",
    );
  }
  if (proposal.decision !== "no_change" && proposal.skillMd === args.skillMd) {
    throw new RepairFrontierError(
      "REPAIR_PROPOSAL_NOOP",
      "the repair proposal is identical to the base skill; a targeted repair must change SKILL.md",
    );
  }
  const consumed = FrontierTicketSchema.parse({ ...args.ticket, repairsUsed: args.ticket.repairsUsed + 1 });
  return { proposal, ticket: consumed, producer: proposer.producer };
}

export interface RepairedEvaluation {
  split: "public" | "holdout";
  gateResults: GateResult[];
  criticalScenariosPassed: boolean;
  capabilityScores: Record<string, number>;
  capabilityFloors: Record<string, number>;
  overallScore: number;
  baselineOverall: number;
  s0Overall: number | null;
  protectedRegression: boolean;
}

export interface SettledRepair extends GateClassification {
  /** Always false: the one-shot budget means no second ticket is ever issued. */
  secondTicketIssued: false;
}

/**
 * Settle a repaired candidate against the SAME public slice it failed on.
 * A holdout evaluation is refused outright — the frontier never touches the
 * holdout. If the repair still fails quality, the budget is gone, so the
 * candidate lands on safe_non_elite (or killed if the repair broke safety),
 * never on a second frontier ticket.
 */
export function settleRepair(args: {
  ticket: FrontierTicket;
  repaired: RepairedEvaluation;
}): SettledRepair {
  if (args.repaired.split !== "public") {
    throw new RepairFrontierError(
      "REPAIR_SPLIT_MISMATCH",
      `a repaired candidate must be re-evaluated on the public slice; got split "${args.repaired.split}" (the frontier never touches holdout)`,
    );
  }
  const classification = classifyGateOutcome({
    candidateId: args.ticket.candidateId,
    gateResults: args.repaired.gateResults,
    criticalScenariosPassed: args.repaired.criticalScenariosPassed,
    capabilityScores: args.repaired.capabilityScores,
    capabilityFloors: args.repaired.capabilityFloors,
    deltaVsB0: {
      overall: args.repaired.overallScore - args.repaired.baselineOverall,
      protectedRegression: args.repaired.protectedRegression,
    },
    deltaVsS0:
      args.repaired.s0Overall === null
        ? null
        : { overall: args.repaired.overallScore - args.repaired.s0Overall },
  });
  if (classification.outcome === "repair_frontier") {
    return {
      outcome: "safe_non_elite",
      reasons: [
        ...classification.reasons,
        "repair budget exhausted: the one allowed targeted repair did not clear the quality bar",
      ],
      frontierTicket: null,
      secondTicketIssued: false,
    };
  }
  return { ...classification, secondTicketIssued: false };
}

export interface FrontierSummaryEntry {
  candidateId: string;
  outcome: string;
  reason: string;
}

export interface FrontierSummary {
  hasElite: boolean;
  actionableReasons: FrontierSummaryEntry[];
}

/**
 * Report one actionable reason per candidate. When every candidate fails
 * quality, the summary is never empty — it lists exactly which gate,
 * scenario, or capability each candidate must fix (or why it died), so an
 * operator always gets a next step instead of a null result.
 */
export function frontierSummary(
  entries: Array<{ candidateId: string; classification: GateClassification }>,
): FrontierSummary {
  const hasElite = entries.some((entry) => entry.classification.outcome === "elite");
  const actionableReasons = entries.map((entry) => ({
    candidateId: entry.candidateId,
    outcome: entry.classification.outcome,
    reason: entry.classification.reasons[0] ?? "no recorded reason",
  }));
  return { hasElite, actionableReasons };
}
