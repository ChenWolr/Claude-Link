<template>
  <section class="page">
    <p class="page__eyebrow">Sessions</p>
    <h1>会话管理</h1>
    <p>这里将展示历史会话、新建会话和删除会话操作。</p>
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
