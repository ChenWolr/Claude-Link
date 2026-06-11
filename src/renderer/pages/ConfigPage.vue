<template>
  <section class="page">
    <p class="page__eyebrow">Settings</p>
    <h1>配置页</h1>
    <p>供应商、密钥、模型和 Claude Code CLI 状态将在这里管理。</p>
  </section>
</template>

<style scoped>
.page {
  padding: 32px;
}

.page__eyebrow {
  margin: 0 0 8px;
  color: var(--color-accent-strong);
  font-size: 12px;
  font-weight: 700;
}

.page h1 {
  margin: 0;
  font-size: 24px;
}

.page p:last-child {
  max-width: 520px;
  margin: 12px 0 0;
  color: var(--color-text-muted);
}
</style>
