<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import ModelPicker from './ModelPicker.svelte';
	import PromptSettingsPanel from './PromptSettingsPanel.svelte';
	import {
		PROVIDER_KINDS,
		PROVIDER_KIND_LABELS,
		emptyAISettings,
		upsertProvider,
		removeProvider,
		upsertModel,
		removeModel,
		selectDefaultModel,
		type AISettings,
		type ProviderSettings,
		type ModelSettings
	} from './model.js';
	import { SERVICE_PRESETS, getServicePreset, type ServiceId } from './services.js';
	import {
		getCredentialStatus,
		saveCredential,
		saveServiceAccountCredential,
		verifyProviderCredential,
		deleteCredential,
		fetchProviderModels,
		type CatalogModel
	} from './credentials.js';
	import { loadAISettings, saveAISettings } from './repository.js';
	import { parseServiceAccountJson, vertexBaseUrl } from './vertex.js';
	let { onclose }: { onclose: () => void } = $props();
	type Section = 'connections' | 'models' | 'prompts';
	let promptPanel = $state<{
		hasUnsavedChanges: () => boolean;
		discardDraft: () => void;
		isBusy: () => boolean;
	}>();
	type Confirmation = { heading: string; message: string; label: string; action: () => void };
	let section = $state<Section>('connections');
	let settings = $state.raw<AISettings>(emptyAISettings());
	let ready = $state(false);
	let loadError = $state('');
	let error = $state('');
	let status = $state('');
	let busy = $state(false);
	let creating = $state(false);
	let providerDraft = $state<ProviderSettings | null>(null);
	let initialProvider = $state('');
	let apiKey = $state('');
	let serviceAccountJson = $state('');
	let serviceAccountFileName = $state('');
	let serviceAccountError = $state('');
	let readingServiceAccount = $state(false);
	let serviceAccountFileInput: HTMLInputElement | undefined;
	let fileGeneration = 0;
	let verificationLoading = $state(false);
	let verificationError = $state('');
	let verificationStatus = $state('');
	let verificationRequest: AbortController | null = null;
	let serviceSearch = $state('');
	let credentialStatus = $state.raw<Record<string, boolean>>({});
	let credentialError = $state('');
	let checkingCredentials = $state(false);
	let modelDraft = $state<ModelSettings | null>(null);
	let initialModel = $state('');
	let modelError = $state('');
	let confirmation = $state<Confirmation | null>(null);
	let catalog = $state.raw<CatalogModel[]>([]);
	let catalogLoading = $state(false);
	let catalogError = $state('');
	let catalogRequest: AbortController | null = null;
	let statusGeneration = 0;
	let dirty = $derived(
		(providerDraft !== null && JSON.stringify(providerDraft) !== initialProvider) ||
			apiKey.length > 0 ||
			serviceAccountJson.length > 0 ||
			serviceAccountFileName.length > 0 ||
			(modelDraft !== null && JSON.stringify(modelDraft) !== initialModel) ||
			(promptPanel?.hasUnsavedChanges() ?? false)
	);
	let selectedProvider = $derived(
		settings.providers.find((provider) => provider.id === providerDraft?.id)
	);
	let selectedModels = $derived(
		settings.models.filter((model) => model.providerId === providerDraft?.id)
	);
	let preset = $derived(getServicePreset(providerDraft?.service));
	let services = $derived(
		SERVICE_PRESETS.filter((service) =>
			`${service.name} ${service.description}`.toLowerCase().includes(serviceSearch.toLowerCase())
		)
	);
	let endpointUnchanged = $derived(
		selectedProvider !== undefined &&
			providerDraft?.kind === selectedProvider.kind &&
			(providerDraft.kind === 'google-vertex'
				? providerDraft.vertex?.projectId.trim() === selectedProvider.vertex?.projectId &&
					providerDraft.vertex?.location.trim() === selectedProvider.vertex?.location
				: providerDraft.baseUrl.replace(/\/+$/, '') ===
					selectedProvider.baseUrl.replace(/\/+$/, ''))
	);
	let vertexEndpoint = $derived.by(() => {
		try {
			return providerDraft?.vertex
				? vertexBaseUrl(providerDraft.vertex.projectId, providerDraft.vertex.location)
				: '';
		} catch {
			return '';
		}
	});
	let hasCredential = $derived(
		endpointUnchanged && !!selectedProvider && credentialStatus[selectedProvider.id] === true
	);

	onMount(() => {
		load();
		return () => {
			catalogRequest?.abort();
			clearVerification();
			clearServiceAccount();
			statusGeneration++;
			apiKey = '';
		};
	});
	function openModal(dialog: HTMLDialogElement) {
		dialog.showModal();
		return () => dialog.close();
	}
	function message(cause: unknown, fallback: string) {
		return cause instanceof Error ? cause.message : fallback;
	}
	function clearCatalog() {
		catalogRequest?.abort();
		catalogRequest = null;
		catalog = [];
		catalogError = '';
		catalogLoading = false;
	}
	function clearVerification() {
		verificationRequest?.abort();
		verificationRequest = null;
		verificationLoading = false;
		verificationError = '';
		verificationStatus = '';
	}
	function clearServiceAccount() {
		fileGeneration++;
		serviceAccountJson = '';
		serviceAccountFileName = '';
		serviceAccountError = '';
		readingServiceAccount = false;
		if (serviceAccountFileInput) serviceAccountFileInput.value = '';
	}
	function attachServiceAccountFile(input: HTMLInputElement) {
		serviceAccountFileInput = input;
		return () => {
			if (serviceAccountFileInput === input) serviceAccountFileInput = undefined;
		};
	}
	function updateServiceAccount(value: string, reportError = false, fromFile = false) {
		if (!fromFile) {
			fileGeneration++;
			readingServiceAccount = false;
		}
		serviceAccountJson = value;
		serviceAccountError = '';
		clearVerification();
		if (!value.trim()) return;
		try {
			const account = parseServiceAccountJson(value);
			if (
				providerDraft?.kind === 'google-vertex' &&
				providerDraft.vertex &&
				!providerDraft.vertex.projectId.trim()
			)
				providerDraft.vertex.projectId = account.project_id;
		} catch (cause) {
			if (reportError)
				serviceAccountError = message(cause, '올바른 Service Account JSON을 입력해주세요.');
		}
	}
	async function importServiceAccount(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file || !providerDraft || busy) return;
		const generation = ++fileGeneration;
		const providerId = providerDraft.id;
		clearVerification();
		serviceAccountFileName = file.name;
		serviceAccountJson = '';
		serviceAccountError = '';
		readingServiceAccount = false;
		if (file.size > 64 * 1024) {
			serviceAccountError = 'JSON 파일은 64KiB 이하여야 해요.';
			return;
		}
		readingServiceAccount = true;
		try {
			const source = await file.text();
			if (generation === fileGeneration && providerDraft?.id === providerId)
				updateServiceAccount(source, true, true);
		} catch {
			if (generation === fileGeneration)
				serviceAccountError = 'JSON 파일을 읽지 못했어요. 다시 가져와 주세요.';
		} finally {
			if (generation === fileGeneration) readingServiceAccount = false;
		}
	}
	function changeProviderKind() {
		if (!providerDraft) return;
		clearCatalog();
		clearVerification();
		clearServiceAccount();
		apiKey = '';
		if (providerDraft.kind === 'google-vertex')
			providerDraft.vertex ??= { projectId: '', location: 'global' };
		else delete providerDraft.vertex;
	}
	async function verifyServiceAccount() {
		const provider = selectedProvider;
		if (
			!provider ||
			provider.kind !== 'google-vertex' ||
			!hasCredential ||
			dirty ||
			busy ||
			verificationLoading
		)
			return;
		clearVerification();
		const controller = new AbortController();
		verificationRequest = controller;
		verificationLoading = true;
		try {
			await verifyProviderCredential(provider, controller.signal);
			if (
				verificationRequest === controller &&
				providerDraft?.id === provider.id &&
				section === 'connections' &&
				!dirty
			)
				verificationStatus = '서비스 계정 인증을 확인했어요.';
		} catch (cause) {
			if (!controller.signal.aborted && verificationRequest === controller)
				verificationError = message(
					cause,
					'서비스 계정 인증을 확인하지 못했어요. 다시 시도해 주세요.'
				);
		} finally {
			if (verificationRequest === controller) {
				verificationLoading = false;
				verificationRequest = null;
			}
		}
	}
	function setProvider(provider: ProviderSettings) {
		clearCatalog();
		clearVerification();
		clearServiceAccount();
		providerDraft = {
			...provider,
			...(provider.kind === 'google-vertex'
				? { vertex: { ...(provider.vertex ?? { projectId: '', location: 'global' }) } }
				: {})
		};
		initialProvider = JSON.stringify(providerDraft);
		apiKey = '';
		error = '';
		status = '';
	}
	function load() {
		loadError = '';
		try {
			settings = loadAISettings();
			ready = true;
			creating = false;
			if (settings.providers[0]) setProvider(settings.providers[0]);
			else providerDraft = null;
			void refreshCredentialStatus();
		} catch {
			ready = false;
			loadError = '설정을 불러오지 못했어요. 다시 불러와 주세요.';
		}
	}
	async function refreshCredentialStatus() {
		clearVerification();
		const generation = ++statusGeneration;
		checkingCredentials = true;
		credentialError = '';
		try {
			const result = await getCredentialStatus(settings.providers);
			if (generation === statusGeneration) credentialStatus = result;
		} catch (cause) {
			if (generation === statusGeneration) {
				credentialStatus = {};
				credentialError = message(
					cause,
					'인증 정보 저장 상태를 확인하지 못했어요. 다시 시도해 주세요.'
				);
			}
		} finally {
			if (generation === statusGeneration) checkingCredentials = false;
		}
	}
	function discardDrafts() {
		promptPanel?.discardDraft();
		const saved = selectedProvider;
		apiKey = '';
		clearServiceAccount();
		clearVerification();
		modelDraft = null;
		if (saved) setProvider(saved);
		else {
			providerDraft = null;
			initialProvider = '';
		}
	}
	function changeView(action: () => void, dirtyOverride?: boolean) {
		if (busy || promptPanel?.isBusy()) return;
		if (dirtyOverride ?? dirty) {
			confirmation = {
				heading: '변경 사항을 버릴까요?',
				message: '저장하지 않은 변경 사항이 있어요. 계속하면 이 변경 사항은 사라집니다.',
				label: '변경 사항 버리기',
				action: () => {
					discardDrafts();
					action();
				}
			};
			return;
		}
		action();
	}
	function switchSection(next: Section) {
		if (next === section) return;
		changeView(() => {
			clearCatalog();
			clearVerification();
			section = next;
			creating = false;
			modelDraft = null;
			if (providerDraft && selectedProvider) setProvider(selectedProvider);
			else {
				providerDraft = null;
				initialProvider = '';
			}
			error = '';
			status = '';
		});
	}
	function selectProvider(provider: ProviderSettings) {
		changeView(() => {
			creating = false;
			setProvider(provider);
			if (provider.kind !== 'google-vertex' && credentialStatus[provider.id])
				void discover(provider);
		});
	}
	function beginConnection() {
		changeView(() => {
			creating = true;
			serviceSearch = '';
			selectService(SERVICE_PRESETS[0].id, false);
		});
	}
	function selectService(id: ServiceId, guarded = true) {
		const action = () => {
			const service = getServicePreset(id);
			setProvider({
				id: crypto.randomUUID(),
				service: service.id,
				name: service.name,
				kind: service.kind,
				baseUrl: service.baseUrl,
				...(service.kind === 'google-vertex'
					? { vertex: { projectId: '', location: 'global' } }
					: {})
			});
		};
		if (guarded) changeView(action);
		else action();
	}
	async function saveConnection(event: SubmitEvent) {
		event.preventDefault();
		if (!providerDraft || busy || !ready || readingServiceAccount) return;
		error = '';
		status = '';
		busy = true;
		statusGeneration++;
		checkingCredentials = false;
		clearVerification();
		const draft = {
			...providerDraft,
			...(providerDraft.vertex ? { vertex: { ...providerDraft.vertex } } : {})
		};
		const isVertex = draft.kind === 'google-vertex';
		const key = isVertex ? serviceAccountJson.trim() : apiKey.trim();
		const keepCredential = hasCredential;
		let metadataSaved = false;
		try {
			if (isVertex) {
				if (serviceAccountError && serviceAccountFileName && !key)
					throw new Error(serviceAccountError);
				if (key) {
					const account = parseServiceAccountJson(key);
					if (draft.vertex && !draft.vertex.projectId.trim()) {
						draft.vertex.projectId = account.project_id;
						providerDraft.vertex = { ...draft.vertex };
					}
				}
				if (!draft.vertex) throw new Error('프로젝트 ID와 리전을 입력해주세요.');
				draft.baseUrl = vertexBaseUrl(draft.vertex.projectId, draft.vertex.location);
			}
			settings = saveAISettings(upsertProvider(settings, draft));
			metadataSaved = true;
			const saved = settings.providers.find((provider) => provider.id === draft.id)!;
			if (key) {
				if (isVertex) await saveServiceAccountCredential(saved, key);
				else await saveCredential(saved, key);
				credentialStatus = { ...credentialStatus, [saved.id]: true };
			} else credentialStatus = { ...credentialStatus, [saved.id]: keepCredential };
			setProvider(saved);
			creating = false;
			status = key
				? isVertex
					? '연결과 인증 정보를 저장했어요.'
					: '연결과 API 키를 저장했어요.'
				: '연결 설정을 저장했어요.';
			if (saved.kind !== 'google-vertex' && credentialStatus[saved.id]) void discover(saved);
		} catch (cause) {
			if (metadataSaved) {
				credentialStatus = { ...credentialStatus, [draft.id]: false };
				error = `연결 설정은 저장했지만 ${isVertex ? '인증 정보' : 'API 키'}를 저장하지 못했어요. ${message(cause, '다시 시도해 주세요.')}`;
			} else error = message(cause, '연결 설정을 저장하지 못했어요. 다시 시도해 주세요.');
		} finally {
			busy = false;
		}
	}
	async function discover(provider = selectedProvider) {
		if (!provider) return;
		clearCatalog();
		if (provider.kind === 'google-vertex') return;
		if (!credentialStatus[provider.id]) {
			catalogError = 'API 키를 저장한 다음 모델 목록을 불러와 주세요.';
			return;
		}
		const controller = new AbortController();
		catalogRequest = controller;
		catalogLoading = true;
		try {
			const result = await fetchProviderModels(provider, controller.signal);
			if (
				catalogRequest === controller &&
				providerDraft?.id === provider.id &&
				section === 'connections'
			)
				catalog = result;
		} catch (cause) {
			if (!controller.signal.aborted && catalogRequest === controller)
				catalogError = message(cause, '모델 목록을 불러오지 못했어요. 다시 시도해 주세요.');
		} finally {
			if (catalogRequest === controller) {
				catalogLoading = false;
				catalogRequest = null;
			}
		}
	}
	function persist(next: () => AISettings, text: string) {
		if (busy || !ready) return false;
		error = '';
		status = '';
		try {
			settings = saveAISettings(next());
			status = text;
			return true;
		} catch (cause) {
			error = message(cause, '설정을 저장하지 못했어요. 다시 시도해 주세요.');
			return false;
		}
	}
	function addModel(catalogModel?: CatalogModel) {
		const provider = section === 'connections' ? selectedProvider : settings.providers[0];
		if (!provider) return;
		changeView(() => {
			modelDraft = {
				id: crypto.randomUUID(),
				name: catalogModel?.name ?? '',
				providerId: provider.id,
				modelId: catalogModel?.id ?? ''
			};
			initialModel = JSON.stringify(modelDraft);
			modelError = '';
		});
	}
	function editModel(model: ModelSettings) {
		changeView(() => {
			modelDraft = { ...model };
			initialModel = JSON.stringify(modelDraft);
			modelError = '';
		});
	}
	function saveModel(event: SubmitEvent) {
		event.preventDefault();
		if (!modelDraft) return;
		modelError = '';
		try {
			const next = upsertModel(settings, { ...modelDraft });
			if (persist(() => next, '모델을 저장했어요.')) modelDraft = null;
			else modelError = error;
		} catch (cause) {
			modelError = message(cause, '모델 설정을 확인해 주세요.');
		}
	}
	function cancelModel() {
		if (busy) return;
		if (modelDraft && JSON.stringify(modelDraft) !== initialModel)
			confirmation = {
				heading: '변경 사항을 버릴까요?',
				message: '저장하지 않은 모델 설정이 사라집니다.',
				label: '변경 사항 버리기',
				action: () => {
					modelDraft = null;
				}
			};
		else modelDraft = null;
	}
	function deleteModel(model: ModelSettings) {
		changeView(() => {
			confirmation = {
				heading: '모델을 삭제할까요?',
				message: `${model.name} 모델을 삭제합니다. 기본 모델이면 다른 모델이 기본으로 선택돼요.`,
				label: '모델 삭제',
				action: () => {
					persist(() => removeModel(settings, model.id), '모델을 삭제했어요.');
				}
			};
		});
	}
	function removeConnection() {
		const provider = selectedProvider;
		if (!provider) return;
		changeView(() => {
			confirmation = {
				heading: 'API 연결을 삭제할까요?',
				message: `${provider.name} 연결과 ${provider.kind === 'google-vertex' ? '인증 정보' : 'API 키'}를 삭제합니다. 추가한 모델 ${selectedModels.length}개도 함께 삭제돼요.`,
				label: '연결 삭제',
				action: () => {
					void deleteConnection(provider);
				}
			};
		});
	}
	async function deleteConnection(provider: ProviderSettings) {
		if (busy) return;
		clearVerification();
		busy = true;
		error = '';
		status = '';
		statusGeneration++;
		checkingCredentials = false;
		try {
			await deleteCredential(provider.id);
			credentialStatus = { ...credentialStatus, [provider.id]: false };
			settings = saveAISettings(removeProvider(settings, provider.id));
			if (settings.providers[0]) setProvider(settings.providers[0]);
			else {
				providerDraft = null;
				initialProvider = '';
				clearCatalog();
			}
			creating = false;
			status = 'API 연결을 삭제했어요.';
		} catch (cause) {
			error = message(cause, 'API 연결을 삭제하지 못했어요. 다시 시도해 주세요.');
		} finally {
			busy = false;
		}
	}
	function confirmAction() {
		const action = confirmation?.action;
		confirmation = null;
		action?.();
	}
