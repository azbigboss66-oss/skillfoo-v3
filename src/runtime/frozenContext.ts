import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { stableStringify } from "../intake/taskCard.js";
import { AdapterError, DEFAULT_MAX_RESPONSE_BYTES } from "./capabilityAdapter.js";

export const REFERENCE_ADAPTER_ID = "reference-v1";
export const RUNTIME_CONTEXT_SCHEMA_VERSION = 1;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const LogicalIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._-]*$/);

export const FrozenContextEntrySchema = z
  .object({
    id: LogicalIdSchema,
    kind: z.enum(["reference", "attachment"]),
    path: z.string().min(1),
    mediaType: z.enum(["text/markdown", "text/plain", "application/json", "text/csv"]),
    sha256: Sha256Schema,
  })
  .strict();

export const FrozenContextReplaySchema = z
  .object({
    id: LogicalIdSchema,
    tool: z.string().regex(/^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/),
    request: z.record(z.unknown()),
    responsePath: z.string().min(1),
    responseSha256: Sha256Schema,
  })
  .strict();

export const FrozenRuntimeContextManifestSchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_CONTEXT_SCHEMA_VERSION),
    adapterId: z.literal(REFERENCE_ADAPTER_ID),
    entries: z.array(FrozenContextEntrySchema),
    replays: z.array(FrozenContextReplaySchema),
    manifestSha256: Sha256Schema,
  })
  .strict();

export type FrozenContextEntry = z.infer<typeof FrozenContextEntrySchema>;
export type FrozenContextReplay = z.infer<typeof FrozenContextReplaySchema>;
export type FrozenRuntimeContextManifest = z.infer<typeof FrozenRuntimeContextManifestSchema>;

export type FrozenContextErrorCode =
  | "FROZEN_CONTEXT_REQUIRED"
  | "FROZEN_CONTEXT_MANIFEST_INVALID"
  | "FROZEN_CONTEXT_PATH_ESCAPE"
  | "FROZEN_CONTEXT_SYMLINK_REJECTED"
  | "FROZEN_CONTEXT_HASH_MISMATCH"
  | "FROZEN_CONTEXT_SEALED_PATH_FORBIDDEN"
  | "FROZEN_CONTEXT_TOOL_UNDECLARED"
  | "FROZEN_CONTEXT_TOOL_ARGUMENT_INVALID"
  | "FROZEN_CONTEXT_REPLAY_MISMATCH"
  | "FROZEN_CONTEXT_RESPONSE_TOO_LARGE"
  | "FROZEN_CONTEXT_RECORD_MODE_FORBIDDEN";

export class FrozenContextError extends AdapterError {
  declare readonly code: FrozenContextErrorCode;

  constructor(code: FrozenContextErrorCode, message: string) {
    super(code, message);
    this.name = "FrozenContextError";
    this.code = code;
  }
}

const CANDIDATE_TOOL_REQUEST_ERROR_CODES: readonly FrozenContextErrorCode[] = [
  "FROZEN_CONTEXT_TOOL_UNDECLARED",
  "FROZEN_CONTEXT_TOOL_ARGUMENT_INVALID",
  "FROZEN_CONTEXT_REPLAY_MISMATCH",
];

/** True only when a frozen-context failure is owned by the candidate's tool request. */
export function isFrozenContextCandidateToolRequestError(
  error: unknown,
): error is FrozenContextError {
  return error instanceof FrozenContextError &&
    CANDIDATE_TOOL_REQUEST_ERROR_CODES.includes(error.code);
}

export interface LoadedFrozenRuntimeContext {
  readonly manifest: FrozenRuntimeContextManifest;
  readonly manifestSha256: string;
  readonly rootDir: string;
}

export interface FrozenContextPayload {
  readonly value: unknown;
  readonly text: string;
  readonly contentSha256: string;
}

export async function readFrozenContextEntry(
  context: LoadedFrozenRuntimeContext,
  id: string,
  kind: FrozenContextEntry["kind"],
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<FrozenContextPayload> {
  const entry = context.manifest.entries.find((candidate) => candidate.id === id);
  if (!entry || entry.kind !== kind) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_TOOL_ARGUMENT_INVALID",
      `${kind}.read id is not declared for that entry kind`,
    );
  }
  return readVerifiedPayload({
    rootDir: context.rootDir,
    relativePath: entry.path,
    expectedSha256: entry.sha256,
    mediaType: entry.mediaType,
    label: `entry ${entry.id}`,
    maxResponseBytes,
  });
}

