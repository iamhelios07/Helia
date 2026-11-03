import type { GameUI } from './runtime/model.js';

/** Allow only individual CSS values; never accept stylesheets or resource references. */
export function safeChatStyle(style: GameUI['chatStyle']): GameUI['chatStyle'] {
	if (!style || typeof CSS === 'undefined') return undefined;
	const safe = (property: string, value: string | undefined) =>
		value &&
		value.length <= 256 &&
		!/[;{}\\\n\r]|(?:url|var|env|attr)\s*\(/i.test(value) &&
		CSS.supports(property, value)
			? value
			: undefined;
	return {
		background: safe('color', style.background),
		color: safe('color', style.color),
		fontFamily: safe('font-family', style.fontFamily),
		userBackground: safe('color', style.userBackground),
		assistantBackground: safe('color', style.assistantBackground)
	};
}
