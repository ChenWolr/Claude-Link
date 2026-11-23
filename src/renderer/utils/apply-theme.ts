// 共享主题应用：把完整 ThemePalette 写入根 CSS 变量。
// 主窗口（App.vue）与隐藏 export renderer（export-runner.ts）共用；ConfigPage.vue 的主题预览未接入本函数，
// 本地持有一份复制的映射（selftest-settings-mapping 钉此现状）——修改下方变量映射时须同步 ConfigPage.vue 的 applyTheme。
// ConfigPage.vue 副本必须同步的完整变量清单（2026-11-08 A1 起 14 个，新增 4 个随 A1 落地）：
//   --color-bg / --color-panel / --color-panel-soft / --color-border / --color-border-strong(new) /
//   --color-text / --color-text-muted / --color-text-sub(new) / --color-accent / --color-accent-strong /
//   --color-on-accent / --color-btn-ink(new) / --color-on-btn-ink(new) / --color-danger。
// 依据：v3 第 5 节 + 第 14.4 节。
import type { ThemePalette } from '../../shared/constants';

export function applyThemePalette(palette: ThemePalette, root: HTMLElement = document.documentElement): void {
  const c = palette.colors;
  root.style.setProperty('--color-bg', c.bg);
  root.style.setProperty('--color-panel', c.panel);
  root.style.setProperty('--color-panel-soft', c.panelSoft);
  root.style.setProperty('--color-border', c.border);
  // 回退=variables.css 原静态值（旧板观感不变）；暗板缺省回退提亮值（黑上叠黑不可见，P1/H1）。
  root.style.setProperty('--color-border-strong', c.borderStrong ?? (palette.isDark ? '#3D444D' : 'rgba(0, 0, 0, 0.12)'));
  root.style.setProperty('--color-text', c.text);
  root.style.setProperty('--color-text-muted', c.textMuted);
  root.style.setProperty('--color-text-sub', c.textSub ?? c.textMuted);
  root.style.setProperty('--color-accent', c.accent);
  root.style.setProperty('--color-accent-strong', c.accentStrong);
  root.style.setProperty('--color-on-accent', c.onAccent);
  root.style.setProperty('--color-btn-ink', c.btnInk ?? c.accent);
  root.style.setProperty('--color-on-btn-ink', c.onBtnInk ?? c.onAccent);
  root.style.setProperty('--color-danger', c.danger);
  root.style.colorScheme = palette.isDark ? 'dark' : 'light';
}

/** 应用字号档位到 --font-size-base。 */
export function applyFontScale(fontScale: string, sizes: Record<string, string>, root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--font-size-base', sizes[fontScale] ?? sizes.medium ?? '16px');
}
