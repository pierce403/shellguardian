import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow, type Theme } from '@tauri-apps/api/window';
import type { UnlistenFn } from '@tauri-apps/api/event';

/** Follow the desktop theme without saving a separate application preference. */
export function followSystemTheme(): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let disposed = false;
  let nativeTheme: Theme | null = null;
  let nativeRevision = 0;
  let unlisten: UnlistenFn | undefined;

  const apply = () => {
    if (!disposed) {
      document.documentElement.dataset.theme = nativeTheme ?? (media.matches ? 'dark' : 'light');
    }
  };
  const acceptNativeTheme = (theme: unknown) => {
    if (theme === 'dark' || theme === 'light') {
      nativeTheme = theme;
      apply();
    }
  };

  // Apply synchronously before React's first render. This also supports the
  // browser preview and platforms where native theme information is unavailable.
  apply();
  media.addEventListener('change', apply);

  if (isTauri()) {
    void (async () => {
      try {
        const window = getCurrentWindow();
        unlisten = await window.onThemeChanged(({ payload }) => {
          nativeRevision += 1;
          acceptNativeTheme(payload);
        });
        if (disposed) {
          unlisten();
          return;
        }
        const revision = nativeRevision;
        const theme = await window.theme();
        // A system change can arrive while the initial read is still pending.
        if (revision === nativeRevision) acceptNativeTheme(theme);
      } catch {
        // The media query remains active if the platform cannot report a theme.
      }
    })();
  }

  return () => {
    disposed = true;
    media.removeEventListener('change', apply);
    unlisten?.();
  };
}
