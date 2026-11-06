import { describe, it, expect } from 'vitest';
import { ProviderDecoder, encodeProviderRequest } from './providers.js';
import { parseRoundRequest, type AgentEvent, type RoundRequest } from './protocol.js';

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const round = (kind: RoundRequest['provider']['kind']): RoundRequest => ({
	provider: { id: 'test', kind, baseUrl: 'https://example.com/v1' },
	model: 'test',
	maxTokens: 100,
	messages: [
		{ role: 'system', content: 'Rules' },
		{ role: 'user', content: 'Hello' }
	],
	tools: []
});
describe('provider stream adapters', () => {
	it('accepts a complete non-streaming response but still validates its terminal reason', () => {
		const decoder = new ProviderDecoder('openai-compatible', () => {});
		decoder.push(
			event({
				helia_nonstream: {
					choices: [{ message: { role: 'assistant', content: 'Complete' }, finish_reason: 'stop' }]
				}
			})
		);
		expect(decoder.finish().text).toBe('Complete');
		expect(() =>
			new ProviderDecoder('openai-compatible', () => {}).push(
				event({
					helia_nonstream: {
						choices: [{ message: { content: 'Cut off' }, finish_reason: 'length' }]
					}
				})
			)
		).toThrow();
	});
	it.each([
		[
			'openai-compatible',
			event({ choices: [{ delta: { content: 'Hello' }, finish_reason: null }] }) +
				event({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
				'data: [DONE]\n\n'
		],
		[
			'openai-responses',
			event({ type: 'response.output_text.delta', delta: 'Hello' }) +
				event({ type: 'response.completed', response: { status: 'completed', output: [] } })
		],
		[
			'anthropic',
			event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
				event({
					type: 'content_block_delta',
					index: 0,
					delta: { type: 'text_delta', text: 'Hello' }
				}) +
				event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) +
				event({ type: 'message_stop' })
		],
		[
			'google',
			event({ candidates: [{ content: { parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }] })
		],
		[
			'google-interactions',
			event({ event_type: 'step.start', index: 0, step: { type: 'model_output' } }) +
				event({ event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'Hello' } }) +
				event({ event_type: 'interaction.completed', interaction: { status: 'completed' } })
		]
	] as const)('streams and verifies completion for %s', (kind, source) => {
		const events: AgentEvent[] = [];
		const decoder = new ProviderDecoder(kind, (e) => events.push(e));
		for (let i = 0; i < source.length; i += 3) decoder.push(source.slice(i, i + 3));
		expect(decoder.finish()).toMatchObject({ text: 'Hello', calls: [] });
		expect(events).toContainEqual({ type: 'text', text: 'Hello' });
	});
	it('never treats a truncated or length-limited stream as a successful final answer', () => {
		const decoder = new ProviderDecoder('openai-compatible', () => {});
		decoder.push(event({ choices: [{ delta: { content: 'Partial' } }] }));
		expect(() => decoder.finish()).toThrow();
		const truncated = new ProviderDecoder('openai-responses', () => {});
		truncated.push(event({ type: 'response.output_text.delta', delta: 'Partial' }));
		expect(() => truncated.finish()).toThrow();
		expect(() =>
			new ProviderDecoder('google', () => {}).push(
				event({
					candidates: [{ content: { parts: [{ text: 'Partial' }] }, finishReason: 'MAX_TOKENS' }]
				})
			)
		).toThrow();
	});
	it('assembles fragmented parallel tool calls and validates identities and JSON', () => {
		const decoder = new ProviderDecoder('openai-compatible', () => {});
		decoder.push(
			event({
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, id: 'id', function: { name: 'lookup', arguments: '{"x":' } }]
						}
					}
				]
			})
		);
		decoder.push(
			event({
				choices: [
					{
						delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] },
						finish_reason: 'tool_calls'
					}
				]
			}) + 'data: [DONE]\n\n'
		);
		expect(decoder.finish().calls).toEqual([{ id: 'id', name: 'lookup', arguments: { x: 1 } }]);
	});
	it('preserves provider thought signatures in native continuation blocks', () => {
		const decoder = new ProviderDecoder('google', () => {});
		decoder.push(
			event({
				candidates: [
					{
						content: {
							parts: [{ functionCall: { name: 'lookup', args: {} }, thoughtSignature: 'signature' }]
						},
						finishReason: 'STOP'
					}
				]
			})
		);
		const result = decoder.finish();
		expect(result.native?.[0]).toMatchObject({ thoughtSignature: 'signature' });
		const input = round('google');
		input.messages.push(
			{ role: 'assistant', content: '', calls: result.calls, native: result.native },
			{ role: 'tool', callId: result.calls[0].id, content: '{"ok":true}' }
		);
		expect(JSON.stringify(encodeProviderRequest(input).body)).toContain('thoughtSignature');
	});
	it.each([
		'openai-compatible',
		'openai-responses',
		'anthropic',
		'google',
		'google-interactions'
	] as const)('encodes only declared client functions for %s', (kind) => {
		const input = round(kind);
		input.tools = [
			{
				name: 'lookup',
				description: 'Read',
				kind: 'query',
				arguments: { type: 'object', properties: {}, additionalProperties: false }
			}
		];
		const wire = encodeProviderRequest(parseRoundRequest(input));
		expect(wire.path).toMatch(/^\//);
		expect(JSON.stringify(wire.body)).toContain('lookup');
		expect(wire.body).not.toHaveProperty('apiKey');
	});
});
