<script setup lang="ts">
import { computed } from "vue";
import type { Observation, ObservationKind } from "@testknowledge/model";
import EvidenceDetails from "./EvidenceDetails.vue";

const props = defineProps<{ observations: Observation[] }>();
const kindNames: Record<ObservationKind, string> = {
  fixture: "测试前置", mock: "模拟依赖", assertion: "断言", exception: "预期异常",
  parametrization: "参数化", lifecycle: "生命周期", environment: "测试环境",
  test_location: "测试位置", dependency: "测试依赖", run_instruction: "执行步骤", history: "历史记录",
};
const groups = computed(() => (Object.keys(kindNames) as ObservationKind[])
  .map((kind) => ({ kind, label: kindNames[kind], items: props.observations.filter((item) => item.kind === kind) }))
  .filter((group) => group.items.length));
</script>

<template>
  <details class="feedback observations">
    <summary>机械事实（{{ observations.length }} 条）</summary>
    <p class="muted">
      根据本次查询的来源证据计算。
    </p>
    <p
      v-if="!observations.length"
      class="muted"
    >
      本次查询没有匹配的机械事实。
    </p>
    <section
      v-for="group in groups"
      :key="group.kind"
    >
      <h3>{{ group.label }}（{{ group.items.length }}）</h3>
      <article
        v-for="item in group.items"
        :key="item.id"
        class="observation"
      >
        <p class="statement">
          {{ item.statement }}
        </p>
        <p class="muted">
          <code>{{ item.sourceRef }}</code> · 第 {{ item.lineStart }}–{{ item.lineEnd }} 行
        </p>
        <EvidenceDetails :ids="item.evidenceIds" />
      </article>
    </section>
  </details>
</template>

<style scoped>
.observation { padding: 12px 0; border-top: 1px solid var(--border); overflow-wrap: anywhere; }
.statement { white-space: pre-wrap; }
</style>
