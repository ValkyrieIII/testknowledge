<script setup lang="ts">
import { ref } from "vue";
import type { Evidence } from "@testknowledge/model";
import { requestJson } from "../api.js";

const props = withDefaults(defineProps<{
  ids: string[];
  label?: string;
}>(), { label: "来源证据" });

const evidenceById = ref<Record<string, Evidence>>({});
const loading = ref(false);
const error = ref("");

async function load(event: Event): Promise<void> {
  if (!(event.currentTarget as HTMLDetailsElement).open || loading.value) return;
  const missing = props.ids.filter((id) => !evidenceById.value[id]);
  if (missing.length === 0) return;
  loading.value = true;
  error.value = "";
  try {
    const loaded = await Promise.all(missing.map(async (id) => [id, await requestJson<Evidence>("/api/evidence/" + encodeURIComponent(id))] as const));
    evidenceById.value = { ...evidenceById.value, ...Object.fromEntries(loaded) };
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "读取来源证据失败";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <details
    class="evidence-details"
    @toggle="load"
  >
    <summary>{{ ids.length }} 条{{ label }}</summary>
    <p
      v-if="loading"
      class="muted"
    >
      正在读取证据…
    </p>
    <p
      v-if="error"
      class="feedback feedback-error evidence-error"
      role="alert"
    >
      {{ error }}
    </p>
    <ul>
      <li
        v-for="id in ids"
        :key="id"
      >
        <code>{{ id }}</code>
        <template v-if="evidenceById[id]">
          <p class="evidence-source">
            {{ evidenceById[id]!.sourceType }} · {{ evidenceById[id]!.sourceRef }} ·
            第 {{ evidenceById[id]!.lineStart }}–{{ evidenceById[id]!.lineEnd }} 行
          </p>
          <pre class="evidence-content">{{ evidenceById[id]!.content }}</pre>
        </template>
      </li>
    </ul>
  </details>
</template>
