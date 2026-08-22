// scripts/native-context-parser-runner.ts
// 共享 /context 解析 runner（Task 10）：CDP E2E 用它统一解析 /context 原文，
// 禁止在 .mjs 里复制第二套 used/max/free regex。
//
// ⚠️ 入口必须经 tsx（.ts 无 Node 原生 loader，`node scripts/native-context-parser-runner.ts`
// 直接运行会报 Unknown file extension，review-v3 §2 已实测）：
//   printf '%s' '{"texts":["226.3k/1m tokens (23%)"]}' | npx tsx scripts/native-context-parser-runner.ts
//   输出 JSON：{ "reports": [ { "usedTokens":226300, "maxTokens":1000000, "percentage":23, ... } ] }
//
// 输入：stdin JSON，含 texts: string[]。输出：stdout JSON，含 reports。

import { parseNativeContextReport } from '../src/shared/context-usage';

async function main(): Promise<void> {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  const input = raw.trim() ? JSON.parse(raw) : { texts: [] };
  const texts: string[] = Array.isArray(input.texts) ? input.texts : [];
  const reports = texts.map((t) => {
    const r = parseNativeContextReport(t);
    return r
      ? {
          usedTokens: r.usedTokens,
          maxTokens: r.maxTokens,
          percentage: r.percentage,
          model: r.model,
          categories: r.categories,
        }
      : null;
  });
  process.stdout.write(JSON.stringify({ reports }) + '\n');
}

main().catch((e) => {
  process.stderr.write(`parser runner error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
