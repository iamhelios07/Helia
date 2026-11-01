/** The build target, including when this module is evaluated during SSR. */
export const isDesktopBuild = import.meta.env.MODE === 'desktop';

/** Check the runtime before calling native APIs, including in desktop browser previews. */
export { isTauri } from '@tauri-apps/api/core';
