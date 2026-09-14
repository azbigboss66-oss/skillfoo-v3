import type { Provider, ProviderMessage, ProviderResponse, ProviderRequestOptions } from "./types.js";

/**
 * A deterministic, no-network provider for testing the Reference Runner.
 *
 * It stores preloaded JSON action envelopes (as raw strings) keyed by a
 * composite key of `scenarioId:snapshotId`. Each call to `chat()` returns the
 * next preloaded envelope in sequence. If no script is found for the current
 * key, or the script runs out of envelopes, `chat()` throws an error.
 *
 * The runner sets the scenario/snapshot context via `setContext()` before the
 * first call (the runner duck-types this method; real providers omit it).
 */
export class ScriptedProvider implements Provider {
  private readonly scripts: Map<string, string[]>;
  private scenarioId = "";
  private snapshotId = "";
  private index = 0;

  constructor(scripts: Map<string, string[]>) {
    this.scripts = scripts;
  }

  /** Set the current scenario/snapshot context and reset the playback cursor. */
  setContext(scenarioId: string, snapshotId: string): void {
    this.scenarioId = scenarioId;
    this.snapshotId = snapshotId;
    this.index = 0;
  }

  /** Composite lookup key derived from the current context. */
  private key(): string {
    return `${this.scenarioId}:${this.snapshotId}`;
  }

  async chat(_messages: ProviderMessage[], _options?: ProviderRequestOptions): Promise<ProviderResponse> {
    const envelopes = this.scripts.get(this.key());
    if (!envelopes) {
      throw new Error(
        `ScriptedProvider: no script found for key "${this.key()}"`,
      );
    }
    if (this.index >= envelopes.length) {
      throw new Error(
        `ScriptedProvider: script for key "${this.key()}" is exhausted ` +
          `(requested index ${this.index}, have ${envelopes.length})`,
      );
    }
    const content = envelopes[this.index];
    this.index += 1;
    return { content };
  }
}
