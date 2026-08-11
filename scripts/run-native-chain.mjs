// run-native-chain.mjs
// native E2E 门禁链（review-v2 P2 抽取，消除 selftest / selftest:native 重复）。
// 与 package.json selftest:native 的 native 增量段一致：typecheck:scripts + baseline/settings/init-matrix/command/matrix。
// 不读环境变量——由调用方决定是否执行（run-native-if-env.mjs 读 env；selftest:native 无条件执行）。
import { spawnSync } from 'node:child_process';

const chain = [
  'npm run typecheck:scripts',
  'tsx scripts/claude-code-command-baseline.ts --native',
  'tsx scripts/claude-code-command-e2e-verify.ts --native --settings',
  'tsx scripts/claude-code-command-e2e-verify.ts --native --init-matrix',
  'tsx scripts/claude-code-command-e2e-verify.ts --native --command /init --command /compact',
  // Task 6：候选平替等价性对照（任一字段 false → 保持 native-sdk，不合格则回退原生执行）。
  'tsx scripts/claude-code-command-e2e-verify.ts --native --replacements',
  'tsx scripts/claude-code-command-matrix.ts --require-runtime-match',
];

for (const cmd of chain) {
  console.log(`\n$ ${cmd}`);
  const r = spawnSync(cmd, { stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`native 门禁失败：${cmd} (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}
