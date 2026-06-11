<script setup lang="ts">
defineProps<{ content: string }>();
</script>

<template>
  <div class="stream">
    <div class="stream__role">Claude</div>
    <div class="stream__content">{{ content }}<span class="cursor">▊</span></div>
  </div>
</template>

<style scoped>
.stream {
  align-self: flex-start;
  max-width: 75%;
  padding: 12px 16px;
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
}

.stream__role {
  font-size: 11px;
  font-weight: 700;
  color: var(--color-accent-strong);
  text-transform: uppercase;
  margin-bottom: 6px;
  opacity: 0.7;
}

.stream__content {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
}

.cursor {
  animation: blink 1s step-end infinite;
  color: var(--color-accent-strong);
}

@keyframes blink {
  50% { opacity: 0; }
}
</style>
