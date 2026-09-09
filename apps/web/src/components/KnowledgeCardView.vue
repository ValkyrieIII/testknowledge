<script setup lang="ts">
import { computed } from "vue";
import type { ContextPack, KnowledgeCard, KnowledgeKind, KnowledgeStatus, ObservedFacts } from "@testknowledge/model";

const props = withDefaults(defineProps<{
  card: KnowledgeCard;
  retrieval?: ContextPack["retrieval"][number] | undefined;
  reviewable?: boolean;
  busy?: boolean;
  error?: string;
}>(), { retrieval: undefined, reviewable: false, busy: false, error: "" });
defineEmits<{ review: [card: KnowledgeCard, status: "verified" | "rejected"] }>();

const kinds: Record<KnowledgeKind, string> = {
  fixture: "测试前置", mock: "模拟依赖", boundary: "边界", assertion: "断言",
  behavior: "行为", execution_recipe: "执行步骤", historical_bug: "历史缺陷",
};
const statuses: Record<KnowledgeStatus, string> = {
  candidate: "待审核", verified: "已审核", rejected: "已拒绝", stale: "已过期",
};
const fields: Array<{ key: keyof ObservedFacts; label: string }> = [
  { key: "assertions", label: "断言" },
  { key: "expectedExceptions", label: "预期异常" },
  { key: "mocks", label: "Mock / Patch" },
  { key: "dependencies", label: "测试依赖" },
  { key: "parametrize", label: "参数化" },
];
const facts = computed(() => fields.map((field) => ({
  ...field,
  values: (props.card.observed?.[field.key] ?? []).filter((value) => value.trim().length > 0),
})).filter((field) => field.values.length > 0));
const channelNames = { exact: "精确匹配", bm25f: "文本检索", dense: "语义检索" };
</script>

<template>
  <article
    class="knowledge-card"
    :aria-busy="busy"
  >
    <header class="card-heading">
      <div class="card-title-block">
        <p class="card-kind">
          {{ kinds[card.kind] }}
        </p>
        <h3>{{ card.title }}</h3>
      </div>
      <span
        class="status-label"
        :class="'status-' + card.status"
      >{{ statuses[card.status] }}</span>
    </header>
    <p class="card-summary">
      {{ card.statement }}
    </p>
    <div class="observed-facts">
      <div class="facts-heading">
        <span class="eyebrow">OBSERVED FACTS</span>
        <span>来源中记录的事实</span>
      </div>
      <dl
        v-if="facts.length"
        class="fact-list"
      >
        <div
          v-for="field in facts"
          :key="field.key"
          class="fact-group"
        >
          <dt>{{ field.label }} <span class="fact-count">{{ field.values.length }}</span></dt>
          <dd>
            <ul>
              <li
                v-for="(value, index) in field.values"
                :key="index"
              >
                <code>{{ value }}</code>
              </li>
            </ul>
          </dd>
        </div>
      </dl>
      <p
        v-else
        class="facts-empty"
      >
        未记录结构化事实
      </p>
    </div>
    <footer class="card-source">
      <dl class="source-fields">
        <div><dt>文件</dt><dd><code>{{ card.path }}</code></dd></div>
        <div><dt>符号</dt><dd><code>{{ card.symbol || "未记录符号" }}</code></dd></div>
      </dl>
      <details class="evidence-details">
        <summary>{{ card.evidenceIds.length }} 条来源证据</summary>
        <ul>
          <li
            v-for="id in card.evidenceIds"
            :key="id"
          >
            <code>{{ id }}</code>
          </li>
        </ul>
      </details>
      <p
        v-if="retrieval"
        class="retrieval-source"
      >
        召回方式 · {{ retrieval.channels.map((channel) => channelNames[channel]).join(" / ") }}
      </p>
    </footer>
    <div
      v-if="reviewable && card.status === 'candidate'"
      class="card-actions"
    >
      <span class="muted">核对事实后确认</span>
      <div class="button-group">
        <button
          class="button button-quiet"
          :disabled="busy"
          @click="$emit('review', card, 'rejected')"
        >
          拒绝
        </button>
        <button
          class="button button-review"
          :disabled="busy"
          @click="$emit('review', card, 'verified')"
        >
          {{ busy ? "提交中…" : "审核通过" }}
        </button>
      </div>
    </div>
    <p
      v-if="error"
      class="feedback feedback-error card-feedback"
      role="alert"
    >
      {{ error }}
    </p>
  </article>
</template>
