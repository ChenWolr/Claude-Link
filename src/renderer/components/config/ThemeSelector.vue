<script setup lang="ts">
import { THEME_PALETTES } from '../../../shared/constants';

const props = defineProps<{
  selectedId: string;
}>();

const emit = defineEmits<{
  select: [paletteId: string];
}>();
</script>

<template>
  <div class="theme-selector">
    <div
      v-for="palette in THEME_PALETTES"
      :key="palette.id"
      :class="['palette-card', { active: palette.id === selectedId }]"
      @click="emit('select', palette.id)"
    >
      <div class="palette-swatch">
        <div class="swatch" :style="{ background: palette.colors.bg }"></div>
        <div class="swatch" :style="{ background: palette.colors.panel }"></div>
        <div class="swatch" :style="{ background: palette.colors.accent }"></div>
        <div class="swatch" :style="{ background: palette.colors.text }"></div>
      </div>
      <span class="palette-name">{{ palette.name }}</span>
    </div>
  </div>
</template>

<style scoped>
.theme-selector {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 12px;
}

.palette-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 12px;
  cursor: pointer;
  text-align: center;
}

.palette-card:hover {
  background: var(--color-panel-soft);
}

.palette-card.active {
  border-color: var(--color-accent);
  background: rgba(58, 166, 117, 0.06);
}

.palette-swatch {
  display: flex;
  gap: 4px;
  justify-content: center;
  margin-bottom: 8px;
}

.swatch {
  width: 20px;
  height: 20px;
  border-radius: 4px;
}

.palette-name {
  color: var(--color-text);
  font-size: 0.8125rem;
}
</style>
