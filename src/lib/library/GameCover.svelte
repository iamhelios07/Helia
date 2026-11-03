<svg
	class="cover"
	viewBox="0 0 240 320"
	preserveAspectRatio="xMidYMid slice"
	fill="none"
	aria-hidden="true"
>
	<path class="paper" d="M0 0h240v320H0z" />
	<path class="frame" d="M15 15h210v290H15z" />
	<g stroke="currentColor" stroke-width="1.2">
		<path d="m120 71 67 39v78l-67 39-67-39v-78l67-39Z" opacity=".5" />
		<path d="m53 110 67 39 67-39m-67 39v78m0-156v78m-67 39 67-39 67 39" opacity=".25" />
		<circle cx="120" cy="149" r="38" opacity=".5" />
		<path d="M120 128v42m-21-21h42" />
	</g>
</svg>

<style>
	.cover {
		--cover-paper: var(--palette-gray);
		--cover-ink: var(--palette-pepper);
		display: block;
		width: 100%;
		height: 100%;
		color: var(--cover-ink);
	}
	.paper {
		fill: var(--cover-paper);
	}
	.frame {
		stroke: currentColor;
		opacity: 0.18;
	}
</style>
