<script setup lang="ts">
import { computed, ref } from 'vue';
import type { InteractionPromptOption } from '../../../shared/types/ipc';

const ITEM_HEIGHT = 68;
const VIEWPORT_HEIGHT = 390;
const BUFFER = 4;

const props = defineProps<{
  options: InteractionPromptOption[];
  focusedIndex: number;
  selectedIds: string[];
  multiSelect?: boolean;
  virtual?: boolean;
}>();

const emit = defineEmits<{
  focus: [index: number];
  toggle: [id: string];
  submit: [id: string];
}>();

const scrollTop = ref(0);

const startIndex = computed(() => props.virtual ? Math.max(0, Math.floor(scrollTop.value / ITEM_HEIGHT) - BUFFER) : 0);
const visibleCount = computed(() => props.virtual ? Math.ceil(VIEWPORT_HEIGHT / ITEM_HEIGHT) + BUFFER * 2 : props.options.length);
const visibleEntries = computed(() => props.options
  .map((option, index) => ({ option, index }))
  .slice(startIndex.value, startIndex.value + visibleCount.value));
const totalHeight = computed(() => props.virtual ? props.options.length * ITEM_HEIGHT : undefined);
const offsetY = computed(() => props.virtual ? startIndex.value * ITEM_HEIGHT : 0);

function isSelected(id: string): boolean {
  return props.selectedIds.includes(id);
}

function onScroll(event: Event): void {
  scrollTop.value = (event.currentTarget as HTMLElement).scrollTop;
}
</script>

<template>
  <div
    class="interaction-options"
    :class="{ 'interaction-options--virtual': virtual }"
    role="listbox"
    :aria-multiselectable="multiSelect ? 'true' : 'false'"
    @scroll="onScroll"
  >
    <div v-if="virtual" class="interaction-options__spacer" :style="{ height: `${totalHeight}px` }">
      <div class="interaction-options__window" :style="{ transform: `translateY(${offsetY}px)` }">
        <button
          v-for="entry in visibleEntries"
          :key="entry.option.id"
          type="button"
          class="interaction-option"
          :class="{
            'interaction-option--focused': focusedIndex === entry.index,
            'interaction-option--selected': isSelected(entry.option.id),
            'interaction-option--danger': entry.option.danger,
            'interaction-option--primary': entry.option.primary,
          }"
          role="option"
          :aria-selected="isSelected(entry.option.id)"
          @click="emit('toggle', entry.option.id)"
          @mouseenter="emit('focus', entry.index)"
          @dblclick="!multiSelect && emit('submit', entry.option.id)"
        >
          <span class="interaction-option__marker" aria-hidden="true">
            <span v-if="multiSelect">{{ isSelected(entry.option.id) ? '✓' : '' }}</span>
          </span>
          <span class="interaction-option__content">
            <strong>{{ entry.option.label }}</strong>
            <small v-if="entry.option.description">{{ entry.option.description }}</small>
          </span>
        </button>
      </div>
    </div>

    <button
      v-for="(option, index) in virtual ? [] : options"
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
  gap: var(--interaction-option-gap);
}

.interaction-options--virtual {
  display: block;
  max-height: 390px;
  overflow: auto;
  padding-right: 4px;
  contain: content;
}

.interaction-options__spacer {
  position: relative;
}

.interaction-options__window {
  position: absolute;
  inset: 0 0 auto 0;
  display: grid;
  gap: var(--interaction-option-gap);
}

.interaction-option {
  position: relative;
  display: flex;
  width: 100%;
  min-height: 58px;
  gap: 10px;
  align-items: flex-start;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--color-border) 78%, var(--color-accent-strong));
  border-radius: var(--radius-md);
  background: var(--interaction-option-bg);
  color: var(--color-text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.15s, background 0.15s, box-shadow 0.15s, color 0.15s;
}

.interaction-option::before {
  content: '';
  position: absolute;
  inset: 8px auto 8px 0;
  width: 4px;
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
  border-color: color-mix(in srgb, var(--color-accent-strong) 88%, #ffffff 12%);
  background: var(--interaction-option-selected-bg);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-accent-strong) 50%, transparent), 0 8px 18px rgba(0, 0, 0, 0.12);
}

.interaction-option--selected::before {
  background: linear-gradient(180deg, var(--color-accent-strong), color-mix(in srgb, var(--color-accent-strong) 68%, #ffffff));
}

.interaction-option--danger.interaction-option--selected {
  border-color: color-mix(in srgb, var(--color-danger) 88%, #ffffff 12%);
  background: var(--interaction-option-danger-bg);
}

.interaction-option--danger.interaction-option--selected::before {
  background: linear-gradient(180deg, var(--color-danger), color-mix(in srgb, var(--color-danger) 68%, #ffffff));
}

.interaction-option__marker {
  display: grid;
  flex: 0 0 20px;
  width: 20px;
  height: 20px;
  margin-top: 0;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-accent-strong) 65%, var(--color-border));
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.1);
  color: transparent;
  font-size: 0.8125rem;
  font-weight: 900;
  transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s, transform 0.15s;
}

.interaction-option--selected .interaction-option__marker {
  border-color: color-mix(in srgb, var(--color-accent-strong) 90%, #ffffff 10%);
  background: var(--color-accent-strong);
  color: #05110a;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-accent-strong) 36%, transparent), 0 3px 10px rgba(0, 0, 0, 0.18);
  transform: scale(1.06);
}

.interaction-option--danger.interaction-option--selected .interaction-option__marker {
  border-color: color-mix(in srgb, var(--color-danger) 90%, #ffffff 10%);
  background: var(--color-danger);
  color: #fff;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-danger) 36%, transparent), 0 3px 10px rgba(0, 0, 0, 0.18);
}

.interaction-option:not(.interaction-option--selected) .interaction-option__marker {
  opacity: 0.82;
}

.interaction-option__content {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.interaction-option--selected .interaction-option__content strong {
  color: #ffffff;
}

.interaction-option--selected .interaction-option__content small {
  color: color-mix(in srgb, var(--color-text-muted) 58%, #ffffff 42%);
}

.interaction-option--focused .interaction-option__content strong {
  color: #ffffff;
}

.interaction-option--focused .interaction-option__marker {
  border-color: color-mix(in srgb, var(--color-accent-strong) 82%, #ffffff 18%);
}
</style>
