import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename as fsRename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { freezeRoot } from "./freezeRoots.js";
import { assertNoPrivilegeEscalation, createScaffold, forbiddenToolViolations } from "./createScaffold.js";
import {
  BootstrapBundleSchema,
  BootstrapCandidateSchema,
  type AdapterDeclaration,
  type BootstrapBundle,
  type BootstrapCandidate,
  type BootstrapLaneError,
  type BootstrapLaneResult,
  type EvaluationContractV3,
  type Producer,
  type TaskCard,
} from "../types.js";
import { taskCardContentSha256 } from "../intake/taskCard.js";

export class BootstrapError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BootstrapError";
  }
}

export interface B0RepairContext {
  b0SkillMd: string;
  taskCard: TaskCard;
  contract: EvaluationContractV3;
}

export interface BootstrapProposer {
  producer: Producer;
  proposeB0Repair(context: B0RepairContext): Promise<{ hypothesis: string; skillMd: string }>;
}

/** Offline deterministic proposer used only to build a user-facing B0 fixture candidate. */
export function createFixtureBootstrapProposer(): BootstrapProposer {
  return {
    producer: { kind: "fixture", name: "bootstrap-fixture-b0-repair" },
    async proposeB0Repair(context) {
      const boundary = context.taskCard.capabilityBoundary;
      const lines = [
        "",
        "## Capability limits",
        "",
        `- Goal: ${context.taskCard.goal}`,
        `- Allowed capabilities: ${boundary.allowedCapabilities.join(", ")}`,
        `- Network access: ${boundary.network}.`,
        `- Filesystem access: ${boundary.filesystem}.`,
        `- External actions: ${boundary.externalActions}.`,
        "",
      ];
      for (const redline of context.taskCard.redlines) {
        lines.push(`- Red line: ${redline}`);
      }
      lines.push("");
      return {
        hypothesis:
          "state the approved capability limits and red lines without adding execution surfaces",
        skillMd: `${context.b0SkillMd}\n${lines.join("\n")}`,
      };
    },
  };
}

