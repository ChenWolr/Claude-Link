<!-- XlsxPreview.vue（2026-11-04 计划 round-001 p7；p4 增列维度钳制）
     抽屉 body 的 xlsx/xls 渲染卡（xlsx@0.18.5 SheetJS）：XLSX.read 解析 workbook 后按
     sheet_to_json({ header:1, defval:'' }) 全量提取各表为 string[][] 缓存——tab 切换纯前端
     换 selected，不重新解析。渲染上限 MAX_ROWS=500（B20）：仅 slice 渲染，超限注明条
     『仅显示前 500 行（共 N 行）』，N 取 !ref 真实总行数（不受解析截断影响）。大表解析截断
     选型（SheetJS 0.18.5 源码已核，node_modules/xlsx/xlsx.js sheet_to_json/make_json_row）：
     sheet_to_json 无 limit 参数，但 range 支持 Range 对象原样生效（default: r = range），
     故解析前用 decode_range(!ref) 得真实总行数，超 EXTRACT_ROWS_CAP 时钳制 range.e.r
     限行提取——10 万行级 sheet 不再逐行分配数组（每行一个 padded array，实测路径）。
     列维度同理（round-001 p4）：Excel 单表上限 16384 列，宽表若不钳列，解析层
     5000×16384≈8200 万条目可内存爆炸/长冻结、渲染层 500×16384≈820 万 <td> 卡死渲染进程，
     故解析前同步钳制 range.e.c 至 MAX_COLS=100（与行钳制同位同风格，锚定 range.s.c），
     超限注明条『仅显示前 100 列（共 N 列）』（仅超限表显示）；displayRows 渲染层每行再
     slice(MAX_COLS) 防御（防多 sheet 处理链旁路遗漏）。
     header:1 时 blankrows 默认含空行（源码 `o.blankrows !== false`），保留空行保表对齐；
     t:'e' 错误单元格出 null，String() 转换前先 null 收口为 ''。错误态：损坏/伪扩展/加密
     统一落「文件损坏或格式异常」（B22/B24），提示可走抽屉「外部打开」。loadToken 竞态守卫
     （每个 await 后比对）+ 卸载 token++ 失效在途链。真实 xlsx 渲染视觉验证归 p11 CDP 冒烟，
     本点以 typecheck + 结构钉为门。
     【性能取舍申报（review round-1 P3-D，2026-11-04）】XLSX.read + sheet_to_json 同步主线程
     执行，8MB 级工作簿大表解析数百 ms~数秒冻结（loading spinner 仅观感兜底）。p4 列钳制
     （MAX_COLS=100）落地后，最坏解析条目量已从 5000×16384≈8200 万收窄至 5000×100≈50 万级，
     冻结风险显著下降。评估结论：当前规模可接受，暂不移 Worker（如未来需支持超大表再评估
     迁移）。本取舍为 review round-1 P3-D 处置结论（评审意见：列钳制落地后重新评估是否移
     Worker，本轮仅申报）。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { Range, WorkSheet } from 'xlsx';
import { base64ToUint8Array } from '../../utils/preview-format';

const props = defineProps<{ base64: string; size: number }>();

type XlsxModule = typeof import('xlsx');
type SheetEntry = { name: string; rows: string[][]; totalRows: number; totalCols: number };

const MAX_ROWS = 500; // 渲染上限（B20）：缓存可超，仅 slice 渲染前 500 行
const EXTRACT_ROWS_CAP = 5000; // 解析截断上限：>5000 行的表只提取前 5000 行（渲染仅 500，缓存余量 10x）
const MAX_COLS = 100; // 列维度钳制（round-001 p4）：解析截断 + 渲染防御双保险（Excel 上限 16384 列，宽表防内存爆炸/渲染卡死）

// ── 视图态 ──
const loading = ref(false);
const errorMsg = ref(''); // '' = 无错误；非空渲染空态卡（B22 损坏/伪扩展/加密统一落点）
const sheets = ref<SheetEntry[]>([]);
const selected = ref(0);

let loadToken = 0; // 竞态 token：换文件/快速重载时旧异步链各 await 后比对丢弃

/** 单表提取：!ref 得真实总行数/总列数（注明条用），超上限分别钳制 range.e.r / range.e.c
 *  限行限列解析（p4：列钳制锚定 range.s.c，与行钳制同风格，s.c>0 的表也精确保 100 列）。
 *  无 !ref（空 sheet）→ rows 空。cells：null（t:'e'）收口 ''，其余原样 String()。 */
