const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
// Keep this list aligned with markdown-it's data URL validator and browser-safe raster formats.
const ALLOWED_DATA_IMAGE_MIMES = new Set(['png', 'jpeg', 'gif', 'webp']);

export function isAllowedMarkdownImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return true;
    if (parsed.protocol !== 'data:') return false;

    const comma = parsed.pathname.indexOf(',');
    if (comma <= 0 || comma === parsed.pathname.length - 1) return false;
    const [mimeWithParameters] = parsed.pathname.slice(0, comma).split(';', 1);
    const mime = mimeWithParameters.toLowerCase();
    return mime.startsWith('image/') && ALLOWED_DATA_IMAGE_MIMES.has(mime.slice('image/'.length));
  } catch {
    return false;
  }
}

export type NavigationDisposition = 'allow' | 'open-external' | 'block';

export function shouldOpenExternally(url: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function isAllowedAppNavigation(url: string, devRendererUrl?: string): boolean {
  if (!devRendererUrl) {
    return false;
  }

  try {
    const candidate = new URL(url);
    const renderer = new URL(devRendererUrl);
    return (
      renderer.origin !== 'null' &&
      candidate.protocol === renderer.protocol &&
      candidate.origin === renderer.origin
    );
  } catch {
    return false;
  }
}

export function getNavigationDisposition(
  url: string,
  devRendererUrl?: string,
): NavigationDisposition {
  if (isAllowedAppNavigation(url, devRendererUrl)) {
    return 'allow';
  }

  return shouldOpenExternally(url) ? 'open-external' : 'block';
}
