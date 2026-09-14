import { createHash } from "node:crypto";
import { createScaffold } from "../bootstrap/createScaffold.js";
import { REFERENCE_ADAPTER_ID } from "../runtime/frozenContext.js";
import type { AdapterDeclaration, CapabilityBoundary, EvaluationContractV3, TaskCard } from "../types.js";

// ── P1 任务 4：U1 intake 分车道（纯静态，零 Provider 调用）─────────
//
// T22 根因 4：medium/poor 的原始 U1 违规承诺被直接送进 live prompt 后
// 空 content 失败——那不是对坏 Skill 的有效优化。修复：入口先做纯静态
// 分车道决策。干净 B0 走 eligible_b0_repair（原 B0 修复车道）；带 legacy
// 工具承诺的 B0 冻结为证据（只留 sha256），只走 requires_s0_rebuild——
// live bootstrap/mutation 看到的是 Task Card 生成的 S0 安全脚手架 + 冻结
// 卡片 + 去敏失败类别，看不到带工具/网络/脚本承诺的原文。决策零 Provider
// 调用、零网络、零工具执行；去敏类别只引用 kind + 静态 label。

export type U1IntakeLane = "eligible_b0_repair" | "requires_s0_rebuild" | "blocked";

export type U1BoundaryFindingKind = "network" | "external_push" | "script_exec";

interface U1BoundaryFinding {
  kind: U1BoundaryFindingKind;
  label: string;
}

const U1_BOUNDARY_PATTERNS: ReadonlyArray<{
  kind: U1BoundaryFindingKind;
  label: string;
  pattern: RegExp;
}> = [
  { kind: "network", label: "hard-coded monitoring URL", pattern: /https?:\/\/\S+/i },
  {
    kind: "network",
    label: "automatic website scanning commitment",
    pattern: /自动扫描|自动抓取|定时扫描|automatic(?:ally)?\s+scan|crawl(?:ing|er)?\s+(?:the\s+)?(?:website|网站|来源|sites?)/i,
  },
  {
    kind: "external_push",
    label: "push-to-Feishu/external delivery commitment",
    pattern: /推送至|推送到|推送用户|发送至飞书|push\s+to\s+(?:feishu|lark|webhook|飞书)/i,
  },
  {
    kind: "external_push",
    label: "scheduled automatic push",
    pattern: /(?:每日|每天|定时|定期).{0,24}(?:推送|发送|分发)/i,
  },
  {
    kind: "script_exec",
    label: "mounted script execution",
    pattern: /scripts?\/[\w./-]+\.(?:py|ps1|sh|js|ts)\b|\b(?:curl|wget)\b/i,
  },
];

/** Static, payload-local diagnosis used only to choose the safe U1 intake lane. */
export function diagnoseU1BoundaryCommitments(skillMd: string): {
  hasU1Violations: boolean;
  findings: U1BoundaryFinding[];
} {
  const findings: U1BoundaryFinding[] = [];
  for (const { kind, label, pattern } of U1_BOUNDARY_PATTERNS) {
    if (pattern.test(skillMd)) findings.push({ kind, label });
  }
  return { hasU1Violations: findings.length > 0, findings };
}

/** A sanitized boundary category: kind + static label only — never the matched evidence text. */
export interface U1ViolationCategory {
  kind: U1BoundaryFindingKind;
  label: string;
}

export interface U1IntakeDecision {
  lane: U1IntakeLane;
  reasons: string[];
  violationCategories: U1ViolationCategory[];
  /** sha256 of the original B0 SKILL.md — frozen as evidence, never the text itself. */
  b0EvidenceSha256: string;
}

export class U1IntakeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "U1IntakeError";
  }
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function boundaryIsU1(boundary: CapabilityBoundary, adapterId?: string): boolean {
  const instructionOnly =
    boundary.network === "forbidden" &&
    boundary.filesystem === "forbidden" &&
    boundary.externalActions === "forbidden";
  const frozenReferenceOnly =
    adapterId === REFERENCE_ADAPTER_ID &&
    boundary.network === "forbidden" &&
    boundary.filesystem === "controlled" &&
    (boundary.externalActions === "forbidden" || boundary.externalActions === "controlled") &&
    boundary.allowedCapabilities.length === 1 &&
    boundary.allowedCapabilities[0] === "reference";
  return instructionOnly || frozenReferenceOnly;
}

/**
 * The pure static lane decision. Synchronous by construction: no provider,
 * no network, no filesystem — everything it reads is already in memory.
 */
