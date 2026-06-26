<script setup lang="ts">
import { onMounted } from 'vue';
import AppLayout from './components/layout/AppLayout.vue';
import InteractionPrompt from './components/chat/InteractionPrompt.vue';
import { useConfigStore } from './stores/config-store';
import { THEME_PALETTES } from '../shared/constants';

const configStore = useConfigStore();

onMounted(async () => {
  await configStore.loadConfig();
  const palette = THEME_PALETTES.find((p) => p.id === configStore.config.themePaletteId);
  if (palette) {
    const root = document.documentElement;
    root.style.setProperty('--color-bg', palette.colors.bg);
    root.style.setProperty('--color-panel', palette.colors.panel);
    root.style.setProperty('--color-panel-soft', palette.colors.panelSoft);
    root.style.setProperty('--color-border', palette.colors.border);
    root.style.setProperty('--color-text', palette.colors.text);
    root.style.setProperty('--color-text-muted', palette.colors.textMuted);
    root.style.setProperty('--color-accent', palette.colors.accent);
    root.style.setProperty('--color-accent-strong', palette.colors.accentStrong);
    root.style.setProperty('--color-danger', palette.colors.danger);
  }
});
</script>

<template>
  <AppLayout>
    <router-view />
    <InteractionPrompt />
  </AppLayout>
</template>
