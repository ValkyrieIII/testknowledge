<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { BuildResult, ContextPack, EvidenceCluster, EvaluationObservation, EvaluationPlan, EvaluationReport, EvaluationVariant, KnowledgeCard, KnowledgeChange, KnowledgeChangePage, KnowledgeChangeSummary, KnowledgePage, KnowledgeRelation, ProjectMap, RelationType } from "@testknowledge/model";
import EvidenceDetails from "./components/EvidenceDetails.vue";
import KnowledgeCardView from "./components/KnowledgeCardView.vue";
import ObservationList from "./components/ObservationList.vue";
import RunLedgerView from "./components/RunLedgerView.vue";
import { errorMessage, requestJson } from "./api.js";

const cards = ref<KnowledgeCard[]>([]);
const clusters = ref<EvidenceCluster[]>([]);
const changes = ref<KnowledgeChangeSummary[]>([]);
const cardTotal = ref(0);
const cardCounts = ref<KnowledgePage["counts"]>({ candidate: 0, reviewed: 0, verified: 0, rejected: 0, stale: 0, total: 0 });
const cardPage = ref(0);
const cardPageSize = 12;
const historyTotal = ref(0);
const historyPage = ref(0);
const historyPageSize = 20;
const loadingHistory = ref(false);
const projectMaps = ref<ProjectMap[]>([]);
const relations = ref<KnowledgeRelation[]>([]);
const evaluationPlans = ref<EvaluationPlan[]>([]);
const evaluationObservations = ref<EvaluationObservation[]>([]);
const evaluationReports = ref<Record<string, EvaluationReport>>({});
const evaluationRunSetSelection = ref<Record<string, string>>({});
const task = ref("");
const repo = ref("");
const result = ref<ContextPack | null>(null);
const loadingCards = ref(false);
const searching = ref(false);
const listError = ref("");
const queryError = ref("");
const scanning = ref(false);
const scanError = ref("");
const scanResult = ref<BuildResult | null>(null);
const reviewErrors = ref<Record<string, string>>({});
const reviewing = ref(new Set<string>());
const reviewingClusters = ref(new Set<string>());
const rollingBack = ref(new Set<string>());
const governanceReviewer = ref("");
const reviewNote = ref("");
const rollbackNote = ref("");
const reviewNotice = ref("");
const knowledgeView = ref<"candidates" | "active" | "stale" | "all">("candidates");
const candidateCount = computed(() => cardCounts.value.candidate);
const reviewedCount = computed(() => cardCounts.value.reviewed);
const visibleCards = computed(() => cards.value);
const cardPageCount = computed(() => Math.max(1, Math.ceil(cardTotal.value / cardPageSize)));
const historyPageCount = computed(() => Math.max(1, Math.ceil(historyTotal.value / historyPageSize)));
const cardStatus = computed(() => knowledgeView.value === "candidates" ? "candidate" : knowledgeView.value === "active" ? "active" : knowledgeView.value === "stale" ? "stale" : "all");
const retrievalById = computed(() => new Map(result.value?.retrieval.map((hit) => [hit.id, hit]) ?? []));
const clusterById = computed(() => new Map(clusters.value.map((cluster) => [cluster.id, cluster])));
const activeProjectMap = computed(() => projectMaps.value.find((item) => item.repo === repo.value.trim()) ?? projectMaps.value[0]);
const activeRelations = computed(() => repo.value.trim() ? relations.value.filter((item) => item.repo === repo.value.trim()) : relations.value);
const canSearch = computed(() => Boolean(repo.value.trim() && task.value.trim()) && !searching.value && !scanning.value);
const canScan = computed(() => Boolean(repo.value.trim()) && !scanning.value && !searching.value && !loadingCards.value && reviewing.value.size === 0 && reviewingClusters.value.size === 0 && rollingBack.value.size === 0);
const actionNames: Record<KnowledgeChange["action"], string> = {
  build: "构建更新", create: "人工录入", review: "人工审核", verify: "执行验证",
  merge: "人工合并", rollback: "操作回滚", conflict_resolution: "冲突决议", cluster_rejection: "分组拒绝",
  feedback_invalidation: "Oracle 反证失效",
};
const evaluationVariantNames: Record<EvaluationVariant, string> = {
  A_ordinary_agent: "A · 普通 Agent",
  B_codegraph: "B · CodeGraph",
  C_codegraph_testknowledge: "C · CodeGraph + 测试知识",
};
const relationNames: Record<RelationType, string> = {
  SUPPORTED_BY: "证据支撑", USES_FIXTURE: "使用 Fixture", COVERS: "覆盖路径",
  VERIFIES: "直接验证", VERIFIED_BY: "执行验证", INVALIDATED_BY: "失效证据", IMPACTS: "影响",
  REGRESSION_OF: "回归关联", CONFLICTS_WITH: "存在冲突", MERGED_FROM: "合并来源",
};
const evaluationVerdictNames: Record<EvaluationReport["verdict"], string> = {
  improved: "已证明改进", not_demonstrated: "未证明改进", insufficient_data: "证据不足",
};
const evaluationVariants = Object.keys(evaluationVariantNames) as EvaluationVariant[];
const evaluationRows = computed(() => [...evaluationPlans.value].reverse().map((plan) => {
  const report = evaluationReports.value[plan.id] ?? null;
  const runSetIds = [...new Set(evaluationObservations.value.filter((item) => item.planId === plan.id).map((item) => item.runSetId))].sort();
  return {
    plan,
    report,
    runSetIds,
    observationCounts: Object.fromEntries(evaluationVariants.map((variant) => [
      variant,
      evaluationObservations.value.filter((item) => item.planId === plan.id && item.variant === variant && (plan.protocolVersion !== "evaluation.v2" || Boolean(report?.runSetId) && item.runSetId === report?.runSetId)).length,
    ])) as Record<EvaluationVariant, number>,
  };
}));

