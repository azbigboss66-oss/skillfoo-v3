import {
  type AdapterDeclaration,
  type CapabilityBoundary,
  type EvaluationContractV3,
  type SideEffectPolicy,
  type TaskCard,
} from "../types.js";
import { completeTaskCardIntentDetails, taskCardContentSha256 } from "../intake/taskCard.js";
import {
  analyzeU1CapabilityText,
  blockingU1CapabilityFindings,
} from "../runtime/u1CapabilityPolicy.js";

export class ScaffoldError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ScaffoldError";
  }
}

type SideEffectChannel = "network" | "filesystem" | "externalActions";

const CHANNEL_LABELS: Record<SideEffectChannel, string> = {
  network: "Network access",
  filesystem: "Filesystem access",
  externalActions: "External actions",
};

const CHANNEL_PROHIBITIONS: Record<SideEffectChannel, string> = {
  network: "must not fetch, browse, or call any external HTTP service",
  filesystem: "must not read, write, or delete any file",
  externalActions: "must not execute commands, scripts, or send anything on the operator's behalf",
};

/**
 * Lines that mention a tool from a forbidden side-effect channel without
 * carrying a prohibition marker. A scaffold (or repair candidate) whose
 * text introduces such lines claims capabilities beyond the task card's
 * boundary — that is a privilege escalation, not a wording choice.
 */
export function forbiddenToolViolations(
  text: string,
  boundary: CapabilityBoundary,
): string[] {
  return blockingU1CapabilityFindings(text, boundary).map(
    (finding) => `${finding.code}:${finding.kind} line ${finding.line}: ${finding.excerpt}`,
  );
}

export function assertNoPrivilegeEscalation(
  text: string,
  boundary: CapabilityBoundary,
  context: string,
): void {
  const analysis = analyzeU1CapabilityText(text, boundary);
  const violations = analysis.findings.filter((finding) => finding.blocking);
  if (!analysis.passed) {
    throw new ScaffoldError(
      "SCAFFOLD_PRIVILEGE_ESCALATION",
      `${context} introduces execution beyond the capability boundary (${violations.length} finding(s)): first violation ${violations[0].code}:${violations[0].kind} line ${violations[0].line}: ${violations[0].excerpt}`,
    );
  }
}

function describePolicy(policy: SideEffectPolicy, channel: SideEffectChannel): string {
  if (policy === "forbidden") {
    return `${CHANNEL_LABELS[channel]}: forbidden — ${CHANNEL_PROHIBITIONS[channel]}.`;
  }
  if (policy === "controlled") {
    return `${CHANNEL_LABELS[channel]}: controlled — only through capabilities explicitly allowed above and within their limits.`;
  }
  return `${CHANNEL_LABELS[channel]}: allowed by the task card.`;
}

export interface ScaffoldInput {
  taskCard: TaskCard;
  contract: EvaluationContractV3;
  adapter: AdapterDeclaration;
}

export interface ScaffoldOutput {
  skillMd: string;
}

/**
 * Build the S0 scaffold SKILL.md from the validated task intent and capability
 * boundary. Contract and adapter data are validation inputs, not content. The
 * interface has no B0 input, so no B0 workflow text, script command or
 * unverified reference can leak into S0 by construction. Output is
 * deterministic: identical inputs produce an identical scaffold.
 */
export function createScaffold(input: ScaffoldInput): ScaffoldOutput {
  const { taskCard, contract, adapter } = input;
  const currentIntent = completeTaskCardIntentDetails(taskCard);
  if (taskCardContentSha256(taskCard) !== contract.taskCardHash) {
    throw new ScaffoldError(
      "SCAFFOLD_TASK_CARD_HASH_MISMATCH",
      "the Task Card content differs from the hash frozen into the evaluation contract",
    );
  }
  if (taskCard.confirmation.status !== "confirmed") {
    throw new ScaffoldError(
      "SCAFFOLD_TASK_CARD_NOT_CONFIRMED",
      "S0 may only be scaffolded from a confirmed task card",
    );
  }
  if (
    contract.confirmationMode !== "human" &&
    contract.confirmationMode !== "test-fixture"
  ) {
    throw new ScaffoldError(
      "SCAFFOLD_CONFIRMATION_MODE_UNSUPPORTED",
      "S0 requires a human-confirmed formal contract or a zero-network test fixture contract",
    );
  }
  if (
    taskCard.confirmation.confirmationMode !== contract.confirmationMode
  ) {
    throw new ScaffoldError(
      "SCAFFOLD_CONFIRMATION_MODE_MISMATCH",
      "Task Card and frozen contract confirmation modes must match",
    );
  }
  if (contract.adapterId !== adapter.id) {
    throw new ScaffoldError(
      "SCAFFOLD_ADAPTER_MISMATCH",
      `the contract binds adapter "${contract.adapterId}" but scaffold input declares "${adapter.id}"`,
    );
  }
  const excess = adapter.requiredCapabilities.filter(
    (capability) => !taskCard.capabilityBoundary.allowedCapabilities.includes(capability),
  );
  if (excess.length > 0) {
    throw new ScaffoldError(
      "SCAFFOLD_CAPABILITY_NOT_ALLOWED",
      `adapter "${adapter.id}" requires capabilities beyond the task card boundary: ${excess.join(", ")}`,
    );
  }

  const lines: string[] = [
    `# Skill: ${taskCard.goal}`,
    "",
    "## Role",
    "",
    `Mission: ${taskCard.goal}`,
    ...(currentIntent
      ? [
          `Goal and intended user: ${currentIntent.goal_and_intended_user ?? taskCard.goal}`,
          `Inputs and evidence: ${currentIntent.inputs_and_evidence ?? "use only the evidence supplied by the user or an authorized logical-id tool"}`,
          `Success and protected behavior: ${currentIntent.success_criteria_and_protected_behavior ?? "satisfy the confirmed goal without crossing the capability boundary"}`,
        ]
      : []),
    "",
    "## Capability limits",
    "",
    `- Allowed capabilities: ${taskCard.capabilityBoundary.allowedCapabilities.join(", ")}`,
    `- ${describePolicy(taskCard.capabilityBoundary.network, "network")}`,
    `- ${describePolicy(taskCard.capabilityBoundary.filesystem, "filesystem")}`,
    `- ${describePolicy(taskCard.capabilityBoundary.externalActions, "externalActions")}`,
    "",
    "## Red lines (never cross, never paraphrase away)",
    "",
  ];
  for (const redline of taskCard.redlines) {
    lines.push(`- ${redline}`);
  }
  lines.push(
    "",
    "## Quality priorities",
    "",
    ...taskCard.qualityPriorities.map(
      (dimension, index) => `${index + 1}. ${dimension}`,
    ),
    "",
    "## Workflow and output",
    "",
    "- Address the mission directly and keep facts, assumptions, gaps, and recommendations distinguishable.",
    "- If required evidence is absent or conflicting, state the limitation and request the smallest useful clarification.",
    "- Never imply that an unavailable tool, file, network source, script, plugin, or external action was executed.",
    `- Output contract: ${currentIntent?.output_and_format ?? "use a clear final response whose structure serves the confirmed goal"}.`,
    ...(currentIntent
      ? [`- Capability boundary and redlines: ${currentIntent.capability_boundary_and_redlines}.`]
      : []),
    "",
  );

  const skillMd = lines.join("\n");
  assertNoPrivilegeEscalation(skillMd, taskCard.capabilityBoundary, "scaffold S0");
  return { skillMd };
}
