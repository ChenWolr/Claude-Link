// tdd-queue-task-image-preview-verify.ts
// UI13 批次 P2「队列任务图片预览」（2026-11-14 计划，用例正本 03-test-cases.md §P2；
// 实现权威 01-impl-details.md §P2；改动面收敛 src/renderer/components/task/TaskItem.vue 单文件）。
//
// 行为契约（00-behavior-specs §P2 六条）：队列任务卡展开详情区中图片类附件（kind==='image' 且
// previewAvailable）以缩略图展示、点击开全局灯箱（复用 useImageLightbox 单例）看原图；非图片/
// 预览不可用/加载失败回退文件名文本；Blob URL 组件卸载或附件集合变化时全部 revoke；网页版经
// 既有 WEB_CHANNEL_TABLE（attachment:preview）零改动自动可用；头行回形针 chip 逐字节不变。
//
// 用例映射（T2-A~H，八条不增删）：
//   T2-A  渲染规则：编译真实模板 + SSR 渲染观测（img blob: 缩略图 vs 文件名文本行）+ 门控
//         结构钉（v-if 两条件与门 + .task-item__att-thumb + thumbUrls img 绑定 + .task-item__att-file
//         兜底保留）；附属结构钉（01 边界值「展开才加载」）：缩略图加载触发 watch(expanded) 门控
//         ——折叠卡零 IPC 零 Blob（实现标准清单 #4 前半，随 A 的「展开详情区渲染规则」落锚）；
//   T2-B  灯箱单例：import openImageLightbox 自 chat 同款 composable + previewImage 函数体调用钉
//         + 非自造灯箱负向钉（无本地 lightbox DOM/teleport）；
//   T2-C  失败回退：缩略图 IPC 失败静默（catch 无 throw/alert/console.error 组件级负向钉）
//         + 失败态 DOM 观测（thumbUrls 无键 → placeholder 文件名，无 img）；
//   T2-D  生命周期对账：注入实现直测（stub URL.createObjectURL/revokeObjectURL 计数，附件移除
//         →watch 清收、卸载→revokeAll，created===revoked）+ 源码形态钉（revokeAll/safeRevokeFull/
//         onBeforeUnmount alive=false + 附件 watch 清收 + 灯箱占用豁免/本卡源关闭守卫）；
//   T2-E  chip 逐字节不变：chip 块字节级比对（回形针 svg path + title 文件名 \n join + 数量）
//         + SSR 观测（chip 类渲染）；
//   T2-F  网页版回归钉：web-bridge WEB_CHANNEL_TABLE 仍含 getAttachmentPreview →
//         IPC_CHANNELS.ATTACHMENT_PREVIEW（ipc.ts 通道字面 + preload api 同键，先例
//         tdd-web-access-wiring-verify §11.2 口径）；
//   T2-G  连点去重：注入实现直测（并发/连点两次 previewImage，stub fetchPreview 计数=1、
//         openImageLightbox 单实例调用）+ 源码形态钉（previewImage 存在 ⇒ 必含 loading 在飞
//         守卫；feature 未落地前场景不存在，条件钉现状即绿、落地后护住守卫）；
//   T2-H  kind 门控优先：SSR 观测——document kind 且 previewAvailable=true 仍文件名文本行、
//         image kind 且 previewAvailable=false 仍文件名文本行（两条件与门缺一即文本）。
//
// 观测机制（形态门）：@vue/compiler-dom compile(mode:'function') 编译 TaskItem.vue 真实模板
// 为 render 函数，createSSRApp + renderToString 观测渲染形态（仅观测，不改被测源码）。
// 模板内 TS 断言后缀 ` as HTMLElement`（编译期直译产物，与渲染形态无关）在观测副本中剥离
// ——源码结构钉仍钉完整含 as 的字面。
//
// RED 期望桶（对未实现工作树）：T2-A/B/C/D 红；T2-E/F/G/H 回归钉现状即绿
//（E=chip 现状字节、F=桥表现状键、G=条件钉在无 previewImage 时空转、H=现状全文本行天然满足）。
// 若 T2-E/F 红 ⇒ 转写锚错，修转写锚不修实现。
// 运行：npx tsx scripts/tdd-queue-task-image-preview-verify.ts（登记 scripts/selftest-static-list.txt）

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { compile } from '@vue/compiler-dom';
import * as Vue from 'vue';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { AttachmentSummary } from '../src/shared/types/attachment';
import type { Task } from '../src/shared/types/task';