async function scanRepository(): Promise<void> {
  if (!canScan.value) return;
  scanning.value = true;
  scanError.value = "";
  scanResult.value = null;
  try {
    scanResult.value = await requestJson<BuildResult>("/api/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: repo.value.trim(), useLlm: true }),
    });
    repo.value = scanResult.value.repo;
    cardPage.value = 0;
    historyPage.value = 0;
    result.value = null;
    queryError.value = "";
    reviewNotice.value = "";
    reviewErrors.value = {};
    await loadCards();
  } catch (cause) {
    scanError.value = errorMessage(cause);
  } finally {
    scanning.value = false;
  }
}

function knowledgePageUrl(): string {
  const params = new URLSearchParams({ offset: String(cardPage.value * cardPageSize), limit: String(cardPageSize) });
  if (repo.value.trim()) params.set("repo", repo.value.trim());
  if (cardStatus.value !== "all") params.set("status", cardStatus.value);
  return `/api/knowledge/page?${params.toString()}`;
}

async function fetchKnowledgePage(): Promise<KnowledgePage> {
  return requestJson<KnowledgePage>(knowledgePageUrl());
}

function applyKnowledgePage(page: KnowledgePage): void {
  cards.value = page.items;
  cardTotal.value = page.total;
  cardCounts.value = page.counts;
  if (cardPage.value >= cardPageCount.value) cardPage.value = Math.max(0, cardPageCount.value - 1);
}

async function loadKnowledgePage(): Promise<void> {
  if (loadingCards.value) return;
  loadingCards.value = true;
  listError.value = "";
  try {
    const page = await fetchKnowledgePage();
    const requestedPage = cardPage.value;
    applyKnowledgePage(page);
    if (!page.items.length && page.total > 0 && cardPage.value !== requestedPage) applyKnowledgePage(await fetchKnowledgePage());
  } catch (cause) {
    listError.value = errorMessage(cause);
  } finally {
    loadingCards.value = false;
  }
}

function historyPageUrl(): string {
  const params = new URLSearchParams({ offset: String(historyPage.value * historyPageSize), limit: String(historyPageSize) });
  if (repo.value.trim()) params.set("repo", repo.value.trim());
  return `/api/knowledge-changes/page?${params.toString()}`;
}

async function fetchHistoryPage(): Promise<KnowledgeChangePage> {
  return requestJson<KnowledgeChangePage>(historyPageUrl());
}

async function loadHistoryPage(): Promise<void> {
  if (loadingHistory.value) return;
  loadingHistory.value = true;
  try {
    const page = await fetchHistoryPage();
    const requestedPage = historyPage.value;
    changes.value = page.items;
    historyTotal.value = page.total;
    if (historyPage.value >= historyPageCount.value) historyPage.value = Math.max(0, historyPageCount.value - 1);
    if (!page.items.length && page.total > 0 && historyPage.value !== requestedPage) {
      const retry = await fetchHistoryPage();
      changes.value = retry.items;
      historyTotal.value = retry.total;
    }
  } catch (cause) {
    listError.value = errorMessage(cause);
  } finally {
    loadingHistory.value = false;
  }
}

async function changeCardPage(delta: number): Promise<void> {
  const next = cardPage.value + delta;
  if (loadingCards.value || next < 0 || next >= cardPageCount.value) return;
  cardPage.value = next;
  await loadKnowledgePage();
}

async function changeHistoryPage(delta: number): Promise<void> {
  const next = historyPage.value + delta;
  if (loadingHistory.value || next < 0 || next >= historyPageCount.value) return;
  historyPage.value = next;
  await loadHistoryPage();
}

function changeKnowledgeView(): void {
  cardPage.value = 0;
  void loadKnowledgePage();
}

function changeRepository(): void {
  cardPage.value = 0;
  historyPage.value = 0;
  void Promise.all([loadKnowledgePage(), loadHistoryPage()]);
}

