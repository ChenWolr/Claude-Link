// tdd-draft-attachment-quota-verify.ts
// A11（D08-F1，P2）契约钉：暂存感知草稿余量——四入口（粘贴/拖放/PICK/克隆）不再「先落盘后裁剪」。
//
// 根因：三入口都在主进程暂存完成之后才由 renderer draftStore 做 10 上限裁剪，超量部分已真实
// 落盘并建行（或进暂态 Map），却永远进不了草稿列表——UI 无卡片即无删除入口，回收只能等下次
// 启动的 reconcile/orphan 清理（「不可见草稿」滞留）。PICK 仅按本次 ≤10 截断、不感知草稿余量
// 且被截断文件无提示（D08-F10 同链顺带修复）；克隆返回值被丢弃（D08-F12 同链顺带修复）。
//
// 修复语义：① shared 纯函数 filterDraftAttachmentsByQuota 按「已有草稿 + 本次新增」组合裁定
// 三约束（数量 ≤10、图片按 Base64 编码后计入总预算 ≤50MiB、非图片按原始字节；单项图片
// 10MiB / 其余 30MiB——与 attachment-policy 同值，本脚本钉两处同步）；② 四入口暂存前预检，
// 超量项拒并提示（粘贴/拖放 notice、PICK errors、克隆 rejected 名单）；③ 主进程
// stageAttachment/stageTransientAttachment 权威校验（不落盘、不建行/不进暂态 Map）。
//
// 运行：npx tsx scripts/tdd-draft-attachment-quota-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}

const MB = 1024 * 1024;
const chatPage = readFileSync(new URL('../src/renderer/pages/ChatPage.vue', import.meta.url), 'utf8');
const useChat = readFileSync(new URL('../src/renderer/composables/use-chat.ts', import.meta.url), 'utf8');
const service = readFileSync(new URL('../src/main/modules/attachment-service.ts', import.meta.url), 'utf8');
const repo = readFileSync(new URL('../src/main/database/repositories/attachment-repo.ts', import.meta.url), 'utf8');
const handlers = readFileSync(new URL('../src/main/ipc-handlers.ts', import.meta.url), 'utf8');
const preloadApi = readFileSync(new URL('../src/preload/api.ts', import.meta.url), 'utf8');
const attachmentTypes = readFileSync(new URL('../src/shared/types/attachment.ts', import.meta.url), 'utf8');

