// 共享主题应用：把完整 ThemePalette 写入根 CSS 变量。
// 主窗口（App.vue）、配置预览（ConfigPage.vue）与隐藏 export renderer 共用，不再复制第三份映射。
// 依据：v3 第 5 节 + 第 14.4 节。
import type { ThemePalette } from '../../shared/constants';

export function applyThemePalette(palette: ThemePalette, root: HTMLElement = document.documentElement): void {
  const c = palette.colors;
  root.style.setProperty('--color-bg', c.bg);
  root.style.setProperty('--color-panel', c.panel);
  root.style.setProperty('--color-panel-soft', c.panelSoft);
  root.style.setProperty('--color-border', c.border);
  root.style.setProperty('--color-text', c.text);
  root.style.setProperty('--color-text-muted', c.textMuted);
  root.style.setProperty('--color-accent', c.accent);
  root.style.setProperty('--color-accent-strong', c.accentStrong);
  root.style.setProperty('--color-on-accent', c.onAccent);
  root.style.setProperty('--color-danger', c.danger);
  root.style.colorScheme = palette.isDark ? 'dark' : 'light';
}

/** 应用字号档位到 --font-size-base。 */
export function applyFontScale(fontScale: string, sizes: Record<string, string>, root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--font-size-base', sizes[fontScale] ?? sizes.medium ?? '16px');
}
