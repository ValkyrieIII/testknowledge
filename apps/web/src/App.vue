<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { ContextPack, KnowledgeCard } from "@testknowledge/model";

const cards = ref<KnowledgeCard[]>([]);
const task = ref("输入测试任务或行为，例如：load_dotenv override 环境变量");
const repo = ref("");
const result = ref<ContextPack | null>(null);
const error = ref("");

async function loadCards(): Promise<void> {
  const response = await fetch("/api/knowledge");
  cards.value = await response.json() as KnowledgeCard[];
}

async function search(): Promise<void> {
  error.value = "";
  try {
    const response = await fetch("/api/context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo: repo.value, task: task.value, changedFiles: [], targetSymbols: [], includeCandidates: true, limit: 8 }) });
    if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? "查询失败");
    result.value = await response.json() as ContextPack;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "查询失败";
  }
}

async function review(card: KnowledgeCard, status: "verified" | "rejected"): Promise<void> {
  error.value = "";
  try {
    const response = await fetch(`/api/knowledge/${encodeURIComponent(card.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status, reviewer: "local-user", note: status === "verified" ? "本地审核通过" : "本地审核拒绝" }) });
    if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? "审核失败");
    await loadCards();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "审核失败";
  }
}

onMounted(async () => { await loadCards(); if (cards.value[0]) repo.value = cards.value[0].repo; });
</script>

<template>
  <main>
    <header>
      <div>
        <p class="eyebrow">
          TESTKNOWLEDGE
        </p>
        <h1>测试知识工作台</h1>
        <p class="muted">
          从项目证据中找到下一条测试应该关注什么。
        </p>
      </div>
      <a href="/api/health">API 状态</a>
    </header>

    <section class="panel query">
      <h2>查询 Context Pack</h2>
      <label>
        仓库路径
        <input
          v-model="repo"
          placeholder="/path/to/repository"
        >
      </label>
      <label>
        测试任务
        <textarea v-model="task" />
      </label>
      <button @click="search">
        检索证据
      </button>
      <p
        v-if="error"
        class="error"
      >
        {{ error }}
      </p>
    </section>

    <section
      v-if="result"
      class="panel"
    >
      <div class="result-head">
        <h2>检索结果</h2>
        <span :class="['tag', result.mode]">{{ result.mode }}</span>
      </div>
      <p
        v-if="result.reason"
        class="muted"
      >
        {{ result.reason }}
      </p>
      <article
        v-for="card in result.knowledge"
        :key="card.id"
      >
        <div class="result-head">
          <h3>{{ card.title }}</h3>
          <span class="tag">{{ card.status }}</span>
        </div>
        <p>{{ card.statement }}</p>
        <small>
          召回：{{ result.retrieval.find((item) => item.id === card.id)?.channels.join(" + ") }}
          · 来源：{{ card.evidenceIds.join(", ") }}
        </small>
      </article>
    </section>

    <section class="panel">
      <div class="result-head">
        <h2>知识卡片</h2>
        <span class="muted">{{ cards.length }} 条</span>
      </div>
      <article
        v-for="card in cards"
        :key="card.id"
      >
        <div class="result-head">
          <h3>{{ card.title }}</h3>
          <span class="tag">{{ card.status }}</span>
        </div>
        <p>{{ card.statement }}</p>
        <small>{{ card.path }} · {{ card.symbol }}</small>
        <div
          v-if="card.status === 'candidate'"
          class="actions"
        >
          <button @click="review(card, 'verified')">
            审核通过
          </button>
          <button
            class="secondary"
            @click="review(card, 'rejected')"
          >
            拒绝
          </button>
        </div>
      </article>
    </section>
  </main>
</template>
