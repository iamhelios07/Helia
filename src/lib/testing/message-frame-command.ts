import { defineBrowserCommand } from '@vitest/browser-playwright';

export const inspectMessageFrame = defineBrowserCommand(async ({ iframe }, toggle = false) => {
	const body = iframe.frameLocator('iframe[title="메시지 HTML"]').locator('body');
	if (toggle) {
		await body.locator('summary').click();
	}
	return body.evaluate((element) => {
		const root = element.querySelector('#helia-message-root')!;
		let isolated = false;
		try {
			void window.parent.document.body;
		} catch {
			isolated = true;
		}
		return {
			images: [...root.querySelectorAll('img')].map((image) => ({
				src: image.getAttribute('src'),
				width: image.naturalWidth,
				hidden: image.hidden
			})),
			html: root.innerHTML,
			text: root.textContent,
			color: getComputedStyle(root.querySelector('[data-card]') ?? root).color,
			font: getComputedStyle(element).fontFamily,
			documentColorScheme: getComputedStyle(element.ownerDocument.documentElement).colorScheme,
			height: root.getBoundingClientRect().height,
			isolated,
			policy: element.ownerDocument.querySelector('meta[http-equiv]')?.getAttribute('content')
		};
	});
});

declare module 'vitest/browser' {
	interface BrowserCommands {
		inspectMessageFrame: (toggle?: boolean) => Promise<{
			images: { src: string | null; width: number; hidden: boolean }[];
			html: string;
			text: string | null;
			color: string;
			font: string;
			documentColorScheme: string;
			height: number;
			isolated: boolean;
			policy: string | null | undefined;
		}>;
	}
}
