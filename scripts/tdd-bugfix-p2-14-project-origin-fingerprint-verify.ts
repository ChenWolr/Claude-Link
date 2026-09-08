// tdd-bugfix-p2-14-project-origin-fingerprint-verify.ts
// P2-14 契约钉：已物化会话的项目级命令文件变更无任何刷新/stale 标记。
//
// 修复语义：watcher 增 getProjectOriginFingerprint(cwd)（与用户级同一指纹函数、作用于项目两根）；
// registry 快照增加 projectOriginFingerprint（probe 成功时写入，状态切换保留）；
// isSnapshotOriginStale 增项目级比对（双端缺省不误标）；COMMANDS_GET 传入现算值。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-14-project-origin-fingerprint-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getProjectOriginFingerprint } from '../src/main/modules/command-source-watcher';
import { isSnapshotOriginStale } from '../src/shared/commands-get';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sdkCommandRegistry } = require('../src/main/modules/sdk-command-registry');

let pass = 0;
let fail = 0;
let settled = 0;
function check(name: string, fn: () => void | Promise<void>): void {
  void (async () => {
    try { await fn(); pass += 1; console.log(`  ✅ ${name}`); }
    catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
    settled += 1; if (settled === 7) { console.log(`
verify 结果：${pass} passed, ${fail} failed`); process.exit(fail > 0 ? 1 : 0); }
  })();
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p214-proj-'));
  const cmdsDir = path.join(root, '.claude', 'commands');
  fs.mkdirSync(cmdsDir, { recursive: true });
  fs.writeFileSync(path.join(cmdsDir, 'build.md'), 'noop\n');

  const fp1 = await getProjectOriginFingerprint(root);
  check('① 项目级指纹可计算（两根递归 sha1）', () => {
    assert.equal(typeof fp1, 'string');
    assert.equal(fp1?.length, 40);
  });

  // 变更项目文件 → 指纹变化。
  fs.writeFileSync(path.join(cmdsDir, 'lint.md'), 'noop\n');
  const fp2 = await getProjectOriginFingerprint(root);
  check('② 项目命令文件变更 → 指纹变化', () => assert.notEqual(fp1, fp2));

  // 边界：无 cwd → undefined；目录不存在 → 确定性空集指纹。
  const fpNone = await getProjectOriginFingerprint(null);
  const fpMissing1 = await getProjectOriginFingerprint(path.join(root, 'no-such'));
  const fpMissing2 = await getProjectOriginFingerprint(path.join(root, 'no-such'));
  check('③ 无 cwd → undefined（不比对不误标）；不存在目录 → 确定性指纹', () => {
    assert.equal(fpNone, undefined);
    assert.equal(fpMissing1, fpMissing2);
  });

  // stale 判定：项目级不匹配 → stale；任一端缺省 → false。
  const snapshot = {
    sessionId: 's1', commands: [], status: 'ready' as const, source: 'probe' as const, updatedAt: null,
    originFingerprint: 'user-fp-1',
    projectOriginFingerprint: fp1!,
  };
  check('④ 项目指纹不匹配 → stale', () => assert.equal(isSnapshotOriginStale(snapshot, 'user-fp-1', fp2), true));
  check('⑤ 项目指纹匹配 → 非 stale（用户级匹配）', () => assert.equal(isSnapshotOriginStale(snapshot, 'user-fp-1', fp1), false));
  check('⑥ 快照无项目指纹 / 当前无 cwd → 不比对（缺省不误标）', () => {
    const legacy = { ...snapshot, projectOriginFingerprint: undefined };
    assert.equal(isSnapshotOriginStale(legacy, 'user-fp-1', fp2), false);
    assert.equal(isSnapshotOriginStale(snapshot, 'user-fp-1', undefined), false);
  });

  // registry 接线：replace 写入 + setStatusPreservingCommands 保留。
  check('⑦ registry.replace 写入项目指纹；状态切换保留', () => {
    const snap = sdkCommandRegistry.replace('p214-sess', [], 'probe', undefined, 'user-fp', fp1);
    assert.equal(snap.projectOriginFingerprint, fp1);
    const degraded = sdkCommandRegistry.setStatusPreservingCommands('p214-sess', 'degraded', 'x');
    assert.equal(degraded.projectOriginFingerprint, fp1, '状态切换不得丢失项目指纹');
  });

  fs.rmSync(root, { recursive: true, force: true });
})();