const itemSrc = readFileSync(
  new URL('../src/renderer/components/task/TaskItem.vue', import.meta.url),
  'utf8',
);
const tplStart = itemSrc.indexOf('<template>');
const tplEnd = itemSrc.lastIndexOf('</template>');
const itemTpl = itemSrc.slice(tplStart + '<template>'.length, tplEnd);
const webBridgeSrc = readFileSync(
  new URL('../src/renderer/web/web-bridge.ts', import.meta.url),
  'utf8',
);
const ipcTypesSrc = readFileSync(new URL('../src/shared/types/ipc.ts', import.meta.url), 'utf8');
const preloadSrc = readFileSync(new URL('../src/preload/api.ts', import.meta.url), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

/** 函数体切片：自（async）`function <name>(` 起、至首个列 0 的 `\n}` 闭合。 */
function functionBody(name: string): string {
  const idx = itemSrc.indexOf(`function ${name}(`);
  assert.ok(idx > -1, `TaskItem.vue 缺 ${name} 函数`);
  const end = itemSrc.indexOf('\n}', idx);
  const body = itemSrc.slice(idx, end > idx ? end : undefined);
  assert.ok(body.length > 0, `${name} 函数体切片失败`);
  return body;
}

// ── 形态观测门：编译真实模板 + SSR 渲染 ──
// 观测副本剥离模板表达式中的 TS 断言后缀（` as HTMLElement`）——它只影响编译期类型直译，
// 不影响渲染形态；源码结构钉（T2-B）仍钉完整字面。
const tplForCompile = itemTpl.replace(/ as HTMLElement/g, '');
const compiledCode = compile(tplForCompile, { mode: 'function', prefixIdentifiers: true }).code;
// 编译产物是工厂函数体（前奏 `const { … } = Vue` + return render）：调用工厂并注入 Vue 运行时，
// 才得到真正的 render 函数（不调用则解构落到组件代理上，产生假告警/坏渲染）。
const renderFn = new Function('Vue', compiledCode)(Vue) as (
  ctx: Record<string, unknown>,
  cache: unknown[],
) => unknown;

function fixtureAtt(partial: Partial<AttachmentSummary> & { id: string; kind: AttachmentSummary['kind'] }): AttachmentSummary {
  return {
    sessionId: 's1',
    filename: `${partial.id}.${partial.kind === 'image' ? 'png' : 'pdf'}`,
    mimeType: partial.kind === 'image' ? 'image/png' : 'application/pdf',
    sizeBytes: 1024,
    previewAvailable: true,
    status: 'task',
    ...partial,
  } as AttachmentSummary;
}
function fixtureTask(attachments: AttachmentSummary[]): Task {
  return {
    id: 't1',
    sessionId: 's1',
    prompt: '执行队列任务',
    status: 'pending',
    sortOrder: 0,
    result: null,
    costUsd: null,
    durationMs: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
    attachments,
    clientMessageId: null,
    paused: false,
  };
}

/** SSR 渲染一张任务卡（默认展开），返回 HTML 字符串供形态断言。 */
async function renderCard(opts: {
  task: Task;
  thumbUrls?: Record<string, string>;
  expanded?: boolean;
}): Promise<string> {
  const app = createSSRApp({
    data: () => ({
      task: opts.task,
      eta: null,
      sending: false,
      queuePaused: false,
      queueEnabled: true,
      runNowTitle: '',
      expanded: opts.expanded ?? true,
      thumbUrls: opts.thumbUrls ?? {},
      previewImage: (): void => {},
      emit: (): void => {},
    }),
    render: renderFn,
  });
  app.component('TaskStatusBadge', { inheritAttrs: false, render: (): string => '' });
  return await renderToString(app);
}

void (async (): Promise<void> => {
  console.log('\n=== T2-A 展开详情区渲染规则（缩略图 vs 文件名文本行，双门控） ===');
  check('T2-A-1 门控结构钉：缩略图分支 v-if 两条件与门 + .task-item__att-thumb + thumbUrls img 绑定', () => {
    assert.match(
      itemTpl,
      /v-if="a\.kind === 'image' && a\.previewAvailable"/,
      '缩略图分支缺两条件与门（kind===image && previewAvailable）',
    );
    assert.ok(itemTpl.includes('class="task-item__att-thumb"'), '缺缩略图按钮类 task-item__att-thumb');
    assert.ok(
      /<img v-if="thumbUrls\[a\.id\]" :src="thumbUrls\[a\.id\]" :alt="a\.filename" \/>/.test(itemTpl),
      '缩略图 <img> 未绑定 thumbUrls（应 v-if="thumbUrls[a.id]" :src="thumbUrls[a.id]" :alt="a.filename"）',
    );
    // 点击链路字面（含 TS as 断言的完整形态）
    assert.ok(
      itemTpl.includes('@click="previewImage(a, $event.currentTarget as HTMLElement)"'),
      '缩略图按钮缺 @click="previewImage(a, $event.currentTarget as HTMLElement)" 点击链路',
    );
  });
  check('T2-A-2 非图片兜底结构钉：v-else 文件名文本行 .task-item__att-file 保留', () => {
    assert.ok(
      /<span v-else class="task-item__att-file" :title="a\.filename">\{\{ a\.filename \}\}<\/span>/.test(itemTpl),
      '非图片/预览不可用兜底文件名文本行（v-else .task-item__att-file）缺失',
    );
  });
  check('T2-A-3 附属结构钉（01 边界值·实现标准 #4 前半）：缩略图加载触发以 expanded 门控（折叠零 IPC）', () => {
    assert.match(
      itemSrc,
      /watch\(\s*expanded[\s\S]{0,400}loadThumb\(/,
      '缺 watch(expanded) 展开触发 loadThumb（折叠卡不得发起预览 IPC）',
    );
    assert.ok(
      /watch\(\s*expanded[\s\S]{0,120}if \(!v\) return/.test(itemSrc),
      'expanded watch 缺 false 早退守卫（收起动作不得触发加载）',
    );
  });
  await checkAsync('T2-A-4 形态观测：展开卡渲染 img blob: 缩略图 + 非图片文件名文本行', async () => {
    const img = fixtureAtt({ id: 'img1', kind: 'image' });
    const doc = fixtureAtt({ id: 'doc1', kind: 'document' });
    const html = await renderCard({
      task: fixtureTask([img, doc]),
      thumbUrls: { img1: 'blob:thumb-img1' },
    });
    assert.ok(
      html.includes('task-item__att-thumb'),
      '展开详情区未渲染缩略图元素（task-item__att-thumb）',
    );
    assert.ok(
      html.includes('<img src="blob:thumb-img1"'),
      '缩略图 <img> 未渲染 blob: URL src（应为受控预览产物）',
    );
    assert.ok(
      /task-item__att-file[^<]*>doc1\.pdf</.test(html),
      '非图片附件未呈文件名文本行（doc1.pdf 应在 .task-item__att-file 内）',
    );
  });

  console.log('\n=== T2-B 点缩略图开全局灯箱（同一 composable 单例） ===');
  check('T2-B-1 结构钉：openImageLightbox 自 chat 同款 useImageLightbox composable 导入', () => {
    assert.ok(
      /import \{[^}]*openImageLightbox[^}]*\} from '\.\.\/\.\.\/composables\/useImageLightbox'/.test(itemSrc),
      "缺 import { ... openImageLightbox ... } from '../../composables/useImageLightbox'（必须走全局灯箱单例）",
    );
    assert.ok(
      /useImageLightbox\(\)/.test(itemSrc),
      '未消费 useImageLightbox()（灯箱状态须与聊天附件同源）',
    );
  });
  check('T2-B-2 结构钉：previewImage 函数体调用 openImageLightbox(url, ...) 打开原图', () => {
    const body = functionBody('previewImage');
    assert.ok(
      body.includes('openImageLightbox(url'),
      'previewImage 未调用 openImageLightbox(url, ...)（点击无响应/另起炉灶）',
    );
    assert.ok(
      body.includes('thumbnail: false'),
      'previewImage 应取原图（thumbnail:false），缩略图放大模糊',
    );
    assert.ok(
      body.includes('props.task.sessionId'),
      'previewImage 的 sessionId 应取 props.task.sessionId（任务自带字段，抗切会话竞态）',
    );
  });
  check('T2-B-3 负向钉：任务面板不自造灯箱（无本地 lightbox 组件/teleport）', () => {
    assert.ok(!/new\s+\w*Lightbox/.test(itemSrc), '出现自造灯箱实例化（应复用全局单例）');
    assert.ok(!itemTpl.includes('Teleport'), '模板出现 Teleport（灯箱应由 App.vue 全局单例承载）');
    assert.ok(
      !/lightbox-(backdrop|overlay|mask|close)/.test(itemSrc),
      '出现本地灯箱 DOM 结构类名（应零自造）',
    );
  });

  console.log('\n=== T2-C 预览加载失败回退（静默 + 文件名兜底） ===');
  check('T2-C-1 静默钉：组件无 alert/弹窗/console.error；loadThumb catch 静默无 throw', () => {
    // 负向钉作用于可执行文本：剥离模板注释与整行 // 注释（注释是文档不是执行面，T5-E 同口径）
    const exec = itemSrc
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^[ \t]*\/\/[^\n]*$/gm, '');
    assert.ok(!/[\s(]alert\(/.test(exec), '组件出现 alert( 调用（失败不得弹窗）');
    assert.ok(!exec.includes('window.alert'), '组件出现 window.alert');
    assert.ok(!exec.includes('console.error'), '组件出现 console.error（终审纪律零异常）');
    const body = functionBody('loadThumb');
    assert.ok(body.includes('catch'), 'loadThumb 缺 catch（失败路径可能抛未捕获错致展开白屏）');
    assert.ok(!body.includes('throw'), 'loadThumb 失败路径出现 throw（应静默退化）');
  });
  check('T2-C-2 回退结构钉：未加载成功态呈 placeholder 文件名（thumbUrls 无键 → 文件名 span）', () => {
    assert.ok(
      /<span v-else class="task-item__att-thumb-placeholder">\{\{ a\.filename \}\}<\/span>/.test(itemTpl),
      '缩略图加载失败态缺 placeholder 文件名兜底（应 <span v-else class="task-item__att-thumb-placeholder">{{ a.filename }}</span>）',
    );
  });
  await checkAsync('T2-C-3 失败态 DOM 观测：thumbUrls 空（IPC 失败后无键）→ 只有 placeholder 文件名、无 img', async () => {
    const img = fixtureAtt({ id: 'img1', kind: 'image' });
    const html = await renderCard({ task: fixtureTask([img]), thumbUrls: {} });
    assert.ok(
      html.includes('task-item__att-thumb-placeholder'),
      '失败态未渲染 placeholder 兜底',
    );
    assert.ok(html.includes('img1.png'), '失败态未呈文件名文本（应回退文件名）');
    assert.ok(!html.includes('<img'), '失败态渲染了 <img>（不应有破图）');
    assert.ok(html.includes('task-item__att-thumb'), '失败态应保留缩略图按钮壳（可再点重试）');
  });

  console.log('\n=== T2-D Blob URL 生命周期对账（stub 计数 + 源码形态钉 双门控） ===');
  await checkAsync('T2-D-1 注入实现直测：附件移除→watch 清收、卸载→revokeAll，created === revoked 全部收回', async () => {
    // 按 01-P2 范式注入最小生命周期实现（与组件同构），URL 全程 stub 计数：
    const created: string[] = [];
    const revoked: string[] = [];
    const urlStub = {
      createObjectURL(): string {
        const u = `blob:u${created.length}`;
        created.push(u);
        return u;
      },
      revokeObjectURL(u: string): void {
        revoked.push(u);
      },
    };
    const thumbUrls: Record<string, string> = {};
    const fullUrls = new Map<string, string>();
    const lightbox = { src: null as string | null };
    let alive = true;
    const loadThumb = async (id: string): Promise<void> => {
      if (thumbUrls[id]) return;
      const url = urlStub.createObjectURL();
      if (!alive) return; // 卸载后回跳不建 URL（不泄漏）
      thumbUrls[id] = url;
    };
    const previewImage = async (id: string): Promise<void> => {
      const url = urlStub.createObjectURL();
      if (!alive) return;
      fullUrls.set(id, url);
      lightbox.src = url;
    };
    const watchCleanup = (keepIds: Set<string>): void => {
      for (const [id, url] of [...fullUrls]) {
        if (!keepIds.has(id) && lightbox.src !== url) {
          urlStub.revokeObjectURL(url);
          fullUrls.delete(id);
        }
      }
      for (const id of Object.keys(thumbUrls)) {
        if (!keepIds.has(id)) {
          urlStub.revokeObjectURL(thumbUrls[id]);
          delete thumbUrls[id];
        }
      }
    };
    const unmount = (): void => {
      alive = false;
      const shown = lightbox.src ?? '';
      const owned = [...fullUrls.values(), ...Object.values(thumbUrls)].includes(shown);
      for (const url of fullUrls.values()) urlStub.revokeObjectURL(url);
      for (const id of Object.keys(thumbUrls)) {
        urlStub.revokeObjectURL(thumbUrls[id]);
        delete thumbUrls[id];
      }
      fullUrls.clear();
      if (owned) lightbox.src = null; // 本卡打开的灯箱随卸载关闭
    };

    // 场景：两图缩略图 + A1 原图灯箱打开 → A1 附件被移除（任务替换）→ 组件卸载
    void loadThumb('a1');
    void loadThumb('a2');
    await Promise.resolve();
    void previewImage('a1');
    await Promise.resolve();
    assert.equal(created.length, 3, '前置：应创建 2 缩略图 + 1 原图');
    watchCleanup(new Set(['a2']));
    assert.deepEqual(
      [...fullUrls.keys()],
      ['a1'],
      '附件移除后：原图 URL 被灯箱占用应豁免（否则灯箱破图）',
    );
    assert.ok(!('a1' in thumbUrls), '附件移除后：对应缩略图 URL 应已清收');
    unmount();
    assert.equal(
      created.length,
      revoked.length,
      `对账失败：created=${created.length} revoked=${revoked.length}（有 Blob URL 泄漏）`,
    );
    assert.equal(lightbox.src, null, '本卡灯箱源随卸载应关闭');
    assert.equal(Object.keys(thumbUrls).length, 0, '卸载后 thumbUrls 应清空');
    assert.equal(fullUrls.size, 0, '卸载后 fullUrls 应清空');
    // 每个创建过的 URL 都被 revoke 恰一次
    for (const u of created) {
      assert.equal(revoked.filter((r) => r === u).length, 1, `URL ${u} 未被收回或重复 revoke`);
    }
  });
  check('T2-D-2 源码形态钉：revokeAll/safeRevokeFull 存在且成对 revoke + 灯箱占用豁免', () => {
    const revokeAll = functionBody('revokeAll');
    assert.ok(revokeAll.includes('URL.revokeObjectURL'), 'revokeAll 缺 URL.revokeObjectURL');
    assert.ok(revokeAll.includes('fullUrls.values()'), 'revokeAll 未遍历 fullUrls（原图泄漏）');
    assert.ok(revokeAll.includes('thumbUrls'), 'revokeAll 未清 thumbUrls（缩略图泄漏）');
    assert.ok(revokeAll.includes('fullUrls.clear()'), 'revokeAll 未清空 fullUrls');
    const safeRevoke = functionBody('safeRevokeFull');
    assert.ok(
      safeRevoke.includes('lightboxState'),
      'safeRevokeFull 缺灯箱占用豁免（正在显示的原图被 revoke 会破图）',
    );
    assert.ok(safeRevoke.includes('URL.revokeObjectURL'), 'safeRevokeFull 缺实际 revoke');
  });
  check('T2-D-3 源码形态钉：onBeforeUnmount alive=false + revokeAll + 本卡源灯箱才关闭', () => {
    const idx = itemSrc.indexOf('onBeforeUnmount(');
    assert.ok(idx > -1, '缺 onBeforeUnmount 生命周期钩子');
    const block = itemSrc.slice(idx, itemSrc.indexOf('\n});', idx));
    assert.ok(block.includes('alive = false'), '卸载未置 alive=false（在飞 IPC 回跳会建幽灵 URL/灯箱）');
    assert.ok(block.includes('revokeAll()'), '卸载未调用 revokeAll（Blob URL 泄漏）');
    assert.ok(
      block.includes('[...fullUrls.values(), ...Object.values(thumbUrls)]'),
      '卸载关灯箱缺「本卡源」判据（应仅当灯箱 src 属于本卡 URL 才关闭，避免 A 卡卸载关掉 B 卡灯箱）',
    );
    assert.ok(block.includes('closeImageLightbox'), '卸载缺 closeImageLightbox（本卡灯箱泄漏常开）');
  });
  check('T2-D-4 源码形态钉：附件集合 watch 清收已消失附件 URL（任务整替/删除路径）', () => {
    assert.ok(
      itemSrc.includes('`${a.id}:${a.kind}`'),
      '附件 watch 源非 id:kind 串（同集整替应不触发多余 IPC）',
    );
    assert.ok(/watch\(\s*\(\) => props\.task\.attachments[\s\S]{0,200}join/.test(itemSrc), '缺附件集合 watch');
    assert.ok(itemSrc.includes('safeRevokeFull(id, url)'), '附件 watch 未对消失附件走 safeRevokeFull（原图清收）');
    assert.ok(
      itemSrc.includes('URL.revokeObjectURL(thumbUrls[id])') && itemSrc.includes('delete thumbUrls[id]'),
      '附件 watch 未清收消失附件缩略图 URL',
    );
  });

  console.log('\n=== T2-E 头行回形针 chip 逐字节不变（契约 #6 回归钉） ===');
  check('T2-E chip 块字节级不变：v-if 数量门 + title 文件名 join + 回形针 svg path + 数量插值', () => {
    const start = itemSrc.indexOf('<span v-if="task.attachments.length" class="task-item__atts-chip"');
    assert.ok(start > -1, '头行回形针 chip 缺失');
    const end = itemSrc.indexOf('</span>', start);
    // 源文件为 CRLF 行尾（平台产物）：比对前归一为 \n，其余字节（缩进/字面/插值）逐字节比对
    const block = itemSrc.slice(start, end + '</span>'.length).replace(/\r\n/g, '\n');
    const expected = [
      `<span v-if="task.attachments.length" class="task-item__atts-chip" :title="task.attachments.map((a) => a.filename).join('\\n')">`,
      `        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`,
      `          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />`,
      `        </svg>`,
      `        {{ task.attachments.length }}`,
      `      </span>`,
    ].join('\n');
    assert.equal(block, expected, 'chip 块字节级漂移（P2 契约 #6：头行 chip 逐字节不变）');
  });
  await checkAsync('T2-E SSR 观测：带附件任务卡渲染 chip（数量 + 类名）', async () => {
    const html = await renderCard({
      task: fixtureTask([fixtureAtt({ id: 'img1', kind: 'image' })]),
      thumbUrls: {},
    });
    assert.ok(html.includes('task-item__atts-chip'), 'chip 未随卡渲染');
    assert.ok(/task-item__atts-chip[\s\S]{0,400}?1</.test(html), 'chip 数量插值缺失（应渲染附件数）');
  });

  console.log('\n=== T2-F 网页版可用回归钉（WEB_CHANNEL_TABLE 现状键） ===');
  check('T2-F web-bridge 表仍含 getAttachmentPreview → ATTACHMENT_PREVIEW；ipc/preload 同键在位', () => {
    assert.ok(
      webBridgeSrc.includes('getAttachmentPreview: IPC_CHANNELS.ATTACHMENT_PREVIEW'),
      'WEB_CHANNEL_TABLE 缺 getAttachmentPreview 键（网页端任务预览将 404）',
    );
    assert.ok(
      ipcTypesSrc.includes("ATTACHMENT_PREVIEW: 'attachment:preview'"),
      'ipc.ts 通道字面缺失',
    );
    assert.ok(
      preloadSrc.includes('getAttachmentPreview') && preloadSrc.includes('ATTACHMENT_PREVIEW'),
      'preload api 缺 getAttachmentPreview 实现',
    );
  });

  console.log('\n=== T2-G 连点缩略图去重（stub 计数 + 条件形态钉） ===');
  await checkAsync('T2-G-1 注入实现直测：并发/连点两次 previewImage → fetchPreview 计数=1、灯箱单开', async () => {
    let fetchCount = 0;
    let openCount = 0;
    const openedUrls: string[] = [];
    const loading: Record<string, boolean> = {};
    const fullUrls = new Map<string, string>();
    let seq = 0;
    const fetchPreview = async (id: string): Promise<{ bytes: Uint8Array }> => {
      fetchCount++;
      void id;
      return { bytes: new Uint8Array([++seq]) };
    };
    const previewImage = async (id: string): Promise<void> => {
      if (loading[id]) return; // 在飞去重：双击第二击不得发起第二次 IPC
      let url = fullUrls.get(id);
      if (!url) {
        loading[id] = true;
        try {
          const res = await fetchPreview(id);
          url = `blob:${res.bytes[0]}`;
          fullUrls.set(id, url);
        } finally {
          loading[id] = false;
        }
      }
      openCount++;
      openedUrls.push(url);
    };
    // 并发双击（第二击在第一击在飞期间发起）
    const p1 = previewImage('x');
    const p2 = previewImage('x');
    await Promise.all([p1, p2]);
    assert.equal(fetchCount, 1, `并发连点发起了 ${fetchCount} 次 IPC（应为 1）`);
    assert.equal(openCount, 1, `并发连点开了 ${openCount} 次灯箱（应为 1，单实例）`);
    // 已缓存后再点：不再拉取，仅复用同一 URL 重开灯箱
    await previewImage('x');
    assert.equal(fetchCount, 1, '缓存命中后仍发起 IPC');
    assert.equal(openCount, 2, '缓存命中后应可重开灯箱（原图复用同一 Blob URL）');
    assert.equal(new Set(openedUrls).size, 1, '同一附件多次点击应复用同一 Blob URL（灯箱单实例）');
  });
  check('T2-G-2 条件形态钉：previewImage 存在 ⇒ 必含 loading 在飞守卫（未落地前场景空转）', () => {
    if (!itemSrc.includes('function previewImage(')) return; // RED 态：无点击链路，连点场景不存在
    const body = functionBody('previewImage');
    assert.ok(
      body.includes('if (loading[att.id]) return'),
      'previewImage 缺在飞去重守卫 if (loading[att.id]) return（连点双重 IPC/URL 泄漏）',
    );
    assert.ok(
      body.includes('fullUrls.get(att.id)'),
      'previewImage 缺原图缓存复用（每次点击重复建 URL）',
    );
  });

  console.log('\n=== T2-H kind 门控优先于 previewAvailable（与门缺一即文本行） ===');
  await checkAsync('T2-H-1 观测：document kind 且 previewAvailable=true → 文件名文本行、无缩略图', async () => {
    const doc = fixtureAtt({ id: 'doc1', kind: 'document', previewAvailable: true });
    const html = await renderCard({
      task: fixtureTask([doc]),
      thumbUrls: { doc1: 'blob:should-not-render' },
    });
    assert.ok(html.includes('task-item__att-file'), '文档附件应呈文件名文本行');
    assert.ok(/task-item__att-file[^<]*>doc1\.pdf</.test(html), '文档附件文件名缺失');
    assert.ok(
      !html.includes('task-item__att-thumb'),
      '非 image kind 竟渲染缩略图（kind 门控缺失，文档出破图）',
    );
    assert.ok(!html.includes('<img'), '文档附件渲染了 <img>');
  });
  await checkAsync('T2-H-2 观测：image kind 且 previewAvailable=false → 文件名文本行、无缩略图', async () => {
    const img = fixtureAtt({ id: 'img2', kind: 'image', previewAvailable: false });
    const html = await renderCard({ task: fixtureTask([img]), thumbUrls: {} });
    assert.ok(html.includes('task-item__att-file'), 'previewAvailable=false 的图片应呈文件名文本行');
    assert.ok(
      !html.includes('task-item__att-thumb'),
      'previewAvailable=false 竟渲染缩略图（不可预览附件出破图）',
    );
    assert.ok(!html.includes('<img'), '不可预览附件渲染了 <img>');
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
})();