</script>

<dialog
	class="settings-dialog"
	{@attach openModal}
	aria-labelledby="settings-heading"
	aria-busy={busy || promptPanel?.isBusy()}
	{onclose}
	oncancel={(event) => {
		event.preventDefault();
		changeView(onclose);
	}}
>
	<div class="settings-shell">
		<aside class="settings-rail">
			<div class="rail-heading">
				<h1 id="settings-heading">설정</h1>
				<button
					class="icon-button"
					type="button"
					aria-label="설정 닫기"
					disabled={busy || promptPanel?.isBusy()}
					onclick={() => changeView(onclose)}><Icon name="close" size={19} /></button
				>
			</div>
			<nav aria-label="설정 메뉴">
				<button
					class={{ selected: section === 'models' }}
					type="button"
					aria-label="모델"
					aria-current={section === 'models' ? 'page' : undefined}
					disabled={busy || promptPanel?.isBusy()}
					onclick={() => switchSection('models')}><Icon name="chat" size={18} />모델</button
				><button
					class={{ selected: section === 'connections' }}
					type="button"
					aria-label="API 연결"
					aria-current={section === 'connections' ? 'page' : undefined}
					disabled={busy || promptPanel?.isBusy()}
					onclick={() => switchSection('connections')}
					><Icon name="tool" size={18} />API 연결</button
				>
				<button
					class={{ selected: section === 'prompts' }}
					type="button"
					aria-label="프롬프트"
					aria-current={section === 'prompts' ? 'page' : undefined}
					disabled={busy || promptPanel?.isBusy()}
					onclick={() => switchSection('prompts')}><Icon name="book" size={18} />프롬프트</button
				>
			</nav>
			<div class="rail-footer"><Icon name="sun" size={19} /><span>Helia</span></div>
		</aside>
		<main class="settings-main">
			<div class="page-heading">
				<div>
					<h2>
						{section === 'connections' ? 'API 연결' : section === 'prompts' ? '프롬프트' : '모델'}
					</h2>
					<p>
						{section === 'connections'
							? 'AI 서비스를 연결하고 사용할 모델을 추가하세요.'
							: section === 'prompts'
								? '프롬프트 프리셋과 전송 순서를 관리하세요.'
								: '추가한 모델을 관리하고 기본 모델을 선택하세요.'}
					</p>
				</div>
				{#if section === 'connections'}<button
						class="primary-button"
						type="button"
						disabled={!ready || busy}
						onclick={beginConnection}><Icon name="plus" size={17} />새 연결</button
					>{/if}
			</div>
			{#if section === 'prompts'}
				<PromptSettingsPanel
					bind:this={promptPanel}
					requestChange={changeView}
					requestConfirmation={(heading, message, label, action) => {
						confirmation = { heading, message, label, action };
					}}
				/>
			{:else if loadError}<div class="notice" role="alert">
					<p>{loadError}</p>
					<button class="secondary-button" type="button" onclick={load}>다시 불러오기</button>
				</div>{:else if !ready}<p class="muted" role="status">설정을 불러오는 중…</p>{:else}
				{#if error}<p class="notice" role="alert">{error}</p>{/if}
				<p class="save-status" role="status">{status}</p>
				{#if credentialError}<div class="notice credential-notice" role="alert">
						<p>{credentialError}</p>
						<button
							class="text-button"
							type="button"
							disabled={checkingCredentials || busy}
							onclick={refreshCredentialStatus}
							>{providerDraft?.kind === 'google-vertex'
								? '인증 정보 상태 다시 확인'
								: 'API 키 상태 다시 확인'}</button
						>
					</div>{/if}
				{#if section === 'connections'}
					{#if settings.providers.length}<div class="connection-cards" aria-label="API 연결 목록">
							{#each settings.providers as provider (provider.id)}<button
									class={[
										'connection-card',
										{ active: !creating && provider.id === providerDraft?.id }
									]}
									type="button"
									disabled={busy}
									aria-label={`${provider.name} 연결 선택`}
									aria-pressed={!creating && provider.id === providerDraft?.id}
									onclick={() => selectProvider(provider)}
									><span class="service-mark"
										>{getServicePreset(provider.service).name.slice(0, 1)}</span
									><span
										><strong>{provider.name}</strong><small
											>추가한 모델 {settings.models.filter(
												(model) => model.providerId === provider.id
											).length}개</small
										></span
									>{#if credentialStatus[provider.id]}<span
											class="saved-dot"
											aria-label={provider.kind === 'google-vertex'
												? '인증 정보 저장됨'
												: 'API 키 저장됨'}
										></span>{/if}</button
								>{/each}
						</div>{/if}
					{#if creating && providerDraft}
						<div class="new-connection">
							<section class="service-catalog" aria-label="서비스 선택">
								<div class="panel-heading">
									<h3>서비스 선택</h3>
									<span>{SERVICE_PRESETS.length}</span>
								</div>
								<label class="search"
									><Icon name="search" size={16} /><input
										aria-label="서비스 검색"
										bind:value={serviceSearch}
										placeholder="서비스 검색"
										disabled={busy}
									/></label
								>
								<div class="service-list">
									{#each services as service (service.id)}<button
											class={['service-option', { active: providerDraft.service === service.id }]}
											type="button"
											disabled={busy}
											aria-pressed={providerDraft.service === service.id}
											aria-label={service.name}
											onclick={() => selectService(service.id)}
											><span class="service-mark">{service.name.slice(0, 1)}</span><span
												><strong>{service.name}</strong><small>{service.description}</small></span
											><Icon name="arrow-right" size={16} /></button
										>{:else}<p class="muted">검색 결과가 없어요.</p>{/each}
								</div>
							</section>
							<section class="connection-setup">
								<div class="setup-title">
									<span class="service-mark large">{preset.name.slice(0, 1)}</span>
									<h3>{preset.name} 연결</h3>
									<p>{preset.description}</p>
								</div>
								{@render connectionForm()}
							</section>
						</div>
					{:else if providerDraft}
						<div class="connection-detail">
							<section class="connection-setup">
								<div class="panel-heading">
									<h3>연결 설정</h3>
									<span>{preset.name}</span>
								</div>
								{@render connectionForm()}
							</section>
							<div class="models-panel">
								<ModelPicker
									models={selectedModels}
									providers={settings.providers}
									defaultModelId={settings.defaultModelId}
									{busy}
									connection
									manualOnly={providerDraft.kind === 'google-vertex'}
									{catalog}
									loading={catalogLoading}
									{catalogError}
									canDiscover={hasCredential && !dirty}
									ondiscover={() => {
										void discover();
									}}
									onadd={addModel}
									onedit={editModel}
									ondelete={deleteModel}
									ondefault={(id) => {
										changeView(() => {
											persist(() => selectDefaultModel(settings, id), '기본 모델을 변경했어요.');
										});
									}}
								/>
							</div>
						</div>
					{:else}<div class="empty-state">
							<span class="empty-icon"><Icon name="tool" size={30} /></span>
							<h3>첫 API 연결을 추가하세요</h3>
							<p>사용할 AI 서비스를 선택하고<br />인증 정보와 모델을 추가하세요.</p>
							<button class="secondary-button" type="button" onclick={beginConnection}
								><Icon name="plus" size={16} />새 연결 만들기</button
							>
						</div>{/if}
				{:else}<div class="global-models">
						<ModelPicker
							models={settings.models}
							providers={settings.providers}
							defaultModelId={settings.defaultModelId}
							{busy}
							onadd={addModel}
							onedit={editModel}
							ondelete={deleteModel}
							ondefault={(id) => {
								persist(() => selectDefaultModel(settings, id), '기본 모델을 변경했어요.');
							}}
						/>{#if !settings.providers.length}<button
								class="secondary-button"
								type="button"
								onclick={() => {
									switchSection('connections');
									beginConnection();
								}}>API 연결 추가</button
							>{/if}
					</div>{/if}
			{/if}
		</main>
	</div>
</dialog>

{#snippet connectionForm()}
	{#if providerDraft}<form
			class="connection-form"
			onsubmit={saveConnection}
			oninput={clearVerification}
			novalidate
		>
			<fieldset disabled={busy}>
				<label for="connection-name">연결 이름</label><input
					id="connection-name"
					bind:value={providerDraft.name}
					autocomplete="off"
					placeholder="연결 이름"
					required
				/>
				{#if providerDraft.kind === 'google-vertex' && providerDraft.vertex}
					<p class="field-help">Vertex AI · Service Account JSON</p>
					<div class="field-heading">
						<label for="service-account-json">Service Account JSON</label>{#if preset.keyUrl}<a
								href={preset.keyUrl}
								target="_blank"
								rel="external noreferrer">서비스 계정 관리 <Icon name="arrow-right" size={12} /></a
							>{/if}
					</div>
					<textarea
						id="service-account-json"
						rows="7"
						bind:value={() => serviceAccountJson, (value) => updateServiceAccount(value)}
						onblur={() => updateServiceAccount(serviceAccountJson, true)}
						autocomplete="off"
						spellcheck="false"
						placeholder={hasCredential
							? '저장된 인증 정보를 유지합니다'
							: 'Service Account JSON을 붙여넣으세요'}
						aria-describedby="service-account-help"></textarea>
					<label for="service-account-file">JSON 파일 가져오기</label><input
						id="service-account-file"
						type="file"
						accept=".json,application/json"
						{@attach attachServiceAccountFile}
						onchange={importServiceAccount}
					/>
					<p class="field-help" id="service-account-help">
						{hasCredential
							? '인증 정보가 저장되어 있어요. 교체할 때만 새 JSON을 입력하거나 가져오세요.'
							: '64KiB 이하의 서비스 계정 JSON을 입력하세요. 인증 정보는 보안 저장소에 보관됩니다.'}
					</p>
					{#if readingServiceAccount}<p class="field-help" role="status">
							JSON 파일을 읽는 중…
						</p>{/if}
					{#if serviceAccountError}<p class="notice" role="alert">{serviceAccountError}</p>{/if}
					<label for="vertex-project">프로젝트 ID</label><input
						id="vertex-project"
						bind:value={providerDraft.vertex.projectId}
						placeholder="my-project-id"
						autocomplete="off"
						spellcheck="false"
						required
					/>
					<label for="vertex-location">리전</label><input
						id="vertex-location"
						bind:value={providerDraft.vertex.location}
						placeholder="global"
						autocomplete="off"
						spellcheck="false"
						required
					/>
					<p class="field-help">프로젝트 ID는 JSON에서 자동으로 채워지며 직접 변경할 수 있어요.</p>
					{#if !creating}
						<button
							class="secondary-button verify-button"
							type="button"
							disabled={!hasCredential || dirty || verificationLoading}
							onclick={verifyServiceAccount}>서비스 계정 인증 확인</button
						>
						<p class="field-help">저장된 서비스 계정으로 OAuth 토큰 인증을 확인합니다.</p>
						{#if verificationLoading}<p class="field-help" role="status">
								서비스 계정 인증을 확인하는 중…
							</p>{/if}
						{#if verificationError}<p class="notice" role="alert">{verificationError}</p>{/if}
						{#if verificationStatus}<p class="field-help" role="status">
								{verificationStatus}
							</p>{/if}
					{/if}
				{:else}
					<div class="field-heading">
						<label for="connection-key">API 키</label>{#if preset.keyUrl}<a
								href={preset.keyUrl}
								target="_blank"
								rel="external noreferrer">API 키 발급 <Icon name="arrow-right" size={12} /></a
							>{/if}
					</div>
					<input
						id="connection-key"
						type="password"
						bind:value={apiKey}
						autocomplete="new-password"
						spellcheck="false"
						placeholder={hasCredential ? '저장된 API 키를 유지합니다' : 'API 키 입력'}
						aria-describedby="key-help"
					/>
					<p class="field-help" id="key-help">
						{hasCredential
							? 'API 키가 저장되어 있어요. 교체할 때만 새 키를 입력하세요.'
							: endpointUnchanged || creating
								? '키를 저장하면 이 연결의 모델 목록을 가져올 수 있어요.'
								: 'API 주소 또는 형식이 바뀌었어요. 새 주소에서 사용할 키를 다시 입력하세요.'}
					</p>
				{/if}
				<details class="advanced" open={!preset.baseUrl}>
					<summary>고급 설정</summary>
					<div>
						<label for="connection-kind">API 형식</label><select
							id="connection-kind"
							bind:value={providerDraft.kind}
							onchange={changeProviderKind}
							>{#each PROVIDER_KINDS as kind (kind)}<option value={kind}
									>{PROVIDER_KIND_LABELS[kind]}</option
								>{/each}</select
						><label for="connection-url">기본 URL</label>
						{#if providerDraft.kind === 'google-vertex'}
							<input
								id="connection-url"
								value={vertexEndpoint}
								readonly
								placeholder="프로젝트 ID와 리전을 입력하세요"
							/>
						{:else}<input
								id="connection-url"
								type="url"
								bind:value={providerDraft.baseUrl}
								oninput={clearCatalog}
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
					disabled={readingServiceAccount}
					>{busy ? '저장하는 중…' : creating ? '모델 선택' : '변경 사항 저장'}<Icon
						name="arrow-right"
						size={16}
					/></button
				>{#if !creating}<button class="delete-connection" type="button" onclick={removeConnection}
						><Icon name="trash" size={15} />연결 삭제</button
					>{/if}
			</fieldset>
		</form>{/if}
{/snippet}

{#if modelDraft}<dialog
		class="editor-dialog"
		{@attach openModal}
		aria-labelledby="model-editor-heading"
		oncancel={(event) => {
			event.preventDefault();
			cancelModel();
		}}
	>
		<div class="editor-heading">
			<h2 id="model-editor-heading">
				{settings.models.some((model) => model.id === modelDraft?.id) ? '모델 편집' : '모델 추가'}
			</h2>
			<button class="icon-button" type="button" aria-label="모델 편집 닫기" onclick={cancelModel}
				><Icon name="close" size={18} /></button
			>
		</div>
		<form onsubmit={saveModel} novalidate>
			<label for="model-name">표시 이름</label><input
				id="model-name"
				bind:value={modelDraft.name}
				placeholder="내가 알아보기 쉬운 이름"
				autocomplete="off"
				required
			/><label for="model-provider">API 연결</label><select
				id="model-provider"
				bind:value={modelDraft.providerId}
				>{#each settings.providers as provider (provider.id)}<option value={provider.id}
						>{provider.name}</option
					>{/each}</select
			><label for="model-id">모델 ID</label><input
				id="model-id"
				bind:value={modelDraft.modelId}
				placeholder="서비스에서 제공하는 모델 ID"
				autocomplete="off"
				spellcheck="false"
				required
			/>
			<p class="field-help">같은 모델도 다른 이름으로 여러 번 추가할 수 있어요.</p>
			{#if modelError}<p class="notice" role="alert">{modelError}</p>{/if}
			<div class="form-actions">
				<button class="secondary-button" type="button" onclick={cancelModel}>취소</button><button
					class="primary-button"
					type="submit">모델 저장</button
				>
			</div>
		</form>
	</dialog>{/if}
{#if confirmation}<dialog
		class="confirmation-dialog"
		{@attach openModal}
		aria-labelledby="confirmation-heading"
		aria-describedby="confirmation-message"
		oncancel={(event) => {
			event.preventDefault();
			confirmation = null;
		}}
	>
		<h2 id="confirmation-heading">{confirmation.heading}</h2>
		<p id="confirmation-message">{confirmation.message}</p>
		<div class="form-actions">
			<button class="secondary-button" type="button" onclick={() => (confirmation = null)}
				>돌아가기</button
			><button class="primary-button" type="button" onclick={confirmAction}
				>{confirmation.label}</button
			>
		</div>
	</dialog>{/if}

<style>
	dialog {
		padding: 0;
		border: 1px solid var(--border-strong);
		background: var(--background);
		color: var(--text);
	}
	dialog::backdrop {
		background: color-mix(in srgb, var(--palette-pepper) 80%, transparent);
		backdrop-filter: blur(6px);
	}
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
	h1,
	h2,
	h3,
	p {
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
	h3 {
		color: var(--text-strong);
		font-size: 15px;
		font-weight: 550;
		letter-spacing: -0.025em;
	}
	.panel-heading > span {
		color: var(--text-muted);
		font-size: 10px;
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
	.global-models {
		max-width: 920px;
		padding: 27px;
		border: 1px solid var(--border);
		border-radius: 12px;
	}
	.global-models > button {
		display: flex;
		margin: 18px auto 0;
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
	.muted {
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.8;
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
	.editor-dialog,
	.confirmation-dialog {
		width: min(440px, calc(100vw - 32px));
		max-height: calc(100dvh - 32px);
		padding: 27px;
		border-radius: 13px;
		overflow-y: auto;
	}
	.editor-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 15px;
		margin-bottom: 24px;
	}
	.editor-heading h2,
	.confirmation-dialog h2 {
		font-size: 18px;
		font-weight: 550;
		color: var(--text-strong);
	}
	.confirmation-dialog p {
		margin: 16px 0 24px;
		font-size: 13px;
		line-height: 1.8;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}
	.form-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
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
		.settings-shell {
			grid-template-columns: 170px minmax(0, 1fr);
		}
		.settings-rail {
			padding: 25px 12px 20px;
		}
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
		.settings-shell {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto minmax(0, 1fr);
		}
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
		.global-models {
			padding: 20px;
		}
		.credential-notice {
			align-items: flex-start;
			flex-direction: column;
			gap: 9px;
		}
	}
</style>
