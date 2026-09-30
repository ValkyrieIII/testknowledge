import { join } from "node:path";
import {
  KnowledgeEngine,
  type CandidateExtractor,
  type EvidenceToolRuntime,
  type KnowledgeRepository,
  type ProjectEvidenceProvider,
  type SearchIndex,
  type SourceAdapter,
  type StructuralContextProvider,
} from "@testknowledge/core";
import { CodeGraphCliStructuralProvider } from "./codegraph-structural.js";
import { RepoEvidenceToolRuntime } from "./evidence-tools.js";
import { ConversationAdapter } from "./conversation.js";
import { resolveDataRoot } from "./data-root.js";
import { ExternalArtifactAdapter } from "./external-artifact.js";
import { GitHistoryEvidenceProvider } from "./git-history.js";
import { GoTestingAdapter, JavaJUnitAdapter, RustTestAdapter } from "./jvm-go-rust-tests.js";
import { JsonlRepository } from "./jsonl-repository.js";
import { LlmKnowledgeExtractor } from "./llm-knowledge.js";
import { FileLlmResponseCache } from "./llm-response-cache.js";
import { MarkdownAdapter } from "./markdown.js";
import { PythonPytestAdapter } from "./python-pytest.js";
import { RuleCandidateExtractor } from "./rule-extractor.js";
import { SettingsStore, liveLlmConfig, settingsFilePath } from "./settings.js";
import { SqliteBm25fIndex } from "./sqlite-bm25f.js";
import { TestEnvironmentAdapter } from "./test-environment.js";

export type DefaultEngineOptions = {
  dataRoot?: string;
  environment?: NodeJS.ProcessEnv;
  settings?: SettingsStore;
  repository?: KnowledgeRepository;
  searchIndex?: SearchIndex;
  sourceAdapters?: SourceAdapter[];
  ruleExtractor?: CandidateExtractor;
  llmExtractor?: CandidateExtractor | null;
  structuralContextProvider?: StructuralContextProvider | null;
  evidenceToolRuntime?: EvidenceToolRuntime | null;
  projectEvidenceProviders?: ProjectEvidenceProvider[];
};

export function defaultSourceAdapters(): SourceAdapter[] {
  return [
    new PythonPytestAdapter(),
    new JavaJUnitAdapter(),
    new GoTestingAdapter(),
    new RustTestAdapter(),
    new ConversationAdapter(),
    new MarkdownAdapter(),
    new TestEnvironmentAdapter(),
    new ExternalArtifactAdapter(),
  ];
}

/** Shared composition root for API, CLI and MCP. Protocol adapters do not choose engine capabilities independently. */
export function createDefaultEngine(options: DefaultEngineOptions = {}): KnowledgeEngine {
  const environment = options.environment ?? process.env;
  const dataRoot = options.dataRoot ?? resolveDataRoot(environment.TESTKNOWLEDGE_DATA_ROOT);
  const repository = options.repository ?? new JsonlRepository(dataRoot);
  const searchIndex = options.searchIndex ?? new SqliteBm25fIndex(join(dataRoot, "index.sqlite3"));
  const ruleExtractor = options.ruleExtractor ?? new RuleCandidateExtractor();
  const settings = options.settings ?? new SettingsStore(settingsFilePath(dataRoot), environment);
  // The extractor is always wired: its settings may be completed after startup, and the engine
  // asks it whether it is ready before spending a build on it.
  const llmExtractor = options.llmExtractor === null
    ? undefined
    : options.llmExtractor ?? new LlmKnowledgeExtractor(liveLlmConfig(settings, new FileLlmResponseCache(join(dataRoot, "llm-cache"))));
  return new KnowledgeEngine(
    repository,
    searchIndex,
    options.sourceAdapters ?? defaultSourceAdapters(),
    ruleExtractor,
    llmExtractor,
    options.structuralContextProvider === null ? undefined : options.structuralContextProvider ?? new CodeGraphCliStructuralProvider(),
    options.projectEvidenceProviders ?? [new GitHistoryEvidenceProvider()],
    // Repository reads are only useful to a model-directed extractor, so the runtime follows the
    // extractor rather than the presence of credentials.
    options.evidenceToolRuntime === null ? undefined : options.evidenceToolRuntime ?? (llmExtractor ? new RepoEvidenceToolRuntime() : undefined),
  );
}
