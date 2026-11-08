<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';

	import type { SettingsDialogController } from './settings-dialog-controller.svelte.js';

	import { PROVIDER_KINDS, PROVIDER_KIND_LABELS } from './model.js';
	let { controller }: { controller: SettingsDialogController } = $props();
</script>

{#if controller.providerDraft}<form
		class="connection-form"
		onsubmit={controller.saveConnection}
		oninput={controller.clearVerification}
		novalidate
	>
		<fieldset disabled={controller.busy}>
			<label for="connection-name">연결 이름</label><input
				id="connection-name"
				bind:value={controller.providerDraft.name}
				autocomplete="off"
				placeholder="연결 이름"
				required
			/>
			{#if controller.providerDraft.kind === 'google-vertex' && controller.providerDraft.vertex}
				<p class="field-help">Vertex AI · Service Account JSON</p>
				<div class="field-heading">
					<label for="service-account-json">Service Account JSON</label
					>{#if controller.preset.keyUrl}<a
							href={controller.preset.keyUrl}
							target="_blank"
							rel="external noreferrer">서비스 계정 관리 <Icon name="arrow-right" size={12} /></a
						>{/if}
				</div>
				<textarea
					id="service-account-json"
					rows="7"
					bind:value={
						() => controller.serviceAccountJson, (value) => controller.updateServiceAccount(value)
					}
					onblur={() => controller.updateServiceAccount(controller.serviceAccountJson, true)}
					autocomplete="off"
					spellcheck="false"
					placeholder={controller.hasCredential
						? '저장된 인증 정보를 유지합니다'
						: 'Service Account JSON을 붙여넣으세요'}
					aria-describedby="service-account-help"></textarea>
				<label for="service-account-file">JSON 파일 가져오기</label><input
					id="service-account-file"
					type="file"
					accept=".json,application/json"
					{@attach controller.attachServiceAccountFile}
					onchange={controller.importServiceAccount}
				/>
				<p class="field-help" id="service-account-help">
					{controller.hasCredential
						? '인증 정보가 저장되어 있어요. 교체할 때만 새 JSON을 입력하거나 가져오세요.'
						: '64KiB 이하의 서비스 계정 JSON을 입력하세요. 인증 정보는 보안 저장소에 보관됩니다.'}
				</p>
				{#if controller.readingServiceAccount}<p class="field-help" role="status">
						JSON 파일을 읽는 중…
					</p>{/if}
				{#if controller.serviceAccountError}<p class="notice" role="alert">
						{controller.serviceAccountError}
					</p>{/if}
				<label for="vertex-project">프로젝트 ID</label><input
					id="vertex-project"
					bind:value={controller.providerDraft.vertex.projectId}
					placeholder="my-project-id"
					autocomplete="off"
					spellcheck="false"
					required
				/>
				<label for="vertex-location">리전</label><input
					id="vertex-location"
					bind:value={controller.providerDraft.vertex.location}
					placeholder="global"
					autocomplete="off"
					spellcheck="false"
					required
				/>
				<p class="field-help">프로젝트 ID는 JSON에서 자동으로 채워지며 직접 변경할 수 있어요.</p>
				{#if !controller.creating}
					<button
						class="secondary-button verify-button"
						type="button"
						disabled={!controller.hasCredential ||
							controller.dirty ||
							controller.verificationLoading}
						onclick={controller.verifyServiceAccount}>서비스 계정 인증 확인</button
					>
					<p class="field-help">저장된 서비스 계정으로 OAuth 토큰 인증을 확인합니다.</p>
					{#if controller.verificationLoading}<p class="field-help" role="status">
							서비스 계정 인증을 확인하는 중…
						</p>{/if}
					{#if controller.verificationError}<p class="notice" role="alert">
							{controller.verificationError}
						</p>{/if}
					{#if controller.verificationStatus}<p class="field-help" role="status">
							{controller.verificationStatus}
						</p>{/if}
				{/if}
			{:else}
				<div class="field-heading">
					<label for="connection-key">API 키</label>{#if controller.preset.keyUrl}<a
							href={controller.preset.keyUrl}
							target="_blank"
							rel="external noreferrer">API 키 발급 <Icon name="arrow-right" size={12} /></a
						>{/if}
				</div>
				<input
					id="connection-key"
					type="password"
					bind:value={controller.apiKey}
					autocomplete="new-password"
					spellcheck="false"
					placeholder={controller.hasCredential ? '저장된 API 키를 유지합니다' : 'API 키 입력'}
					aria-describedby="key-help"
				/>
				<p class="field-help" id="key-help">
					{controller.keyHelp}
				</p>
			{/if}
			<details class="advanced" open={!controller.preset.baseUrl}>
				<summary>고급 설정</summary>
				<div>
					<label for="connection-kind">API 형식</label><select
						id="connection-kind"
						bind:value={controller.providerDraft.kind}
						onchange={controller.changeProviderKind}
						>{#each PROVIDER_KINDS as kind (kind)}<option value={kind}
								>{PROVIDER_KIND_LABELS[kind]}</option
							>{/each}</select
					><label for="connection-url">기본 URL</label>
					{#if controller.providerDraft.kind === 'google-vertex'}
						<input
							id="connection-url"
							value={controller.vertexEndpoint}
							readonly
							placeholder="프로젝트 ID와 리전을 입력하세요"
						/>
					{:else}<input
							id="connection-url"
							type="url"
							bind:value={controller.providerDraft.baseUrl}
							oninput={controller.clearCatalog}
							placeholder="https://api.example.com/v1"
							autocomplete="off"
							spellcheck="false"
							required
						/>
					{/if}
				</div>
			</details>
			<button
				class="primary-button save-connection"
				type="submit"
				disabled={controller.readingServiceAccount}
				>{controller.saveLabel}<Icon name="arrow-right" size={16} /></button
			>{#if !controller.creating}<button
					class="delete-connection"
					type="button"
					onclick={controller.removeConnection}><Icon name="trash" size={15} />연결 삭제</button
				>{/if}
		</fieldset>
	</form>{/if}

<style>
	p {
		margin: 0;
	}

	.primary-button,
	.secondary-button {
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
	.primary-button {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--on-accent);
	}
	.primary-button:hover:not(:disabled) {
		background: var(--palette-silver);
		border-color: var(--palette-silver);
	}
	.secondary-button:hover:not(:disabled) {
		background: var(--surface-active);
	}
	button:disabled {
		opacity: 0.45;
	}

	fieldset {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	label:not(.search) {
		display: block;
		margin-bottom: 9px;
		color: var(--text);
		font-size: 12px;
	}
	input,
	textarea,
	select {
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
	textarea {
		min-height: 150px;
		max-height: 320px;
		resize: vertical;
		font-family: inherit;
		line-height: 1.7;
	}
	input[type='file'] {
		padding: 9px;
		font-size: 11px;
	}
	.verify-button {
		width: 100%;
		margin-bottom: 12px;
	}
	input::placeholder,
	textarea::placeholder {
		color: var(--text-muted);
	}
	input:focus,
	textarea:focus,
	select:focus {
		border-color: var(--text-muted);
	}
	.field-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.field-heading a {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-bottom: 9px;
		color: var(--text-muted);
		font-size: 10px;
		text-decoration: none;
	}
	.field-heading a:hover {
		color: var(--text-strong);
	}
	input[type='password'] {
		margin-bottom: 9px;
	}
	.field-help {
		margin-bottom: 23px;
		color: var(--text-muted);
		font-size: 11px;
		line-height: 1.8;
	}
	.advanced {
		margin: 23px 0;
		padding-top: 19px;
		border-top: 1px solid var(--border);
	}
	summary {
		color: var(--text-muted);
		font-size: 11px;
		cursor: pointer;
	}
	.advanced > div {
		padding-top: 22px;
	}
	.advanced input {
		margin-bottom: 0;
	}
	.save-connection {
		width: 100%;
		justify-content: space-between;
		margin-top: 3px;
	}
	.delete-connection {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		width: 100%;
		min-height: 36px;
		margin-top: 15px;
		border: 0;
		background: transparent;
		color: var(--text-muted);
		font-size: 11px;
	}
	.delete-connection:hover {
		color: var(--text-strong);
	}

	.notice {
		margin-bottom: 20px;
		padding: 14px;
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		color: var(--text);
		font-size: 12px;
		line-height: 1.8;
		overflow-wrap: anywhere;
	}
	@media (max-width: 600px) {
		.primary-button {
			padding: 8px 11px;
		}
	}
</style>