export async function readFrozenContextReplay(
  context: LoadedFrozenRuntimeContext,
  id: string,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<{ replay: FrozenContextReplay; payload: FrozenContextPayload }> {
  const replay = getFrozenContextReplay(context, id);
  return {
    replay,
    payload: await readVerifiedPayload({
      rootDir: context.rootDir,
      relativePath: replay.responsePath,
      expectedSha256: replay.responseSha256,
      label: `replay ${replay.id}`,
      maxResponseBytes,
    }),
  };
}

export function getFrozenContextReplay(
  context: LoadedFrozenRuntimeContext,
  id: string,
): FrozenContextReplay {
  const replay = context.manifest.replays.find((candidate) => candidate.id === id);
  if (!replay) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_TOOL_ARGUMENT_INVALID",
      "tool.replay id is not declared in the frozen runtime context",
    );
  }
  return replay;
}

export function runtimeContextManifestContentSha256(
  manifest: FrozenRuntimeContextManifest,
): string {
  const { manifestSha256: _manifestSha256, ...content } = manifest;
  return createHash("sha256").update(stableStringify(content), "utf8").digest("hex");
}

function normalizedFilesystemPath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathEscapes(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel);
}

function hasSealedPathComponent(path: string): boolean {
  return path
    .split(/[\\/]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase())
    .some((part) =>
      part === "sealed" ||
      part.startsWith("sealed-") ||
      part.endsWith("-sealed") ||
      /(^|[-_.])holdout(?:[-_.]|$)/.test(part),
    );
}

function assertPortableRelativePath(path: string, label: string): void {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    isAbsolute(path) ||
    /^[a-zA-Z]:/.test(path) ||
    path.startsWith("//")
  ) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_PATH_ESCAPE",
      `${label} must be a non-empty portable relative path`,
    );
  }
  const parts = path.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_PATH_ESCAPE",
      `${label} contains a forbidden path component`,
    );
  }
  if (hasSealedPathComponent(path)) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_SEALED_PATH_FORBIDDEN",
      `${label} points at a sealed or holdout-shaped path`,
    );
  }
}

function assertSupportedTextPath(path: string, label: string): void {
  const supported = new Set([".md", ".markdown", ".txt", ".json", ".csv"]);
  if (!supported.has(extname(path).toLowerCase())) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_MANIFEST_INVALID",
      `${label} must use a supported UTF-8 text extension`,
    );
  }
}

function assertMediaTypeMatchesPath(entry: FrozenContextEntry): void {
  const extension = extname(entry.path).toLowerCase();
  const allowedByMediaType: Record<FrozenContextEntry["mediaType"], readonly string[]> = {
    "text/markdown": [".md", ".markdown"],
    "text/plain": [".txt"],
    "application/json": [".json"],
    "text/csv": [".csv"],
  };
  if (!allowedByMediaType[entry.mediaType].includes(extension)) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_MANIFEST_INVALID",
      `entry ${entry.id} mediaType does not match its file extension`,
    );
  }
}

async function assertRegularFileWithinRoot(
  rootDir: string,
  relativePath: string,
  label: string,
): Promise<void> {
  const absoluteRoot = resolve(rootDir);
  let rootMetadata;
  try {
    rootMetadata = await lstat(absoluteRoot);
  } catch {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_MANIFEST_INVALID",
      "the frozen context root is not readable",
    );
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_SYMLINK_REJECTED",
      "the frozen context root may not be a symbolic link or junction",
    );
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(absoluteRoot);
  } catch {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_MANIFEST_INVALID",
      "the frozen context root cannot be resolved safely",
    );
  }
  if (normalizedFilesystemPath(canonicalRoot) !== normalizedFilesystemPath(absoluteRoot)) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_SYMLINK_REJECTED",
      "the frozen context root may not resolve through a symbolic link or junction",
    );
  }

  let cursor = absoluteRoot;
  for (const part of relativePath.split("/")) {
    cursor = resolve(cursor, part);
    if (pathEscapes(absoluteRoot, cursor)) {
      throw new FrozenContextError(
        "FROZEN_CONTEXT_PATH_ESCAPE",
        `${label} resolves outside the frozen context root`,
      );
    }
    let metadata;
    try {
      metadata = await lstat(cursor);
    } catch {
      throw new FrozenContextError(
        "FROZEN_CONTEXT_MANIFEST_INVALID",
        `${label} does not name a readable file`,
      );
    }
    if (metadata.isSymbolicLink()) {
      throw new FrozenContextError(
        "FROZEN_CONTEXT_SYMLINK_REJECTED",
        `${label} may not traverse a symbolic link, junction or reparse point`,
      );
    }
  }

  const targetMetadata = await lstat(cursor);
  if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_MANIFEST_INVALID",
      `${label} must name one regular file`,
    );
  }
  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(cursor);
  } catch {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_MANIFEST_INVALID",
      `${label} cannot be resolved safely`,
    );
  }
  if (pathEscapes(canonicalRoot, canonicalTarget)) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_PATH_ESCAPE",
      `${label} resolves outside the frozen context root`,
    );
  }
  if (normalizedFilesystemPath(canonicalTarget) !== normalizedFilesystemPath(cursor)) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_SYMLINK_REJECTED",
      `${label} may not resolve through a symbolic link, junction or reparse point`,
    );
  }
}

