<template>
  <header class="app-header">
    <div>
      <p class="app-header__label">当前会话</p>
      <h2>默认会话</h2>
    </div>
    <div class="app-header__model">claude-sonnet-4-6</div>
  </header>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 72px;
  padding: 0 24px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-panel);
}

.app-header__label {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 12px;
}

.app-header h2 {
  margin: 2px 0 0;
  font-size: 18px;
  font-weight: 650;
}

.app-header__model {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
  padding: 8px 10px;
  font-size: 12px;
}
</style>