async function main(): Promise<void> {
  console.log('\n=== A11（D08-F1）：暂存感知草稿余量 ===');

  // RED 阶段 shared 模块可能未创建：包 try 使脚本以「组1 逐项红」而非崩溃收场。
  let quota: typeof import('../src/shared/draft-attachment-quota') | null = null;
  try {
    quota = await import('../src/shared/draft-attachment-quota');
  } catch {
    /* RED：模块未建，组1/组2 各 check 自行报红 */
  }
  const policy = await import('../src/main/modules/attachment-policy');

  if (quota) {
    const { filterDraftAttachmentsByQuota, draftQuotaImageEncodedBytes, draftQuotaKindFromMime } = quota;
    type QI = { filename: string; kind: 'image' | 'document' | 'file'; sizeBytes: number };
    const img = (n: number, mb: number): QI => ({ filename: `img${n}.png`, kind: 'image', sizeBytes: mb * MB });
    const doc = (n: number, mb: number): QI => ({ filename: `doc${n}.pdf`, kind: 'document', sizeBytes: mb * MB });

    console.log('\n=== 组1 纯函数行为（数量/预算/单项限额组合矩阵） ===');
    check('① 数量余量：已有 8 + 新 3 → accepted 2 / rejected 1（reason 数量）', () => {
      const cur = Array.from({ length: 8 }, (_, i) => doc(i, 1));
      const r = filterDraftAttachmentsByQuota(cur, [doc(100, 1), doc(101, 1), doc(102, 1)]);
      assert.equal(r.accepted.length, 2);
      assert.equal(r.rejected.length, 1);
      assert.equal(r.rejected[0].item.filename, 'doc102.pdf');
      assert.match(r.rejected[0].reason, /数量|10 个/);
    });
    check('② 恰好压线：空草稿 10 个全过、第 11 个拒；已有 10 时新项全拒', () => {
      const ten = Array.from({ length: 10 }, (_, i) => doc(i, 1));
      assert.equal(filterDraftAttachmentsByQuota([], ten).accepted.length, 10);
      assert.equal(filterDraftAttachmentsByQuota([], ten).rejected.length, 0);
      const r = filterDraftAttachmentsByQuota(ten, [doc(99, 1)]);
      assert.equal(r.accepted.length, 0);
      assert.equal(r.rejected.length, 1);
    });
    check('③ 图片预算按 Base64 编码后计：3×9.9MiB 图 + 15MiB 文档（原始 44.7MiB 过、编码 54.6MiB 超）末项拒', () => {
      const r = filterDraftAttachmentsByQuota([], [img(1, 9.9), img(2, 9.9), img(3, 9.9), doc(4, 15)]);
      assert.equal(r.accepted.length, 3, '前三项应过（单项均未超）');
      assert.equal(r.rejected.length, 1, '若图片按原始字节计则总 44.7MiB 不会超——本拒即编码后计的证据');
      assert.equal(r.rejected[0].item.filename, 'doc4.pdf');
      assert.match(r.rejected[0].reason, /总传输量|50 MiB/);
    });
    check('④ 单项限额：image 10.5MiB 拒（图片口径）、file 30.5MiB 拒（文件口径）', () => {
      const r1 = filterDraftAttachmentsByQuota([], [img(1, 10.5)]);
      assert.equal(r1.accepted.length, 0);
      assert.match(r1.rejected[0].reason, /图片|10 MiB/);
      const r2 = filterDraftAttachmentsByQuota([], [{ filename: 'big.zip', kind: 'file', sizeBytes: 30.5 * MB }]);
      assert.equal(r2.accepted.length, 0);
      assert.match(r2.rejected[0].reason, /文件|30 MiB/);
    });
    check('⑤ 空入参 no-op：空草稿 + 空入参 → 双空；合法小文件全过', () => {
      const r = filterDraftAttachmentsByQuota([], []);
      assert.equal(r.accepted.length, 0);
      assert.equal(r.rejected.length, 0);
      const ok = filterDraftAttachmentsByQuota([], [doc(1, 1), img(1, 2)]);
      assert.equal(ok.accepted.length, 2);
      assert.equal(ok.rejected.length, 0);
    });
    check('⑥ 部分超量保合法：3 项中第 2 项超单项 → 1、3 进 accepted，2 进 rejected', () => {
      const r = filterDraftAttachmentsByQuota([], [doc(1, 1), { filename: 'huge.pdf', kind: 'document', sizeBytes: 31 * MB }, doc(3, 1)]);
      assert.deepEqual(r.accepted.map((a: QI) => a.filename), ['doc1.pdf', 'doc3.pdf']);
      assert.equal(r.rejected.length, 1);
      assert.equal(r.rejected[0].item.filename, 'huge.pdf');
    });
    check('⑦ MIME→kind 镜像：jpeg/png/gif/webp 判 image，其余判 file（document 预算无差别）', () => {
      assert.equal(draftQuotaKindFromMime('image/png'), 'image');
      assert.equal(draftQuotaKindFromMime('image/webp'), 'image');
      assert.equal(draftQuotaKindFromMime('application/pdf'), 'file');
      assert.equal(draftQuotaKindFromMime(''), 'file');
    });
    check('⑧ base64 编码估算式与 policy 同构：ceil(n/3)*4（3B→4、4B→8 含填充）', () => {
      assert.equal(draftQuotaImageEncodedBytes(3), 4);
      assert.equal(draftQuotaImageEncodedBytes(4), 8);
      assert.equal(draftQuotaImageEncodedBytes(30 * MB), Math.ceil((30 * MB) / 3) * 4);
    });

    console.log('\n=== 组2 常量同步钉（shared 镜像与 attachment-policy 同值） ===');
    check('⑨ 数量/预算/单项限额四常量两处同值（漂移即红）', () => {
      assert.equal(quota.DRAFT_QUOTA_MAX_COUNT, policy.MAX_ATTACHMENTS_PER_SEND);
      assert.equal(quota.DRAFT_QUOTA_MAX_TOTAL_BYTES, policy.MAX_TOTAL_BYTES);
      assert.equal(quota.DRAFT_QUOTA_IMAGE_MAX_BYTES, policy.MAX_IMAGE_BYTES);
      assert.equal(quota.DRAFT_QUOTA_FILE_MAX_BYTES, policy.MAX_FILE_BYTES);
    });
    check('⑨b 常量字面值钉（10 / 50MiB / 10MiB / 30MiB）', () => {
      assert.equal(quota.DRAFT_QUOTA_MAX_COUNT, 10);
      assert.equal(quota.DRAFT_QUOTA_MAX_TOTAL_BYTES, 50 * MB);
      assert.equal(quota.DRAFT_QUOTA_IMAGE_MAX_BYTES, 10 * MB);
      assert.equal(quota.DRAFT_QUOTA_FILE_MAX_BYTES, 30 * MB);
    });
  } else {
    console.log('\n=== 组1/组2：shared/draft-attachment-quota 模块未创建（RED） ===');
    check('①-⑨ shared 纯函数模块存在并可导入', () => {
      assert.ok(false, 'src/shared/draft-attachment-quota.ts 不存在或不可导入');
    });
  }

  console.log('\n=== 组3 结构契约（四入口接线 + 主进程权威校验） ===');
  check('⑩ ChatPage.stageFiles 预检接线：filterDraftAttachmentsByQuota 在 stage 循环前 + 超量 notice', () => {
    const at = chatPage.indexOf('async function stageFiles');
    assert.ok(at > -1, '缺 stageFiles');
    const body = chatPage.slice(at, chatPage.indexOf('\n}', at));
    assert.ok(body.includes('filterDraftAttachmentsByQuota'), 'stageFiles 缺预检调用');
    assert.ok(body.includes('draftQuotaKindFromMime'), '缺 MIME→kind 近似判定');
    const preIdx = body.indexOf('filterDraftAttachmentsByQuota');
    const loopIdx = body.indexOf('for (const file of');
    assert.ok(preIdx > -1 && loopIdx > preIdx, '预检须在暂存循环之前');
    assert.match(body, /已忽略/, '缺超量 notice 文案');
  });
  check('⑪ ChatPage.retryLastFailed 消费 { created, rejected } 且 rejected 弹 notice', () => {
    const at = chatPage.indexOf('async function retryLastFailed');
    assert.ok(at > -1, '缺 retryLastFailed');
    const end = chatPage.indexOf('async function handleCompress', at);
    const body = chatPage.slice(at, end > at ? end : undefined);
    assert.match(body, /result\.created/, '须消费 result.created');
    assert.match(body, /result\.rejected/, '须消费 result.rejected');
    assert.match(body, /showNotice/, 'rejected 须有 notice 出口');
  });
  check('⑫ use-chat.retryLastTurn 消费 result.created（既有 p2-13 契约字面保留）', () => {
    const at = useChat.indexOf('async function retryLastTurn');
    const body = useChat.slice(at);
    assert.ok(body.includes('cloneMessageAttachments'), '须调用克隆 IPC');
    assert.match(body, /result\.created/, '须消费 result.created');
    assert.ok(body.includes('addAttachments'), '克隆附件须入 draft store');
    assert.ok(body.includes('附件恢复失败，已按纯文本重发'), '回落文案保留');
  });
  check('⑬ service 权威校验：stageAttachment 与 stageTransientAttachment 均先余量校验后落盘', () => {
    for (const fn of ['export async function stageAttachment', 'export async function stageTransientAttachment']) {
      const at = service.indexOf(fn);
      assert.ok(at > -1, `缺 ${fn}`);
      const body = service.slice(at, service.indexOf('\n}', at));
      const quotaIdx = body.indexOf('assertDraftQuotaAllows');
      const storeIdx = body.indexOf('validateAndStoreAttachment');
      assert.ok(quotaIdx > -1, `${fn} 缺 assertDraftQuotaAllows`);
      assert.ok(storeIdx > -1, `${fn} 缺 validateAndStoreAttachment`);
      assert.ok(quotaIdx < storeIdx, `${fn} 余量校验须先于校验落盘`);
    }
    assert.ok(service.includes('function assertDraftQuotaAllows'), '缺 assertDraftQuotaAllows 定义');
    assert.ok(service.includes('filterDraftAttachmentsByQuota'), 'service 须复用 shared 纯函数');
  });
  check('⑭ service.listDraftQuotaItems：合并 DB draft 行 + 暂态 Map（余量权威口径）', () => {
    assert.ok(service.includes('export function listDraftQuotaItems'), '缺 listDraftQuotaItems');
    const at = service.indexOf('export function listDraftQuotaItems');
    const body = service.slice(at, service.indexOf('\n}', at));
    assert.ok(body.includes('listDraftAttachmentsBySession'), '须查 DB draft 行');
    assert.ok(body.includes('transientAttachments'), '须合并暂态 Map');
    assert.ok(repo.includes('export function listDraftAttachmentsBySession'), 'repo 缺 listDraftAttachmentsBySession');
  });
  check('⑮ 克隆预检：cloneMessageAttachmentsToDraft 组合预检 + 返回 { created, rejected }', () => {
    const at = service.indexOf('export async function cloneMessageAttachmentsToDraft');
    const body = service.slice(at, at + 2400);
    assert.ok(body.includes('filterDraftAttachmentsByQuota'), '克隆须组合预检');
    assert.match(body, /return \{ created, rejected/, '返回形态须为 { created, rejected }');
  });
  check('⑯ PICK：旧 slice(0,10) 截断已废 + 余量预检 + 超余量进 errors（D08-F10 提示顺带）', () => {
    const at = handlers.indexOf('IPC_CHANNELS.ATTACHMENT_PICK');
    const body = handlers.slice(at, at + 2200);
    assert.ok(!body.includes('slice(0, 10)'), '旧「本次 ≤10」截断应删除（由余量预检替代）');
    assert.ok(body.includes('listDraftQuotaItems') || body.includes('DRAFT_QUOTA_MAX_COUNT'), '缺余量预检');
    assert.match(body, /一次最多 10 个附件|hb10-ATT-06/, 'PICK 限量注释锚保留');
    assert.ok(body.includes('errors.push'), '超余量项须进 errors 提示');
  });
  check('⑰ 类型与 preload 同步：CloneMessageAttachmentsResult 双端暴露', () => {
    assert.ok(attachmentTypes.includes('CloneMessageAttachmentsResult'), 'shared 类型缺失');
    assert.match(preloadApi, /cloneMessageAttachments[\s\S]{0,200}CloneMessageAttachmentsResult/, 'preload 返回类型未同步');
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
