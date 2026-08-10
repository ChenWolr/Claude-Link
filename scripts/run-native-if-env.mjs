// run-native-if-env.mjs
// P2-2（review-v1）/ review-v2 P2：让 `CLAUDE_LINK_RUN_NATIVE_E2E=1 npm run selftest` 追加 native E2E 门禁。
// 计划 Task 5 Step 4 契约：设置 CLAUDE_LINK_RUN_NATIVE_E2E=1 时，selftest 必须额外执行 /init 全矩阵。
// 默认（未设 env）直接 exit 0，selftest 仅跑静态链——行为与历史一致，不破坏无 CLI/凭据环境。
//
// 委托 run-native-chain.mjs 执行 native 链（单一命令源，避免与 selftest:native 漂移）。
import { spawnSync } from 'node:child_process';

if (process.env.CLAUDE_LINK_RUN_NATIVE_E2E !== '1') {
  process.exit(0);
}

console.log('CLAUDE_LINK_RUN_NATIVE_E2E=1：追加 native E2E 门禁（/init 全矩阵 + settings + matrix）...');
const r = spawnSync('node', ['scripts/run-native-chain.mjs'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