function decodeUtf8(raw: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_MANIFEST_INVALID",
      `${label} is not valid UTF-8 text`,
    );
  }
}

function parseJsonPayload(text: string, label: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_MANIFEST_INVALID",
      `${label} declares JSON but its content is not valid JSON`,
    );
  }
}

async function readVerifiedPayload(args: {
  rootDir: string;
  relativePath: string;
  expectedSha256: string;
  mediaType?: FrozenContextEntry["mediaType"];
  label: string;
  maxResponseBytes: number;
}): Promise<FrozenContextPayload> {
  await assertRegularFileWithinRoot(args.rootDir, args.relativePath, args.label);
  const absolutePath = resolve(args.rootDir, ...args.relativePath.split("/"));
  const metadata = await lstat(absolutePath);
  if (metadata.size > args.maxResponseBytes) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_RESPONSE_TOO_LARGE",
      "frozen context response exceeds the configured byte limit",
    );
  }
  const raw = await readFile(absolutePath);
  if (raw.byteLength > args.maxResponseBytes) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_RESPONSE_TOO_LARGE",
      "frozen context response exceeds the configured byte limit",
    );
  }
  const contentSha256 = createHash("sha256").update(raw).digest("hex");
  if (contentSha256 !== args.expectedSha256) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_HASH_MISMATCH",
      `${args.label} content no longer matches its frozen SHA-256`,
    );
  }
  // Repeat the path check after the body read so a replacement cannot be
  // silently accepted between validation and hashing.
  await assertRegularFileWithinRoot(args.rootDir, args.relativePath, args.label);
  const text = decodeUtf8(raw, args.label);
  const json = args.mediaType === "application/json" || extname(args.relativePath).toLowerCase() === ".json";
  return {
    text,
    value: json ? parseJsonPayload(text, args.label) : text,
    contentSha256,
  };
}

function parseManifest(raw: string): FrozenRuntimeContextManifest {
  let unknownManifest: unknown;
  try {
    unknownManifest = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_MANIFEST_INVALID",
      "runtime-context.v1.json is not valid JSON",
    );
  }
  const parsed = FrozenRuntimeContextManifestSchema.safeParse(unknownManifest);
  if (!parsed.success) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_MANIFEST_INVALID",
      `runtime-context.v1.json fails its schema (${parsed.error.issues.map((issue) => issue.path.join(".") || "root").join(", ")})`,
    );
  }
  const ids = [...parsed.data.entries.map((entry) => entry.id), ...parsed.data.replays.map((replay) => replay.id)];
  if (new Set(ids).size !== ids.length) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_MANIFEST_INVALID",
      "runtime context logical ids must be unique across entries and replays",
    );
  }
  return parsed.data;
}

export async function loadFrozenRuntimeContext(
  manifestPath: string,
): Promise<LoadedFrozenRuntimeContext> {
  if (!manifestPath.trim()) {
    throw new FrozenContextError("FROZEN_CONTEXT_REQUIRED", "an explicit runtime context manifest is required");
  }
  const absoluteManifest = resolve(manifestPath);
  if (hasSealedPathComponent(absoluteManifest)) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_SEALED_PATH_FORBIDDEN",
      "the runtime context manifest may not live under a sealed or holdout-shaped path",
    );
  }
  let manifestMetadata;
  try {
    manifestMetadata = await lstat(absoluteManifest);
  } catch {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_MANIFEST_INVALID",
      "the runtime context manifest is not readable",
    );
  }
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_SYMLINK_REJECTED",
      "the runtime context manifest must be a regular non-linked file",
    );
  }
  const rootDir = dirname(absoluteManifest);
  await assertRegularFileWithinRoot(rootDir, basename(absoluteManifest), "runtime context manifest");
  const manifest = parseManifest(await readFile(absoluteManifest, "utf8"));
  if (runtimeContextManifestContentSha256(manifest) !== manifest.manifestSha256) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_HASH_MISMATCH",
      "runtime-context.v1.json does not match its canonical manifestSha256",
    );
  }
  for (const entry of manifest.entries) {
    assertPortableRelativePath(entry.path, `entry ${entry.id}`);
    assertSupportedTextPath(entry.path, `entry ${entry.id}`);
    assertMediaTypeMatchesPath(entry);
    await readVerifiedPayload({
      rootDir,
      relativePath: entry.path,
      expectedSha256: entry.sha256,
      mediaType: entry.mediaType,
      label: `entry ${entry.id}`,
      maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    });
  }
  for (const replay of manifest.replays) {
    assertPortableRelativePath(replay.responsePath, `replay ${replay.id}`);
    assertSupportedTextPath(replay.responsePath, `replay ${replay.id}`);
    await readVerifiedPayload({
      rootDir,
      relativePath: replay.responsePath,
      expectedSha256: replay.responseSha256,
      label: `replay ${replay.id}`,
      maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    });
  }
  return { manifest, manifestSha256: manifest.manifestSha256, rootDir };
}