export function decideU1Intake(args: {
  b0SkillMd: string;
  taskCard: TaskCard;
  /** Frozen contract adapter identity; omitted legacy callers retain instruction-only behavior. */
  adapterId?: string;
}): U1IntakeDecision {
  const b0EvidenceSha256 = sha256Hex(args.b0SkillMd);

  if (!args.b0SkillMd.trim()) {
    return {
      lane: "blocked",
      reasons: ["B0_SKILL_EMPTY: the anchor SKILL.md carries no text; nothing can be repaired or rebuilt"],
      violationCategories: [],
      b0EvidenceSha256,
    };
  }

  if (!boundaryIsU1(args.taskCard.capabilityBoundary, args.adapterId)) {
    const boundary = args.taskCard.capabilityBoundary;
    return {
      lane: "blocked",
      reasons: [
        `TASK_CARD_NOT_U1: adapter=${args.adapterId ?? "legacy-unspecified"} grants network=${boundary.network}, filesystem=${boundary.filesystem}, externalActions=${boundary.externalActions}; U1 accepts either the instruction-only boundary (all three forbidden) or reference-v1's frozen reference-only read/replay boundary with externalActions forbidden or controlled`,
      ],
      violationCategories: [],
      b0EvidenceSha256,
    };
  }

  const diagnosis = diagnoseU1BoundaryCommitments(args.b0SkillMd);
  const seen = new Set<string>();
  const violationCategories: U1ViolationCategory[] = [];
  for (const finding of diagnosis.findings) {
    const key = `${finding.kind}::${finding.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    violationCategories.push({ kind: finding.kind, label: finding.label });
  }

  if (diagnosis.hasU1Violations) {
    return {
      lane: "requires_s0_rebuild",
      reasons: [
        `legacy U1 tool commitment(s) discovered: ${violationCategories
          .map((category) => `${category.kind} (${category.label})`)
          .join(", ")}; the original B0 text is frozen as evidence (sha256 ${b0EvidenceSha256.slice(0, 12)}…) and is never sent to a live proposer — the case runs on the S0 rebuild track`,
      ],
      violationCategories,
      b0EvidenceSha256,
    };
  }

  return {
    lane: "eligible_b0_repair",
    reasons: [
      "B0 carries no legacy U1 tool commitment; the b0-repair track may feed it to live proposers under the frozen card",
    ],
    violationCategories: [],
    b0EvidenceSha256,
  };
}

/**
 * Prompt-safe failure-category lines: kind + static label + the U1
 * consequence, never the matched evidence text from the original B0.
 */
export function sanitizedCategoryLines(categories: U1ViolationCategory[]): string[] {
  return categories.map(
    (category) =>
      `rebuild-note ${category.kind}: the frozen original carried a ${category.label} commitment; that commitment is unexecutable under U1 and must not reappear in any form`,
  );
}

export interface S0RebuildTrack {
  track: "s0-rebuild";
  lane: "requires_s0_rebuild";
  /** The S0 scaffold SKILL.md built from the frozen card + contract + adapter (zero B0 content). */
  s0SkillMd: string;
  s0SkillSha256: string;
  /** sha256 of the original B0 — evidence only. */
  b0EvidenceSha256: string;
  violationCategories: U1ViolationCategory[];
  sanitizedFailureCategories: string[];
  reportingNote: string;
}

/**
 * The scaffold's own voice: the scaffold text minus the verbatim frozen-card
 * quotes (goal, redlines, scenario requests/outcomes). The card quotes are
 * frozen evaluation content — the eval prompts carry the same user requests
 * by design — so they are not the skill's own commitments; everything the
 * scaffold says in its own words must stay clean.
 */
export function stripCardQuotes(text: string, taskCard: TaskCard): string {
  let remainder = text;
  const quotes = [
    taskCard.goal,
    ...taskCard.redlines,
    ...taskCard.scenarios.flatMap((scenario) => [scenario.userRequest, scenario.expectedOutcome ?? ""]),
  ];
  for (const quote of quotes) {
    if (quote.trim()) remainder = remainder.split(quote).join(" ");
  }
  return remainder;
}

/**
 * Materialize the S0 rebuild track for a requires_s0_rebuild decision:
 * the scaffold comes from the frozen card (createScaffold — the same
 * architecture bootstrap uses), and a scaffold whose OWN voice trips the
 * legacy diagnosis fails closed rather than entering any live prompt.
 */
export function materializeS0RebuildTrack(args: {
  decision: U1IntakeDecision;
  taskCard: TaskCard;
  contract: EvaluationContractV3;
  adapter: AdapterDeclaration;
}): S0RebuildTrack {
  if (args.decision.lane !== "requires_s0_rebuild") {
    throw new U1IntakeError(
      "U1_INTAKE_NOT_REBUILD_LANE",
      `the S0 rebuild track may only be materialized for a requires_s0_rebuild decision, not "${args.decision.lane}"`,
    );
  }
  const scaffold = createScaffold({
    taskCard: args.taskCard,
    contract: args.contract,
    adapter: args.adapter,
  });
  if (diagnoseU1BoundaryCommitments(stripCardQuotes(scaffold.skillMd, args.taskCard)).hasU1Violations) {
    throw new U1IntakeError(
      "U1_INTAKE_CARD_NOT_CLEAN",
      "the scaffold's own voice (frozen-card quotes stripped) trips the U1 capability-boundary diagnosis; the card must be re-frozen before any live run (fail closed)",
    );
  }
  return {
    track: "s0-rebuild",
    lane: "requires_s0_rebuild",
    s0SkillMd: scaffold.skillMd,
    s0SkillSha256: sha256Hex(scaffold.skillMd),
    b0EvidenceSha256: args.decision.b0EvidenceSha256,
    violationCategories: args.decision.violationCategories,
    sanitizedFailureCategories: sanitizedCategoryLines(args.decision.violationCategories),
    reportingNote:
      "rebuild-track: the original B0 is frozen as evidence and was never sent to a live proposer; this result is NOT a B0 direct improvement",
  };
}
