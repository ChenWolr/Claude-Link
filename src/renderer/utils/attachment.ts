// 附件徽标：优先按文件名后缀（用户期望显示"对应后缀格式"，且 stageAttachment 对非图片
// 常拿不到准确 MIME），mimeType 仅作无后缀时的兜底。返回短大写徽标文本。
const KNOWN_EXTS: Record<string, string> = {
  pdf: 'PDF',
  txt: 'TXT', md: 'MD', markdown: 'MD', rtf: 'RTF',
  png: 'PNG', jpg: 'JPG', jpeg: 'JPG', gif: 'GIF', webp: 'WEBP', bmp: 'BMP', svg: 'SVG', tiff: 'TIF',
  json: 'JSON', csv: 'CSV', tsv: 'TSV', yaml: 'YAML', yml: 'YML', xml: 'XML', toml: 'TOML', ini: 'INI', cfg: 'CFG', conf: 'CONF',
  ts: 'TS', tsx: 'TSX', js: 'JS', jsx: 'JSX', mjs: 'MJS', cjs: 'CJS',
  vue: 'VUE', svelte: 'SVEL', astro: 'AST',
  py: 'PY', java: 'JAVA', kt: 'KT', go: 'GO', rs: 'RS', rb: 'RB', php: 'PHP', c: 'C', h: 'H', cpp: 'CPP', cc: 'CC', cs: 'CS',
  html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', less: 'LESS',
  ipynb: 'NB', sql: 'SQL', sh: 'SH', bash: 'SH', zsh: 'SH', bat: 'BAT', ps1: 'PS1',
  zip: 'ZIP', gz: 'GZ', tar: 'TAR', rar: 'RAR', '7z': '7Z',
  doc: 'DOC', docx: 'DOC', xls: 'XLS', xlsx: 'XLS', ppt: 'PPT', pptx: 'PPT',
};

export function attachmentBadge(filename: string, mimeType?: string): string {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext) {
    return KNOWN_EXTS[ext] ?? ext.slice(0, 4).toUpperCase();
  }
  // 无后缀兜底：按 mimeType 归类。
  const mime = (mimeType ?? '').toLowerCase();
  if (mime === 'application/pdf') return 'PDF';
  if (mime.startsWith('text/')) return 'TXT';
  if (mime.startsWith('image/')) return 'IMG';
  if (mime.includes('json')) return 'JSON';
  if (mime.includes('xml')) return 'XML';
  return 'FILE';
}
