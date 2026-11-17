import type { AgentEvent } from '#lib/games/ai/protocol.js';

/** Transient generation telemetry; response bodies and game state stay elsewhere. */
export class GenerationMonitor {
	active = $state(false);
	expanded = $state(false);
	model = $state('');
	round = $state(0);
	attempt = $state(1);
	characters = $state(0);
	elapsedMs = $state(0);
	phase = $state<'waiting' | 'receiving' | 'text' | 'thinking' | 'tool' | 'executing'>('waiting');
	toolName = $state('');
	private startedAt = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	seconds = $derived((this.elapsedMs / 1000).toFixed(1));
	speed = $derived(this.elapsedMs > 0 ? Math.round((this.characters * 1000) / this.elapsedMs) : 0);
	label = $derived.by(() => {
		if (this.phase === 'executing') {
			return `도구 실행 중 · ${this.toolName}`;
		}
		if (this.phase === 'thinking') {
			return 'Thinking 수신 중';
		}
		if (this.phase === 'tool') {
			return '도구 호출 수신 중';
		}
		if (this.phase === 'text') {
			return '응답 수신 중';
		}
		if (this.phase === 'receiving') {
			return '응답 연결됨 · 수신 중';
		}
		if (this.attempt > 1) {
			return `응답 재시도 중 · ${this.attempt}차`;
		}
		return this.round > 1 ? '다음 응답 대기 중' : '응답 대기 중';
	});
	start(model: string) {
		this.dispose();
		this.active = true;
		this.expanded = false;
		this.model = model;
		this.round = 0;
		this.attempt = 1;
		this.characters = 0;
		this.elapsedMs = 0;
		this.phase = 'waiting';
		this.toolName = '';
		this.startedAt = performance.now();
		this.timer = setInterval(this.tick, 100);
	}
	private tick = () => {
		this.elapsedMs = Math.max(0, performance.now() - this.startedAt);
	};
	receive(event: AgentEvent) {
		if (!this.active) {
			return;
		}
		if (event.type === 'model') {
			this.model = event.name;
		} else if (event.type === 'request') {
			this.round = event.round;
			this.attempt = event.attempt;
			this.phase = 'waiting';
		} else if (event.type === 'activity' && this.phase === 'waiting') {
			this.phase = 'receiving';
		} else if (event.type === 'received') {
			this.characters += event.characters;
			this.phase = event.kind;
			this.tick();
		} else if (event.type === 'tool' && event.status === 'running') {
			this.phase = 'executing';
			this.toolName = event.name;
		}
	}
	finish() {
		if (this.active) {
			this.tick();
			this.expanded = false;
		}
		this.dispose();
	}
	dispose() {
		clearInterval(this.timer);
		this.timer = undefined;
		this.active = false;
	}
}
