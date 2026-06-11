<template>
  <section class="placeholder-page chat-page">
    <p class="placeholder-page__eyebrow">Chat</p>
    <h1>选择或创建一个会话</h1>
    <p>聊天区将在这里显示消息流和 Claude Code 执行详情。</p>
  </section>
</template>

<style scoped>
.placeholder-page {
  display: grid;
  min-height: 100%;
  align-content: center;
  justify-items: center;
  padding: 32px;
  text-align: center;
}

.placeholder-page__eyebrow {
  margin: 0 0 8px;
  color: var(--color-accent-strong);
  font-size: 12px;
  font-weight: 700;
}

.placeholder-page h1 {
  margin: 0;
  font-size: 24px;
}

.placeholder-page p:last-child {
  margin: 12px 0 0;
  color: var(--color-text-muted);
}
</style>
