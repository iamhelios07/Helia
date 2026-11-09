import {
	getCredentialStatus,
	saveCredential,
	saveServiceAccountCredential,
	verifyProviderCredential,
	deleteCredential,
	fetchProviderModels,
	type CatalogModel
} from './credentials.js';
import {
	emptyAISettings,
	upsertProvider,
	removeProvider,
	upsertModel,
	removeModel,
	type AISettings,
	type ProviderSettings,
	type ModelSettings
} from './model.js';
import { loadAISettings, saveAISettings } from './repository.js';
import { SERVICE_PRESETS, getServicePreset, type ServiceId } from './services.js';
import { parseServiceAccountJson, vertexBaseUrl } from './vertex.js';
type Section = 'connections' | 'models' | 'prompts';
type Confirmation = { heading: string; message: string; label: string; action: () => void };
const SECTION_HEADINGS = {
	connections: { title: 'API 연결', description: 'AI 서비스를 연결하고 사용할 모델을 추가하세요.' },
	prompts: { title: '프롬프트', description: '프롬프트 프리셋과 전송 순서를 관리하세요.' },
	models: { title: '모델', description: '추가한 모델을 관리하고 기본 모델을 선택하세요.' }
};
export class SettingsDialogController {
	get keyHelp() {
		if (this.hasCredential) {
			return 'API 키가 저장되어 있어요. 교체할 때만 새 키를 입력하세요.';
		}
		if (this.endpointUnchanged || this.creating) {
			return '키를 저장하면 이 연결의 모델 목록을 가져올 수 있어요.';
		}
		return 'API 주소 또는 형식이 바뀌었어요. 새 주소에서 사용할 키를 다시 입력하세요.';
	}
	get saveLabel() {
		if (this.busy) {
			return '저장하는 중…';
		}
		return this.creating ? '모델 선택' : '변경 사항 저장';
	}
	prepareVertexDraft = (draft: ProviderSettings, key: string) => {
		if (draft.kind !== 'google-vertex') {
			return;
		}
		if (this.serviceAccountError && this.serviceAccountFileName && !key) {
			throw new Error(this.serviceAccountError);
		}
		if (key) {
			this.fillVertexProject(draft, key);
		}
		if (!draft.vertex) {
			throw new Error('프로젝트 ID와 리전을 입력해주세요.');
		}
		draft.baseUrl = vertexBaseUrl(draft.vertex.projectId, draft.vertex.location);
	};
	fillVertexProject = (draft: ProviderSettings, key: string) => {
		const account = parseServiceAccountJson(key);
		if (!draft.vertex || draft.vertex.projectId.trim()) {
			return;
		}
		draft.vertex.projectId = account.project_id;
		if (this.providerDraft) {
			this.providerDraft.vertex = { ...draft.vertex };
		}
	};
	storeConnectionCredential = async (
		saved: ProviderSettings,
		key: string,
		keepCredential: boolean
	) => {
		if (!key) {
			this.credentialStatus = { ...this.credentialStatus, [saved.id]: keepCredential };
			return;
		}
		if (saved.kind === 'google-vertex') {
			await saveServiceAccountCredential(saved, key);
		} else {
			await saveCredential(saved, key);
		}
		if (!this.disposed) {
			this.credentialStatus = { ...this.credentialStatus, [saved.id]: true };
		}
	};
	savedConnectionMessage = (key: string, isVertex: boolean) => {
		if (!key) {
			return '연결 설정을 저장했어요.';
		}
		return isVertex ? '연결과 인증 정보를 저장했어요.' : '연결과 API 키를 저장했어요.';
	};
	promptPanel = $state<{
		hasUnsavedChanges: () => boolean;
		discardDraft: () => void;
		isBusy: () => boolean;
	}>();
	section = $state<Section>('connections');
	sectionHeading = $derived(SECTION_HEADINGS[this.section]);
	settings = $state.raw<AISettings>(emptyAISettings());
	ready = $state(false);
	loadError = $state('');
	error = $state('');
	status = $state('');
	busy = $state(false);
	creating = $state(false);
	providerDraft = $state<ProviderSettings | null>(null);
	initialProvider = $state('');
	apiKey = $state('');
	serviceAccountJson = $state('');
	serviceAccountFileName = $state('');
	serviceAccountError = $state('');
	readingServiceAccount = $state(false);
	serviceAccountFileInput: HTMLInputElement | undefined;
	fileGeneration = 0;
	verificationLoading = $state(false);
	verificationError = $state('');
	verificationStatus = $state('');
	verificationRequest: AbortController | null = null;
	serviceSearch = $state('');
	credentialStatus = $state.raw<Record<string, boolean>>({});
	credentialError = $state('');
	checkingCredentials = $state(false);
	modelDraft = $state<ModelSettings | null>(null);
	initialModel = $state('');
	modelError = $state('');
	confirmation = $state<Confirmation | null>(null);
	catalog = $state.raw<CatalogModel[]>([]);
	catalogLoading = $state(false);
	catalogError = $state('');
	catalogRequest: AbortController | null = null;
	statusGeneration = 0;
	loadGeneration = 0;
	disposed = false;
	dirty = $derived(
		(this.providerDraft !== null && JSON.stringify(this.providerDraft) !== this.initialProvider) ||
			this.apiKey.length > 0 ||
			this.serviceAccountJson.length > 0 ||
			this.serviceAccountFileName.length > 0 ||
			(this.modelDraft !== null && JSON.stringify(this.modelDraft) !== this.initialModel) ||
			(this.promptPanel?.hasUnsavedChanges() ?? false)
	);
	selectedProvider = $derived(
		this.settings.providers.find((provider) => provider.id === this.providerDraft?.id)
	);
	selectedModels = $derived(
		this.settings.models.filter((model) => model.providerId === this.providerDraft?.id)
	);
	preset = $derived(getServicePreset(this.providerDraft?.service));
	services = $derived(
		SERVICE_PRESETS.filter((service) =>
			`${service.name} ${service.description}`
				.toLowerCase()
				.includes(this.serviceSearch.toLowerCase())
		)
	);
	endpointUnchanged = $derived(
		this.selectedProvider !== undefined &&
			this.providerDraft?.kind === this.selectedProvider.kind &&
			(this.providerDraft.kind === 'google-vertex'
				? this.providerDraft.vertex?.projectId.trim() === this.selectedProvider.vertex?.projectId &&
					this.providerDraft.vertex?.location.trim() === this.selectedProvider.vertex?.location
				: this.providerDraft.baseUrl.replace(/\/+$/, '') ===
					this.selectedProvider.baseUrl.replace(/\/+$/, ''))
	);
	vertexEndpoint = $derived.by(() => {
		try {
			return this.providerDraft?.vertex
				? vertexBaseUrl(this.providerDraft.vertex.projectId, this.providerDraft.vertex.location)
				: '';
		} catch {
			return '';
		}
	});
	hasCredential = $derived(
		this.endpointUnchanged &&
			!!this.selectedProvider &&
			this.credentialStatus[this.selectedProvider.id] === true
	);
	openModal = (dialog: HTMLDialogElement) => {
		dialog.showModal();
		return () => dialog.close();
	};
	message = (cause: unknown, fallback: string) => {
		return cause instanceof Error ? cause.message : fallback;
	};
	clearCatalog = () => {
		this.catalogRequest?.abort();
		this.catalogRequest = null;
		this.catalog = [];
		this.catalogError = '';
		this.catalogLoading = false;
	};
	clearVerification = () => {
		this.verificationRequest?.abort();
		this.verificationRequest = null;
		this.verificationLoading = false;
		this.verificationError = '';
		this.verificationStatus = '';
	};
	clearServiceAccount = () => {
		this.fileGeneration++;
		this.serviceAccountJson = '';
		this.serviceAccountFileName = '';
		this.serviceAccountError = '';
		this.readingServiceAccount = false;
		if (this.serviceAccountFileInput) {
			this.serviceAccountFileInput.value = '';
		}
	};
	attachServiceAccountFile = (input: HTMLInputElement) => {
		this.serviceAccountFileInput = input;
		return () => {
			if (this.serviceAccountFileInput === input) {
				this.serviceAccountFileInput = undefined;
			}
		};
	};
	updateServiceAccount = (value: string, reportError = false, fromFile = false) => {
		if (!fromFile) {
			this.fileGeneration++;
			this.readingServiceAccount = false;
		}
		this.serviceAccountJson = value;
		this.serviceAccountError = '';
		this.clearVerification();
		if (!value.trim()) {
			return;
		}
		try {
			const account = parseServiceAccountJson(value);
			if (
				this.providerDraft?.kind === 'google-vertex' &&
				this.providerDraft.vertex &&
				!this.providerDraft.vertex.projectId.trim()
			) {
				this.providerDraft.vertex.projectId = account.project_id;
			}
		} catch (cause) {
			if (reportError) {
				this.serviceAccountError = this.message(
					cause,
					'올바른 Service Account JSON을 입력해주세요.'
				);
			}
		}
	};
	importServiceAccount = async (event: Event) => {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file || !this.providerDraft || this.busy) {
			return;
		}
		const generation = ++this.fileGeneration;
		const providerId = this.providerDraft.id;
		this.clearVerification();
		this.serviceAccountFileName = file.name;
		this.serviceAccountJson = '';
		this.serviceAccountError = '';
		this.readingServiceAccount = false;
		if (file.size > 64 * 1024) {
			this.serviceAccountError = 'JSON 파일은 64KiB 이하여야 해요.';
			return;
		}
		this.readingServiceAccount = true;
		try {
			const source = await file.text();
			if (generation === this.fileGeneration && this.providerDraft?.id === providerId) {
				this.updateServiceAccount(source, true, true);
			}
		} catch {
			if (generation === this.fileGeneration) {
				this.serviceAccountError = 'JSON 파일을 읽지 못했어요. 다시 가져와 주세요.';
			}
		} finally {
			if (generation === this.fileGeneration) {
				this.readingServiceAccount = false;
			}
		}
	};
	changeProviderKind = () => {
		if (!this.providerDraft) {
			return;
		}
		this.clearCatalog();
		this.clearVerification();
		this.clearServiceAccount();
		this.apiKey = '';
		if (this.providerDraft.kind === 'google-vertex') {
			this.providerDraft.vertex ??= { projectId: '', location: 'global' };
		} else {
			delete this.providerDraft.vertex;
		}
	};
	verifyServiceAccount = async () => {
		const provider = this.selectedProvider;
		if (
			!provider ||
			provider.kind !== 'google-vertex' ||
			!this.hasCredential ||
			this.dirty ||
			this.busy ||
			this.verificationLoading
		) {
			return;
		}
		this.clearVerification();
		const controller = new AbortController();
		this.verificationRequest = controller;
		this.verificationLoading = true;
		try {
			await verifyProviderCredential(provider, controller.signal);
			if (
				this.verificationRequest === controller &&
				this.providerDraft?.id === provider.id &&
				this.section === 'connections' &&
				!this.dirty
			) {
				this.verificationStatus = '서비스 계정 인증을 확인했어요.';
			}
		} catch (cause) {
			if (!controller.signal.aborted && this.verificationRequest === controller) {
				this.verificationError = this.message(
					cause,
					'서비스 계정 인증을 확인하지 못했어요. 다시 시도해 주세요.'
				);
			}
		} finally {
			if (this.verificationRequest === controller) {
				this.verificationLoading = false;
				this.verificationRequest = null;
			}
		}
	};
	setProvider = (provider: ProviderSettings) => {
		this.clearCatalog();
		this.clearVerification();
		this.clearServiceAccount();
		this.providerDraft = {
			...provider,
			...(provider.kind === 'google-vertex'
				? { vertex: { ...(provider.vertex ?? { projectId: '', location: 'global' }) } }
				: {})
		};
		this.initialProvider = JSON.stringify(this.providerDraft);
		this.apiKey = '';
		this.error = '';
		this.status = '';
	};
	load = async () => {
		if (this.disposed || this.busy) {
			return;
		}
		const generation = ++this.loadGeneration;
		this.ready = false;
		this.loadError = '';
		try {
			const settings = await loadAISettings();
			if (this.disposed || generation !== this.loadGeneration) {
				return;
			}
			this.settings = settings;
			this.ready = true;
			this.creating = false;
			if (this.settings.providers[0]) {
				this.setProvider(this.settings.providers[0]);
			} else {
				this.providerDraft = null;
			}
			void this.refreshCredentialStatus();
		} catch {
			if (!this.disposed && generation === this.loadGeneration) {
				this.ready = false;
				this.loadError = '설정을 불러오지 못했어요. 다시 불러와 주세요.';
			}
		}
	};
	refreshCredentialStatus = async () => {
		if (this.disposed) {
			return;
		}
		this.clearVerification();
		const generation = ++this.statusGeneration;
		this.checkingCredentials = true;
		this.credentialError = '';
		try {
			const result = await getCredentialStatus(this.settings.providers);
			if (generation === this.statusGeneration) {
				this.credentialStatus = result;
			}
		} catch (cause) {
			if (generation === this.statusGeneration) {
				this.credentialStatus = {};
				this.credentialError = this.message(
					cause,
					'인증 정보 저장 상태를 확인하지 못했어요. 다시 시도해 주세요.'
				);
			}
		} finally {
			if (generation === this.statusGeneration) {
				this.checkingCredentials = false;
			}
		}
	};
	discardDrafts = () => {
		this.promptPanel?.discardDraft();
		const saved = this.selectedProvider;
		this.apiKey = '';
		this.clearServiceAccount();
		this.clearVerification();
		this.modelDraft = null;
		if (saved) {
			this.setProvider(saved);
		} else {
			this.providerDraft = null;
			this.initialProvider = '';
		}
	};
	changeView = (action: () => void, dirtyOverride?: boolean) => {
		if (this.busy || this.promptPanel?.isBusy()) {
			return;
		}
		if (dirtyOverride ?? this.dirty) {
			this.confirmation = {
				heading: '변경 사항을 버릴까요?',
				message: '저장하지 않은 변경 사항이 있어요. 계속하면 이 변경 사항은 사라집니다.',
				label: '변경 사항 버리기',
				action: () => {
					this.discardDrafts();
					action();
				}
			};
			return;
		}
		action();
	};
	switchSection = (next: Section) => {
		if (next === this.section) {
			return;
		}
		this.changeView(() => {
			this.clearCatalog();
			this.clearVerification();
			this.section = next;
			this.creating = false;
			this.modelDraft = null;
			if (this.providerDraft && this.selectedProvider) {
				this.setProvider(this.selectedProvider);
			} else {
				this.providerDraft = null;
				this.initialProvider = '';
			}
			this.error = '';
			this.status = '';
		});
	};
	selectProvider = (provider: ProviderSettings) => {
		this.changeView(() => {
			this.creating = false;
			this.setProvider(provider);
			if (provider.kind !== 'google-vertex' && this.credentialStatus[provider.id]) {
				void this.discover(provider);
			}
		});
	};
	beginConnection = () => {
		this.changeView(() => {
			this.creating = true;
			this.serviceSearch = '';
			this.selectService(SERVICE_PRESETS[0].id, false);
		});
	};
	selectService = (id: ServiceId, guarded = true) => {
		const action = () => {
			const service = getServicePreset(id);
			this.setProvider({
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
		if (guarded) {
			this.changeView(action);
		} else {
			action();
		}
	};
	saveConnection = async (event: SubmitEvent) => {
		event.preventDefault();
		if (
			!this.providerDraft ||
			this.busy ||
			!this.ready ||
			this.disposed ||
			this.readingServiceAccount
		) {
			return;
		}
		this.error = '';
		this.status = '';
		this.busy = true;
		this.statusGeneration++;
		this.checkingCredentials = false;
		this.clearVerification();
		const draft = {
			...this.providerDraft,
			...(this.providerDraft.vertex ? { vertex: { ...this.providerDraft.vertex } } : {})
		};
		const isVertex = draft.kind === 'google-vertex';
		const key = isVertex ? this.serviceAccountJson.trim() : this.apiKey.trim();
		const keepCredential = this.hasCredential;
		let metadataSaved = false;
		try {
			this.prepareVertexDraft(draft, key);
			const settings = await saveAISettings(upsertProvider(this.settings, draft), this.settings);
			if (this.disposed) {
				return;
			}
			this.settings = settings;
			metadataSaved = true;
			const saved = this.settings.providers.find((provider) => provider.id === draft.id)!;
			await this.storeConnectionCredential(saved, key, keepCredential);
			if (this.disposed) {
				return;
			}
			this.setProvider(saved);
			this.creating = false;
			this.status = this.savedConnectionMessage(key, isVertex);
			if (saved.kind !== 'google-vertex' && this.credentialStatus[saved.id]) {
				void this.discover(saved);
			}
		} catch (cause) {
			this.reportConnectionSaveError(cause, draft, metadataSaved);
		} finally {
			this.busy = false;
		}
	};
	reportConnectionSaveError = (cause: unknown, draft: ProviderSettings, metadataSaved: boolean) => {
		if (this.disposed) {
			return;
		}
		if (!metadataSaved) {
			this.error = this.message(cause, '연결 설정을 저장하지 못했어요. 다시 시도해 주세요.');
			return;
		}
		this.credentialStatus = { ...this.credentialStatus, [draft.id]: false };
		const credential = draft.kind === 'google-vertex' ? '인증 정보' : 'API 키';
		this.error = `연결 설정은 저장했지만 ${credential}를 저장하지 못했어요. ${this.message(cause, '다시 시도해 주세요.')}`;
	};
	discover = async (provider = this.selectedProvider) => {
		if (!provider) {
			return;
		}
		this.clearCatalog();
		if (provider.kind === 'google-vertex') {
			return;
		}
		if (!this.credentialStatus[provider.id]) {
			this.catalogError = 'API 키를 저장한 다음 모델 목록을 불러와 주세요.';
			return;
		}
		const controller = new AbortController();
		this.catalogRequest = controller;
		this.catalogLoading = true;
		try {
			const result = await fetchProviderModels(provider, controller.signal);
			if (
				this.catalogRequest === controller &&
				this.providerDraft?.id === provider.id &&
				this.section === 'connections'
			) {
				this.catalog = result;
			}
		} catch (cause) {
			if (!controller.signal.aborted && this.catalogRequest === controller) {
				this.catalogError = this.message(
					cause,
					'모델 목록을 불러오지 못했어요. 다시 시도해 주세요.'
				);
			}
		} finally {
			if (this.catalogRequest === controller) {
				this.catalogLoading = false;
				this.catalogRequest = null;
			}
		}
	};
	persist = async (next: () => AISettings, text: string) => {
		if (this.busy || !this.ready || this.disposed) {
			return false;
		}
		this.busy = true;
		this.error = '';
		this.status = '';
		try {
			const settings = await saveAISettings(next(), this.settings);
			if (this.disposed) {
				return false;
			}
			this.settings = settings;
			this.status = text;
			return true;
		} catch (cause) {
			if (!this.disposed) {
				this.error = this.message(cause, '설정을 저장하지 못했어요. 다시 시도해 주세요.');
			}
			return false;
		} finally {
			this.busy = false;
		}
	};
	addModel = (catalogModel?: CatalogModel) => {
		const provider =
			this.section === 'connections' ? this.selectedProvider : this.settings.providers[0];
		if (!provider) {
			return;
		}
		this.changeView(() => {
			this.modelDraft = {
				id: crypto.randomUUID(),
				name: catalogModel?.name ?? '',
				providerId: provider.id,
				modelId: catalogModel?.id ?? ''
			};
			this.initialModel = JSON.stringify(this.modelDraft);
			this.modelError = '';
		});
	};
	editModel = (model: ModelSettings) => {
		this.changeView(() => {
			this.modelDraft = { ...model };
			this.initialModel = JSON.stringify(this.modelDraft);
			this.modelError = '';
		});
	};
	saveModel = async (event: SubmitEvent) => {
		event.preventDefault();
		if (!this.modelDraft || this.busy || !this.ready || this.disposed) {
			return;
		}
		this.modelError = '';
		try {
			const next = upsertModel(this.settings, { ...this.modelDraft });
			if (await this.persist(() => next, '모델을 저장했어요.')) {
				this.modelDraft = null;
			} else if (!this.disposed) {
				this.modelError = this.error;
			}
		} catch (cause) {
			this.modelError = this.message(cause, '모델 설정을 확인해 주세요.');
		}
	};
	cancelModel = () => {
		if (this.busy) {
			return;
		}
		if (this.modelDraft && JSON.stringify(this.modelDraft) !== this.initialModel) {
			this.confirmation = {
				heading: '변경 사항을 버릴까요?',
				message: '저장하지 않은 모델 설정이 사라집니다.',
				label: '변경 사항 버리기',
				action: () => {
					this.modelDraft = null;
				}
			};
		} else {
			this.modelDraft = null;
		}
	};
	deleteModel = (model: ModelSettings) => {
		this.changeView(() => {
			this.confirmation = {
				heading: '모델을 삭제할까요?',
				message: `${model.name} 모델을 삭제합니다. 기본 모델이면 다른 모델이 기본으로 선택돼요.`,
				label: '모델 삭제',
				action: () => {
					void this.persist(() => removeModel(this.settings, model.id), '모델을 삭제했어요.');
				}
			};
		});
	};
	removeConnection = () => {
		const provider = this.selectedProvider;
		if (!provider) {
			return;
		}
		this.changeView(() => {
			this.confirmation = {
				heading: 'API 연결을 삭제할까요?',
				message: `${provider.name} 연결과 ${provider.kind === 'google-vertex' ? '인증 정보' : 'API 키'}를 삭제합니다. 추가한 모델 ${this.selectedModels.length}개도 함께 삭제돼요.`,
				label: '연결 삭제',
				action: () => {
					void this.deleteConnection(provider);
				}
			};
		});
	};
	deleteConnection = async (provider: ProviderSettings) => {
		if (this.busy || !this.ready || this.disposed) {
			return;
		}
		this.clearVerification();
		this.busy = true;
		this.error = '';
		this.status = '';
		this.statusGeneration++;
		this.checkingCredentials = false;
		let metadataSaved = false;
		try {
			const settings = await saveAISettings(
				removeProvider(this.settings, provider.id),
				this.settings
			);
			metadataSaved = true;
			this.applyConnectionDeletion(settings, provider.id);
			await deleteCredential(provider.id);
			if (!this.disposed) {
				this.status = 'API 연결을 삭제했어요.';
			}
		} catch (cause) {
			if (!this.disposed) {
				const detail = this.message(cause, '다시 시도해 주세요.');
				this.error = metadataSaved
					? `API 연결은 삭제했지만 인증 정보를 정리하지 못했어요. ${detail}`
					: this.message(cause, 'API 연결을 삭제하지 못했어요. 다시 시도해 주세요.');
			}
		} finally {
			this.busy = false;
		}
	};
	applyConnectionDeletion = (settings: AISettings, providerId: string) => {
		if (this.disposed) {
			return;
		}
		this.settings = settings;
		this.credentialStatus = { ...this.credentialStatus, [providerId]: false };
		if (settings.providers[0]) {
			this.setProvider(settings.providers[0]);
		} else {
			this.providerDraft = null;
			this.initialProvider = '';
			this.clearCatalog();
		}
		this.creating = false;
	};
	confirmAction = () => {
		const action = this.confirmation?.action;
		this.confirmation = null;
		action?.();
	};
	dispose = () => {
		this.disposed = true;
		this.loadGeneration++;
		this.clearCatalog();
		this.clearVerification();
		this.clearServiceAccount();
		this.statusGeneration++;
		this.apiKey = '';
	};
}
