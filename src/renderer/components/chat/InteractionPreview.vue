<script setup lang="ts">
defineProps<{
  preview?: string;
}>();
</script>

<template>
  <aside class="interaction-preview" aria-label="选项预览">
    <div class="interaction-preview__label">Preview</div>
    <pre v-if="preview" class="interaction-preview__content">{{ preview }}</pre>
    <div v-else class="interaction-preview__empty">当前选项没有预览内容</div>
  </aside>
</template>

<style scoped>
.interaction-preview {
  min-width: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--color-accent-strong) 18%, var(--color-border));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-panel-soft) 82%, #000);
}

.interaction-preview__label {
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-accent-strong);
  font-size: 10px;
  font-weight: 850;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.interaction-preview__content {
  max-height: 360px;
  margin: 0;
  overflow: auto;
  padding: 12px;
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.interaction-preview__empty {
  padding: 18px 12px;
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.5;
}
</style>
