const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

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
