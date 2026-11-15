<script setup lang="ts">
import { THEME_PALETTES, DEFAULT_THEME_PALETTE_ID } from '../../../shared/constants';

defineProps<{
  selectedId: string;
}>();

const emit = defineEmits<{
  select: [paletteId: string];
}>();
</script>

<template>
  <div class="theme-selector">
    <button
      v-for="palette in THEME_PALETTES"
      :key="palette.id"
      type="button"
      :class="['palette-card', { active: palette.id === selectedId }]"
      :aria-pressed="palette.id === selectedId"
      @click="emit('select', palette.id)"
    >
      <div class="palette-swatch" aria-hidden="true">
        <div class="swatch" :style="{ background: palette.colors.bg }"></div>
        <div class="swatch" :style="{ background: palette.colors.panel }"></div>
        <div class="swatch" :style="{ background: palette.colors.panelSoft }"></div>
        <div class="swatch" :style="{ background: palette.colors.accent }"></div>
      </div>
      <span class="palette-name">
        {{ palette.name }}
        <span v-if="palette.id === DEFAULT_THEME_PALETTE_ID" class="palette-badge palette-badge--muted">默认</span>
        <span v-if="palette.isDark" class="palette-badge palette-badge--accent">暗色</span>
      </span>
    </button>
  </div>
</template>

<style scoped>
.theme-selector {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 0.75rem;
}

.palette-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.75rem;
  cursor: pointer;
  text-align: center;
  font: inherit;            /* 按钮复位：继承正文字号/字族 */
  color: var(--color-text);
  background: transparent;  /* 与原 div 透底等观感（父 solo-card 即 --color-panel） */
}

.palette-card:hover {
  background: var(--color-panel-soft);
}

.palette-card.active {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 6%, transparent);
}

.palette-card:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.palette-swatch {
  display: flex;
  gap: 0.25rem;
  justify-content: center;
  margin-bottom: 0.5rem;
}

.swatch {
  width: 1.25rem;
  height: 1.25rem;
  border-radius: var(--radius-xs);
}

.palette-name {
  color: var(--color-text);
  font-size: 0.8125rem;
}

.palette-badge {
  margin-left: 0.375rem;
  padding: 0.0625rem 0.375rem;
  border-radius: var(--radius-pill);
  font-size: 0.625rem;
  font-weight: 600;
  vertical-align: 0.0625rem;
}

.palette-badge--muted {
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-text-muted) 14%, transparent);
}

.palette-badge--accent {
  color: var(--color-accent-strong);
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
}
</style>
