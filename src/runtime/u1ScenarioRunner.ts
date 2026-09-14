import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { FunnelScenarioRunner } from "../evolution/funnel.js";
import { scenarioApplicationAttemptIdentitySha256 } from "../evolution/structureRecovery.js";
import type { Provider } from "../providers/types.js";
import {
  calculateScenarioCallAuthorization,
  type ScenarioCallAuthorization,
} from "../providers/stageBudgets.js";
import type { CapabilityPolicy } from "../types.js";
import type { EvaluationContractV3 } from "../types.js";
import type {
  RunApplicationAttemptEvidence,
  RunApplicationRecoveryEvidence,
  RunTranscript,
  ScenarioEnvelopeExhaustionClassification,
} from "../types.js";
import { stableStringify } from "../intake/taskCard.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  sha256Hex,
  type AdapterContext,
  type CapabilityAdapter,
} from "./capabilityAdapter.js";
import {
  createInstructionAdapter,
  DEFAULT_INSTRUCTION_MAX_TURNS,
  INSTRUCTION_ADAPTER_ID,
  runInstructionScenario,
} from "./instructionAdapter.js";
import {
  FrozenContextError,
  REFERENCE_ADAPTER_ID,
  loadFrozenRuntimeContext,
  type LoadedFrozenRuntimeContext,
} from "./frozenContext.js";
import { createReferenceAdapter, REFERENCE_TOOL_NAMES } from "./referenceAdapter.js";

export interface U1RuntimeBinding {
  readonly adapterId: "instruction-v1" | "reference-v1";
  readonly manifestSha256: string | null;
  readonly entryCount: number;
  readonly replayCount: number;
  readonly allowedTools: readonly string[];
  readonly runtimeContext: LoadedFrozenRuntimeContext | null;
}

export interface CandidateWorkspace {
  readonly workspaceDir: string;
  readonly skillMdPath: string;
}

export interface U1ScenarioExecutionPolicy {
  readonly maxModelTurns: number;
  readonly maxToolCalls: number;
}

/**
 * Current adapter-scoped execution bounds. These are estimator inputs, not a
 * universal promise that every future adapter or contract has the same shape.
 */
export function u1ScenarioExecutionPolicy(adapterId: U1RuntimeBinding["adapterId"]): U1ScenarioExecutionPolicy {
  return Object.freeze({
    maxModelTurns: DEFAULT_INSTRUCTION_MAX_TURNS,
    maxToolCalls: adapterId === "reference-v1" ? 4 : 2,
  });
}

export type U1ScenarioRole =
  | "starting-reference"
  | "adaptive"
  | "public-select"
  | "direct"
  | "sealed";

export interface U1ScenarioRunnerFactory {
  readonly binding: U1RuntimeBinding;
  runnerFor(
    role: U1ScenarioRole,
    provider: Provider,
    scenarioAuthorization?: ScenarioCallAuthorization,
  ): FunnelScenarioRunner;
}

export class U1ScenarioEnvelopeError extends Error {
  constructor(
    readonly code:
      | "SCENARIO_ENVELOPE_UNDERESTIMATED"
      | "SCENARIO_ENVELOPE_EXHAUSTED_UNCLASSIFIED",
    readonly safeEvidence: RunApplicationRecoveryEvidence,
    readonly role: U1ScenarioRole,
    readonly itemId: string,
    readonly skillSha256: string,
  ) {
    super(`${code}: two authorized application attempts exhausted without a scoreable final answer`);
    this.name = "U1ScenarioEnvelopeError";
  }
}

const CANDIDATE_WORKSPACE_PREFIX = "skillfoo-u1-candidate-";

function normalizedPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function assertCandidateWorkspacePath(workspaceDir: string, tempRoot: string): void {
  const rel = relative(tempRoot, workspaceDir);
  if (
    !rel ||
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    normalizedPath(dirname(workspaceDir)) !== normalizedPath(tempRoot) ||
    !basename(workspaceDir).startsWith(CANDIDATE_WORKSPACE_PREFIX)
  ) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_PATH_ESCAPE",
      "refusing to clean a candidate workspace outside the exact OS-temporary slot",
    );
  }
}