function extractSheet(XLSX: XlsxModule, name: string, ws: WorkSheet): SheetEntry {
  const ref = ws?.['!ref'];
  if (!ref) return { name, rows: [], totalRows: 0, totalCols: 0 };
  const range: Range = XLSX.utils.decode_range(String(ref));
  const totalRows = range.e.r - range.s.r + 1;
  if (totalRows > EXTRACT_ROWS_CAP) range.e.r = range.s.r + EXTRACT_ROWS_CAP - 1;
  const totalCols = range.e.c - range.s.c + 1;
  if (totalCols > MAX_COLS) range.e.c = range.s.c + MAX_COLS - 1;
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', range });
  return {
    name,
    totalRows,
    totalCols,
    rows: raw.map((row) => row.map((cell) => (cell == null ? '' : String(cell)))),
  };
}

async function load(): Promise<void> {
  const token = ++loadToken;
  loading.value = true;
  errorMsg.value = '';
  sheets.value = [];
  selected.value = 0;
  if (!props.base64) {
    // 防御：宿主（抽屉/p9 分发表）只应传合法 blob；空载荷按损坏态收口，不留无限 spinner。
    loading.value = false;
    errorMsg.value = '文件损坏或格式异常';
    return;
  }
  try {
    const XLSX = await import('xlsx');
    if (token !== loadToken) return;
    const wb = XLSX.read(base64ToUint8Array(props.base64), { type: 'array' });
    if (token !== loadToken) return;
    const parsed = wb.SheetNames.map((name) => extractSheet(XLSX, name, wb.Sheets[name]));
    if (token !== loadToken) return;
    sheets.value = parsed;
  } catch {
    // SheetJS 对损坏/伪扩展/加密 xlsx 统一 throw（CFB/zip 结构解析失败或缺 workbook 部件）。
    if (token !== loadToken) return;
    errorMsg.value = '文件损坏或格式异常';
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

// ── 当前表派生态（tab 纯前端切换：rows 已缓存，换 selected 不触发重新解析） ──
const currentSheet = computed<SheetEntry | null>(() => sheets.value[selected.value] ?? null);
const displayRows = computed(() =>
  // p4 渲染层防御：每行再 slice(MAX_COLS)——正常路径解析层已钳列，此处兜底多 sheet
  // 处理链旁路（rows 超宽也不会渲染出 >100 列的 <td>）。
  (currentSheet.value?.rows ?? []).slice(0, MAX_ROWS).map((row) => (row.length > MAX_COLS ? row.slice(0, MAX_COLS) : row)),
);
const showTruncatedNote = computed(() => (currentSheet.value?.rows.length ?? 0) > MAX_ROWS);
// p4：列钳制注记显隐 = !ref 真实总列数超 MAX_COLS（仅超限表显示，普通表不显示）。
const showTruncatedCols = computed(() => (currentSheet.value?.totalCols ?? 0) > MAX_COLS);
// 空表判定：无行或全空行（header:1 默认含空行，纯空行表 rows 非空但全为 ''）。
// D-F2 守卫：解析被钳制截断（totalRows > EXTRACT_ROWS_CAP）且截取段全空 → 不判空表——
// 数据可能位于截取段后方，误判会把大表显示成「空表格」；此场景由注记条 + 追加提示交代。
const isBlankSheet = computed(() => {
  const sheet = currentSheet.value;
  if (!sheet) return true;
  const allEmpty = sheet.rows.every((row) => row.every((cell) => cell === ''));
  if (sheet.totalRows > EXTRACT_ROWS_CAP && allEmpty) return false;
  return sheet.rows.length === 0 || allEmpty;
});
// D-F2：注记条追加提示的显隐 = 截取段全空且总行数超解析上限（仅此场景提示「数据在更后方」）。
const showBeyondHint = computed(() => {
  const sheet = currentSheet.value;
  if (!sheet) return false;
  return sheet.totalRows > EXTRACT_ROWS_CAP && sheet.rows.every((row) => row.every((cell) => cell === ''));
});

watch(() => props.base64, () => { void load(); }, { immediate: true });

onBeforeUnmount(() => {
  loadToken++; // 失效在途异步链（迟到 resolve 不再写任何状态）
  sheets.value = [];
});
</script>

<template>
  <div class="xlsx-preview">
    <div v-if="loading" class="xlsx-preview__state">加载中…</div>
    <div v-else-if="errorMsg" class="xlsx-preview__state xlsx-preview__state--empty">
      <span class="xlsx-preview__state-icon">⚠</span>
      <span class="xlsx-preview__state-text">{{ errorMsg }}</span>
      <span class="xlsx-preview__state-hint">可用抽屉底部「外部打开」</span>
    </div>
    <template v-else-if="sheets.length > 0">
      <!-- 表签名 tab 条：横向小 pill（flex wrap 对齐 FilePreviewDrawer .fpreview-pill） -->
      <div class="xlsx-preview__tabs" role="tablist" aria-label="工作表切换">
        <button
          v-for="(sheet, i) in sheets"
          :key="`${sheet.name}#${i}`"
          type="button"
          role="tab"
          :class="['xlsx-preview__tab', { active: i === selected }]"
          :aria-selected="i === selected"
          :title="sheet.name"
          @click="selected = i"
        >{{ sheet.name }}</button>
      </div>
      <!-- 注明条固定在滚动区上方（不随表格滚动，超限提示常驻可见）；
           currentSheet 在 sheets 非空时恒非空（selected 恒在界内），showTruncatedNote 已含其存在性 -->
      <div v-if="!isBlankSheet && showTruncatedNote" class="xlsx-preview__note">
        仅显示前 500 行（共 {{ currentSheet?.totalRows }} 行）
        <!-- D-F2：截取段全空且总行数超解析上限 → 追加提示（样式沿用注记条） -->
        <span v-if="showBeyondHint">· 数据可能位于更后方，请用外部程序打开查看全部</span>
      </div>
      <!-- p4：列钳制注记条（仅超限表显示），复用 .xlsx-preview__note 同款样式 -->
      <div v-if="!isBlankSheet && showTruncatedCols" class="xlsx-preview__note">
        仅显示前 100 列（共 {{ currentSheet?.totalCols }} 列）
      </div>
      <div class="xlsx-preview__scroll">
        <div v-if="isBlankSheet" class="xlsx-preview__state xlsx-preview__state--empty">（空表格）</div>
        <table v-else class="xlsx-preview__table">
          <tbody>
            <tr v-for="(row, r) in displayRows" :key="r">
              <td v-for="(cell, c) in row" :key="c" :title="cell">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <!-- 空 workbook（SheetNames 空）：空态占位 -->
    <div v-else class="xlsx-preview__state xlsx-preview__state--empty">（空表格）</div>
  </div>
</template>

<style scoped>
/* ═══ 根：flex column —— tab 条/注明条固定 + 表格滚动区自适应（token 化，禁硬编码色值） ═══ */
.xlsx-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* 表签名 tab 条：对齐 .fpreview-pill（bg color-mix 6% + pill radius + active panel-soft/elevation-1/600） */
.xlsx-preview__tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  flex-shrink: 0;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
}
.xlsx-preview__tab {
  display: inline-flex;
  align-items: center;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 0;
  background: transparent;
  padding: 5px 12px;
  border-radius: var(--radius-pill);
  font-size: 0.75rem;
  font-family: inherit;
  color: var(--color-text-muted);
  cursor: pointer;
}
.xlsx-preview__tab.active {
  background: var(--color-panel-soft);
  color: var(--color-text);
  font-weight: 600;
  box-shadow: var(--elevation-1);
}

/* 截断注明条（B20）：固定于滚动区上方，小号弱化文本 */
.xlsx-preview__note {
  flex-shrink: 0;
  padding: 4px 12px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-panel-soft);
  font-size: 0.68rem;
  color: var(--color-text-muted);
}

/* 表格滚动区：纵向滚动；空表态在区内居中（flex + margin:auto 双向居中） */
.xlsx-preview__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
}

/* ═══ 表格：原生 table，第一行 sticky 表头，单元格超长省略 + title 全文 ═══ */
.xlsx-preview__table {
  border-collapse: collapse;
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: var(--color-text);
}
.xlsx-preview__table td {
  border: 1px solid var(--color-border);
  padding: 4px 8px;
  max-width: 240px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  background: var(--color-panel);
}
/* 第一行表头：sticky 悬停在滚动区顶部（td 级 sticky，bg 同底色防透字） */
.xlsx-preview__table tr:first-child td {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--color-panel);
}

/* 空态卡：对齐 PdfPreview/DocxPreview（居中 ⚠ + 文字，token 化）；
   根与滚动区均为 flex column 容器，margin:auto 实现纵向居中 */
.xlsx-preview__state {
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  text-align: center;
}
.xlsx-preview__state-icon { font-size: 1.5rem; }
.xlsx-preview__state-hint { font-size: 0.68rem; }
</style>
