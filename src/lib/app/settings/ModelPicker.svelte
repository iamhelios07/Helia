<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import type { ModelSettings, ProviderSettings } from './model.js';
	import type { CatalogModel } from './credentials.js';
	let {
		models,
		providers,
		defaultModelId,
		busy = false,
		connection = false,
		manualOnly = false,
		catalog = [],
		loading = false,
		catalogError = '',
		canDiscover = false,
		ondiscover,
		onadd,
		onedit,
		ondelete,
		ondefault
	}: {
		models: ModelSettings[];
		providers: ProviderSettings[];
		defaultModelId: string | null;
		busy?: boolean;
		connection?: boolean;
		manualOnly?: boolean;
		catalog?: CatalogModel[];
		loading?: boolean;
		catalogError?: string;
		canDiscover?: boolean;
		ondiscover?: () => void;
		onadd: (model?: CatalogModel) => void;
		onedit: (model: ModelSettings) => void;
		ondelete: (model: ModelSettings) => void;
		ondefault: (id: string) => void;
	} = $props();
	let search = $state('');
	let catalogSearch = $state('');
	let visible = $derived(
		models.filter((model) =>
			`${model.name} ${model.modelId}`.toLowerCase().includes(search.toLowerCase())
		)
	);
	let available = $derived(
		catalog.filter((model) =>
			`${model.name} ${model.id}`.toLowerCase().includes(catalogSearch.toLowerCase())
		)
	);
</script>