async function removeCandidateWorkspace(workspaceDir: string, tempRoot: string): Promise<void> {
  assertCandidateWorkspacePath(workspaceDir, tempRoot);
  let metadata;
  try {
    metadata = await lstat(workspaceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    await rm(workspaceDir, { force: true });
    return;
  }
  const canonical = await realpath(workspaceDir);
  assertCandidateWorkspacePath(canonical, tempRoot);
  await rm(workspaceDir, { recursive: true, force: true });
}

async function assertWorkspaceContainsOnlySkill(workspace: CandidateWorkspace): Promise<void> {
  const entries = await readdir(workspace.workspaceDir, { withFileTypes: true });
  if (
    entries.length !== 1 ||
    entries[0]?.name !== "SKILL.md" ||
    !entries[0].isFile() ||
    entries[0].isSymbolicLink()
  ) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_MANIFEST_INVALID",
      "a candidate workspace may contain only one regular SKILL.md",
    );
  }
  const skillMetadata = await lstat(workspace.skillMdPath);
  if (!skillMetadata.isFile() || skillMetadata.isSymbolicLink()) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_SYMLINK_REJECTED",
      "candidate SKILL.md must remain one regular non-linked file",
    );
  }
}

export async function withIsolatedCandidateWorkspace<T>(
  skillMarkdown: string,
  run: (workspace: CandidateWorkspace) => Promise<T>,
): Promise<T> {
  const tempRoot = await realpath(tmpdir());
  const workspaceDir = await mkdtemp(join(tempRoot, CANDIDATE_WORKSPACE_PREFIX));
  assertCandidateWorkspacePath(workspaceDir, tempRoot);
  const workspace: CandidateWorkspace = {
    workspaceDir,
    skillMdPath: join(workspaceDir, "SKILL.md"),
  };
  try {
    await writeFile(workspace.skillMdPath, skillMarkdown, { encoding: "utf8", flag: "wx" });
    const result = await run(workspace);
    await assertWorkspaceContainsOnlySkill(workspace);
    return result;
  } finally {
    await removeCandidateWorkspace(workspaceDir, tempRoot);
  }
}

/** Load the adapter binding without constructing a Provider or making network calls. */
export async function loadU1RuntimeBinding(args: {
  contract: EvaluationContractV3;
  runtimeContextPath?: string;
}): Promise<U1RuntimeBinding> {
  if (args.contract.adapterId === INSTRUCTION_ADAPTER_ID) {
    if (args.runtimeContextPath !== undefined) {
      throw new FrozenContextError(
        "FROZEN_CONTEXT_MANIFEST_INVALID",
        "instruction-v1 has an empty tool surface and cannot bind a runtime context",
      );
    }
    return {
      adapterId: "instruction-v1",
      manifestSha256: null,
      entryCount: 0,
      replayCount: 0,
      allowedTools: [],
      runtimeContext: null,
    };
  }
  if (args.contract.adapterId !== REFERENCE_ADAPTER_ID) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_MANIFEST_INVALID",
      `U1 frozen runtime does not implement adapter ${args.contract.adapterId}`,
    );
  }
  if (!args.runtimeContextPath) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_REQUIRED",
      "reference-v1 requires --runtime-context <path>",
    );
  }
  const runtimeContext = await loadFrozenRuntimeContext(args.runtimeContextPath);
  const expectedSha256 = args.contract.sourceHashes.runtimeContextManifest;
  if (!expectedSha256) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_REQUIRED",
      "reference-v1 contract does not bind sourceHashes.runtimeContextManifest",
    );
  }
  if (runtimeContext.manifestSha256 !== expectedSha256) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_HASH_MISMATCH",
      "runtime context manifest SHA-256 differs from the frozen EvaluationContractV3 binding",
    );
  }
  return {
    adapterId: "reference-v1",
    manifestSha256: runtimeContext.manifestSha256,
    entryCount: runtimeContext.manifest.entries.length,
    replayCount: runtimeContext.manifest.replays.length,
    allowedTools: REFERENCE_TOOL_NAMES,
    runtimeContext,
  };
}

