import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SettingsPatchSchema, type SettingsPatch, type SettingsView } from "@testknowledge/model";
import type { LlmKnowledgeConfig } from "./llm-knowledge.js";
import type { LlmResponseCache } from "./llm-response-cache.js";

export type ResolvedLlmSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

const LLM_VARIABLES = ["TESTKNOWLEDGE_LLM_BASE_URL", "TESTKNOWLEDGE_LLM_API_KEY", "TESTKNOWLEDGE_LLM_MODEL"] as const;

export function settingsFilePath(dataRoot: string): string {
  return join(dataRoot, "settings.json");
}

/** An unset variable and a variable set to blanks both mean "not configured here". */
function firstSet(...values: Array<string | undefined>): string {
  return values.find((value) => value !== undefined && value.trim() !== "")?.trim() ?? "";
}

/**
 * Settings that outlive the process. The environment stays the outer scope — a deployment or a
 * one-off experiment can still override the file — and the file is what a user configures once.
 */
export class SettingsStore {
  private cached: SettingsPatch | undefined;

  constructor(
    private readonly filePath: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  llm(): ResolvedLlmSettings {
    const file = this.read().llm ?? {};
    return {
      baseUrl: firstSet(this.environment.TESTKNOWLEDGE_LLM_BASE_URL, file.baseUrl),
      apiKey: firstSet(this.environment.TESTKNOWLEDGE_LLM_API_KEY, file.apiKey),
      model: firstSet(this.environment.TESTKNOWLEDGE_LLM_MODEL, file.model),
    };
  }

  /** The api key is never echoed back; callers only learn whether one is stored. */
  view(): SettingsView {
    const llm = this.llm();
    return {
      llm: { baseUrl: llm.baseUrl, model: llm.model, hasApiKey: llm.apiKey !== "" },
      envManaged: LLM_VARIABLES.some((name) => firstSet(this.environment[name]) !== ""),
    };
  }

  read(): SettingsPatch {
    this.cached ??= this.load();
    return this.cached;
  }

  update(patch: SettingsPatch): SettingsPatch {
    const current = this.read();
    const merged: SettingsPatch = { llm: { ...current.llm, ...patch.llm } };
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    this.cached = merged;
    return merged;
  }

  private load(): SettingsPatch {
    try {
      return SettingsPatchSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch {
      // A missing or hand-edited file is not a reason to refuse to start: fall back to the environment.
      return {};
    }
  }
}

/**
 * Live view of the configured endpoint. The extractor reads these values per request, so a saved
 * settings change applies to the next build instead of requiring a restart.
 */
export function liveLlmConfig(store: SettingsStore, cache: LlmResponseCache): LlmKnowledgeConfig {
  return {
    get baseUrl() { return store.llm().baseUrl; },
    get apiKey() { return store.llm().apiKey; },
    get model() { return store.llm().model; },
    cache,
  };
}
