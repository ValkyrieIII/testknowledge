<script setup lang="ts">
import { computed } from "vue";
import type { ContextPack, EvidenceClusterStatus, KnowledgeCard, KnowledgeKind, KnowledgeStatus, ObservedFacts, TestTechnique } from "@testknowledge/model";
import EvidenceDetails from "./EvidenceDetails.vue";

const props = withDefaults(defineProps<{
  card: KnowledgeCard;
  retrieval?: ContextPack["retrieval"][number] | undefined;
  reviewable?: boolean;
  canReview?: boolean;
  busy?: boolean;
  error?: string;
  clusterStatus?: EvidenceClusterStatus | undefined;
}>(), { retrieval: undefined, reviewable: false, canReview: true, busy: false, error: "", clusterStatus: undefined });
defineEmits<{ review: [card: KnowledgeCard, status: "reviewed" | "rejected"] }>();

const kinds: Record<KnowledgeKind, string> = {
  fixture: "测试前置", mock: "模拟依赖", boundary: "边界", assertion: "断言",
  behavior: "行为", execution_recipe: "执行步骤", historical_bug: "历史缺陷",
  environment: "测试环境",
};
const statuses: Record<KnowledgeStatus, string> = {
  candidate: "待审核", reviewed: "已审核", verified: "已验证", rejected: "已拒绝", stale: "已过期",
};
const techniqueNames: Record<TestTechnique, string> = {
  boundary_value: "边界值", equivalence_partition: "等价类", parameterized_input: "参数化输入",
  exception_path: "异常路径", error_handling: "错误处理", dependency_isolation: "依赖隔离",
  fixture_injection: "Fixture 注入", round_trip: "往返", state_transition: "状态转换",
  ordering: "顺序", idempotence: "幂等", property_based: "属性测试",
  snapshot_regression: "快照回归", concurrency: "并发", equivalence_assertion: "等价性断言",
};
const fields: Array<{ key: keyof ObservedFacts; label: string }> = [
  { key: "assertions", label: "断言" },
  { key: "expectedExceptions", label: "预期异常" },
  { key: "mocks", label: "Mock / Patch" },
  { key: "factories", label: "Factory" },
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
    <ul
      v-if="card.techniques.length"
      class="technique-list"
      aria-label="测试设计手法"
    >
      <li
        v-for="technique in card.techniques"
        :key="technique"
      >
        {{ techniqueNames[technique] }}
      </li>
    </ul>
    <div class="knowledge-contract">
      <dl class="contract-fields">
        <div><dt>触发场景</dt><dd>{{ card.trigger }}</dd></div>
        <div><dt>预期行为</dt><dd>{{ card.expectedBehavior }}</dd></div>
        <div><dt>Oracle</dt><dd>{{ card.oracle }}</dd></div>
        <div v-if="card.risk">
          <dt>风险</dt><dd>{{ card.risk }}</dd>
        </div>
        <div v-if="card.partitions.length">
          <dt>输入分区</dt><dd>{{ card.partitions.join('；') }}</dd>
        </div>
        <div v-if="card.preconditions.length">
          <dt>前置条件</dt><dd>{{ card.preconditions.join('；') }}</dd>
        </div>
        <div v-if="card.dependencies.length">
          <dt>依赖</dt><dd>{{ card.dependencies.join('；') }}</dd>
        </div>
        <div><dt>适用语言 / 框架</dt><dd>{{ card.applicability.languages.join('、') || '未限定' }} / {{ card.applicability.frameworks.join('、') || '未限定' }}</dd></div>
        <div><dt>适用路径</dt><dd><code>{{ card.applicability.paths.join('、') || '未限定' }}</code></dd></div>
        <div><dt>适用符号</dt><dd><code>{{ card.applicability.symbols.join('、') || '未限定' }}</code></dd></div>
        <div v-if="card.applicability.revision">
          <dt>适用修订</dt><dd><code>{{ card.applicability.revision }}</code></dd>
        </div>
      </dl>
    </div>
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
        <div><dt>候选来源</dt><dd><code>{{ card.proposalProvenance.source }} · {{ card.proposalProvenance.actor }}</code></dd></div>
        <div><dt>起草说明</dt><dd>{{ card.proposalProvenance.note }}</dd></div>
        <div v-if="card.clusterId">
          <dt>分组</dt><dd><code>{{ card.clusterId }} · {{ clusterStatus ?? 'missing' }}</code></dd>
        </div>
      </dl>
      <EvidenceDetails :ids="card.evidenceIds" />
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
      <span class="muted">{{ !canReview ? '请先填写治理人和本次审核说明' : card.clusterId && clusterStatus !== 'reviewed' ? '请先确认对应证据分组' : '核对事实后确认' }}</span>
      <div class="button-group">
        <button
          class="button button-quiet"
          :disabled="busy || !canReview"
          @click="$emit('review', card, 'rejected')"
        >
          拒绝
        </button>
        <button
          class="button button-review"
          :disabled="busy || !canReview || Boolean(card.clusterId && clusterStatus !== 'reviewed')"
          @click="$emit('review', card, 'reviewed')"
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
