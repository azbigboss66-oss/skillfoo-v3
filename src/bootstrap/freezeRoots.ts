import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  RootFreezeSchema,
  type Producer,
  type RootFileEntry,
  type RootFileStatus,
  type RootFreeze,
  type SkillRootKind,
} from "../types.js";

export class RootFreezeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RootFreezeError";
  }
}

const ROOT_KNOWN_TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".json",
  ".txt",
  ".yaml",
  ".yml",
  ".csv",
]);

const ROOT_DANGEROUS_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".com",
  ".scr",
  ".msi",
  ".bat",
  ".cmd",
  ".ps1",
  ".sh",
  ".bash",
  ".vbs",
  ".js",
  ".mjs",
  ".cjs",
  ".py",
  ".jar",
]);

/** The only paths a bootstrap patch may modify inside a frozen root. */
export const ROOT_EDITABLE_FILES = ["SKILL.md"] as const;

/** Recursively enumerate ordinary files without following links. */
async function listRootFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (currentDir: string): Promise<void> => {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new RootFreezeError(
          "ROOT_SYMLINK_REJECTED",
          `the frozen root contains a symlink at ${fullPath}; links are never followed`,
        );
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(relative(rootDir, fullPath).replace(/\\/g, "/"));
      }
    }
  };
  await walk(rootDir);
  return files.sort();
}

function classifyFile(path: string): RootFileStatus {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  if (ROOT_DANGEROUS_EXTENSIONS.has(ext)) return "skipped-dangerous";
  if (ROOT_KNOWN_TEXT_EXTENSIONS.has(ext)) return "recorded";
  return "skipped-unknown";
}

/**
 * Reproducible content digest of a frozen root: SHA-256 over
 * `path:sha256:status` lines in lexical path order. Timestamps and the
 * root's on-disk location are excluded, so identical content always
 * hashes identically regardless of where the directory lives.
 */
export function rootFreezeDigest(files: RootFileEntry[]): string {
  const input = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => `${file.path}:${file.sha256}:${file.status}`)
    .join("\n");
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Freeze a skill directory into a read-only root record. Every file is
 * hashed and classified; unknown or dangerous files are recorded with
 * their hash but marked skipped — they are never copied into candidates
 * or used as template content. The freeze itself only reads.
 */
export async function freezeRoot(args: {
  skillDir: string;
  kind: SkillRootKind;
  source: string;
  producer?: Producer;
}): Promise<RootFreeze> {
  const paths = await listRootFiles(args.skillDir);
  if (!paths.includes("SKILL.md")) {
    throw new RootFreezeError(
      "ROOT_SKILL_MD_MISSING",
      `the skill directory ${args.skillDir} has no SKILL.md; a root must start from one`,
    );
  }
  const files: RootFileEntry[] = [];
  for (const path of paths) {
    const content = await readFile(join(args.skillDir, path));
    files.push({
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.byteLength,
      status: classifyFile(path),
    });
  }
  return RootFreezeSchema.parse({
    schemaVersion: 3,
    createdAt: new Date().toISOString(),
    producer: args.producer ?? { kind: "cli", name: "bootstrap-freeze" },
    kind: args.kind,
    rootDir: args.skillDir,
    source: args.source,
    rootHash: rootFreezeDigest(files),
    files,
  });
}

/** Re-freeze the root's directory and verify its hash did not move. */
export async function assertRootUnchanged(freeze: RootFreeze): Promise<void> {
  const recheck = await freezeRoot({
    skillDir: freeze.rootDir,
    kind: freeze.kind,
    source: freeze.source,
  });
  if (recheck.rootHash !== freeze.rootHash) {
    throw new RootFreezeError(
      "ROOT_CHANGED",
      `root ${freeze.kind} at ${freeze.rootDir} changed after freezing (${freeze.rootHash.slice(0, 12)} -> ${recheck.rootHash.slice(0, 12)}); frozen roots are read-only`,
    );
  }
}

/**
 * Copy a frozen root into a fresh target directory and apply a bounded
 * patch on top. Only `recorded` files are copied — quarantined files
 * never leave the root — and patch paths are restricted to
 * ROOT_EDITABLE_FILES. The root directory itself is never written to:
 * all writes land inside targetDir, which must live outside the root.
 */
export async function materializeCandidate(args: {
  root: RootFreeze;
  files: Array<{ path: string; content: string }>;
  targetDir: string;
}): Promise<void> {
  const { root, files, targetDir } = args;
  for (const file of files) {
    if (!(ROOT_EDITABLE_FILES as readonly string[]).includes(file.path)) {
      throw new RootFreezeError(
        "ROOT_PATCH_PATH_LOCKED",
        `patch path "${file.path}" is locked; bootstrap patches may only modify ${ROOT_EDITABLE_FILES.join(", ")}`,
      );
    }
    const entry = root.files.find((candidate) => candidate.path === file.path);
    if (!entry || entry.status !== "recorded") {
      throw new RootFreezeError(
        "ROOT_PATCH_TARGET_MISSING",
        `patch path "${file.path}" is not a recorded file of root ${root.rootHash.slice(0, 12)}`,
      );
    }
  }

  const absoluteRoot = resolve(root.rootDir);
  const absoluteTarget = resolve(targetDir);
  const targetRelativeToRoot = relative(absoluteRoot, absoluteTarget);
  const targetInsideRoot =
    targetRelativeToRoot !== "" &&
    !targetRelativeToRoot.startsWith("..") &&
    !isAbsolute(targetRelativeToRoot);
  if (targetInsideRoot) {
    throw new RootFreezeError(
      "ROOT_TARGET_INSIDE_ROOT",
      `candidate target ${absoluteTarget} lies inside the frozen root ${absoluteRoot}; candidates must be materialized outside the root`,
    );
  }

  await mkdir(absoluteTarget, { recursive: true });
  for (const entry of root.files) {
    if (entry.status !== "recorded") continue;
    const destination = join(absoluteTarget, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(absoluteRoot, entry.path), destination);
  }
  for (const file of files) {
    await writeFile(join(absoluteTarget, file.path), file.content, "utf-8");
  }
}
