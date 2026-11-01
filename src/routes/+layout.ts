import { isDesktopBuild } from '#lib/platform/index.js';

// The Node.js app keeps SSR; the Tauri webview renders the shared UI as an SPA.
export const ssr = !isDesktopBuild;
