export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}