function laneError(error: unknown): BootstrapLaneError {
  if (error instanceof BootstrapError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "BOOTSTRAP_LANE_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

export interface RunBootstrapArgs {
  skillDir: string;
  taskCard: TaskCard;
  contract: EvaluationContractV3;
  adapter: AdapterDeclaration;
  s0Dir: string;
  proposer?: BootstrapProposer;
  provider?: string;
  release?: boolean;
  producer?: Producer;
}

export interface RunBootstrapResult {
  bundle: BootstrapBundle;
}

/**
 * Dual-root bootstrap round 1 (zero-network fixture provider):
 *
 * 1. freeze B0 read-only — unknown/dangerous files are recorded, never
 *    executed;
 * 2. scaffold S0 from the confirmation-governed intent charter + contract hashes +
 *    adapter template (zero B0 content) and freeze it;
 * 3. run the two lanes independently — one bounded b0-repair candidate
 *    and one s0-scaffold candidate, both bound to the same frozen
 *    contract; a failing lane never deletes the other;
 * 4. refuse release and any non-fixture provider outright (T13 gates
 *    real runs).
 */
export async function runBootstrap(args: RunBootstrapArgs): Promise<RunBootstrapResult> {
  if (taskCardContentSha256(args.taskCard) !== args.contract.taskCardHash) {
    throw new BootstrapError(
      "BOOTSTRAP_TASK_CARD_HASH_MISMATCH",
      "the supplied Task Card content differs from the hash frozen into the evaluation contract",
    );
  }
  if (args.taskCard.confirmation.status !== "confirmed") {
    throw new BootstrapError(
      "BOOTSTRAP_TASK_CARD_NOT_CONFIRMED",
      "bootstrap requires a confirmed task card; run intake --confirm first",
    );
  }
  if (
    args.contract.confirmationMode !== "human" &&
    args.contract.confirmationMode !== "test-fixture"
  ) {
    throw new BootstrapError(
      "BOOTSTRAP_CONFIRMATION_MODE_UNSUPPORTED",
      "bootstrap requires a human-confirmed formal contract or a zero-network test fixture contract",
    );
  }
  if (args.taskCard.confirmation.confirmationMode !== args.contract.confirmationMode) {
    throw new BootstrapError(
      "BOOTSTRAP_CONFIRMATION_MODE_MISMATCH",
      "Task Card and frozen contract confirmation modes must match",
    );
  }
  if (args.release) {
    throw new BootstrapError(
      "BOOTSTRAP_RELEASE_FORBIDDEN",
      "bootstrap round 1 is fixture/dry-run only; release requires explicit T13 authorization",
    );
  }
  if ((args.provider ?? "fixture") !== "fixture") {
    throw new BootstrapError(
      "BOOTSTRAP_PROVIDER_UNAUTHORIZED",
      `provider mode "${args.provider}" is not authorized; only "fixture" runs without T13 authorization`,
    );
  }
  if (args.contract.adapterId !== args.adapter.id) {
    throw new BootstrapError(
      "BOOTSTRAP_ADAPTER_MISMATCH",
      `the contract binds adapter "${args.contract.adapterId}" but bootstrap was given "${args.adapter.id}"`,
    );
  }

  const proposer = args.proposer ?? createFixtureBootstrapProposer();
  const boundary = args.taskCard.capabilityBoundary;

  const b0 = await freezeRoot({
    skillDir: args.skillDir,
    kind: "b0",
    source: "operator-supplied rough skill directory (read-only freeze)",
  });

  const scaffold = createScaffold({
    taskCard: args.taskCard,
    contract: args.contract,
    adapter: args.adapter,
  });
  await mkdir(args.s0Dir, { recursive: true });
  await writeFile(join(args.s0Dir, "SKILL.md"), scaffold.skillMd, "utf-8");
  const s0 = await freezeRoot({
    skillDir: args.s0Dir,
    kind: "s0",
    source:
      "scaffolded from frozen complete intent charter + frozen contract hashes + adapter template (no B0 or test content)",
    producer: { kind: "cli", name: "bootstrap-scaffold" },
  });

  const createdAt = new Date().toISOString();
  const makeCandidate = (fields: {
    lane: "b0-repair" | "s0-scaffold";
    originRoot: "b0" | "s0";
    origin: "b0-repair" | "s0-scaffold";
    parentRootHash: string;
    producer: Producer;
    hypothesis: string;
    files: Array<{ path: string; content: string }>;
  }): BootstrapCandidate =>
    BootstrapCandidateSchema.parse({
      schemaVersion: 3,
      createdAt,
      producer: fields.producer,
      lane: fields.lane,
      originRoot: fields.originRoot,
      origin: fields.origin,
      contractSha256: args.contract.contractSha256,
      parentRootHash: fields.parentRootHash,
      hypothesis: fields.hypothesis,
      files: fields.files,
    }) as BootstrapCandidate;

  let b0Lane: BootstrapLaneResult;
  try {
    const b0SkillMd = await readFile(join(args.skillDir, "SKILL.md"), "utf-8");
    const proposal = await proposer.proposeB0Repair({
      b0SkillMd,
      taskCard: args.taskCard,
      contract: args.contract,
    });
    if (!proposal.hypothesis?.trim() || !proposal.skillMd?.trim()) {
      throw new BootstrapError(
        "BOOTSTRAP_PROPOSAL_INVALID",
        "the b0-repair proposer must return a non-empty hypothesis and SKILL.md content",
      );
    }
    if (proposal.skillMd === b0SkillMd) {
      throw new BootstrapError(
        "BOOTSTRAP_PROPOSAL_NOOP",
        "the b0-repair candidate must differ from B0's SKILL.md",
      );
    }
    const existing = new Set(forbiddenToolViolations(b0SkillMd, boundary));
    const introduced = forbiddenToolViolations(proposal.skillMd, boundary).filter(
      (violation) => !existing.has(violation),
    );
    if (introduced.length > 0) {
      throw new BootstrapError(
        "BOOTSTRAP_PRIVILEGE_ESCALATION",
        `the b0-repair candidate introduces ${introduced.length} forbidden-tool line(s) beyond B0's own surface: first violation ${introduced[0]}`,
      );
    }
    b0Lane = {
      lane: "b0-repair",
      status: "ok",
      candidate: makeCandidate({
        lane: "b0-repair",
        originRoot: "b0",
        origin: "b0-repair",
        parentRootHash: b0.rootHash,
        producer: proposer.producer,
        hypothesis: proposal.hypothesis,
        files: [{ path: "SKILL.md", content: proposal.skillMd }],
      }),
    };
  } catch (error) {
    b0Lane = { lane: "b0-repair", status: "failed", error: laneError(error) };
  }

  let s0Lane: BootstrapLaneResult;
  try {
    assertNoPrivilegeEscalation(scaffold.skillMd, boundary, "s0-scaffold candidate");
    s0Lane = {
      lane: "s0-scaffold",
      status: "ok",
      candidate: makeCandidate({
        lane: "s0-scaffold",
        originRoot: "s0",
        origin: "s0-scaffold",
        parentRootHash: s0.rootHash,
        producer: { kind: "cli", name: "bootstrap-scaffold" },
        hypothesis: `scaffolded S0 from the frozen complete intent charter and contract hashes via adapter ${args.adapter.id}; no B0 or exact test content inherited`,
        files: [{ path: "SKILL.md", content: scaffold.skillMd }],
      }),
    };
  } catch (error) {
    s0Lane = { lane: "s0-scaffold", status: "failed", error: laneError(error) };
  }

  const bundle = BootstrapBundleSchema.parse({
    schemaVersion: 3,
    createdAt,
    producer: args.producer ?? { kind: "cli", name: "skillfoo-bootstrap" },
    contractSha256: args.contract.contractSha256,
    provider: "fixture",
    dryRun: true,
    b0,
    s0,
    lanes: [b0Lane, s0Lane],
  });
  return { bundle };
}

type FormalBootstrapRename = (source: string, target: string) => Promise<void>;

export interface RunFormalBootstrapArgs extends Omit<RunBootstrapArgs, "s0Dir"> {
  /** Existing, separately approved formal-evidence directory. */
  formalDir: string;
  /** Must be exactly <formalDir>/bootstrap. */
  outDir: string;
  /** Narrow commit seam used only to prove rollback in a deterministic test. */
  commitRename?: FormalBootstrapRename;
}

const FORMAL_BOOTSTRAP_STAGE_PREFIX = ".formal-bootstrap-tmp-";
const FORMAL_BOOTSTRAP_FORBIDDEN_PROPERTY_KEYS = new Set([
  "judgingrule",
  "expectedoutcome",
  "holdoutinput",
  "holdoutitems",
  "holdoutpayload",
  "holdoutbody",
  "holdoutcontent",
  "holdoutfile",
  "sealedpayload",
  "sealeditems",
  "sealedinput",
  "sealedbody",
  "sealedcontent",
]);

const FORMAL_BOOTSTRAP_FORBIDDEN_CONTAINER_KEYS = new Set([
  "holdout",
  "evaluationholdout",
  "sealed",
]);

const FORMAL_BOOTSTRAP_PATH_PROPERTY_KEYS = new Set([
  "path",
  "rootdir",
  "source",
  "filename",
  "uri",
  "location",
  "directory",
  "dir",
]);

function normalizedPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function assertSamePath(actual: string, expected: string, code: string, label: string): void {
  if (normalizedPath(actual) !== normalizedPath(expected)) {
    throw new BootstrapError(code, `${label} must be exactly ${resolve(expected)}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Reject symlinks and Windows junctions in every existing path component. */
async function assertNoLinkedPathComponents(path: string, code: string, label: string): Promise<void> {
  const absolute = resolve(path);
  const chain: string[] = [];
  let cursor = absolute;
  while (true) {
    chain.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const component of chain.reverse()) {
    let metadata;
    try {
      metadata = await lstat(component);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new BootstrapError(code, `${label} may not traverse a symbolic link or junction (${component})`);
    }
  }
  if (await pathExists(absolute)) {
    const canonical = await realpath(absolute);
    if (normalizedPath(canonical) !== normalizedPath(absolute)) {
      throw new BootstrapError(code, `${label} may not resolve through a symbolic link or junction`);
    }
  }
}

/**
 * Read exactly one regular SKILL.md. Directory enumeration is completed and
 * rejected before any file body is opened, so an extra holdout file is never
 * sampled merely to diagnose a bad B0 scope.
 */
async function readExactSkillBytes(args: {
  dir: string;
  code: string;
  label: string;
}): Promise<Buffer> {
  await assertNoLinkedPathComponents(args.dir, args.code, args.label);
  let entries;
  try {
    entries = await readdir(args.dir, { withFileTypes: true });
  } catch (error) {
    throw new BootstrapError(
      args.code,
      `${args.label} is not a readable directory (${(error as NodeJS.ErrnoException).code ?? "IO_ERROR"})`,
    );
  }
  if (
    entries.length !== 1 ||
    entries[0]?.name !== "SKILL.md" ||
    !entries[0].isFile() ||
    entries[0].isSymbolicLink()
  ) {
    throw new BootstrapError(args.code, `${args.label} must contain exactly one regular SKILL.md`);
  }
  const skillPath = join(args.dir, "SKILL.md");
  const metadata = await lstat(skillPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new BootstrapError(args.code, `${args.label}/SKILL.md must be a regular file`);
  }
  return readFile(skillPath);
}

function assertSingleRecordedSkill(bundle: BootstrapBundle, root: "b0" | "s0"): void {
  const files = bundle[root].files;
  if (
    files.length !== 1 ||
    files[0]?.path !== "SKILL.md" ||
    files[0].status !== "recorded"
  ) {
    throw new BootstrapError(
      `FORMAL_BOOTSTRAP_${root.toUpperCase()}_SCOPE_INVALID`,
      `${root.toUpperCase()} must freeze exactly one recorded SKILL.md`,
    );
  }
}

function containsHoldoutPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(?:evaluation-)?holdout(?:\.v3)?(?:\.json)?(?:$|\/)/.test(normalized);
}

function isOrdinaryCandidateFreeText(
  parent: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean {
  if (typeof value !== "string") return false;
  if (key === "content" && parent.path === "SKILL.md") return true;
  return key === "hypothesis" || key === "patch" || key === "reasoning";
}

/**
 * Inspect provenance-bearing JSON structure rather than keyword-scanning the
 * serialized bundle. Candidate SKILL/patch/reasoning prose is intentionally
 * opaque; sensitive property keys, holdout-shaped payloads and metadata paths
 * remain forbidden.
 */
export function assertFormalBootstrapBundleIsolation(value: unknown): void {
  const visit = (current: unknown, path: string[]): void => {
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, [...path, String(index)]));
      return;
    }
    if (current === null || typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    if (typeof record.split === "string" && record.split.toLowerCase() === "holdout") {
      throw new BootstrapError(
        "FORMAL_BOOTSTRAP_SEALED_STRUCTURE_FORBIDDEN",
        `formal bootstrap bundle contains a holdout-shaped payload at ${path.join(".") || "(root)"}`,
      );
    }
    for (const [key, child] of Object.entries(record)) {
      const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
      if (FORMAL_BOOTSTRAP_FORBIDDEN_PROPERTY_KEYS.has(normalizedKey)) {
        throw new BootstrapError(
          "FORMAL_BOOTSTRAP_SEALED_STRUCTURE_FORBIDDEN",
          `formal bootstrap bundle contains forbidden property ${[...path, key].join(".")}`,
        );
      }
      if (
        FORMAL_BOOTSTRAP_FORBIDDEN_CONTAINER_KEYS.has(normalizedKey) &&
        child !== null &&
        typeof child === "object"
      ) {
        throw new BootstrapError(
          "FORMAL_BOOTSTRAP_SEALED_STRUCTURE_FORBIDDEN",
          `formal bootstrap bundle contains forbidden sealed container ${[...path, key].join(".")}`,
        );
      }
      if (isOrdinaryCandidateFreeText(record, key, child)) continue;
      if (
        typeof child === "string" &&
        FORMAL_BOOTSTRAP_PATH_PROPERTY_KEYS.has(normalizedKey) &&
        containsHoldoutPath(child)
      ) {
        throw new BootstrapError(
          "FORMAL_BOOTSTRAP_SEALED_PATH_FORBIDDEN",
          `formal bootstrap metadata contains a holdout path at ${[...path, key].join(".")}`,
        );
      }
      visit(child, [...path, key]);
    }
  };
  visit(value, []);
}

function assertSafeStagePath(stageDir: string, formalDir: string): void {
  const stageRelative = relative(resolve(formalDir), resolve(stageDir));
  if (
    stageRelative.startsWith("..") ||
    stageRelative.includes("/") ||
    stageRelative.includes("\\") ||
    !stageRelative.startsWith(FORMAL_BOOTSTRAP_STAGE_PREFIX)
  ) {
    throw new BootstrapError(
      "FORMAL_BOOTSTRAP_STAGE_PATH_INVALID",
      "refusing to clean a path outside the exact formal bootstrap staging slot",
    );
  }
}

async function removeFormalBootstrapStage(stageDir: string, formalDir: string): Promise<void> {
  assertSafeStagePath(stageDir, formalDir);
  await rm(stageDir, { recursive: true, force: true });
}

/**
 * Commit a self-contained formal B0/S0/bootstrap identity without changing the
 * legacy development bootstrap layout. The two final sibling renames are
 * rollback-protected, but intentionally make no power-loss atomicity claim.
 */
export async function runFormalBootstrap(args: RunFormalBootstrapArgs): Promise<RunBootstrapResult> {
  const formalDir = resolve(args.formalDir);
  const sourceSkillDir = resolve(args.skillDir);
  const outDir = resolve(args.outDir);
  const finalB0Dir = join(formalDir, "b0-source");
  const expectedSourceDir = join(dirname(formalDir), "b0-source");
  const expectedOutDir = join(formalDir, "bootstrap");

  if (args.contract.confirmationMode !== "human" && args.contract.confirmationMode !== "test-fixture") {
    throw new BootstrapError(
      "FORMAL_BOOTSTRAP_CONFIRMATION_MODE_INVALID",
      "the self-contained formal bootstrap accepts only a separately approved human or temporary test-fixture contract",
    );
  }

  assertSamePath(
    sourceSkillDir,
    expectedSourceDir,
    "FORMAL_BOOTSTRAP_SOURCE_PATH_INVALID",
    "formal bootstrap source",
  );
  assertSamePath(
    outDir,
    expectedOutDir,
    "FORMAL_BOOTSTRAP_OUTPUT_PATH_INVALID",
    "formal bootstrap output",
  );
  await assertNoLinkedPathComponents(formalDir, "FORMAL_BOOTSTRAP_FORMAL_PATH_LINKED", "formal lane");
  const sourceBytes = await readExactSkillBytes({
    dir: sourceSkillDir,
    code: "FORMAL_BOOTSTRAP_SOURCE_SCOPE_INVALID",
    label: "formal B0 source",
  });

  let b0AlreadyPresent = false;
  if (await pathExists(finalB0Dir)) {
    const existingBytes = await readExactSkillBytes({
      dir: finalB0Dir,
      code: "FORMAL_BOOTSTRAP_EXISTING_B0_SCOPE_DRIFT",
      label: "existing formal B0",
    });
    if (!existingBytes.equals(sourceBytes)) {
      throw new BootstrapError(
        "FORMAL_BOOTSTRAP_EXISTING_B0_HASH_DRIFT",
        "existing formal B0 differs byte-for-byte from the approved source; refusing before writes",
      );
    }
    b0AlreadyPresent = true;
  }
  if (await pathExists(outDir)) {
    throw new BootstrapError(
      "FORMAL_BOOTSTRAP_OUTPUT_EXISTS",
      `refusing to overwrite the existing formal bootstrap at ${outDir}`,
    );
  }

  const stageDir = join(formalDir, `${FORMAL_BOOTSTRAP_STAGE_PREFIX}${randomUUID()}`);
  const stageB0Dir = join(stageDir, "b0-source");
  const stageBootstrapDir = join(stageDir, "bootstrap");
  const stageS0Dir = join(stageBootstrapDir, "s0");
  const commitRename = args.commitRename ?? fsRename;
  let committedB0ThisRun = false;
  let committedBootstrapThisRun = false;

  try {
    await mkdir(stageB0Dir, { recursive: true });
    await writeFile(join(stageB0Dir, "SKILL.md"), sourceBytes);
    const staged = await runBootstrap({
      ...args,
      skillDir: stageB0Dir,
      s0Dir: stageS0Dir,
    });
    const reboundBundle = {
      ...staged.bundle,
      b0: { ...staged.bundle.b0, rootDir: finalB0Dir },
      s0: { ...staged.bundle.s0, rootDir: join(outDir, "s0") },
    };
    assertFormalBootstrapBundleIsolation(reboundBundle);
    const bundle = BootstrapBundleSchema.parse(reboundBundle) as BootstrapBundle;
    assertSingleRecordedSkill(bundle, "b0");
    assertSingleRecordedSkill(bundle, "s0");

    const [stagedB0, stagedS0] = await Promise.all([
      freezeRoot({ skillDir: stageB0Dir, kind: "b0", source: "formal bootstrap staged B0 verification" }),
      freezeRoot({ skillDir: stageS0Dir, kind: "s0", source: "formal bootstrap staged S0 verification" }),
    ]);
    if (stagedB0.rootHash !== bundle.b0.rootHash || stagedS0.rootHash !== bundle.s0.rootHash) {
      throw new BootstrapError(
        "FORMAL_BOOTSTRAP_STAGED_ROOT_DRIFT",
        "staged B0 or S0 no longer matches the bundle prepared for commit",
      );
    }
    const bundleText = `${JSON.stringify(bundle, null, 2)}\n`;
    await writeFile(join(stageBootstrapDir, "bootstrap-bundle.v3.json"), bundleText, "utf8");

    if (!b0AlreadyPresent) {
      await commitRename(stageB0Dir, finalB0Dir);
      committedB0ThisRun = true;
    }
    await commitRename(stageBootstrapDir, outDir);
    committedBootstrapThisRun = true;
    await removeFormalBootstrapStage(stageDir, formalDir);
    return { bundle };
  } catch (error) {
    if (committedBootstrapThisRun && (await pathExists(outDir))) {
      await rm(outDir, { recursive: true, force: true });
    }
    if (committedB0ThisRun && (await pathExists(finalB0Dir))) {
      await rm(finalB0Dir, { recursive: true, force: true });
    }
    await removeFormalBootstrapStage(stageDir, formalDir);
    throw error;
  }
}