async function loadCards(): Promise<void> {
  if (loadingCards.value || reviewing.value.size > 0 || reviewingClusters.value.size > 0 || rollingBack.value.size > 0) return;
  loadingCards.value = true;
  listError.value = "";
  try {
    const [nextKnowledgePage, nextClusters, nextProjectMaps, nextRelations, nextEvaluationPlans, nextEvaluationObservations] = await Promise.all([
      fetchKnowledgePage(),
      requestJson<EvidenceCluster[]>("/api/clusters"),
      requestJson<ProjectMap[]>("/api/project-maps"),
      requestJson<KnowledgeRelation[]>("/api/relations"),
      requestJson<EvaluationPlan[]>("/api/evaluations"),
      requestJson<EvaluationObservation[]>("/api/evaluation-observations"),
    ]);
    let page = nextKnowledgePage;
    if (!repo.value && page.items[0]) {
      repo.value = page.items[0].repo;
      page = await fetchKnowledgePage();
    }
    applyKnowledgePage(page);
    clusters.value = nextClusters;
    projectMaps.value = nextProjectMaps;
    relations.value = nextRelations;
    evaluationPlans.value = nextEvaluationPlans;
    evaluationObservations.value = nextEvaluationObservations;
    const nextRunSetSelection = { ...evaluationRunSetSelection.value };
    for (const plan of nextEvaluationPlans) {
      const runSetIds = [...new Set(nextEvaluationObservations.filter((item) => item.planId === plan.id).map((item) => item.runSetId))].sort();
      if (!runSetIds.includes(nextRunSetSelection[plan.id] ?? "")) nextRunSetSelection[plan.id] = runSetIds.length === 1 ? runSetIds[0]! : "";
    }
    evaluationRunSetSelection.value = nextRunSetSelection;
    evaluationReports.value = Object.fromEntries(await Promise.all(nextEvaluationPlans.map(async (plan) => {
      const selected = nextRunSetSelection[plan.id];
      const query = selected ? `?runSetId=${encodeURIComponent(selected)}` : "";
      return [plan.id, await requestJson<EvaluationReport>(`/api/evaluations/${encodeURIComponent(plan.id)}/report${query}`)];
    })));
    await loadHistoryPage();
  } catch (cause) {
    listError.value = errorMessage(cause);
  } finally {
    loadingCards.value = false;
  }
}

async function selectEvaluationRunSet(planId: string): Promise<void> {
  const selected = evaluationRunSetSelection.value[planId] ?? "";
  const query = selected ? `?runSetId=${encodeURIComponent(selected)}` : "";
  try {
    evaluationReports.value = {
      ...evaluationReports.value,
      [planId]: await requestJson<EvaluationReport>(`/api/evaluations/${encodeURIComponent(planId)}/report${query}`),
    };
  } catch (cause) {
    listError.value = errorMessage(cause);
  }
}

