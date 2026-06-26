<script setup lang="ts">
import type { InteractionPromptOption } from '../../../shared/types/ipc';

const props = defineProps<{
  options: InteractionPromptOption[];
  focusedIndex: number;
  selectedIds: string[];
  multiSelect?: boolean;
}>();

const emit = defineEmits<{
  focus: [index: number];
  toggle: [id: string];
  submit: [id: string];
}>();

function isSelected(id: string): boolean {
  return props.selectedIds.includes(id);
}
</script>

<template>
  <div class="interaction-options" role="listbox" :aria-multiselectable="multiSelect ? 'true' : 'false'">
    <button
      v-for="(option, index) in options"
      :key="option.id"
      type="button"
      class="interaction-option"
      :class="{
        'interaction-option--focused': focusedIndex === index,
        'interaction-option--selected': isSelected(option.id),
        'interaction-option--danger': option.danger,
        'interaction-option--primary': option.primary,
      }"
      role="option"
      :aria-selected="isSelected(option.id)"
      @click="emit('toggle', option.id)"
      @mouseenter="emit('focus', index)"
      @dblclick="!multiSelect && emit('submit', option.id)"
    >
      <span class="interaction-option__marker" aria-hidden="true">
        <span v-if="multiSelect">{{ isSelected(option.id) ? '✓' : '' }}</span>
      </span>
      <span class="interaction-option__content">
        <strong>{{ option.label }}</strong>
        <small v-if="option.description">{{ option.description }}</small>
      </span>
    </button>
  </div>
</template>

<style scoped>
.interaction-options {
  display: grid;
  gap: 10px;
}

.interaction-option {
  position: relative;
  display: flex;
  width: 100%;
  gap: 10px;
  align-items: flex-start;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.15s, background 0.15s, box-shadow 0.15s;
}

.interaction-option::before {
  content: '';
  position: absolute;
  inset: 10px auto 10px 0;
  width: 3px;
  border-radius: 0 999px 999px 0;
  background: transparent;
}

.interaction-option:active {
  transform: scale(0.98);
}

.interaction-option--focused {
  border-color: color-mix(in srgb, var(--color-accent-strong) 65%, var(--color-border));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 18%, transparent);
}

.interaction-option--selected {
  border-color: var(--color-accent-strong);
  background: color-mix(in srgb, var(--color-accent) 15%, var(--color-panel-soft));
}

.interaction-option--selected::before {
  background: var(--color-accent-strong);
}

.interaction-option--danger.interaction-option--selected {
  border-color: var(--color-danger);
  background: color-mix(in srgb, var(--color-danger) 12%, var(--color-panel-soft));
}

.interaction-option--danger.interaction-option--selected::before {
  background: var(--color-danger);
}

.interaction-option__marker {
  display: grid;
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-accent-strong) 48%, var(--color-border));
  border-radius: 5px;
  color: var(--color-accent-strong);
  font-size: 12px;
  font-weight: 900;
}

.interaction-option:not(.interaction-option--selected) .interaction-option__marker {
  opacity: 0.55;
}

.interaction-option__content {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.interaction-option__content strong {
  font-size: 13px;
  line-height: 1.35;
}

.interaction-option__content small {
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.45;
}
</style>