function adapterForBinding(
  binding: U1RuntimeBinding,
  scenarioAuthorization?: ScenarioCallAuthorization,
): {
  adapter: CapabilityAdapter;
  adapterContext: AdapterContext;
  maxToolCalls: number;
  maxModelTurns: number;
} {
  const executionPolicy = u1ScenarioExecutionPolicy(binding.adapterId);
  const maxModelTurns = scenarioAuthorization?.authorizedMaxTurns ?? executionPolicy.maxModelTurns;
  const maxToolCalls = scenarioAuthorization?.authorizedMaxToolCalls ?? executionPolicy.maxToolCalls;
  const policy: CapabilityPolicy = {
    adapterId: binding.adapterId,
    allowedTools: [...binding.allowedTools],
    maxToolCalls,
    networkMode: "fixture",
    lockedPaths: [],
  };
  const adapter = binding.adapterId === "reference-v1"
    ? createReferenceAdapter({ policy, runtimeContext: binding.runtimeContext ?? undefined })
    : createInstructionAdapter({ policy });
  return {
    adapter,
    adapterContext: {
      mode: "fixture",
      maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      allowNetwork: false,
    },
    maxToolCalls: policy.maxToolCalls,
    maxModelTurns,
  };
}

type ContextBoundProvider = Provider & {
  withContext?: (context: {
    scenarioId: string;
    snapshotId: string;
    frozenEvidenceSha256?: string;
  }) => Provider;
  setContext?: (scenarioId: string, snapshotId: string) => void;
};

function isCandidateLoop(reason: RunTranscript["terminalReason"]): boolean {
  return reason === "too_many_tool_calls" || reason === "too_many_turns";
}

function repeatedAuthorizedToolRequest(transcript: RunTranscript): boolean {
  const seen = new Set<string>();
  for (const event of transcript.toolEvents) {
    if (!event.success) continue;
    const fingerprint = stableStringify({ toolName: event.toolName, args: event.args });
    if (seen.has(fingerprint)) return true;
    seen.add(fingerprint);
  }
  return false;
}

function classifyScenarioEnvelopeExhaustion(args: {
  transcripts: readonly [RunTranscript, RunTranscript];
  attempts: readonly [RunApplicationAttemptEvidence, RunApplicationAttemptEvidence];
  authorizedModelCallsPerAttempt: number;
}): ScenarioEnvelopeExhaustionClassification {
  if (args.transcripts.some(repeatedAuthorizedToolRequest)) return "persistent_candidate_loop";
  if (
    args.attempts.every((attempt) => attempt.modelCalls === args.authorizedModelCallsPerAttempt) &&
    args.transcripts.every((transcript) => transcript.toolEvents.every((event) => event.success))
  ) {
    return "scenario_envelope_underestimated";
  }
  return "scenario_envelope_exhausted_unclassified";
}

function applicationAttemptEvidence(args: {
  attempt: 1 | 2;
  attemptIdentitySha256: string;
  transcript: RunTranscript;
  modelCalls: number;
}): RunApplicationAttemptEvidence {
  const { transcript } = args;
  const successfulRequestFingerprints = transcript.toolEvents
    .filter((event) => event.success)
    .map((event) => sha256Hex(stableStringify({ toolName: event.toolName, args: event.args })));
  const uniqueSuccessfulToolRequests = new Set(successfulRequestFingerprints).size;
  return {
    attempt: args.attempt,
    attemptIdentitySha256: args.attemptIdentitySha256,
    terminalReason: transcript.terminalReason,
    modelCalls: args.modelCalls,
    transcriptSha256: sha256Hex(stableStringify({
      scenarioId: transcript.scenarioId,
      snapshotId: transcript.snapshotId,
      terminalReason: transcript.terminalReason,
      turns: transcript.turns,
      toolEvents: transcript.toolEvents.map((event) => ({
        turn: event.turn,
        sequence: event.sequence,
        toolName: event.toolName,
        success: event.success,
        error: event.error ?? null,
      })),
      rawFinalResponseSha256: sha256Hex(transcript.rawFinalResponse),
      parsedFinalAnswerSha256: transcript.parsedFinalAnswer === undefined
        ? null
        : sha256Hex(stableStringify(transcript.parsedFinalAnswer)),
    })),
    successfulToolCalls: successfulRequestFingerprints.length,
    failedToolCalls: transcript.toolEvents.filter((event) => !event.success).length,
    uniqueSuccessfulToolRequests,
    repeatedSuccessfulToolRequests:
      successfulRequestFingerprints.length - uniqueSuccessfulToolRequests,
    trajectorySha256: sha256Hex(stableStringify({
      modelCalls: args.modelCalls,
      terminalReason: transcript.terminalReason,
      toolEvents: transcript.toolEvents.map((event) => ({
        toolName: event.toolName,
        requestSha256: sha256Hex(stableStringify(event.args)),
        success: event.success,
        errorCode: event.success ? null : String(event.error ?? "UNKNOWN").split(":", 1)[0],
      })),
    })),
  };
}

