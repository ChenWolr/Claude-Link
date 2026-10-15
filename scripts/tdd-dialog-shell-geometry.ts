// tdd-dialog-shell-geometry.ts
// 「全弹窗可调大小 + 可拖动」P4 契约钉：弹窗壳纯几何函数（计划 2026-10-14 §2 P4 / L224-228）。
//
// 被测对象：src/renderer/composables/dialog-shell-geometry.ts（纯函数，零依赖——不 import vue，
// 契约脚本 tsx 直测的前提）：
//   centerRect           居中 + 视口钳制（pad 默认 24）
//   clampRectToViewport  全钳到视口内（标题栏必须可点回，不允许部分出视口）
//   dragRect             平移后整体走 clampRectToViewport
//   resizeRect           8 向缩放；宽高按 min/max 钳制；n/w 向收缩反向补偿 left/top；
//                        钳制触底时锚定对侧不动（如 w 收缩到 minW 后 left 不再右移）
//
// 静态断言（E 组）：geometry 文件不 import vue；use-dialog-shell.ts 引用 geometry 的四个函数名
// （防两套实现漂移——use-dialog-shell 必须 import 复用而非复制实现）。
//
// 运行：npx tsx scripts/tdd-dialog-shell-geometry.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  centerRect,
  clampRectToViewport,
  dragRect,
  resizeRect,
  type DialogRect,
  type RectConstraints,
} from '../src/renderer/composables/dialog-shell-geometry';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  check(name, ok, ok ? '' : `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}
/** 逐字段全等比较（DialogRect 四字段与期望完全一致） */
function eqRect(name: string, actual: DialogRect, expected: DialogRect): void {
  const fields: (keyof DialogRect)[] = ['left', 'top', 'width', 'height'];
  const bad = fields.filter((k) => actual[k] !== expected[k]);
  check(
    name,
    bad.length === 0,
    bad.length === 0 ? '' : `字段 ${bad.join('/')} 不符：实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`,
  );
}

function main(): void {
  // ── A 组：centerRect（居中 + 视口钳制，pad 默认 24） ──
  console.log('\n[A] centerRect');
  eqRect(
    '大视口居中：centerRect(720,480, 1920×1080) → left=600 top=300',
    centerRect(720, 480, 1920, 1080),
    { left: 600, top: 300, width: 720, height: 480 },
  );
  eqRect(
    '自然宽超视口：centerRect(1000,480, 800×600) → width=800-2×24=752、left=24',
    centerRect(1000, 480, 800, 600),
    { left: 24, top: 60, width: 752, height: 480 },
  );
  eqRect(
    '自然高超视口：centerRect(720,2000, 800×600) → height=600-2×24=552、top=24',
    centerRect(720, 2000, 800, 600),
    { left: 40, top: 24, width: 720, height: 552 },
  );

  // ── B 组：clampRectToViewport（全钳，pad 默认 8） ──
  console.log('\n[B] clampRectToViewport');
  eqRect(
    '负 left/top 钳回 pad',
    clampRectToViewport({ left: -50, top: -30, width: 400, height: 300 }, 1920, 1080, { minW: 200, minH: 200 }),
    { left: 8, top: 8, width: 400, height: 300 },
  );
  const narrow = clampRectToViewport(
    { left: 0, top: 0, width: 400, height: 300 },
    300, 200,
    { minW: 560, minH: 360 },
  );
  eq('窄视口 300×200 < minW 560 → width = 300-16 = 284', narrow.width, 284);
  eq('窄视口 → left = 8（pad）', narrow.left, 8);
  eq('窄视口 → height = 200-16 = 184', narrow.height, 184);
  eq('窄视口 → top = 8（pad）', narrow.top, 8);
  check(
    '窄视口弹窗仍完整可见（right ≤ vw-pad 且 bottom ≤ vh-pad）',
    narrow.left + narrow.width <= 300 - 8 && narrow.top + narrow.height <= 200 - 8,
    `right=${narrow.left + narrow.width}, bottom=${narrow.top + narrow.height}`,
  );

  // ── C 组：dragRect（平移后整体钳制） ──
  console.log('\n[C] dragRect');
  const dragBase: DialogRect = { left: 1700, top: 100, width: 200, height: 150 };
  const dragC: RectConstraints = { minW: 100, minH: 100 };
  eqRect(
    '拖出右边界钳回（left 2200 → 1712 = vw-width-pad）',
    dragRect(dragBase, 500, 0, 1920, 1080, dragC),
    { left: 1712, top: 100, width: 200, height: 150 },
  );
  const dragLeft = dragRect(dragBase, -3000, 50, 1920, 1080, dragC);
  check('拖出左边界 left ≥ pad（-1300 → 8）', dragLeft.left >= 8, `left=${dragLeft.left}`);
  eqRect(
    '拖出左边界精确值与宽高保持',
    dragLeft,
    { left: 8, top: 150, width: 200, height: 150 },
  );

  // ── D 组：resizeRect（8 向钳制 + 触底锚定对侧） ──
  console.log('\n[D] resizeRect');
  eqRect(
    'se 放大触 max（视口）：left/top 已在 pad → width=784=vw-2pad、height=584=vh-2pad',
    resizeRect({ left: 8, top: 8, width: 600, height: 400 }, 'se', 1000, 1000, 800, 600, { minW: 100, minH: 100 }),
    { left: 8, top: 8, width: 784, height: 584 },
  );
  // w 收缩：right 固定 = 100+300 = 400
  const wBase: DialogRect = { left: 100, top: 50, width: 300, height: 200 };
  const wC: RectConstraints = { minW: 100, minH: 100 };
  eqRect(
    'w 收缩未触底：dx=+100 → width=200、left=200（右移）',
    resizeRect(wBase, 'w', 100, 0, 800, 600, wC),
    { left: 200, top: 50, width: 200, height: 200 },
  );
  const wHit = resizeRect(wBase, 'w', 250, 0, 800, 600, wC);
  const wOver = resizeRect(wBase, 'w', 500, 0, 800, 600, wC);
  eqRect('w 收缩触底 minW：dx=+250 → width=100、left=300', wHit, { left: 300, top: 50, width: 100, height: 200 });
  eqRect(
    'w 触底后 left 锚定不再右移：dx=+500 与 dx=+250 结果一致',
    wOver,
    wHit,
  );
  eqRect(
    'nw 组合双向：dx=dy=-50 → 双向放大 250、se 角锚定（right/bottom 保持 300）',
    resizeRect({ left: 100, top: 100, width: 200, height: 200 }, 'nw', -50, -50, 800, 600, { minW: 100, minH: 100 }),
    { left: 50, top: 50, width: 250, height: 250 },
  );
  // n 收缩：bottom 固定 = 100+200 = 300
  const nBase: DialogRect = { left: 100, top: 100, width: 300, height: 200 };
  const nC: RectConstraints = { minW: 100, minH: 100 };
  const nHit = resizeRect(nBase, 'n', 0, 150, 800, 600, nC);
  const nOver = resizeRect(nBase, 'n', 0, 400, 800, 600, nC);
  eqRect('n 收缩触底 minH：dy=+150 → height=100、top=200', nHit, { left: 100, top: 200, width: 300, height: 100 });
  eqRect('n 触底后 top 锚定不再下移：dy=+400 与 dy=+150 结果一致', nOver, nHit);
  // 补充：e/s 普通增长不动对侧
  eqRect(
    'e 放大普通增长：left/top 不动',
    resizeRect({ left: 100, top: 100, width: 200, height: 200 }, 'e', 60, 0, 1920, 1080, { minW: 100, minH: 100 }),
    { left: 100, top: 100, width: 260, height: 200 },
  );
  eqRect(
    's 增长：top 不动',
    resizeRect({ left: 100, top: 100, width: 200, height: 200 }, 's', 0, 40, 1920, 1080, { minW: 100, minH: 100 }),
    { left: 100, top: 100, width: 200, height: 240 },
  );

  // ── E 组：静态断言（零 vue 依赖 + 复用防漂移） ──
  console.log('\n[E] 静态断言');
  const geoSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'composables', 'dialog-shell-geometry.ts'),
    'utf8',
  );
  check("geometry 不含 from 'vue'（纯函数零框架依赖）", !geoSrc.includes("from 'vue'"));
  check('geometry 不含 from "vue"（双引号写法同样禁止）', !geoSrc.includes('from "vue"'));

  const shellSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'composables', 'use-dialog-shell.ts'),
    'utf8',
  );
  check(
    "use-dialog-shell 从 './dialog-shell-geometry' 引用（单源实现）",
    shellSrc.includes('from \'./dialog-shell-geometry\'') || shellSrc.includes('from "./dialog-shell-geometry"'),
  );
  for (const fn of ['clampRectToViewport', 'centerRect', 'dragRect', 'resizeRect'] as const) {
    check(`use-dialog-shell 引用 ${fn}`, shellSrc.includes(fn));
  }
  // round-002 F2 配套：自然尺寸测量改用布局尺寸 offsetWidth/offsetHeight（不含 transform，
  // 带 scale 的进场动画 from 帧不再污染）；getBoundingClientRect 含 transform，禁止回归。
  check(
    'use-dialog-shell 含 offsetWidth 与 offsetHeight（布局尺寸测量）',
    shellSrc.includes('offsetWidth') && shellSrc.includes('offsetHeight'),
  );
  check('use-dialog-shell 不含 getBoundingClientRect（防回退）', !shellSrc.includes('getBoundingClientRect'));

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
