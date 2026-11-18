import { isTauri } from '@tauri-apps/api/core';

/** `?preview=1` shows illustrative sample data and contacts nothing. */
export const previewMode = new URLSearchParams(window.location.search).get('preview') === '1';
/** True inside the ShellGuardian desktop app. */
export const desktopMode = isTauri();
