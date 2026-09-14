import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { findAdaptersForCapability } from "./adapterRegistry.js";
import { loadFrozenRuntimeContext } from "./frozenContext.js";
import { REFERENCE_TOOL_NAMES } from "./referenceAdapter.js";
import type { QualityPriorityRanking, SideEffectPolicy } from "../types.js";

// ── Skill-level doctor (V3 T02) ──────────────────────────────────
//
// Diagnoses which execution tier a bare skill directory can reach:
//   U0 local deterministic — SKILL.md readable, snapshot/fixture work
//   U1 controlled sandbox  — instruction/reference adapters
//   U2 allowlisted network — github (and future) adapters, URL allowlist required
//
// The doctor only reads files and hashes them: no provider, no tool,
// no network. Every rejection path carries a stable machine code.

export const DOCTOR_DECLARATION_FILENAME = "skillfoo.declaration.json";

/** Structural failures: the diagnosis itself cannot be produced. Exit code 2. */
export class DoctorError extends Error {
  readonly code: string;
  readonly exitCode: number;
  constructor(code: string, message: string, exitCode = 2) {
    super(`${code}: ${message}`);
    this.name = "DoctorError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

const SkillDeclarationSchema = z
  .object({
    capabilities: z.array(z.string().trim().min(1)).max(8).default([]),
    networkAllowlist: z.array(z.string().url()).default([]),
  })
  .strict();
type SkillDeclaration = z.infer<typeof SkillDeclarationSchema>;

export type ExecutionTierDiagnosis = "U0" | "U1" | "U2";

export interface AdapterRequirementStatus {
  capability: string;
  adapterId: string | null;
  executionTier: ExecutionTierDiagnosis | null;
  implementation: "implemented" | "contract-only" | "unsupported";
  satisfied: boolean;
}

export type DoctorBlockerCode =
  | "UNSUPPORTED_ADAPTER"
  | "ADAPTER_NOT_IMPLEMENTED"
  | "MISSING_RUNTIME_CONTEXT"
  | "MISSING_URL_ALLOWLIST";

export interface DoctorBlocker {
  code: DoctorBlockerCode;
  message: string;
  capability?: string;
  adapterId?: string;
}

export interface SuggestedTaskCard {
  suggestionsOnly: true;
  goal: string;
  scenarioHint: string;
  redlineHint: string;
  capabilityBoundary: {
    allowedCapabilities: string[];
    network: SideEffectPolicy;
    filesystem: SideEffectPolicy;
    externalActions: SideEffectPolicy;
  };
  qualityPriorities: QualityPriorityRanking;
}

export interface DoctorReport {
  schemaVersion: 3;
  createdAt: string;
  producer: { kind: "cli"; name: "skillfoo-doctor" };
  skillPath: string;
  skillMd: { found: true; bytes: number; sha256: string };
  declaredCapabilities: string[];
  networkAllowlist: string[];
  maxTier: ExecutionTierDiagnosis;
  readyToRun: boolean;
  needsAdapter: boolean;
  adapters: AdapterRequirementStatus[];
  blockers: DoctorBlocker[];
  runtimeContextPresent: boolean;
  runtimeContext?: {
    adapterId: "reference-v1";
    manifestSha256: string;
    entryCount: number;
    replayCount: number;
    allowedTools: readonly string[];
  };
  suggestedTaskCard: SuggestedTaskCard;
  humanSummary: string;
}

/** 0 = runnable now, 3 = diagnosed but blocked (DoctorError paths use exit 2). */
export function doctorExitCode(report: DoctorReport): number {
  return report.readyToRun ? 0 : 3;
}

const TIER_RANK: Record<ExecutionTierDiagnosis, number> = { U0: 0, U1: 1, U2: 2 };

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function firstGoalHint(markdown: string): string {
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = trimmed.match(/^#+\s+(.*)$/);
    const text = (heading ? heading[1] : trimmed).trim();
    if (text.length === 0) continue;
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  }
  return "";
}

function buildSuggestedTaskCard(
  markdown: string,
  capabilities: string[],
  allowlist: string[],
): SuggestedTaskCard {
  return {
    suggestionsOnly: true,
    goal: firstGoalHint(markdown),
    scenarioHint: "provide 2-3 real user requests the skill must handle",
    redlineHint: "provide 1-2 absolute must-nots (red lines)",
    capabilityBoundary: {
      allowedCapabilities: [...capabilities],
      network: allowlist.length > 0 ? "allowed" : "forbidden",
      filesystem: "forbidden",
      externalActions: "forbidden",
    },
    qualityPriorities: ["correctness", "evidence", "format", "speed", "cost"],
  };
}

function buildHumanSummary(
  maxTier: ExecutionTierDiagnosis,
  capabilities: string[],
  blockers: DoctorBlocker[],
): string {
  const parts: string[] = [`maxTier ${maxTier}: SKILL.md readable`];
  if (capabilities.length === 0) {
    parts.push("no capabilities declared, local deterministic U0 only");
  } else {
    parts.push(`${capabilities.length} capability(ies) declared`);
  }
  if (blockers.length > 0) {
    parts.push(`blockers: ${[...new Set(blockers.map((b) => b.code))].join(", ")}`);
  } else {
    parts.push("no blockers");
  }
  return `${parts.join("; ")}.`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Diagnose a bare skill directory (SKILL.md + optional declaration file).
 * Offline and side-effect free by construction: filesystem reads only.
 */
export async function diagnoseSkill(
  skillPath: string,
  options: { runtimeContextPath?: string } = {},
): Promise<DoctorReport> {
  const skillMdPath = join(skillPath, "SKILL.md");
  if (!(await fileExists(skillMdPath))) {
    throw new DoctorError("SKILL_NOT_FOUND", `no SKILL.md found under ${skillPath}`);
  }
  const skillMd = await readFile(skillMdPath, "utf8");
  if (skillMd.trim().length === 0) {
    throw new DoctorError("SKILL_EMPTY", "SKILL.md has no non-whitespace content");
  }

  let declaration: SkillDeclaration = { capabilities: [], networkAllowlist: [] };
  const declarationPath = join(skillPath, DOCTOR_DECLARATION_FILENAME);
  if (await fileExists(declarationPath)) {
    const raw = await readFile(declarationPath, "utf8");
    let parsedJson: unknown;
    try {
      // Windows editors commonly write a UTF-8 BOM; strip it before parsing.
      parsedJson = JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch {
      throw new DoctorError("INVALID_DECLARATION", `${DOCTOR_DECLARATION_FILENAME} is not valid JSON`);
    }
    const result = SkillDeclarationSchema.safeParse(parsedJson);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new DoctorError("INVALID_DECLARATION", `${DOCTOR_DECLARATION_FILENAME}: ${issues}`);
    }
    declaration = result.data;
  }

  const capabilities = [...new Set(declaration.capabilities)];
  const allowlist = declaration.networkAllowlist;
  const requiresRuntimeContext = capabilities.includes("reference");
  if (options.runtimeContextPath !== undefined && !requiresRuntimeContext) {
    throw new DoctorError(
      "RUNTIME_CONTEXT_NOT_APPLICABLE",
      "--runtime-context is accepted only for a skill that declares the reference capability",
    );
  }
  const loadedRuntimeContext = requiresRuntimeContext && options.runtimeContextPath
    ? await loadFrozenRuntimeContext(options.runtimeContextPath)
    : null;
  const runtimeContext = loadedRuntimeContext
    ? {
        adapterId: "reference-v1" as const,
        manifestSha256: loadedRuntimeContext.manifestSha256,
        entryCount: loadedRuntimeContext.manifest.entries.length,
        replayCount: loadedRuntimeContext.manifest.replays.length,
        allowedTools: REFERENCE_TOOL_NAMES,
      }
    : undefined;

  const adapters: AdapterRequirementStatus[] = [];
  const blockers: DoctorBlocker[] = [];
  let maxTier: ExecutionTierDiagnosis = "U0";

  for (const capability of capabilities) {
    const candidates = findAdaptersForCapability(capability);
    if (candidates.length === 0) {
      adapters.push({
        capability,
        adapterId: null,
        executionTier: null,
        implementation: "unsupported",
        satisfied: false,
      });
      blockers.push({
        code: "UNSUPPORTED_ADAPTER",
        capability,
        message: `capability "${capability}" is not provided by any registered adapter`,
      });
      continue;
    }
    const adapter = candidates[0];
    let tierCounts = true;
    let satisfied = true;
    if (adapter.implementation !== "implemented") {
      blockers.push({
        code: "ADAPTER_NOT_IMPLEMENTED",
        capability,
        adapterId: adapter.id,
        message: `adapter "${adapter.id}" is registered as ${adapter.implementation} in this build`,
      });
      satisfied = false;
    }
    if (adapter.id === "reference-v1" && runtimeContext === undefined) {
      blockers.push({
        code: "MISSING_RUNTIME_CONTEXT",
        capability,
        adapterId: adapter.id,
        message: "reference-v1 requires an explicit valid --runtime-context manifest",
      });
      satisfied = false;
    }
    if (adapter.executionTier === "U2" && allowlist.length === 0) {
      blockers.push({
        code: "MISSING_URL_ALLOWLIST",
        capability,
        adapterId: adapter.id,
        message: `U2 adapter "${adapter.id}" requires a non-empty networkAllowlist in ${DOCTOR_DECLARATION_FILENAME}`,
      });
      tierCounts = false;
      satisfied = false;
    }
    if (tierCounts && TIER_RANK[adapter.executionTier] > TIER_RANK[maxTier]) {
      maxTier = adapter.executionTier;
    }
    adapters.push({
      capability,
      adapterId: adapter.id,
      executionTier: adapter.executionTier,
      implementation: adapter.implementation,
      satisfied,
    });
  }

  const report: DoctorReport = {
    schemaVersion: 3,
    createdAt: new Date().toISOString(),
    producer: { kind: "cli", name: "skillfoo-doctor" },
    skillPath,
    skillMd: {
      found: true,
      bytes: Buffer.byteLength(skillMd, "utf8"),
      sha256: sha256Hex(skillMd),
    },
    declaredCapabilities: capabilities,
    networkAllowlist: allowlist,
    maxTier,
    readyToRun: blockers.length === 0,
    needsAdapter: capabilities.length > 0,
    adapters,
    blockers,
    runtimeContextPresent: runtimeContext !== undefined,
    ...(runtimeContext ? { runtimeContext } : {}),
    suggestedTaskCard: buildSuggestedTaskCard(skillMd, capabilities, allowlist),
    humanSummary: buildHumanSummary(maxTier, capabilities, blockers),
  };
  return report;
}
