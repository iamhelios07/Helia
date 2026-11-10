/**
 * The frame document lives in an opaque-origin iframe, so host CSS variables never
 * inherit across the boundary; the shared base must be embedded as text. Vite's
 * `?raw` import returns an empty string for `.css` files in server-side contexts,
 * so the app base layer is mirrored here instead. A parity test fails the build
 * when this sheet drifts from src/app.css.
 */
export const FRAME_STYLES = `
:root {
	color-scheme: dark;
	--palette-white: #ffffff;
	--palette-silver: #d4d4d4;
	--palette-gray: #b3b3b3;
	--palette-pepper: #2b2b2b;
	--background: var(--palette-pepper);
	--surface: color-mix(in srgb, var(--palette-white) 3%, var(--background));
	--surface-hover: color-mix(in srgb, var(--palette-white) 7%, var(--background));
	--surface-active: color-mix(in srgb, var(--palette-white) 11%, var(--background));
	--text-strong: var(--palette-white);
	--text: var(--palette-silver);
	--text-muted: var(--palette-gray);
	--border: color-mix(in srgb, var(--palette-gray) 19%, transparent);
	--border-strong: color-mix(in srgb, var(--palette-gray) 35%, transparent);
	--accent: var(--palette-white);
	--on-accent: var(--palette-pepper);
	font-family:
		Inter,
		'Pretendard Variable',
		Pretendard,
		-apple-system,
		BlinkMacSystemFont,
		'Segoe UI',
		'Noto Sans KR',
		'Malgun Gothic',
		sans-serif;
	font-synthesis: none;
	text-rendering: optimizeLegibility;
	-webkit-font-smoothing: antialiased;
	background: var(--background);
	color: var(--text);
}
* {
	box-sizing: border-box;
}
button,
input,
select {
	font: inherit;
}
button {
	color: inherit;
	cursor: pointer;
}
button:disabled {
	cursor: not-allowed;
}
:focus-visible {
	outline: 2px solid var(--accent);
	outline-offset: 4px;
}
::selection {
	background: var(--palette-silver);
	color: var(--palette-pepper);
}
/* Frame-only layout rules the app sheet cannot know. */
html,
body,
#workbench {
	margin: 0;
	width: 100%;
	height: 100%;
	overflow: hidden;
}
.content {
	overflow: auto;
	padding: 12px;
	background: var(--surface);
}
button,
select {
	background: var(--surface-hover);
	border: 1px solid var(--border-strong);
	border-radius: 5px;
	padding: 5px 8px;
}
button:disabled {
	opacity: 0.5;
}
progress {
	max-width: 100%;
}
`;
