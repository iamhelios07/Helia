<script lang="ts">
	import type { PreviewGame } from './preview-games';
	let { kind }: { kind: PreviewGame['cover'] } = $props();
</script>

<svg
	class={['cover', `cover--${kind}`]}
	viewBox="0 0 240 320"
	preserveAspectRatio="xMidYMid slice"
	fill="none"
	aria-hidden="true"
>
	<path class="paper" d="M0 0h240v320H0z" />
	<path class="frame" d="M15 15h210v290H15z" />
	{#if kind === 'forest'}
		<circle cx="146" cy="96" r="43" fill="currentColor" opacity=".17" />
		<g stroke="currentColor" stroke-width="1.2" opacity=".7">
			<path
				d="M40 64v185m-25-88 25-40 30 50M25 118l15-27 21 34M17 198l23-41 39 62M186 42v220m-34-120 34-61 39 74m-60 35 21-42 39 66M75 93v126m-20-64 20-41 27 51M208 141v129m-24-63 24-40 25 48"
			/>
			<path
				d="M111 167c51 22-48 39-19 66s66 25 61 57M126 176c48 21-39 35-7 59s64 31 59 55"
				opacity=".7"
			/>
		</g>
		<text x="28" y="46" class="eyebrow">01 / FANTASY</text>
		<text x="28" y="267" class="cover-title">BEYOND</text>
		<text x="28" y="292" class="cover-title">THE MIST</text>
	{:else if kind === 'archive'}
		<g stroke="currentColor" stroke-width="1.2">
			<path
				d="M42 294V122a78 78 0 0 1 156 0v172M57 294V123a63 63 0 0 1 126 0v171M73 294V124a47 47 0 0 1 94 0v170M88 294V125a32 32 0 0 1 64 0v169"
				opacity=".5"
			/>
			<path
				d="M103 294V127a17 17 0 0 1 34 0v167M103 199h34m-34-14h34m-34-14h34M20 225h22m156 0h22M20 200h22m156 0h22M20 175h22m156 0h22"
				opacity=".6"
			/>
			<path d="m120 70 4 10-4 10-4-10 4-10Z" fill="currentColor" />
		</g>
		<text x="28" y="46" class="eyebrow">02 / MYSTERY</text>
		<path class="paper" d="M24 228h192v72H24z" />
		<text x="28" y="267" class="cover-title">MIDNIGHT</text>
		<text x="28" y="292" class="cover-title">ARCHIVE</text>
	{:else if kind === 'orbit'}
		<g stroke="currentColor">
			<circle
				cx="122"
				cy="148"
				r="59"
				fill="currentColor"
				fill-opacity=".08"
				stroke-opacity=".65"
			/>
			<ellipse cx="122" cy="148" rx="104" ry="31" transform="rotate(-35 122 148)" opacity=".7" />
			<ellipse cx="122" cy="148" rx="91" ry="78" transform="rotate(-35 122 148)" opacity=".18" />
			<path
				d="M72 119c24 6 52 26 65 68m-55-80c24 6 52 26 65 68m-40-77c22 11 40 27 49 49"
				opacity=".25"
			/>
			<path d="M51 77h8m-4-4v8m126-13h6m-3-3v6M180 221h8m-4-4v8M39 204h4" opacity=".8" />
		</g>
		<circle cx="194" cy="92" r="5" fill="currentColor" />
		<text x="28" y="46" class="eyebrow">03 / SCI-FI</text>
		<text x="28" y="267" class="cover-title">THE LAST</text>
		<text x="28" y="292" class="cover-title">ORBIT</text>
	{:else}
		<g stroke="currentColor" stroke-width="1.2">
			<path d="m120 71 67 39v78l-67 39-67-39v-78l67-39Z" opacity=".5" />
			<path d="m53 110 67 39 67-39m-67 39v78m0-156v78m-67 39 67-39 67 39" opacity=".25" />
			<circle cx="120" cy="149" r="38" opacity=".5" />
			<path d="M120 128v42m-21-21h42" />
		</g>
		<text x="28" y="46" class="eyebrow">04 / SANDBOX</text>
		<text x="28" y="267" class="cover-title">A WORLD</text>
		<text x="28" y="292" class="cover-title">UNWRITTEN</text>
	{/if}
</svg>

<style>
	.cover {
		--cover-paper: var(--surface);
		--cover-ink: var(--palette-silver);
		display: block;
		width: 100%;
		height: 100%;
		color: var(--cover-ink);
	}
	.cover--archive {
		--cover-paper: var(--palette-silver);
		--cover-ink: var(--palette-pepper);
	}
	.cover--blank {
		--cover-paper: var(--palette-gray);
		--cover-ink: var(--palette-pepper);
	}
	.paper {
		fill: var(--cover-paper);
	}
	.frame {
		stroke: currentColor;
		opacity: 0.18;
	}
	text {
		fill: currentColor;
		font-family: 'Segoe UI', sans-serif;
	}
	.eyebrow {
		font-size: 8px;
		letter-spacing: 2px;
	}
	.cover-title {
		font-size: 25px;
		font-weight: 300;
		letter-spacing: 1px;
	}
</style>
