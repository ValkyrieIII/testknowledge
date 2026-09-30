<script setup lang="ts">
import { ref, watch } from "vue";
import type { ExecutionRun, RunItem, RunStage, RunDisposition, RunErrorCode } from "@testknowledge/model";
import { errorMessage, requestJson } from "../api.js";

const props = defineProps<{ repo: string }>();
const opened = ref(false);
const runs = ref<ExecutionRun[]>([]);
const loading = ref(false);
const error = ref("");
const items = ref<Record<string, RunItem[]>>({});
const itemErrors = ref<Record<string, string>>({});
const loadingItems = ref(new Set<string>());
let generation = 0;
const stageNames: Record<RunStage, string> = {
  scan: "仓库扫描", source_evidence: "源码证据", project_evidence: "项目证据", partition: "证据分片",
  knowledge_extraction: "知识抽取", rule_extraction: "规则抽取", cluster_materialization: "生成证据分组",
  card_materialization: "生成知识卡", relations: "生成关系", index_rebuild: "重建索引",
};
const dispositionNames: Record<RunDisposition, string> = { done: "完成", failed: "失败", skipped: "跳过" };
const errorNames: Record<RunErrorCode, string> = {
  timeout: "请求超时", http_4xx: "请求错误（HTTP 4xx）", http_5xx: "服务端错误（HTTP 5xx）",
  parse: "响应解析失败", unknown: "未知错误",
};

async function load(): Promise<void> {
  const current = ++generation;
  loading.value = true;
  error.value = "";
  runs.value = [];
  items.value = {};
  itemErrors.value = {};
  loadingItems.value = new Set();
  try {
    const query = props.repo ? `?repo=${encodeURIComponent(props.repo)}` : "";
    const next = await requestJson<ExecutionRun[]>(`/api/runs${query}`);
    if (current === generation) runs.value = next.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  } catch (cause) {
    if (current === generation) error.value = errorMessage(cause);
  } finally {
    if (current === generation) loading.value = false;
  }
}

async function loadItems(runId: string): Promise<void> {
  if (loadingItems.value.has(runId) || items.value[runId]) return;
  const current = generation;
  loadingItems.value.add(runId);
  itemErrors.value[runId] = "";
  try {
    const next = await requestJson<RunItem[]>(`/api/runs/${encodeURIComponent(runId)}/items`);
    if (current === generation) items.value[runId] = next;
  } catch (cause) {
    if (current === generation) itemErrors.value[runId] = errorMessage(cause);
  } finally {
    if (current === generation) loadingItems.value.delete(runId);
  }
}

function toggle(event: Event): void {
  opened.value = (event.currentTarget as HTMLDetailsElement).open;
  if (opened.value) void load();
}
function toggleRun(event: Event, runId: string): void {
  if ((event.currentTarget as HTMLDetailsElement).open) void loadItems(runId);
}
watch(() => props.repo, () => {
  if (opened.value) void load();
  else { generation++; runs.value = []; }
});
</script>

<template>
  <details
    class="feedback run-ledger"
    @toggle="toggle"
  >
    <summary>运行台账</summary>
    <p class="muted">
      运行及条目在阶段结束后可见。长阶段执行期间可能暂无记录；此处不表示实时进度。
    </p>
    <button
      type="button"
      class="button button-quiet"
      :disabled="loading"
      @click="load"
    >
      {{ loading ? '正在读取…' : '刷新台账' }}
    </button>
    <p
      v-if="error"
      class="feedback-error"
      role="alert"
    >
      {{ error }} 请刷新重试。
    </p>
    <p
      v-else-if="!loading && !runs.length"
      class="muted"
    >
      当前仓库暂无运行记录，阶段结束后可刷新查看。
    </p>
    <div :aria-busy="loading">
      <details
        v-for="run in runs"
        :key="run.id"
        class="ledger-run"
        @toggle="toggleRun($event, run.id)"
      >
        <summary>
          {{ stageNames[run.stage] }} · <span :class="{ 'feedback-error': run.disposition === 'failed' }">{{ dispositionNames[run.disposition] }}</span>
          · {{ run.durationMs }} ms · {{ new Date(run.startedAt).toLocaleString() }}
        </summary>
        <p class="muted">
          {{ run.repo }} · {{ run.extractor }} · 第 {{ run.attempt }} 次尝试
        </p>
        <p>
          <span
            v-for="(count, name) in run.counts"
            :key="name"
            class="run-count"
          >{{ name }}：{{ count }}</span><span
            v-if="!Object.keys(run.counts).length"
            class="muted"
          >未记录计数</span>
        </p>
        <p
          v-if="run.errorCode || run.errorMessage"
          class="feedback-error"
        >
          {{ run.errorCode ? errorNames[run.errorCode] : '' }} {{ run.errorMessage }}
        </p>
        <ul v-if="run.warnings.length">
          <li
            v-for="warning in run.warnings"
            :key="warning"
          >
            {{ warning }}
          </li>
        </ul>
        <p
          v-if="loadingItems.has(run.id)"
          role="status"
        >
          正在读取条目…
        </p>
        <div
          v-else-if="itemErrors[run.id]"
          role="alert"
        >
          <p class="feedback-error">
            {{ itemErrors[run.id] }}
          </p>
          <button
            type="button"
            class="button button-quiet"
            @click="loadItems(run.id)"
          >
            重试读取条目
          </button>
        </div>
        <p
          v-else-if="items[run.id]?.length === 0"
          class="muted"
        >
          此阶段未记录条目明细；条目按阶段批量写入。
        </p>
        <article
          v-for="item in items[run.id] ?? []"
          :key="item.id"
          class="ledger-item"
          :class="{ 'feedback-error': item.disposition === 'failed' }"
        >
          <p><code>{{ item.itemKey }}</code> · {{ dispositionNames[item.disposition] }} · {{ item.durationMs }} ms</p>
          <p v-if="item.errorCode || item.errorMessage">
            {{ item.errorCode ? errorNames[item.errorCode] : '' }} {{ item.errorMessage }}
          </p>
        </article>
      </details>
    </div>
  </details>
</template>

<style scoped>
.run-ledger { overflow-wrap: anywhere; }
.ledger-run { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); }
.ledger-item { padding: 8px 14px; margin-top: 8px; border-left: 2px solid var(--border); }
.ledger-item.feedback-error { border-color: currentColor; }
.run-count { display: inline-block; margin-right: 16px; }
</style>
