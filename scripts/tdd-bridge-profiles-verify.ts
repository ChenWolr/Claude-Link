// tdd-bridge-profiles-verify.ts
// 计划 docs/plans/2026-09-21-im-bridge-feishu-wechat-plan.md Task 3 契约钉：bridge 凭据存储。
//   A. 默认值形状（全关、无凭据、region 默认 feishu_cn）。
//   B. save→load 往返（fake cipher：enc='E:'+btoa(plain)）+ 原子写落盘。
//   C. 掩码视图：hasAppSecret=true、masked='********'、不含明文/密文；wechat.loggedIn。
//   D. resolveSecretPatch 掩码语义：'********'/undefined→保留旧密文；新明文→加密；空串→null。
//   E. 解密失败 cipher → loadProfilesWithStatus broken 标记 + Enc 置 null（B12）。
//   F. profiles.json 损坏 JSON → 回落默认值不抛（B13）。
// 生命周期修复计划追加（docs/plans/2026-09-22-im-bridge-lifecycle-ux-fix-plan.md 批次5.2）：
//   G. wechat ownerUserId：默认 null / save→load 往返 / 老文件缺字段兜底 null。
// RED 预期（未改树）：profiles 模块不存在 → import 即 FAIL。
// 运行：npx tsx scripts/tdd-bridge-profiles-verify.ts

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MASKED_SECRET,
  defaultProfiles,
  loadProfiles,
  loadProfilesWithStatus,
  saveProfiles,
  toFeishuView,
  toWechatView,
  resolveSecretPatch,
  type BridgeCipher,
} from '../src/main/modules/bridge/profiles';

