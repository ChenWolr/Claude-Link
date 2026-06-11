<script setup lang="ts">
import type { TaskStatus } from '../../../shared/types/task';

defineProps<{ status: TaskStatus }>();
</script>

<template>
  <span :class="['badge', `badge--${status}`]">
    <template v-if="status === 'pending'">⏳</template>
    <template v-else-if="status === 'queued'">📋</template>
    <template v-else-if="status === 'running'">▶️</template>
    <template v-else-if="status === 'completed'">✅</template>
    <template v-else-if="status === 'failed'">❌</template>
    <template v-else-if="status === 'cancelled'">🚫</template>
    {{ status }}
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.badge--pending {
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
}

.badge--queued {
  border: 1px solid #3b82f6;
  color: #60a5fa;
}

.badge--running {
  border: 1px solid var(--color-accent);
  color: var(--color-accent-strong);
  background: rgba(58, 166, 117, 0.08);
}

.badge--completed {
  border: 1px solid #22c55e;
  color: #4ade80;
}

.badge--failed {
  border: 1px solid var(--color-danger);
  color: #f87171;
}

.badge--cancelled {
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  text-decoration: line-through;
}
</style>
