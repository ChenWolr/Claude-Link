/** 写剪贴板统一入口:安全上下文(桌面/localhost)走 navigator.clipboard;
 * 网页端 http://局域网IP 为非安全上下文,clipboard API 缺失/受限,降级
 * textarea+execCommand('copy');两者皆失败返回 false,由调用方提示。 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 安全上下文也可能因未聚焦等失败,继续走降级
  }
  // F4：textarea 清理移入 finally——execCommand 抛异常（或上方任一步骤异常）也保证
  // ta.remove()，不把隐藏 textarea 遗留在 DOM；返回语义（boolean）不变。
  let ta: HTMLTextAreaElement | null = null;
  try {
    ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta?.remove();
  }
}
