<script lang="ts">
	import { onMount } from 'svelte';

	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import Icon from '#lib/components/Icon.svelte';

	import ConnectionSettingsPanel from './ConnectionSettingsPanel.svelte';
	import ModelEditorDialog from './ModelEditorDialog.svelte';
	import ModelSettingsPanel from './ModelSettingsPanel.svelte';
	import NetworkGrantsPanel from './NetworkGrantsPanel.svelte';
	import PersonaSettingsPanel from './PersonaSettingsPanel.svelte';
	import PromptSettingsPanel from './PromptSettingsPanel.svelte';
	import { SettingsDialogController } from './settings-dialog-controller.svelte.js';
	import SettingsRail from './SettingsRail.svelte';

	let { onclose }: { onclose: () => void } = $props();
	const controller = new SettingsDialogController();
	onMount(() => {
		controller.load();
		return controller.dispose;
	});
</script>

<dialog
	class="settings-dialog"
	{@attach controller.openModal}
	aria-labelledby="settings-heading"
	aria-busy={controller.busy || controller.promptPanel?.isBusy()}
	{onclose}
	oncancel={(event) => {
		event.preventDefault();
		controller.changeView(onclose);
	}}
>
	<div class="settings-shell">
		<SettingsRail {controller} {onclose} />
		<main class="settings-main">
			<div class="page-heading">
				<div>
					<h2>{controller.sectionHeading.title}</h2>
					<p>{controller.sectionHeading.description}</p>
				</div>
				{#if controller.section === 'connections'}
					<button
						class="primary-button"
						type="button"
						disabled={!controller.ready || controller.busy}
						onclick={controller.beginConnection}
					>
						<Icon name="plus" size={17} />새 연결
					</button>
				{/if}
			</div>
			{#if controller.section === 'personas'}
				<PersonaSettingsPanel
					bind:this={controller.personaPanel}
					requestChange={controller.changeView}
				/>
			{:else if controller.section === 'network'}
				<NetworkGrantsPanel />
			{:else if controller.section === 'prompts'}
				<PromptSettingsPanel
					bind:this={controller.promptPanel}
					requestChange={controller.changeView}
					requestConfirmation={(heading, message, label, action) => {
						controller.confirmation = { heading, message, label, action };
					}}
				/>
			{:else if controller.loadError}
				<div class="notice" role="alert">
					<p>{controller.loadError}</p>
					<button class="secondary-button" type="button" onclick={controller.load}>
						다시 불러오기
					</button>
				</div>
			{:else if !controller.ready}
				<p class="muted" role="status">설정을 불러오는 중…</p>
			{:else}
				{#if controller.error}
					<p class="notice" role="alert">{controller.error}</p>
				{/if}
				<p class="save-status" role="status">{controller.status}</p>
				{#if controller.credentialError}
					<div class="notice credential-notice" role="alert">
						<p>{controller.credentialError}</p>
						<button
							class="text-button"
							type="button"
							disabled={controller.checkingCredentials || controller.busy}
							onclick={controller.refreshCredentialStatus}
						>
							{controller.providerDraft?.kind === 'google-vertex'
								? '인증 정보 상태 다시 확인'
								: 'API 키 상태 다시 확인'}
						</button>
					</div>
				{/if}
				{#if controller.section === 'connections'}
					<ConnectionSettingsPanel {controller} />
				{:else}
					<ModelSettingsPanel {controller} />
				{/if}
			{/if}
		</main>
	</div>
</dialog>

<ModelEditorDialog {controller} />

{#if controller.confirmation}
	<ConfirmDialog
		title={controller.confirmation.heading}
		message={controller.confirmation.message}
		confirmLabel={controller.confirmation.label.includes('삭제')
			? '삭제'
			: controller.confirmation.label}
		tone={controller.confirmation.label.includes('삭제') ? 'danger' : 'default'}
		onconfirm={controller.confirmAction}
		oncancel={() => (controller.confirmation = null)}
	/>
{/if}

<style>
	.settings-dialog {
		inset: 0;
		width: 100vw;
		max-width: none;
		height: 100dvh;
		max-height: none;
		margin: 0;
		border: 0;
		overflow: hidden;
	}
	.settings-shell {
		display: grid;
		grid-template-columns: 238px minmax(0, 1fr);
		height: 100%;
	}

	/* Shell markup only. Panels get their own reset from the shared rules below. */
	h2,
	p {
		margin: 0;
	}

	.settings-main {
		min-width: 0;
		min-height: 0;
		overflow-y: auto;
		padding: 46px clamp(24px, 4vw, 64px) 60px;
		overscroll-behavior: contain;
	}
	.page-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 24px;
		margin-bottom: 35px;
	}
	.page-heading h2 {
		color: var(--text-strong);
		font-size: 25px;
		font-weight: 550;
		letter-spacing: -0.045em;
	}
	.page-heading p {
		margin-top: 12px;
		font-size: 12px;
		line-height: 1.8;
		color: var(--text-muted);
	}
	/*
	 * Shared base rules for the settings window and its model editor.
	 * Defined once here and scoped to the two dialog roots so
	 * ConnectionSettingsPanel, ModelSettingsPanel and ModelEditorDialog
	 * do not each carry a copy.
	 *
	 * Every selector is wrapped in :where() so specificity stays at zero.
	 * Component-local rules therefore always win, which keeps nested
	 * components (ModelPicker, ConnectionSettingsForm, Prompt/Persona/
	 * NetworkGrants panels) and the editor's own media queries rendering
	 * exactly as before, regardless of stylesheet injection order.
	 */
	:global(:where(.settings-dialog, .settings-editor-dialog)) {
		padding: 0;
		border: 1px solid var(--border-strong);
		background: var(--background);
		color: var(--text);
	}
	:global(:where(:is(.settings-dialog, .settings-editor-dialog))::backdrop) {
		background: color-mix(in srgb, var(--palette-pepper) 80%, transparent);
		backdrop-filter: blur(6px);
	}
	:global(
		:where(:is(.settings-dialog, .settings-editor-dialog) :is(.primary-button, .secondary-button))
	) {
		display: inline-flex;
		flex-shrink: 0;
		min-height: 38px;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 9px 14px;
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		background: var(--surface-hover);
		color: var(--text-strong);
		font-size: 12px;
		font-weight: 500;
	}
	:global(:where(:is(.settings-dialog, .settings-editor-dialog) .primary-button)) {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--on-accent);
	}
	:global(
		:where(:is(.settings-dialog, .settings-editor-dialog) .primary-button:hover:not(:disabled))
	) {
		background: var(--palette-silver);
		border-color: var(--palette-silver);
	}
	:global(
		:where(:is(.settings-dialog, .settings-editor-dialog) .secondary-button:hover:not(:disabled))
	) {
		background: var(--surface-active);
	}
	:global(:where(:is(.settings-dialog, .settings-editor-dialog) button:disabled)) {
		opacity: 0.45;
	}
	:global(:where(:is(.settings-dialog, .settings-editor-dialog) .muted)) {
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.8;
	}
	/*
	 * The editor nests no components, so its form primitives can be shared
	 * too. Panel tag rules stay component-local on purpose: ModelPicker and
	 * ConnectionSettingsForm are nested inside the panels and set their own
	 * margins/padding for p/label/input, so a window-wide tag rule would
	 * change their layout.
	 */
	:global(:where(.settings-editor-dialog) p) {
		margin: 0;
	}
	:global(:where(.settings-editor-dialog) label) {
		display: block;
		margin-bottom: 9px;
		color: var(--text);
		font-size: 12px;
	}
	:global(:where(.settings-editor-dialog) :is(input, select)) {
		width: 100%;
		min-width: 0;
		min-height: 41px;
		margin: 0 0 24px;
		padding: 10px 11px;
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		background: var(--background);
		color: var(--text-strong);
		font-size: 12px;
	}
	:global(:where(.settings-editor-dialog) input::placeholder) {
		color: var(--text-muted);
	}
	:global(:where(.settings-editor-dialog) :is(input, select):focus) {
		border-color: var(--text-muted);
	}
	/*
	 * Scoped to the shell's notices and the editor's own notice only.
	 * Persona/Prompt panels and ModelPicker render their own `.notice` with
	 * different values, so a window-wide descendant selector would restyle
	 * them.
	 */
	:global(:where(:is(.settings-dialog .settings-main > .notice, .settings-editor-dialog .notice))) {
		margin-bottom: 20px;
		padding: 14px;
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		color: var(--text);
		font-size: 12px;
		line-height: 1.8;
		overflow-wrap: anywhere;
	}
	.notice button {
		margin-top: 9px;
	}
	.credential-notice {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 15px;
	}
	.credential-notice button {
		margin: 0;
	}
	.text-button {
		min-height: 32px;
		padding: 5px 8px;
		flex-shrink: 0;
		border: 0;
		border-radius: 6px;
		background: var(--surface-hover);
		color: var(--text);
		font-size: 11px;
	}
	.save-status:not(:empty) {
		margin-bottom: 20px;
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.7;
	}
	@media (min-width: 1700px) {
		.settings-main {
			padding-right: 7vw;
		}
	}
	@media (max-width: 1100px) {
		.settings-shell {
			grid-template-columns: 195px minmax(0, 1fr);
		}
		.settings-main {
			padding: 32px 25px;
		}
	}
	@media (max-width: 850px) {
		.settings-shell {
			grid-template-columns: 170px minmax(0, 1fr);
		}
	}
	@media (max-width: 600px) {
		.settings-shell {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto minmax(0, 1fr);
		}

		.settings-main {
			padding: 25px 18px 38px;
		}
		.page-heading {
			gap: 14px;
			align-items: flex-start;
			margin-bottom: 25px;
		}
		.page-heading h2 {
			font-size: 22px;
		}
		.page-heading p {
			font-size: 11px;
		}
		.primary-button {
			padding: 8px 11px;
		}
		.credential-notice {
			align-items: flex-start;
			flex-direction: column;
			gap: 9px;
		}
	}
</style>
