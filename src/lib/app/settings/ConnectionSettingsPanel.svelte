<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';

	import type { SettingsDialogController } from './settings-dialog-controller.svelte.js';

	import ConnectionSettingsForm from './ConnectionSettingsForm.svelte';
	import { selectDefaultModel } from './model.js';
	import ModelPicker from './ModelPicker.svelte';
	import { SERVICE_PRESETS, getServicePreset } from './services.js';

	let { controller }: { controller: SettingsDialogController } = $props();
</script>

{#if controller.settings.providers.length}
	<div class="connection-cards" aria-label="API 연결 목록">
		{#each controller.settings.providers as provider (provider.id)}
			<button
				class={[
					'connection-card',
					{ active: !controller.creating && provider.id === controller.providerDraft?.id }
				]}
				type="button"
				disabled={controller.busy}
				aria-label={`${provider.name} 연결 선택`}
				aria-pressed={!controller.creating && provider.id === controller.providerDraft?.id}
				onclick={() => controller.selectProvider(provider)}
			>
				<span class="service-mark">{getServicePreset(provider.service).name.slice(0, 1)}</span>
				<span>
					<strong>{provider.name}</strong>
					<small>
						추가한 모델 {controller.settings.models.filter(
							(model) => model.providerId === provider.id
						).length}개
					</small>
				</span>
				{#if controller.credentialStatus[provider.id]}
					<span
						class="saved-dot"
						aria-label={provider.kind === 'google-vertex' ? '인증 정보 저장됨' : 'API 키 저장됨'}
					></span>
				{/if}
			</button>
		{/each}
	</div>
{/if}

{#if controller.creating && controller.providerDraft}
	<div class="new-connection">
		<section class="service-catalog" aria-label="서비스 선택">
			<div class="panel-heading">
				<h3>서비스 선택</h3>
				<span>{SERVICE_PRESETS.length}</span>
			</div>
			<label class="search">
				<Icon name="search" size={16} />
				<input
					aria-label="서비스 검색"
					bind:value={controller.serviceSearch}
					placeholder="서비스 검색"
					disabled={controller.busy}
				/>
			</label>
			<div class="service-list">
				{#each controller.services as service (service.id)}
					<button
						class={['service-option', { active: controller.providerDraft.service === service.id }]}
						type="button"
						disabled={controller.busy}
						aria-pressed={controller.providerDraft.service === service.id}
						aria-label={service.name}
						onclick={() => controller.selectService(service.id)}
					>
						<span class="service-mark">{service.name.slice(0, 1)}</span>
						<span>
							<strong>{service.name}</strong>
							<small>{service.description}</small>
						</span>
						<Icon name="arrow-right" size={16} />
					</button>
				{:else}
					<p class="muted">검색 결과가 없어요.</p>
				{/each}
			</div>
		</section>
		<section class="connection-setup">
			<div class="setup-title">
				<span class="service-mark large">{controller.preset.name.slice(0, 1)}</span>
				<h3>{controller.preset.name} 연결</h3>
				<p>{controller.preset.description}</p>
			</div>
			<ConnectionSettingsForm {controller} />
		</section>
	</div>
{:else if controller.providerDraft}
	<div class="connection-detail">
		<section class="connection-setup">
			<div class="panel-heading">
				<h3>연결 설정</h3>
				<span>{controller.preset.name}</span>
			</div>
			<ConnectionSettingsForm {controller} />
		</section>
		<div class="models-panel">
			<ModelPicker
				models={controller.selectedModels}
				providers={controller.settings.providers}
				defaultModelId={controller.settings.defaultModelId}
				busy={controller.busy}
				connection
				manualOnly={controller.providerDraft.kind === 'google-vertex'}
				catalog={controller.catalog}
				loading={controller.catalogLoading}
				catalogError={controller.catalogError}
				canDiscover={controller.hasCredential && !controller.dirty}
				ondiscover={() => {
					void controller.discover();
				}}
				onadd={controller.addModel}
				onedit={controller.editModel}
				ondelete={controller.deleteModel}
				ondefault={(id) => {
					controller.changeView(() => {
						controller.persist(
							() => selectDefaultModel(controller.settings, id),
							'기본 모델을 변경했어요.'
						);
					});
				}}
			/>
		</div>
	</div>
{:else}
	<div class="empty-state">
		<span class="empty-icon"><Icon name="tool" size={30} /></span>
		<h3>첫 API 연결을 추가하세요</h3>
		<p>사용할 AI 서비스를 선택하고<br />인증 정보와 모델을 추가하세요.</p>
		<button class="secondary-button" type="button" onclick={controller.beginConnection}>
			<Icon name="plus" size={16} />새 연결 만들기
		</button>
	</div>
{/if}

<style>
	/*
	 * Component-specific rules only. Button base styles and disabled opacity
	 * come from the shared rules in SettingsDialog.svelte, scoped to
	 * .settings-dialog / .settings-editor-dialog.
	 *
	 * p/notice/muted/input rules stay here: ModelPicker and
	 * ConnectionSettingsForm are nested inside this component and rely on
	 * their own values for those elements, so hoisting them would change
	 * their rendering.
	 */
	h3,
	p {
		margin: 0;
	}

	.connection-cards {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		margin-bottom: 32px;
	}
	.connection-card {
		position: relative;
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 202px;
		padding: 16px 30px 16px 16px;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface);
		text-align: left;
	}
	.connection-card.active {
		border-color: var(--text-muted);
		background: var(--surface-active);
	}
	.connection-card:hover:not(:disabled) {
		border-color: var(--text-muted);
	}
	.connection-card strong,
	.service-option strong {
		display: block;
		color: var(--text-strong);
		font-size: 13px;
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.connection-card small,
	.service-option small {
		display: block;
		margin-top: 7px;
		color: var(--text-muted);
		font-size: 10px;
		line-height: 1.7;
	}
	.service-mark {
		display: grid;
		width: 36px;
		height: 36px;
		flex-shrink: 0;
		place-items: center;
		border: 1px solid var(--border-strong);
		border-radius: 9px;
		background: var(--surface-hover);
		color: var(--text-strong);
		font-size: 16px;
		font-weight: 550;
	}
	.service-mark.large {
		width: 51px;
		height: 51px;
		margin: 0 auto 20px;
		border-radius: 13px;
		font-size: 23px;
	}
	.saved-dot {
		position: absolute;
		top: 14px;
		right: 13px;
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--text-muted);
	}
	.new-connection {
		display: grid;
		grid-template-columns: minmax(220px, 0.9fr) minmax(300px, 1.1fr);
		max-width: 1050px;
		border: 1px solid var(--border);
		border-radius: 12px;
		overflow: hidden;
	}
	.service-catalog {
		padding: 25px;
		border-right: 1px solid var(--border);
		background: var(--surface);
	}
	.panel-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		margin-bottom: 23px;
	}
	.panel-heading > span {
		color: var(--text-muted);
		font-size: 10px;
	}
	h3 {
		color: var(--text-strong);
		font-size: 15px;
		font-weight: 550;
		letter-spacing: -0.025em;
	}
	.search {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 39px;
		padding: 0 11px;
		margin-bottom: 15px;
		border: 1px solid var(--border);
		border-radius: 7px;
		color: var(--text-muted);
	}
	.search:focus-within {
		border-color: var(--text-muted);
	}
	.search input {
		width: 100%;
		min-width: 0;
		height: 100%;
		margin: 0;
		padding: 0;
		border: 0;
		outline: none;
		background: transparent;
		font-size: 12px;
	}
	.service-list {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.service-option {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 13px 11px;
		border: 1px solid transparent;
		border-radius: 8px;
		background: transparent;
		text-align: left;
	}
	.service-option > span:nth-child(2) {
		min-width: 0;
		flex: 1;
	}
	.service-option > :global(svg) {
		flex-shrink: 0;
		color: var(--text-muted);
	}
	.service-option.active {
		border-color: var(--border-strong);
		background: var(--surface-active);
	}
	.service-option:hover:not(:disabled) {
		background: var(--surface-hover);
	}
	.connection-setup {
		min-width: 0;
		padding: 28px;
	}
	.setup-title {
		padding: 10px 0 29px;
		text-align: center;
	}
	.setup-title h3 {
		font-size: 19px;
	}
	.setup-title p {
		margin-top: 11px;
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.8;
	}
	.connection-detail {
		display: grid;
		grid-template-columns: minmax(250px, 0.72fr) minmax(330px, 1.28fr);
		max-width: 1260px;
		border: 1px solid var(--border);
		border-radius: 12px;
	}
	.connection-detail .connection-setup {
		border-right: 1px solid var(--border);
		background: var(--surface);
		border-radius: 12px 0 0 12px;
	}
	.models-panel {
		min-width: 0;
		padding: 28px;
	}
	input {
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
	input::placeholder {
		color: var(--text-muted);
	}
	input:focus {
		border-color: var(--text-muted);
	}
	.empty-state {
		display: flex;
		min-height: 430px;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 17px;
		padding: 30px;
		border: 1px dashed var(--border);
		border-radius: 12px;
		text-align: center;
	}
	.empty-icon {
		display: grid;
		width: 72px;
		height: 72px;
		place-items: center;
		margin-bottom: 8px;
		border: 1px solid var(--border);
		border-radius: 20px;
		color: var(--text-muted);
		background: var(--surface);
	}
	.empty-state h3 {
		font-size: 18px;
	}
	.empty-state p {
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.9;
	}
	.empty-state button {
		margin-top: 5px;
	}
	@media (max-width: 1100px) {
		.connection-detail {
			grid-template-columns: minmax(230px, 0.8fr) minmax(270px, 1fr);
		}
		.connection-setup,
		.models-panel,
		.service-catalog {
			padding: 22px;
		}
		.new-connection {
			grid-template-columns: minmax(210px, 0.85fr) minmax(260px, 1.15fr);
		}
	}
	@media (max-width: 850px) {
		.new-connection,
		.connection-detail {
			grid-template-columns: minmax(0, 1fr);
		}
		.service-catalog {
			border-right: 0;
			border-bottom: 1px solid var(--border);
		}
		.service-list {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.service-option {
			align-items: flex-start;
			padding: 12px 9px;
		}
		.service-option > :global(svg) {
			display: none;
		}
		.service-option .service-mark {
			width: 29px;
			height: 29px;
			font-size: 13px;
		}
		.connection-detail .connection-setup {
			border-right: 0;
			border-bottom: 1px solid var(--border);
			border-radius: 12px 12px 0 0;
		}
		.connection-setup {
			padding: 26px;
		}
	}
	@media (max-width: 600px) {
		.connection-card {
			min-width: 0;
			flex: 1 1 180px;
		}
		.connection-cards {
			gap: 9px;
			margin-bottom: 23px;
		}
		.connection-setup,
		.models-panel,
		.service-catalog {
			padding: 20px;
		}
		.service-list {
			grid-template-columns: minmax(0, 1fr);
		}
		.empty-state {
			min-height: 330px;
			padding: 25px 15px;
		}
		.empty-state h3 {
			font-size: 16px;
		}
	}
</style>
