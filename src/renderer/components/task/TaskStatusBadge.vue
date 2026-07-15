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
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
}

.badge--pending {
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
}

.badge--queued {
  border: 1px solid var(--color-info-strong);
  color: var(--color-info-strong);
}

.badge--running {
  border: 1px solid var(--color-accent);
  color: var(--color-accent-strong);
  background: color-mix(in srgb, var(--color-accent) 8%, transparent);
}

.badge--completed {
  border: 1px solid var(--color-success-strong);
  color: var(--color-success-strong);
}

.badge--failed {
  border: 1px solid var(--color-danger);
  color: var(--color-fail-strong);
}

.badge--cancelled {
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  text-decoration: line-through;
}
</style>
