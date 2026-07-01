<script setup lang="ts">
import { computed } from 'vue';
import { useConfigStore, type ModelAlias } from '../../stores/config-store';

const store = useConfigStore();

// 每个 alias 输入框双向：get 读 modelMappings getter，set 调 setModelMapping 写回 advancedJson.env
const bind = (alias: ModelAlias) =>
  computed({
    get: () => store.modelMappings[alias] ?? '',
    set: (v: string) => store.setModelMapping(alias, v),
  });

const sonnet = bind('sonnet');
const haiku = bind('haiku');
const opus = bind('opus');
const fable = bind('fable');
</script>

<template>
  <div class="model-mapping">
    <div class="model-mapping__title">模型类型映射</div>
    <div class="model-mapping__grid">
      <label class="model-mapping__field">
        <span>sonnet（默认 · 均衡）</span>
        <input v-model="sonnet" type="text" placeholder="实际模型名，如 glm-5.2" autocomplete="off" spellcheck="false" />
      </label>
      <label class="model-mapping__field">
        <span>haiku（快速）</span>
        <input v-model="haiku" type="text" placeholder="实际模型名，如 glm-5.2" autocomplete="off" spellcheck="false" />
      </label>
      <label class="model-mapping__field">
        <span>opus（强力）</span>
        <input v-model="opus" type="text" placeholder="实际模型名，如 glm-5.2" autocomplete="off" spellcheck="false" />
      </label>
      <label class="model-mapping__field">
        <span>fable（超长任务）</span>
        <input v-model="fable" type="text" placeholder="实际模型名" autocomplete="off" spellcheck="false" />
      </label>
    </div>
  </div>
</template>

<style scoped>
.model-mapping {
  display: grid;
  gap: 0.5rem;
}

.model-mapping__title {
  color: var(--color-text);
  font-size: 0.8125rem;
  font-weight: 600;
}

.model-mapping__hint {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.model-mapping__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

.model-mapping__field {
  display: grid;
  gap: 0.375rem;
}

.model-mapping__field span {
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

.model-mapping__field input {
  min-width: 0;
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 0.5rem 0.625rem;
  font-size: 0.8125rem;
}
</style>
