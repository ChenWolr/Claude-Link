<template>
  <aside class="sidebar">
    <div class="sidebar__brand">
      <div class="brand-mark">CL</div>
      <div>
        <h1>Claude Link</h1>
        <p>Task Console</p>
      </div>
    </div>

    <input class="sidebar__search" type="search" placeholder="搜索会话" />

    <nav class="sidebar__sessions">
      <RouterLink class="session-link" to="/">默认会话</RouterLink>
      <RouterLink class="session-link" to="/sessions">会话管理</RouterLink>
    </nav>

    <div class="sidebar__footer">
      <button class="new-button" type="button">+ 新会话</button>
      <RouterLink class="settings-link" to="/config">配置</RouterLink>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  width: var(--sidebar-width);
  min-width: var(--sidebar-width);
  flex-direction: column;
  border-right: 1px solid var(--color-border);
  background: #11151d;
  padding: 16px 12px;
}

.sidebar__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
}

.brand-mark {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: #07120d;
  font-size: 13px;
  font-weight: 800;
}

.sidebar__brand h1 {
  margin: 0;
  font-size: 15px;
}

.sidebar__brand p {
  margin: 2px 0 0;
  color: var(--color-text-muted);
  font-size: 12px;
}

.sidebar__search {
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 9px 10px;
  outline: none;
}

.sidebar__sessions {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  margin-top: 16px;
}

.session-link,
.settings-link,
.new-button {
  border-radius: var(--radius-md);
  padding: 10px 11px;
  color: var(--color-text);
}

.session-link.router-link-active {
  background: var(--color-panel-soft);
}

.sidebar__footer {
  display: grid;
  gap: 8px;
}

.new-button {
  border: 0;
  background: var(--color-accent);
  color: #07120d;
  font-weight: 700;
}

.settings-link {
  display: block;
  border: 1px solid var(--color-border);
  text-align: center;
}
</style>
