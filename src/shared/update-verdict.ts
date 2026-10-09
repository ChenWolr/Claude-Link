// src/shared/update-verdict.ts
// latest.yml 缺失错误的分级裁决：electron-updater 的 ERR_UPDATER_CHANNEL_FILE_NOT_FOUND
// 消息内含 channelFileUrl（…/download/v0.4.5/latest.yml）。GitHub 源下该 404 发生在
// releases/latest 已确认「存在已发布 Release」之后——若其版本高于当前，是发版资产事故，
// 应显式报错而非静默判「无更新」；不高（用户比 stable 还新等边缘）维持原 latest 语义。

/** tag 是否高于 current（v 前缀剥除、按 . 拆前三段数值比；prerelease 后缀截断不参与；不可解析保守判否）。 */
export function isNewerVersion(tag: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10));
  const [a, b] = [parse(tag), parse(current)];
  for (let i = 0; i < 3; i++) {
    const x = Number.isNaN(a[i]) ? 0 : a[i], y = Number.isNaN(b[i]) ? 0 : b[i];
    if (x !== y) return x > y;
  }
  return false; // 相等或不可解析 → 不判新（保守，回落旧语义）
}

export type MissingMetadataVerdict = { status: 'latest' } | { status: 'error'; message: string };

/** latest.yml 缺失类错误消息 + 当前版本 → 裁决：消息可解析出更高的 /download/<tag>/ → error 文案；否则 latest。 */
export function missingMetadataVerdict(message: string, currentVersion: string): MissingMetadataVerdict {
  const m = /\/download\/(v?[\w.+-]+)\/latest(?:-mac)?\.ya?ml/i.exec(message);
  if (m && isNewerVersion(m[1], currentVersion)) {
    return { status: 'error', message: `发现新版本 ${m[1]}，但其 Release 资产不完整（latest.yml 缺失）——请稍后重试，或到 GitHub Releases 手动下载` };
  }
  return { status: 'latest' };
}