<section class="model-section" aria-label={connection ? '연결 모델' : '모델 관리'}>
	<div class="section-title">
		<div>
			<h2>{connection ? '추가한 모델' : '등록된 모델'}</h2>
			<span>{models.length}개</span>
		</div>
		<button
			class="subtle-button"
			type="button"
			disabled={busy || !providers.length}
			onclick={() => onadd()}><Icon name="plus" size={16} />모델 직접 추가</button
		>
	</div>
	{#if models.length}
		<label class="search"
			><Icon name="search" size={16} /><input
				aria-label="등록된 모델 검색"
				bind:value={search}
				placeholder="모델 검색"
			/></label
		>
		<ul class="model-list" aria-label="등록된 모델">
			{#each visible as model (model.id)}<li>
					<div class="model-info">
						<div class="model-title">
							<strong>{model.name}</strong>{#if model.id === defaultModelId}<span class="badge"
									>기본</span
								>{/if}
						</div>
						<p>{model.modelId}</p>
						{#if !connection}<small
								>{providers.find((provider) => provider.id === model.providerId)?.name}</small
							>{/if}
					</div>
					<div class="model-actions">
						{#if model.id !== defaultModelId}<button
								class="text-button"
								type="button"
								disabled={busy}
								aria-label={`${model.name} 기본 모델로 설정`}
								onclick={() => ondefault(model.id)}>기본으로</button
							>{/if}<button
							class="icon-button"
							type="button"
							disabled={busy}
							aria-label={`${model.name} 모델 편집`}
							onclick={() => onedit(model)}><Icon name="pencil" size={16} /></button
						><button
							class="icon-button"
							type="button"
							disabled={busy}
							aria-label={`${model.name} 모델 삭제`}
							onclick={() => ondelete(model)}><Icon name="trash" size={16} /></button
						>
					</div>
				</li>{:else}<li class="empty-copy">검색 결과가 없어요.</li>{/each}
		</ul>
	{:else}<div class="empty-models">
			<Icon name="chat" size={25} />
			<p>아직 추가한 모델이 없어요.</p>
			<span
				>{connection
					? '목록에서 선택하거나 모델 ID를 직접 입력하세요.'
					: 'API 연결을 만들고 사용할 모델을 추가하세요.'}</span
			>
		</div>{/if}
	{#if connection && manualOnly}
		<p class="muted">Vertex AI에서는 모델 ID를 직접 추가해주세요.</p>
	{:else if connection}
		<div class="catalog-heading">
			<div>
				<h2>추가 가능한 모델</h2>
				<p>서비스에서 제공하는 모델을 찾아보세요.</p>
			</div>
			<button
				class="subtle-button"
				type="button"
				disabled={busy || loading || !canDiscover}
				onclick={ondiscover}
				>{loading ? '불러오는 중…' : catalog.length ? '새로고침' : '모델 목록 불러오기'}</button
			>
		</div>
		{#if catalogError}<p class="notice" role="alert">{catalogError}</p>{/if}
		{#if !canDiscover}<p class="muted">
				API 키를 저장하면 모델 목록을 불러올 수 있어요. 모델 ID를 직접 추가할 수도 있습니다.
			</p>{/if}
		{#if loading}<p class="muted" role="status">모델 목록을 불러오는 중…</p>{/if}
		{#if catalog.length}
			<label class="search"
				><Icon name="search" size={16} /><input
					aria-label="추가 가능한 모델 검색"
					bind:value={catalogSearch}
					placeholder="이름 또는 모델 ID 검색"
				/></label
			>
			<ul class="model-list catalog-list" aria-label="추가 가능한 모델">
				{#each available as model (model.id)}<li>
						<div class="model-info">
							<strong>{model.name}</strong>
							<p>{model.id}</p>
							{#if model.description}<small>{model.description}</small>{/if}
						</div>
						<button
							class="icon-button add-model"
							type="button"
							disabled={busy}
							aria-label={`${model.name} 모델 추가`}
							onclick={() => onadd(model)}><Icon name="plus" size={17} /></button
						>
					</li>{:else}<li class="empty-copy">
						검색 결과가 없어요. 모델 ID로 직접 추가할 수 있습니다.
					</li>{/each}
			</ul>
		{:else if canDiscover && !loading && !catalogError}<p class="muted">
				모델 목록 불러오기를 눌러 사용 가능한 모델을 확인하세요.
			</p>{/if}
	{/if}
</section>

<style>
	.model-section {
		min-width: 0;
	}
	h2,
	p {
		margin: 0;
	}
	h2 {
		color: var(--text-strong);
		font-size: 15px;
		font-weight: 550;
		letter-spacing: -0.025em;
	}
	.section-title,
	.catalog-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		margin-bottom: 22px;
	}
	.section-title > div {
		display: flex;
		align-items: center;
		gap: 9px;
	}
	.section-title span {
		color: var(--text-muted);
		font-size: 11px;
	}
	.catalog-heading {
		margin-top: 38px;
		padding-top: 28px;
		border-top: 1px solid var(--border);
	}
	.catalog-heading p {
		margin-top: 8px;
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.7;
	}
	.subtle-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		gap: 6px;
		min-height: 34px;
		padding: 7px 10px;
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		background: transparent;
		font-size: 11px;
	}
	.subtle-button:hover:not(:disabled),
	.icon-button:hover:not(:disabled),
	.text-button:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text-strong);
	}
	button:disabled {
		opacity: 0.45;
	}
	.search {
		display: flex;
		align-items: center;
		gap: 9px;
		height: 39px;
		margin: 0 0 14px;
		padding: 0 12px;
		border: 1px solid var(--border);
		border-radius: 7px;
		color: var(--text-muted);
	}
	.search input {
		min-width: 0;
		width: 100%;
		height: 100%;
		border: 0;
		outline: none;
		background: transparent;
		color: var(--text-strong);
		font-size: 12px;
	}
	.search:focus-within {
		border-color: var(--text-muted);
	}
	.model-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.model-list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		padding: 16px 0;
		border-bottom: 1px solid var(--border);
	}
	.model-info {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.model-info strong {
		font-size: 12px;
		font-weight: 500;
		color: var(--text-strong);
	}
	.model-info p {
		margin-top: 6px;
		font-size: 11px;
		color: var(--text-muted);
		line-height: 1.6;
	}
	.model-info small {
		display: block;
		margin-top: 6px;
		color: var(--text-muted);
		font-size: 10px;
		line-height: 1.7;
	}
	.model-title {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.badge {
		padding: 2px 5px;
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		color: var(--text-muted);
		font-size: 9px;
	}
	.model-actions {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 3px;
	}
	.icon-button {
		display: grid;
		flex-shrink: 0;
		width: 30px;
		height: 30px;
		padding: 0;
		place-items: center;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-muted);
	}
	.text-button {
		min-height: 30px;
		padding: 6px;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--text-muted);
		font-size: 10px;
	}
	.add-model {
		border: 1px solid var(--border);
	}
	.empty-models {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		min-height: 160px;
		justify-content: center;
		border: 1px dashed var(--border);
		border-radius: 9px;
		padding: 22px;
		color: var(--text-muted);
		text-align: center;
	}
	.empty-models p {
		font-size: 13px;
		color: var(--text);
	}
	.empty-models span {
		font-size: 11px;
		line-height: 1.7;
	}
	.muted,
	.notice,
	.empty-copy {
		margin: 14px 0;
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.8;
	}
	.notice {
		padding: 12px;
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		color: var(--text);
	}
	@media (max-width: 600px) {
		.section-title,
		.catalog-heading {
			align-items: flex-start;
			flex-wrap: wrap;
		}
		.model-list li {
			flex-wrap: wrap;
		}
		.model-actions {
			margin-left: auto;
		}
		.catalog-list li {
			flex-wrap: nowrap;
		}
	}
</style>
