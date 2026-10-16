<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import { useData, withBase } from 'vitepress';
import { computed } from 'vue';

const { Layout } = DefaultTheme;
const { page } = useData();

// The raw Markdown source is emitted alongside the HTML at build time
// (see buildEnd in config.ts), so `guide/introduction.md` is fetchable at
// `/guide/introduction.md`.
const mdHref = computed(() => withBase('/' + page.value.relativePath));
</script>

<template>
  <Layout>
    <!-- Doc pages: above the page content. -->
    <template #doc-before>
      <div class="for-llms">
        <a class="for-llms-btn" :href="mdHref" target="_blank" rel="noreferrer">
          <span class="for-llms-icon">🤖</span>
          For LLMs
          <span class="for-llms-hint">view raw Markdown</span>
        </a>
      </div>
    </template>

    <!-- Home page (home layout has no doc-before slot): under the features. -->
    <template #home-features-after>
      <div class="for-llms for-llms--home">
        <a class="for-llms-btn" :href="mdHref" target="_blank" rel="noreferrer">
          <span class="for-llms-icon">🤖</span>
          For LLMs
          <span class="for-llms-hint">view raw Markdown</span>
        </a>
      </div>
    </template>
  </Layout>
</template>

<style scoped>
.for-llms {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 12px;
}
.for-llms--home {
  justify-content: center;
  margin: 8px auto 0;
  padding: 0 24px;
  max-width: 1152px;
}
.for-llms-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  padding: 6px 10px;
  border: 1px solid var(--vp-c-border);
  border-radius: 8px;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  transition:
    color 0.2s,
    border-color 0.2s,
    background-color 0.2s;
}
.for-llms-btn:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-bg);
}
.for-llms-hint {
  color: var(--vp-c-text-3);
  font-weight: 400;
}
.for-llms-btn:hover .for-llms-hint {
  color: var(--vp-c-brand-1);
}
</style>