/**
 * One composition root for Starting Reference, Adaptive, terminal public-select,
 * Direct and future sealed evaluation. It loads one immutable binding and does
 * not inject dependency bodies into any system or mutation prompt.
 */
export async function createU1ScenarioRunnerFactory(args: {
  contract: EvaluationContractV3;
  runtimeContextPath?: string;
}): Promise<U1ScenarioRunnerFactory> {
  const binding = await loadU1RuntimeBinding(args);
  const currentU1 = args.contract.u1ContractVersion === "v2";
  return {
    binding,
    runnerFor(
      role: U1ScenarioRole,
      provider: Provider,
      suppliedAuthorization?: ScenarioCallAuthorization,
    ): FunnelScenarioRunner {
      const rawPolicy = u1ScenarioExecutionPolicy(binding.adapterId);
      const maxApplicationAttempts = role === "sealed" ? 1 : 2;
      const scenarioAuthorization = suppliedAuthorization ?? (
        currentU1
          ? calculateScenarioCallAuthorization(
              rawPolicy.maxModelTurns,
              rawPolicy.maxToolCalls,
              2,
              maxApplicationAttempts,
            )
          : undefined
      );
      if (
        scenarioAuthorization &&
        scenarioAuthorization.maxApplicationAttempts !== maxApplicationAttempts
      ) {
        throw new Error(
          `U1_SCENARIO_AUTHORIZATION_ROLE_MISMATCH: ${role} requires maxApplicationAttempts=${maxApplicationAttempts}`,
        );
      }
      const runtime = adapterForBinding(binding, scenarioAuthorization);
      return async ({ item, skillMd, snapshotId }) =>
        withIsolatedCandidateWorkspace(skillMd, async (workspace) => {
          const isolatedSkillMarkdown = await readFile(workspace.skillMdPath, "utf8");
          const frozenEvidenceSha256 = sha256Hex(stableStringify({
            itemId: item.itemId,
            input: item.input,
            judgingRule: item.judgingRule,
            rubric: item.rubric ?? null,
            taskVerifier: item.taskVerifier ?? null,
          }));
          const originalRequestFingerprint = sha256Hex(stableStringify({
            contract: "u1-scenario-execution-attempt-v1",
            role,
            adapterId: binding.adapterId,
            manifestSha256: binding.manifestSha256,
            skillSha256: sha256Hex(isolatedSkillMarkdown),
            snapshotId,
            frozenEvidenceSha256,
            maxToolCalls: runtime.maxToolCalls,
            maxModelTurns: runtime.maxModelTurns,
            scenarioAuthorization: scenarioAuthorization ?? null,
          }));

          const executeAttempt = async (attempt: 1 | 2): Promise<{
            transcript: RunTranscript;
            evidence: RunApplicationAttemptEvidence;
          }> => {
            const attemptIdentitySha256 = scenarioApplicationAttemptIdentitySha256({
              originalRequestFingerprint,
              attempt,
            });
            const contextProvider = (provider as ContextBoundProvider).withContext?.({
              scenarioId: item.itemId,
              snapshotId: attemptIdentitySha256,
              frozenEvidenceSha256,
            }) ?? provider;
            let modelCalls = 0;
            const countedProvider: Provider & {
              setContext?: (scenarioId: string, snapshotId: string) => void;
            } = {
              async chat(messages, options) {
                modelCalls += 1;
                return contextProvider.chat(messages, options);
              },
              ...(typeof (contextProvider as ContextBoundProvider).setContext === "function"
                ? {
                    setContext(scenarioId: string, attemptSnapshotId: string): void {
                      (contextProvider as ContextBoundProvider).setContext!(scenarioId, attemptSnapshotId);
                    },
                  }
                : {}),
            };
            const transcript = await runInstructionScenario({
              provider: countedProvider,
              skillMarkdown: isolatedSkillMarkdown,
              outputContract:
                "Return exactly one JSON object with type=final and a non-empty answer. Solve the user request from the locked SKILL.md; no evaluation rule or expected answer is available to you.",
              scenario: {
                id: item.itemId,
                userPrompt: item.input,
                maxToolCalls: runtime.maxToolCalls,
              },
              snapshotId: scenarioAuthorization ? attemptIdentitySha256 : snapshotId,
              adapter: runtime.adapter,
              adapterContext: runtime.adapterContext,
              maxTurns: runtime.maxModelTurns,
            });
            return {
              transcript,
              evidence: applicationAttemptEvidence({
                attempt,
                attemptIdentitySha256,
                transcript,
                modelCalls,
              }),
            };
          };

          const primary = await executeAttempt(1);
          if (role === "sealed" || !isCandidateLoop(primary.transcript.terminalReason)) {
            return scenarioAuthorization
              ? {
                  ...primary.transcript,
                  applicationRecovery: {
                    outcome: "no_retry_needed" as const,
                    attempts: [primary.evidence],
                    retryTriggered: false,
                    rawScenarioEstimate: scenarioAuthorization.rawScenarioEstimate,
                    callEnvelopeMultiplier: scenarioAuthorization.callEnvelopeMultiplier,
                    authorizedModelCallsPerAttempt:
                      scenarioAuthorization.authorizedModelCallsPerAttempt,
                    maxApplicationAttempts: scenarioAuthorization.maxApplicationAttempts,
                    scenarioRetryReserve: scenarioAuthorization.scenarioRetryReserve,
                    unusedRetryReserve: scenarioAuthorization.scenarioRetryReserve,
                    classification: null,
                  },
                }
              : primary.transcript;
          }
          const retry = await executeAttempt(2);
          const persistent = isCandidateLoop(retry.transcript.terminalReason);
          const attempts = [primary.evidence, retry.evidence] as const;
          const classification = persistent && scenarioAuthorization
            ? classifyScenarioEnvelopeExhaustion({
                transcripts: [primary.transcript, retry.transcript],
                attempts,
                authorizedModelCallsPerAttempt:
                  scenarioAuthorization.authorizedModelCallsPerAttempt,
              })
            : persistent
              ? "persistent_candidate_loop" as const
              : null;
          const applicationRecovery: RunApplicationRecoveryEvidence = {
            outcome: retry.transcript.terminalReason === "final"
              ? "recovered_after_single_retry"
              : persistent
                ? classification === "persistent_candidate_loop"
                  ? "persistent_candidate_loop"
                  : "scenario_envelope_exhausted"
                : "retry_completed_non_final",
            attempts: [primary.evidence, retry.evidence],
            retryTriggered: true,
            rawScenarioEstimate:
              scenarioAuthorization?.rawScenarioEstimate ?? runtime.maxModelTurns,
            callEnvelopeMultiplier: scenarioAuthorization?.callEnvelopeMultiplier ?? 1,
            authorizedModelCallsPerAttempt:
              scenarioAuthorization?.authorizedModelCallsPerAttempt ?? runtime.maxModelTurns,
            maxApplicationAttempts: 2,
            scenarioRetryReserve:
              scenarioAuthorization?.scenarioRetryReserve ?? runtime.maxModelTurns,
            unusedRetryReserve: Math.max(
              0,
              (scenarioAuthorization?.scenarioRetryReserve ?? runtime.maxModelTurns) - retry.evidence.modelCalls,
            ),
            classification,
          };
          if (
            classification === "scenario_envelope_underestimated" ||
            classification === "scenario_envelope_exhausted_unclassified"
          ) {
            throw new U1ScenarioEnvelopeError(
              classification === "scenario_envelope_underestimated"
                ? "SCENARIO_ENVELOPE_UNDERESTIMATED"
                : "SCENARIO_ENVELOPE_EXHAUSTED_UNCLASSIFIED",
              applicationRecovery,
              role,
              item.itemId,
              sha256Hex(isolatedSkillMarkdown),
            );
          }
          return {
            ...retry.transcript,
            ...(persistent
              ? {
                  terminalReason: "persistent_candidate_loop" as const,
                  rawFinalResponse: "",
                  parsedFinalAnswer: undefined,
                }
              : {}),
            applicationRecovery,
          };
        });
    },
  };
}