function percentage(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function runInstructionText(item: ProjectMap["runInstructions"][number]): string {
  return item.command?.join(" ") ?? item.commandText ?? "";
}

async function rollback(change: KnowledgeChangeSummary): Promise<void> {
  const reviewer = governanceReviewer.value.trim();
  const note = rollbackNote.value.trim();
  if (!reviewer || !note || rollingBack.value.has(change.operationId)) return;
  if (!window.confirm(`确认回滚“${actionNames[change.action]}”操作？恢复出的卡片会重新进入待审核状态。`)) return;
  rollingBack.value.add(change.operationId);
  listError.value = "";
  try {
    await requestJson<KnowledgeCard[]>(`/api/knowledge/${encodeURIComponent(change.knowledgeId)}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ changeId: change.id, reviewer, note }),
    });
    reviewNotice.value = "操作已回滚；恢复的知识卡已重新进入待审核状态。";
    rollbackNote.value = "";
    rollingBack.value.delete(change.operationId);
    await Promise.all([loadKnowledgePage(), loadHistoryPage()]);
  } catch (cause) {
    listError.value = errorMessage(cause);
  } finally {
    rollingBack.value.delete(change.operationId);
  }
}

async function reviewCluster(cluster: EvidenceCluster, status: "reviewed" | "rejected"): Promise<void> {
  if (reviewingClusters.value.has(cluster.id) || loadingCards.value || scanning.value) return;
  const reviewer = governanceReviewer.value.trim();
  const note = reviewNote.value.trim();
  if (!reviewer || !note) {
    listError.value = "请先填写治理人和本次审核说明。";
    return;
  }
  reviewingClusters.value.add(cluster.id);
  reviewNotice.value = "";
  listError.value = "";
  try {
    const updated = await requestJson<EvidenceCluster>("/api/clusters/" + encodeURIComponent(cluster.id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, reviewer, note }),
    });
    clusters.value = clusters.value.map((item) => item.id === cluster.id ? updated : item);
    if (result.value) result.value.evidenceClusters = result.value.evidenceClusters.map((item) => item.id === cluster.id ? updated : item);
    if (status === "rejected") cards.value = cards.value.map((card) => card.clusterId === cluster.id ? { ...card, status: "rejected" } : card);
    reviewNotice.value = status === "reviewed" ? "证据分组已确认；其知识卡仍需独立审核。" : "证据分组及其生成卡片已拒绝。";
    reviewNote.value = "";
    reviewingClusters.value.delete(cluster.id);
    await Promise.all([loadKnowledgePage(), loadHistoryPage()]);
  } catch (cause) {
    listError.value = errorMessage(cause);
  } finally {
    reviewingClusters.value.delete(cluster.id);
  }
}

async function search(): Promise<void> {
  if (!canSearch.value) return;
  queryError.value = "";
  result.value = null;
  searching.value = true;
  try {
    result.value = await requestJson<ContextPack>("/api/context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: repo.value, task: task.value, changedFiles: [], targetSymbols: [], includeCandidates: true, limit: 8 }),
    });
  } catch (cause) {
    queryError.value = errorMessage(cause);
  } finally {
    searching.value = false;
  }
}

async function review(card: KnowledgeCard, status: "reviewed" | "rejected"): Promise<void> {
  if (reviewing.value.has(card.id) || loadingCards.value || scanning.value) return;
  const reviewer = governanceReviewer.value.trim();
  const note = reviewNote.value.trim();
  if (!reviewer || !note) {
    reviewErrors.value[card.id] = "请先填写治理人和本次审核说明。";
    return;
  }
  reviewing.value.add(card.id);
  reviewErrors.value[card.id] = "";
  reviewNotice.value = "";
  try {
    const updated = await requestJson<KnowledgeCard>("/api/knowledge/" + encodeURIComponent(card.id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, reviewer, note }),
    });
    cards.value = cards.value.map((item) => item.id === card.id ? updated : item);
    // The query remains a snapshot; update its card status without pretending to rerun retrieval.
    if (result.value) result.value.knowledge = result.value.knowledge.map((item) => item.id === card.id ? updated : item);
    reviewNotice.value = "「" + card.title + "」" + (status === "reviewed" ? "已完成人工审核，尚未获得执行验证。" : "已拒绝。")
      + (result.value ? "重新检索可更新召回结果。" : "");
    reviewNote.value = "";
    reviewing.value.delete(card.id);
    await Promise.all([loadKnowledgePage(), loadHistoryPage()]);
  } catch (cause) {
    reviewErrors.value[card.id] = errorMessage(cause);
  } finally {
    reviewing.value.delete(card.id);
  }
}

onMounted(loadCards);
</script>

<template>
  <div class="workspace">
    <header class="site-header">
      <a
        class="brand"
        href="#main"
      ><span
        class="brand-mark"
        aria-hidden="true"
      >TK</span><span>TESTKNOWLEDGE</span></a>
      <div class="header-links">
        <span class="header-caption">项目测试知识</span><a
          href="/api/health"
          class="api-link"
        >API 状态 <span aria-hidden="true">↗</span></a>
      </div>
    </header>

    <main id="main">
      <section
        class="hero"
        aria-labelledby="page-title"
      >
        <div class="hero-copy">
          <p class="eyebrow">
            TEST KNOWLEDGE / WORKSPACE
          </p>
          <h1 id="page-title">
            让测试经验，<br>有据可循。
          </h1>
          <p class="hero-description">
            从项目已有的测试中查找断言、依赖与边界线索。<br>阅读事实，核对来源，再带入下一次测试。
          </p>
        </div>
        <dl
          class="workspace-stats"
          aria-label="全部知识卡片统计"
        >
          <div><dt>知识卡片</dt><dd>{{ loadingCards || listError ? '—' : cardCounts.total.toString().padStart(2, '0') }}</dd></div>
          <div><dt>待审核</dt><dd>{{ loadingCards || listError ? '—' : candidateCount.toString().padStart(2, '0') }}</dd></div>
          <div><dt>已审核</dt><dd>{{ loadingCards || listError ? '—' : reviewedCount.toString().padStart(2, '0') }}</dd></div>
        </dl>
      </section>

      <section
        class="query-panel"
        aria-labelledby="query-title"
      >
        <div class="query-intro">
          <span class="section-index">01 / RETRIEVE</span>
          <h2 id="query-title">
            从任务出发<br>查找测试证据
          </h2>
          <p>输入仓库路径与测试任务，查看关联的项目事实。</p>
          <span class="query-note">结果包含待审核卡片，请核对来源。</span>
        </div>
        <form
          class="query-form"
          :aria-busy="searching"
          @submit.prevent="search"
        >
          <label for="repo">仓库路径 <span>REPOSITORY</span></label>
          <input
            id="repo"
            v-model="repo"
            :disabled="scanning || searching"
            required
            spellcheck="false"
            placeholder="例如 D:\projects\your-project"
            @change="changeRepository"
          >
          <div
            class="scan-controls"
            :aria-busy="scanning"
          >
            <p class="muted">
              扫描 Python、Java、Go、Rust 的生产代码、测试来源与环境配置，更新该仓库的知识卡片。
            </p>
            <button
              type="button"
              class="button button-quiet"
              :disabled="!canScan"
              @click="scanRepository"
            >
              {{ scanning ? '正在扫描仓库…' : '扫描仓库' }}
            </button>
          </div>
          <p
            v-if="scanning"
            class="feedback"
            role="status"
          >
            正在扫描并抽取事实，请等待完成。
          </p>
          <p
            v-if="scanError"
            class="feedback feedback-error"
            role="alert"
          >
            {{ scanError }}
          </p>
          <div
            v-if="scanResult"
            class="feedback scan-summary"
            role="status"
          >
            <p>{{ scanResult.scan?.fileCount === 0 ? '扫描完成：未发现测试来源文件' : '扫描完成' }}</p>
            <p>{{ scanResult.repo }}</p>
            <p>{{ scanResult.scan?.fileCount ?? 0 }} 个来源文件 · {{ scanResult.evidenceCount }} 条证据 · {{ scanResult.clusterCount }} 个证据分组 · {{ scanResult.relationCount }} 条关系</p>
            <p v-if="scanResult.scan?.detectedLanguages?.length">
              已识别：{{ scanResult.scan.detectedLanguages.join('、') }} / {{ scanResult.scan.detectedFrameworks?.join('、') }}
            </p>
            <p>知识库卡片总数（含其他仓库及过期卡片）：{{ scanResult.knowledgeCount }}</p>
            <details v-if="scanResult.scan">
              <summary>扫描范围与配置</summary>
              <p>测试目录：{{ scanResult.scan.testDirectories.join('、') || '未发现' }}</p>
              <p>发现的根配置：{{ scanResult.scan.configFiles.join('、') || '无，使用 pytest 默认规则' }}</p>
              <p>环境来源：{{ scanResult.scan.environmentFiles.join('、') || '未发现' }}</p>
            </details>
            <ul v-if="scanResult.warnings.length">
              <li
                v-for="warning in scanResult.warnings"
                :key="warning"
              >
                {{ warning }}
              </li>
            </ul>
          </div>
          <label for="task">测试任务 <span>TEST TASK</span></label>
          <textarea
            id="task"
            v-model="task"
            required
            placeholder="例如：验证 load_dotenv 在 override 开启时如何处理已有环境变量"
          />
          <div class="query-submit">
            <span class="muted">描述目标行为，查找相关证据</span>
            <button
              class="button button-primary"
              :disabled="!canSearch"
              type="submit"
            >
              {{ searching ? '正在检索…' : '检索证据' }} <span aria-hidden="true">→</span>
            </button>
          </div>
          <p
            v-if="queryError"
            class="feedback feedback-error"
            role="alert"
          >
            {{ queryError }}
          </p>
        </form>
      </section>

      <section
        class="results-section"
        aria-labelledby="results-title"
        :aria-busy="searching"
      >
        <div class="section-heading">
          <div>
            <p class="section-index">
              02 / CONTEXT
            </p><h2 id="results-title">
              检索结果
            </h2>
          </div>
          <span
            v-if="result"
            class="status-label"
            :class="result.mode === 'ordinary_agent' ? 'status-stale' : 'status-verified'"
          >{{ result.mode === 'ordinary_agent' ? '普通 Agent 模式' : '证据增强模式' }}</span>
        </div>
        <div
          v-if="searching"
          class="empty-state"
          role="status"
        >
          <span
            class="state-marker"
            aria-hidden="true"
          >…</span><h3>正在查找关联证据</h3><p>结果将在请求完成后显示。</p>
        </div>
        <div v-else-if="result">
          <div class="result-summary">
            <p>任务 · {{ result.request.task }}</p><span>{{ result.knowledge.length }} 张卡片 · {{ result.observations.length }} 条机械事实 · {{ result.evidenceClusters.length }} 个分组 · {{ result.evidence.length }} 条证据 · {{ result.relations.length }} 条关系</span>
          </div>
          <p class="muted">
            影响范围来源 · {{ result.impactSummary.source }}
          </p>
          <p class="muted">
            目标对象 · {{ result.impactSummary.targetSymbols.join('、') || '未识别' }} · {{ result.impactSummary.targetSymbolSource }}
          </p>
          <p
            v-if="result.mode === 'ordinary_agent'"
            class="feedback"
            role="status"
          >
            {{ result.reason === 'no_applicable_reviewed_or_verified_knowledge' ? '没有适用的已审核或已验证知识，当前返回普通 Agent 模式。' : '未找到匹配的知识，当前返回普通 Agent 模式。' }}
          </p>
          <details
            v-if="result.abstentions.length"
            class="feedback"
          >
            <summary>当前上下文未提供的内容（{{ result.abstentions.length }}）</summary>
            <ul>
              <li
                v-for="item in result.abstentions"
                :key="item"
              >
                <code>{{ item }}</code>
              </li>
            </ul>
          </details>
          <ObservationList :observations="result.observations" />
          <details
            v-if="result.executionSignals.length"
            class="feedback execution-signals"
          >
            <summary>关联执行信号（{{ result.executionSignals.length }}）</summary>
            <article
              v-for="signal in result.executionSignals"
              :key="signal.evidenceId"
              class="execution-signal"
            >
              <p><strong>{{ signal.outcome }}</strong> · <code>{{ signal.command.join(' ') }}</code></p>
              <p>{{ signal.observed }}</p>
              <p class="muted">
                用例：{{ signal.testCounts.passed ?? '—' }} 通过 / {{ signal.testCounts.failed ?? '—' }} 失败 / {{ signal.testCounts.skipped ?? '—' }} 跳过
                · 行覆盖 {{ signal.coverage?.linesPercent ?? '—' }}%
                · 分支覆盖 {{ signal.coverage?.branchesPercent ?? '—' }}%
                · 变异分数 {{ signal.mutation?.scorePercent ?? '—' }}%
              </p>
              <ul v-if="signal.failures.length">
                <li
                  v-for="failure in signal.failures"
                  :key="failure.testId + failure.path + failure.line"
                >
                  <code>{{ failure.testId }}</code> · {{ failure.message }}
                </li>
              </ul>
            </article>
          </details>
          <div
            v-if="result.knowledge.length"
            class="card-grid"
          >
            <KnowledgeCardView
              v-for="card in result.knowledge"
              :key="card.id"
              :card="card"
              :retrieval="retrievalById.get(card.id)"
            />
          </div>
          <div
            v-else
            class="empty-state"
          >
            <span
              class="state-marker"
              aria-hidden="true"
            >∅</span><h3>暂无匹配的测试知识</h3><p>检查仓库路径，或换一个更具体的函数名、行为描述。</p>
          </div>
        </div>
        <div
          v-else
          class="empty-state"
        >
          <span
            class="state-marker"
            aria-hidden="true"
          >↳</span><h3>{{ queryError ? '本次检索未完成' : '等待一个测试任务' }}</h3><p>{{ queryError ? '请查看上方错误提示，调整后重新检索。' : '提交任务后，在这里查看关联卡片与召回来源。' }}</p>
        </div>
      </section>

      <section
        class="library-section"
        aria-labelledby="library-title"
        :aria-busy="loadingCards"
      >
        <div class="section-heading">
          <div>
            <p class="section-index">
              03 / KNOWLEDGE
            </p><h2 id="library-title">
              项目知识卡片 <span class="heading-count">{{ visibleCards.length }} / {{ cardTotal }}</span>
            </h2>
          </div>
          <button
            class="button button-quiet"
            :disabled="loadingCards || reviewing.size > 0 || reviewingClusters.size > 0 || scanning"
            @click="loadCards"
          >
            {{ loadingCards ? '加载中…' : '刷新列表' }}
          </button>
        </div>
        <p class="section-description">
          分组与知识卡分别审核；确认分组只表示这些证据可共同描述一个行为，不代表卡片或执行已经验证。
        </p>
        <p
          v-if="listError"
          class="feedback feedback-error"
          role="alert"
        >
          {{ listError }} 可点击“刷新列表”重试。
        </p>
        <p
          v-if="reviewNotice"
          class="feedback"
          role="status"
        >
          {{ reviewNotice }}
        </p>
        <RunLedgerView :repo="repo.trim()" />
        <div class="governance-inputs review-inputs">
          <label>治理人<input
            v-model="governanceReviewer"
            placeholder="请输入姓名或账号"
          ></label>
          <label>本次审核说明<input
            v-model="reviewNote"
            placeholder="写明核对依据；每次提交后会清空"
          ></label>
        </div>
        <div class="knowledge-filter">
          <label>卡片视图
            <select
              v-model="knowledgeView"
              @change="changeKnowledgeView"
            >
              <option value="candidates">全部待审（{{ candidateCount }}）</option>
              <option value="active">已审核 / 已验证</option>
              <option value="stale">过期历史</option>
              <option value="all">全部</option>
            </select>
          </label>
          <span v-if="knowledgeView === 'candidates'">展示所有来源的待审核卡片，包括语义抽取、规则抽取、Agent 起草与人工录入。</span>
        </div>
        <details
          v-if="activeProjectMap"
          class="feedback project-map"
        >
          <summary>测试项目地图 · {{ activeProjectMap.repo }}</summary>
          <p>{{ activeProjectMap.productionFiles.length }} 个生产文件 · {{ activeProjectMap.testFiles.length }} 个测试文件 · {{ activeProjectMap.fixtureSymbols.length }} 个 fixture · {{ activeProjectMap.setupSymbols.length }} 个生命周期钩子</p>
          <p>语言 / 框架：{{ activeProjectMap.languages.join('、') || '未识别' }} / {{ activeProjectMap.frameworks.join('、') || '未识别' }}</p>
          <p>测试目录：{{ activeProjectMap.testDirectories.join('、') || '未发现' }}</p>
          <p>配置：{{ activeProjectMap.configFiles.join('、') || '未发现' }}</p>
          <p>环境来源：{{ activeProjectMap.environmentFiles.join('、') || '未发现' }}</p>
          <ul v-if="activeProjectMap.runInstructions.length">
            <li
              v-for="instruction in activeProjectMap.runInstructions"
              :key="instruction.sourceRef + runInstructionText(instruction)"
            >
              <code>{{ runInstructionText(instruction) }}</code> · {{ instruction.sourceRef }}
            </li>
          </ul>
        </details>
        <details
          v-if="activeRelations.length"
          class="relation-map"
        >
          <summary>关系视图 · {{ activeRelations.length }} 条</summary>
          <div class="relation-list">
            <article
              v-for="relation in activeRelations"
              :key="relation.id"
              class="relation-edge"
            >
              <div class="relation-node">
                <span>{{ relation.from.kind }}</span><code>{{ relation.from.id }}</code>
              </div>
              <div class="relation-type">
                <strong>{{ relationNames[relation.type] }}</strong><code>{{ relation.type }}</code>
              </div>
              <div class="relation-node">
                <span>{{ relation.to.kind }}</span><code>{{ relation.to.id }}</code>
              </div>
              <p>{{ relation.evidenceIds.length }} 条来源证据 · {{ relation.source }} · 置信度 {{ relation.confidence.toFixed(2) }}</p>
              <p v-if="relation.resolution">
                冲突决议：{{ relation.resolution }} · {{ relation.actor }}
              </p>
            </article>
          </div>
        </details>
        <div
          v-if="clusters.length"
          class="cluster-list"
        >
          <article
            v-for="cluster in clusters"
            :key="cluster.id"
            class="knowledge-card cluster-card"
          >
            <header class="card-heading">
              <div>
                <p class="card-kind">
                  EVIDENCE CLUSTER
                </p><h3>{{ cluster.subject }}</h3>
              </div>
              <span
                class="status-label"
                :class="'status-' + cluster.status"
              >{{ cluster.status }}</span>
            </header>
            <p class="card-summary">
              行为形状 · {{ cluster.shape }}
            </p>
            <div class="card-source">
              <p>
                共享确定性信号：<code>{{ cluster.sharedSignals.join('；') }}</code>
              </p>
              <p>
                {{ cluster.evidenceIds.length }} 条证据 · {{ cluster.extractor }}
              </p>
              <EvidenceDetails
                :ids="cluster.evidenceIds"
                label="分组证据"
              />
            </div>
            <div
              v-if="cluster.status === 'candidate'"
              class="card-actions"
            >
              <span class="muted">先确认分组，再审核对应知识卡</span>
              <div class="button-group">
                <button
                  class="button button-quiet"
                  :disabled="reviewingClusters.has(cluster.id) || !governanceReviewer.trim() || !reviewNote.trim()"
                  @click="reviewCluster(cluster, 'rejected')"
                >
                  拒绝
                </button>
                <button
                  class="button button-review"
                  :disabled="reviewingClusters.has(cluster.id) || !governanceReviewer.trim() || !reviewNote.trim()"
                  @click="reviewCluster(cluster, 'reviewed')"
                >
                  确认分组
                </button>
              </div>
            </div>
          </article>
        </div>
        <div
          v-if="loadingCards && !cards.length"
          class="empty-state"
          role="status"
        >
          <h3>正在读取知识卡片</h3><p>从项目数据中加载已记录的事实。</p>
        </div>
        <div
          v-if="!loadingCards && visibleCards.length"
          class="card-grid"
        >
          <KnowledgeCardView
            v-for="card in visibleCards"
            :key="card.id"
            :card="card"
            :cluster-status="card.clusterId ? clusterById.get(card.clusterId)?.status : undefined"
            reviewable
            :busy="reviewing.has(card.id) || loadingCards || scanning"
            :error="reviewErrors[card.id] ?? ''"
            :can-review="Boolean(governanceReviewer.trim() && reviewNote.trim())"
            @review="review"
          />
        </div>
        <nav
          v-if="cardTotal > cardPageSize"
          class="pagination"
          aria-label="知识卡片分页"
        >
          <button
            type="button"
            class="button button-quiet"
            :disabled="loadingCards || cardPage === 0"
            @click="changeCardPage(-1)"
          >
            上一页
          </button>
          <span>第 {{ cardPage + 1 }} / {{ cardPageCount }} 页 · 当前页 {{ visibleCards.length }} 张</span>
          <button
            type="button"
            class="button button-quiet"
            :disabled="loadingCards || cardPage + 1 >= cardPageCount"
            @click="changeCardPage(1)"
          >
            下一页
          </button>
        </nav>
        <div
          v-if="!loadingCards && !visibleCards.length && cardTotal > 0 && !listError"
          class="empty-state"
        >
          <span
            class="state-marker"
            aria-hidden="true"
          >∅</span><h3>当前视图没有知识卡</h3><p>可切换卡片视图查看其他状态或来源。</p>
        </div>
        <div
          v-if="!loadingCards && !listError && !cardCounts.total"
          class="empty-state"
        >
          <span
            class="state-marker"
            aria-hidden="true"
          >[ ]</span><h3>知识卡片尚未建立</h3><p>输入仓库路径并点击“扫描仓库”，完成后在这里查看卡片。</p>
        </div>
      </section>
      <section
        class="library-section"
        aria-labelledby="history-title"
      >
        <div class="section-heading">
          <div>
            <p class="section-index">
              04 / GOVERNANCE
            </p><h2 id="history-title">
              版本审计 <span class="heading-count">{{ historyTotal }}</span>
            </h2>
          </div>
        </div>
        <p class="section-description">
          记录每次知识变更的前后快照。回滚按同一操作整组恢复，并重新进入待审核状态。
        </p>
        <div class="governance-inputs rollback-inputs">
          <label>回滚说明<input
            v-model="rollbackNote"
            placeholder="说明为什么恢复这个版本"
          ></label>
        </div>
        <p
          v-if="loadingHistory"
          class="muted"
          role="status"
        >
          正在读取当前页审计记录…
        </p>
        <div
          v-if="!loadingHistory && changes.length"
          class="history-list"
        >
          <article
            v-for="change in changes"
            :key="change.id"
            class="history-item"
          >
            <div>
              <p><strong>{{ actionNames[change.action] }}</strong> · {{ change.actor }}</p>
              <p class="muted">
                {{ new Date(change.createdAt).toLocaleString() }} · {{ change.knowledgeId }}
              </p>
              <p>{{ change.note }}</p>
            </div>
            <button
              class="button button-quiet"
              :disabled="!governanceReviewer.trim() || !rollbackNote.trim() || rollingBack.has(change.operationId)"
              @click="rollback(change)"
            >
              {{ rollingBack.has(change.operationId) ? '回滚中…' : '回滚此操作' }}
            </button>
          </article>
          <nav
            v-if="historyTotal > historyPageSize"
            class="pagination"
            aria-label="版本审计分页"
          >
            <button
              type="button"
              class="button button-quiet"
              :disabled="loadingHistory || historyPage === 0"
              @click="changeHistoryPage(-1)"
            >
              上一页
            </button>
            <span>第 {{ historyPage + 1 }} / {{ historyPageCount }} 页 · 当前页 {{ changes.length }} 条</span>
            <button
              type="button"
              class="button button-quiet"
              :disabled="loadingHistory || historyPage + 1 >= historyPageCount"
              @click="changeHistoryPage(1)"
            >
              下一页
            </button>
          </nav>
        </div>
        <div
          v-if="!loadingHistory && !changes.length"
          class="empty-state"
        >
          <span
            class="state-marker"
            aria-hidden="true"
          >↶</span><h3>暂无版本记录</h3><p>构建或审核知识后，会在这里留下可追溯快照。</p>
        </div>
      </section>
      <section
        class="library-section"
        aria-labelledby="evaluation-title"
      >
        <div class="section-heading">
          <div>
            <p class="section-index">
              05 / EVALUATION
            </p><h2 id="evaluation-title">
              A/B/C 行为评估 <span class="heading-count">{{ evaluationPlans.length }}</span>
            </h2>
          </div>
        </div>
        <p class="section-description">
          这里只展示冻结计划与外部执行证据，不在本项目中运行测试。只有三组结果齐全的任务才进入配对比较。
        </p>
        <div
          v-if="evaluationPlans.length"
          class="evaluation-list"
        >
          <article
            v-for="row in evaluationRows"
            :key="row.plan.id"
            class="evaluation-card"
          >
            <header class="evaluation-heading">
              <div>
                <p class="card-kind">
                  FROZEN PLAN · {{ row.plan.model }} · {{ row.plan.protocolVersion }}
                </p>
                <h3>{{ row.plan.id }}</h3>
                <p class="muted evaluation-revision">
                  {{ row.plan.repo }} · {{ row.plan.revision }}
                </p>
              </div>
              <span
                v-if="row.report"
                class="status-label"
                :class="row.report.verdict === 'improved' ? 'status-verified' : row.report.verdict === 'not_demonstrated' ? 'status-rejected' : 'status-stale'"
              >{{ evaluationVerdictNames[row.report.verdict] }}</span>
            </header>
            <dl class="evaluation-freeze">
              <div><dt>任务</dt><dd>{{ row.plan.tasks.length }}</dd></div>
              <div><dt>最大 Tokens</dt><dd>{{ row.plan.budget.maxTokens }}</dd></div>
              <div><dt>最大工具调用</dt><dd>{{ row.plan.budget.maxToolCalls }}</dd></div>
              <div><dt>最长耗时</dt><dd>{{ Math.round(row.plan.budget.maxDurationMs / 1000) }}s</dd></div>
            </dl>
            <label
              v-if="row.plan.protocolVersion === 'evaluation.v2' && row.runSetIds.length"
              class="evaluation-run-set"
            >
              <span>运行批次</span>
              <select
                v-model="evaluationRunSetSelection[row.plan.id]"
                @change="selectEvaluationRunSet(row.plan.id)"
              >
                <option
                  v-if="row.runSetIds.length > 1"
                  value=""
                >请选择一个批次</option>
                <option
                  v-for="runSetId in row.runSetIds"
                  :key="runSetId"
                  :value="runSetId"
                >{{ runSetId }}</option>
              </select>
            </label>
            <div class="evaluation-variants">
              <div
                v-for="variant in evaluationVariants"
                :key="variant"
              >
                <p>{{ evaluationVariantNames[variant] }}</p>
                <strong>{{ row.observationCounts[variant] }} / {{ row.plan.tasks.length }}</strong>
                <span class="evaluation-tools">工具：{{ (row.plan.variantTools?.[variant] ?? row.plan.tools).join('、') }}</span>
                <template v-if="row.report">
                  <span>执行通过 {{ percentage(row.report.variants[variant].executionPassRate) }}</span>
                  <span>边界覆盖 {{ percentage(row.report.variants[variant].boundaryCoverageRate) }}</span>
                  <span>有效 Oracle {{ percentage(row.report.variants[variant].effectiveOracleRate) }}</span>
                  <span>无效 / 重复 / 脆弱：{{ row.report.variants[variant].invalidAssertionCount }} / {{ row.report.variants[variant].duplicateTestCount }} / {{ row.report.variants[variant].brittleTestCount }}</span>
                </template>
              </div>
            </div>
            <div
              v-if="row.report"
              class="evaluation-result"
            >
              <p>完整配对任务 {{ row.report.completeTaskCount }} · C 相对 B：{{ row.report.taskWins }} 胜 / {{ row.report.taskLosses }} 负 / {{ row.report.taskTies }} 平</p>
              <p class="muted">
                Token {{ percentage(row.report.deltaCvsB.tokenIncreaseRatio) }} · 工具调用 {{ percentage(row.report.deltaCvsB.toolCallIncreaseRatio) }} · 耗时 {{ percentage(row.report.deltaCvsB.durationIncreaseRatio) }}
              </p>
              <p class="muted">
                C−B 低质测试：无效断言 {{ row.report.deltaCvsB.invalidAssertionCount }} · 重复 {{ row.report.deltaCvsB.duplicateTestCount }} · 脆弱 {{ row.report.deltaCvsB.brittleTestCount }}
              </p>
              <p v-if="row.report.reasons.length">
                未满足条件：<code>{{ row.report.reasons.join(' · ') }}</code>
              </p>
            </div>
          </article>
        </div>
        <div
          v-else
          class="empty-state"
        >
          <span
            class="state-marker"
            aria-hidden="true"
          >A/B/C</span><h3>尚未冻结评估计划</h3><p>先固定仓库版本、模型、任务、提示词、工具和预算，再导入隔离执行结果。</p>
        </div>
      </section>
    </main>
    <footer class="site-footer">
      <span>TESTKNOWLEDGE</span><span>事实 · 来源 · 审核</span>
    </footer>
  </div>
</template>
