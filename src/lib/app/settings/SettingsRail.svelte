<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';

	import type { SettingsDialogController } from './settings-dialog-controller.svelte.js';
	let { controller, onclose }: { controller: SettingsDialogController; onclose: () => void } =
		$props();
</script>

<aside class="settings-rail">
	<div class="rail-heading">
		<h1 id="settings-heading">설정</h1>
		<button
			class="icon-button"
			type="button"
			aria-label="설정 닫기"
			disabled={controller.busy || controller.promptPanel?.isBusy()}
			onclick={() => controller.changeView(onclose)}><Icon name="close" size={19} /></button
		>
	</div>
	<nav aria-label="설정 메뉴">
		<button
			class={{ selected: controller.section === 'models' }}
			type="button"
			aria-label="모델"
			aria-current={controller.section === 'models' ? 'page' : undefined}
			disabled={controller.busy || controller.promptPanel?.isBusy()}
			onclick={() => controller.switchSection('models')}><Icon name="chat" size={18} />모델</button
		><button
			class={{ selected: controller.section === 'connections' }}
			type="button"
			aria-label="API 연결"
			aria-current={controller.section === 'connections' ? 'page' : undefined}
			disabled={controller.busy || controller.promptPanel?.isBusy()}
			onclick={() => controller.switchSection('connections')}
			><Icon name="tool" size={18} />API 연결</button
		>
		<button
			class={{ selected: controller.section === 'prompts' }}
			type="button"
			aria-label="프롬프트"
			aria-current={controller.section === 'prompts' ? 'page' : undefined}
			disabled={controller.busy || controller.promptPanel?.isBusy()}
			onclick={() => controller.switchSection('prompts')}
			><Icon name="book" size={18} />프롬프트</button
		>
	</nav>
	<div class="rail-footer"><Icon name="sun" size={19} /><span>Helia</span></div>
</aside>

<style>
	.settings-rail {
		display: flex;
		min-height: 0;
		flex-direction: column;
		gap: 30px;
		padding: 32px 18px 24px;
		border-right: 1px solid var(--border);
		background: var(--surface);
	}
	.rail-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 0 11px;
	}
	h1 {
		margin: 0;
	}
	h1 {
		font-size: 20px;
		font-weight: 550;
		color: var(--text-strong);
		letter-spacing: -0.04em;
	}
	nav {
		display: flex;
		flex-direction: column;
		gap: 7px;
	}
	nav button {
		display: flex;
		align-items: center;
		gap: 11px;
		min-height: 45px;
		padding: 11px 15px;
		border: 1px solid transparent;
		border-radius: 8px;
		background: transparent;
		color: var(--text-muted);
		text-align: left;
		font-size: 13px;
	}
	nav button.selected {
		background: var(--surface-active);
		border-color: var(--border);
		color: var(--text-strong);
	}
	nav button:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text-strong);
	}
	.rail-footer {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: auto;
		padding: 0 12px;
		color: var(--text-muted);
		font-size: 12px;
	}

	button:disabled {
		opacity: 0.45;
	}
	.icon-button {
		display: grid;
		width: 31px;
		height: 31px;
		padding: 0;
		flex-shrink: 0;
		place-items: center;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-muted);
	}
	.icon-button:hover {
		background: var(--surface-hover);
		color: var(--text-strong);
	}
	@media (max-width: 850px) {
		.settings-rail {
			padding: 25px 12px 20px;
		}
	}
	@media (max-width: 600px) {
		.settings-rail {
			gap: 16px;
			padding: 17px 18px 12px;
			border-right: 0;
			border-bottom: 1px solid var(--border);
		}
		.rail-heading {
			padding: 0;
		}
		h1 {
			font-size: 18px;
		}
		nav {
			flex-direction: row;
			gap: 8px;
		}
		nav button {
			min-height: 37px;
			flex: 1;
			justify-content: center;
			font-size: 12px;
		}
		.rail-footer {
			display: none;
		}
	}
</style>