let pass = 0;
let fail = 0;
function check(group: string, no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ [${group}] ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ [${group}] ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

const fakeCipher: BridgeCipher = {
  encrypt: (plain) => 'E:' + Buffer.from(plain, 'utf8').toString('base64'),
  decrypt: (enc) => (enc.startsWith('E:') ? Buffer.from(enc.slice(2), 'base64').toString('utf8') : null),
};
const brokenCipher: BridgeCipher = { encrypt: (p) => 'E:' + p, decrypt: () => null };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-profiles-test-'));
const profilesFile = path.join(tmpRoot, 'profiles.json');

// A. 默认值形状
{
  const d = defaultProfiles();
  const shapeOk = d.global.workingDir === null
    && d.feishu.enabled === false && d.feishu.appId === '' && d.feishu.appSecretEnc === null
    && d.feishu.region === 'feishu_cn' && d.feishu.ownerOpenId === null
    && d.wechat.enabled === false && d.wechat.botTokenEnc === null && d.wechat.botUserId === null;
  check('A', '①', 'defaultProfiles：全关 + 无凭据 + region=feishu_cn', shapeOk, JSON.stringify(d));
  check('A', '②', "MASKED_SECRET === '********'", MASKED_SECRET === '********');
}

// B. save→load 往返
{
  const p = defaultProfiles();
  p.global.workingDir = 'D:/work/proj';
  p.feishu.enabled = true;
  p.feishu.appId = 'cli_a1b2c3';
  p.feishu.appSecretEnc = fakeCipher.encrypt('secret-plain-xyz');
  p.feishu.region = 'lark_global';
  p.feishu.ownerOpenId = 'ou_owner';
  p.wechat.botTokenEnc = fakeCipher.encrypt('bot-token-plain');
  p.wechat.botUserId = 'wxid_u1';
  saveProfiles(profilesFile, p);
  assert.ok(fs.existsSync(profilesFile), 'saveProfiles 未落盘');
  const back = loadProfiles(profilesFile, fakeCipher);
  const roundOk = JSON.stringify(back) === JSON.stringify(p);
  check('B', '①', 'save→load 往返一致（含密文原样）', roundOk, JSON.stringify(back));
  // 原子写不留 tmp 残留
  const leftovers = fs.readdirSync(tmpRoot).filter((f) => f !== 'profiles.json');
  check('B', '②', '原子写无 tmp 残留文件', leftovers.length === 0, `残留=${JSON.stringify(leftovers)}`);
}

// C. 掩码视图
{
  const p = loadProfiles(profilesFile, fakeCipher);
  const fv = toFeishuView(p);
  const feishuOk = fv.hasAppSecret === true && fv.appSecretMasked === MASKED_SECRET
    && fv.enabled === true && fv.appId === 'cli_a1b2c3' && fv.region === 'lark_global'
    && fv.ownerOpenId === 'ou_owner'
    && !JSON.stringify(fv).includes('secret-plain-xyz')
    && !JSON.stringify(fv).includes('E:');
  check('C', '①', 'toFeishuView：hasAppSecret+掩码，不泄漏明文/密文', feishuOk, JSON.stringify(fv));
  const wv = toWechatView(p);
  const wechatOk = wv.loggedIn === true && wv.enabled === false && wv.botUserId === 'wxid_u1'
    && !JSON.stringify(wv).includes('bot-token-plain')
    && !JSON.stringify(wv).includes('E:');
  check('C', '②', 'toWechatView：loggedIn=true，不泄漏明文/密文', wechatOk, JSON.stringify(wv));
  // 无凭据时视图
  const empty = toFeishuView(defaultProfiles());
  check('C', '③', '无凭据视图：hasAppSecret=false 且 masked=null',
    empty.hasAppSecret === false && empty.appSecretMasked === null, JSON.stringify(empty));
  const emptyW = toWechatView(defaultProfiles());
  check('C', '④', '无凭据视图：loggedIn=false', emptyW.loggedIn === false, JSON.stringify(emptyW));
}

// D. resolveSecretPatch 掩码语义
{
  check('D', '①', "resolveSecretPatch('E:xx','********') → 保留 'E:xx'",
    resolveSecretPatch('E:xx', MASKED_SECRET, fakeCipher) === 'E:xx',
    String(resolveSecretPatch('E:xx', MASKED_SECRET, fakeCipher)));
  check('D', '②', "resolveSecretPatch('E:xx',undefined) → 保留 'E:xx'",
    resolveSecretPatch('E:xx', undefined, fakeCipher) === 'E:xx',
    String(resolveSecretPatch('E:xx', undefined, fakeCipher)));
  check('D', '③', "resolveSecretPatch('E:xx','new-secret') → 'E:new-secret'",
    resolveSecretPatch('E:xx', 'new-secret', fakeCipher) === 'E:' + Buffer.from('new-secret').toString('base64'),
    String(resolveSecretPatch('E:xx', 'new-secret', fakeCipher)));
  check('D', '④', "resolveSecretPatch('E:xx','') → null（空串清除）",
    resolveSecretPatch('E:xx', '', fakeCipher) === null,
    String(resolveSecretPatch('E:xx', '', fakeCipher)));
  check('D', '⑤', 'resolveSecretPatch(null,undefined) → null（旧无新无）',
    resolveSecretPatch(null, undefined, fakeCipher) === null);
}

// E. 解密失败 → broken 标记 + Enc 置 null（B12）
{
  const brokenFile = path.join(tmpRoot, 'broken.json');
  const p = defaultProfiles();
  p.feishu.appSecretEnc = 'GARBAGE';
  p.wechat.botTokenEnc = 'GARBAGE';
  saveProfiles(brokenFile, p);
  const status = loadProfilesWithStatus(brokenFile, brokenCipher);
  check('E', '①', '解密失败：feishuSecretBroken=true 且 wechatTokenBroken=true',
    status.feishuSecretBroken === true && status.wechatTokenBroken === true,
    JSON.stringify({ f: status.feishuSecretBroken, w: status.wechatTokenBroken }));
  check('E', '②', '解密失败：Enc 置 null（不把坏密文带进运行时）',
    status.profiles.feishu.appSecretEnc === null && status.profiles.wechat.botTokenEnc === null,
    JSON.stringify(status.profiles.feishu));
}

// F. 损坏/缺失文件回落默认（B13）
{
  const corruptFile = path.join(tmpRoot, 'corrupt.json');
  fs.writeFileSync(corruptFile, '{ not valid json !!');
  let threw = '';
  let loaded: ReturnType<typeof defaultProfiles> | null = null;
  try { loaded = loadProfiles(corruptFile, fakeCipher); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
  check('F', '①', '损坏 JSON：不抛且回落默认值', threw === '' && loaded !== null && JSON.stringify(loaded) === JSON.stringify(defaultProfiles()),
    `threw=${threw} loaded=${JSON.stringify(loaded)}`);
  const missing = loadProfiles(path.join(tmpRoot, 'no-such.json'), fakeCipher);
  check('F', '②', '文件缺失：回落默认值', JSON.stringify(missing) === JSON.stringify(defaultProfiles()));
}

// G. wechat ownerUserId（生命周期修复批次5.2：owner 收窄的存储面）
{
  check('G', '①', 'defaultProfiles：wechat.ownerUserId 默认 null',
    defaultProfiles().wechat.ownerUserId === null,
    String(defaultProfiles().wechat.ownerUserId));

  const ownerFile = path.join(tmpRoot, 'owner.json');
  const p = defaultProfiles();
  p.wechat.ownerUserId = 'wxid_owner_1';
  saveProfiles(ownerFile, p);
  const back = loadProfiles(ownerFile, fakeCipher);
  check('G', '②', 'ownerUserId save→load 往返一致',
    back.wechat.ownerUserId === 'wxid_owner_1', String(back.wechat.ownerUserId));

  // 老版本 profiles.json（无 ownerUserId 字段）→ 加载兜底 null，不抛。
  const legacyFile = path.join(tmpRoot, 'legacy.json');
  fs.writeFileSync(legacyFile, JSON.stringify({
    global: { workingDir: null },
    feishu: { enabled: false, appId: '', appSecretEnc: null, region: 'feishu_cn', ownerOpenId: null },
    wechat: { enabled: false, botTokenEnc: null, botUserId: null },
  }), 'utf-8');
  const legacy = loadProfiles(legacyFile, fakeCipher);
  check('G', '③', '老文件缺 ownerUserId 字段 → 加载兜底 null',
    legacy.wechat.ownerUserId === null, String(legacy.wechat.ownerUserId));
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
