<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { BuildResult, ContextPack, KnowledgeCard } from "@testknowledge/model";
import KnowledgeCardView from "./components/KnowledgeCardView.vue";
import { errorMessage, requestJson } from "./api.js";

const cards = ref<KnowledgeCard[]>([]);
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
const reviewNotice = ref("");
const candidateCount = computed(() => cards.value.filter((card) => card.status === "candidate").length);
const verifiedCount = computed(() => cards.value.filter((card) => card.status === "verified").length);
const retrievalById = computed(() => new Map(result.value?.retrieval.map((hit) => [hit.id, hit]) ?? []));
const canSearch = computed(() => Boolean(repo.value.trim() && task.value.trim()) && !searching.value && !scanning.value);
const canScan = computed(() => Boolean(repo.value.trim()) && !scanning.value && !searching.value && !loadingCards.value && reviewing.value.size === 0);

async function scanRepository(): Promise<void> {
  if (!canScan.value) return;
  scanning.value = true;
  scanError.value = "";
  scanResult.value = null;
  try {
    scanResult.value = await requestJson<BuildResult>("/api/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: repo.value.trim(), useLlm: false }),
    });
    repo.value = scanResult.value.repo;
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

async function loadCards(): Promise<void> {
  if (loadingCards.value || reviewing.value.size > 0) return;
  loadingCards.value = true;
  listError.value = "";
  try {
    cards.value = await requestJson<KnowledgeCard[]>("/api/knowledge");
    if (!repo.value && cards.value[0]) repo.value = cards.value[0].repo;
  } catch (cause) {
    listError.value = errorMessage(cause);
  } finally {
    loadingCards.value = false;
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

async function review(card: KnowledgeCard, status: "verified" | "rejected"): Promise<void> {
  if (reviewing.value.has(card.id) || loadingCards.value || scanning.value) return;
  reviewing.value.add(card.id);
  reviewErrors.value[card.id] = "";
  reviewNotice.value = "";
  try {
    const updated = await requestJson<KnowledgeCard>("/api/knowledge/" + encodeURIComponent(card.id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, reviewer: "local-user", note: status === "verified" ? "本地审核通过" : "本地审核拒绝" }),
    });
    cards.value = cards.value.map((item) => item.id === card.id ? updated : item);
    // The query remains a snapshot; update its card status without pretending to rerun retrieval.
    if (result.value) result.value.knowledge = result.value.knowledge.map((item) => item.id === card.id ? updated : item);
    reviewNotice.value = "「" + card.title + "」" + (status === "verified" ? "已审核通过。" : "已拒绝。")
      + (result.value ? "重新检索可更新召回结果。" : "");
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
          <div><dt>知识卡片</dt><dd>{{ loadingCards || listError ? '—' : cards.length.toString().padStart(2, '0') }}</dd></div>
          <div><dt>待审核</dt><dd>{{ loadingCards || listError ? '—' : candidateCount.toString().padStart(2, '0') }}</dd></div>
          <div><dt>已审核</dt><dd>{{ loadingCards || listError ? '—' : verifiedCount.toString().padStart(2, '0') }}</dd></div>
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
          >
          <div
            class="scan-controls"
            :aria-busy="scanning"
          >
            <p class="muted">
              扫描 test/tests 目录中的 Python 测试来源，更新该仓库的知识卡片。
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
            <p>{{ scanResult.scan?.fileCount ?? 0 }} 个来源文件 · {{ scanResult.evidenceCount }} 条证据</p>
            <p>知识库卡片总数（含其他仓库及过期卡片）：{{ scanResult.knowledgeCount }}</p>
            <details v-if="scanResult.scan">
              <summary>扫描范围与配置</summary>
              <p>测试目录：{{ scanResult.scan.testDirectories.join('、') || '未发现' }}</p>
              <p>发现的根配置：{{ scanResult.scan.configFiles.join('、') || '无，使用 pytest 默认规则' }}</p>
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
            <p>任务 · {{ result.request.task }}</p><span>{{ result.knowledge.length }} 张卡片 · {{ result.evidence.length }} 条证据</span>
          </div>
          <p
            v-if="result.mode === 'ordinary_agent'"
            class="feedback"
            role="status"
          >
            {{ result.reason === 'no_applicable_verified_knowledge' ? '没有适用的已审核知识，当前返回普通 Agent 模式。' : '未找到匹配的知识，当前返回普通 Agent 模式。' }}
          </p>
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
              项目知识卡片 <span class="heading-count">{{ cards.length }}</span>
            </h2>
          </div>
          <button
            class="button button-quiet"
            :disabled="loadingCards || reviewing.size > 0 || scanning"
            @click="loadCards"
          >
            {{ loadingCards ? '加载中…' : '刷新列表' }}
          </button>
        </div>
        <p class="section-description">
          全部仓库的函数级事实卡片。审核状态表示人工确认，不代表执行验证。
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
        <div
          v-if="loadingCards && !cards.length"
          class="empty-state"
          role="status"
        >
          <h3>正在读取知识卡片</h3><p>从项目数据中加载已记录的事实。</p>
        </div>
        <div
          v-else-if="cards.length"
          class="card-grid"
        >
          <KnowledgeCardView
            v-for="card in cards"
            :key="card.id"
            :card="card"
            reviewable
            :busy="reviewing.has(card.id) || loadingCards || scanning"
            :error="reviewErrors[card.id] ?? ''"
            @review="review"
          />
        </div>
        <div
          v-else-if="!listError"
          class="empty-state"
        >
          <span
            class="state-marker"
            aria-hidden="true"
          >[ ]</span><h3>知识卡片尚未建立</h3><p>输入仓库路径并点击“扫描仓库”，完成后在这里查看卡片。</p>
        </div>
      </section>
    </main>
    <footer class="site-footer">
      <span>TESTKNOWLEDGE</span><span>事实 · 来源 · 审核</span>
    </footer>
  </div>
</template>
