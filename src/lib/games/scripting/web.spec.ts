import { expect, it, vi } from 'vitest';

import type { ActionRequest } from './protocol.js';

import { evaluateAction } from './engine.js';

it('exposes only scoped has/ref capabilities during Actions and never accepts arbitrary secret operations', async () => {
	const has = vi.fn(async (name: string) => name === 'novelai'),
		ref = vi.fn(async () => 'helia-secret:v1:novelai:' + 'a'.repeat(64));
	const result = await evaluateAction(
		input(
			`if(typeof helia.secrets.get!=='undefined'||typeof helia.secrets.set!=='undefined'||typeof helia.secrets.remove!=='undefined')throw Error('write access');if(!await helia.secrets.has('novelai'))throw Error('missing');const value=await helia.secrets.ref('novelai');if(!value.startsWith('helia-secret:'))throw Error('reference');return state;`
		),
		{ secrets: { has, ref } }
	);
	expect(result.state).toEqual({ gold: 100 });
	expect(has).toHaveBeenCalledWith('novelai');
	expect(ref).toHaveBeenCalledWith('novelai');
	await expect(
		evaluateAction(input('await helia.secrets.ref("novelai");return state;'))
	).rejects.toMatchObject({ code: 'execution' });
});

function input(body: string, extra = ''): ActionRequest {
	return {
		scripts: {
			main: {
				language: 'typescript',
				source: `helia.defineAction({name:'remote',async run({state}){${body}}});${extra}`
			}
		},
		schema: {
			type: 'object',
			properties: { gold: { type: 'integer' } },
			additionalProperties: false
		},
		state: { gold: 100 },
		action: { name: 'remote', args: {} }
	};
}
it('awaits Action IO, shares fetch aliases, and keeps host objects outside QuickJS', async () => {
	const send = vi.fn<typeof fetch>().mockImplementation(async (request) => {
		expect(request).toBeInstanceOf(Request);
		const native = request as Request;
		expect(native.url).toBe('https://api.example/gold?user=test');
		expect(native.headers.get('authorization')).toBe('Bearer caller');
		expect(await native.json()).toEqual({ gold: 80 });
		return Response.json({ gold: 80 });
	});
	const request = input(`
 if(fetch!==helia.fetch)throw Error('alias');
 const url=new URL('/gold','https://api.example');url.searchParams.set('user','test');
 const headers=new Headers({authorization:'Bearer caller','content-type':'application/json'});
 if([...headers].length!==2)throw Error('headers');
 const response=await helia.fetch(new Request(url,{method:'POST',headers,body:JSON.stringify({gold:80})}));
 if(!(response instanceof Response)||response.constructor.constructor('return typeof process')()!=='undefined')throw Error('escape');
 state.gold=(await response.json()).gold;helia.appendMessage({role:'assistant',content:'received'});return state;
 `);
	const result = await evaluateAction(request, { fetch: send });
	expect(result.state).toEqual({ gold: 80 });
	expect(request.state).toEqual({ gold: 100 });
	expect(result.messages).toEqual([{ role: 'assistant', content: 'received' }]);
	expect(send).toHaveBeenCalledOnce();
});
it('preserves JSON fields resembling RPC metadata without turning service data into capabilities', async () => {
	const payload = {
		$web: 'ref',
		id: 1,
		type: 'Request',
		nested: { $web: 'bytes', data: 'AP8=', type: 'Uint8Array' }
	};
	const result = await evaluateAction(
		input(`
 const response=await fetch('https://api.example');const data=await response.json();
 if(data.$web!=='ref'||data.id!==1||data.nested.data!=='AP8='||data instanceof Request)throw Error('JSON changed');
 const copy=await Response.json(data).json();if(copy.nested.$web!=='bytes')throw Error('JSON changed');
 return state;
 `),
		{ fetch: async () => Response.json(payload) }
	);
	expect(result.state).toEqual({ gold: 100 });
});
it('does not charge time waiting for a response to the CPU budget, but interrupts loops after await', async () => {
	const send: typeof fetch = async () => {
		await new Promise((resolve) => setTimeout(resolve, 650));
		return Response.json({ gold: 70 });
	};
	expect(
		(
			await evaluateAction(
				input(
					'const response=await fetch("https://api.example");state.gold=(await response.json()).gold;return state;'
				),
				{ fetch: send }
			)
		).state
	).toEqual({ gold: 70 });
	await expect(
		evaluateAction(input('await fetch("https://api.example");while(true){}'), { fetch: send })
	).rejects.toMatchObject({ code: 'timeout' });
}, 10000);
it('supports binary, Blob, FormData, clone and streaming response reads', async () => {
	const send = vi.fn<typeof fetch>().mockImplementation(async (request) => {
		const form = await (request as Request).formData();
		expect(form.get('prompt')).toBe('hello');
		expect(await (form.get('image') as Blob).text()).toBe('image');
		return new Response(new Uint8Array([0, 255, 7]));
	});
	const result = await evaluateAction(
		input(`
 const form=new FormData();form.set('prompt','hello');form.append('image',new Blob(['image'],{type:'text/plain'}),'test.txt');
 const response=await fetch('https://api.example',{method:'POST',body:form});const clone=response.clone();
 const bytes=new Uint8Array(await response.arrayBuffer());if(bytes[1]!==255)throw Error('bytes');
 const reader=clone.body.getReader();const part=await reader.read();if(part.value[2]!==7)throw Error('stream');await reader.cancel();reader.releaseLock();
 const encoded=new TextEncoder().encode('hello');if(new TextDecoder().decode(encoded)!=='hello')throw Error('codec');
 state.gold=bytes.length;return state;
 `),
		{ fetch: send }
	);
	expect(result.state).toEqual({ gold: 3 });
});
it('propagates AbortSignal into the host response and preserves synchronous rule contracts', async () => {
	const send: typeof fetch = async (_input, init) => {
		return new Response(
			new ReadableStream({
				start(controller) {
					init?.signal?.addEventListener(
						'abort',
						() => controller.error(new DOMException('Aborted', 'AbortError')),
						{ once: true }
					);
				}
			})
		);
	};
	expect(
		(
			await evaluateAction(
				input(
					`const controller=new AbortController();const response=await fetch('https://api.example',{signal:controller.signal});controller.abort();try{await response.text();throw Error('not aborted');}catch(error){if(error.name!=='AbortError')throw error;}return state;`
				),
				{ fetch: send }
			)
		).state
	).toEqual({ gold: 100 });
	for (const definition of [
		`helia.defineFilter({name:'bad',run(){helia.fetch('https://api.example');return {allow:true};}});`,
		`helia.defineHook({name:'bad',run(){helia.fetch('https://api.example');return [];}});`
	]) {
		await expect(
			evaluateAction(input('state.gold++;return state;', definition), { fetch: send })
		).rejects.toThrow();
	}
	await expect(
		evaluateAction(input('return state;', `helia.fetch('https://api.example');`), { fetch: send })
	).rejects.toMatchObject({ code: 'script' });
});
it('awaits Actions returned by included and independent Hooks and discards events when a later Filter rejects', async () => {
	const send = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ gold: 20 }));
	const source = input(
		'state.gold--;return state;',
		`
 helia.defineAction({name:'bonus',async run({state}){state.gold+=(await (await fetch('https://api.example')).json()).gold;return state;}});
 helia.defineHook({name:'after',actions:['remote'],run(){return [{name:'bonus',args:{}}];}});
 `
	);
	expect((await evaluateAction(source, { fetch: send })).state).toEqual({ gold: 119 });
	const denied = input(
		`await fetch('https://api.example');state.gold=20;helia.emit('remote');helia.appendMessage({role:'assistant',content:'not committed'});return state;`,
		`helia.defineFilter({name:'deny',run(){return {allow:false};}});`
	);
	await expect(evaluateAction(denied, { fetch: send })).rejects.toMatchObject({
		code: 'filter-rejected'
	});
	expect(denied.state).toEqual({ gold: 100 });
});
it('cancels unawaited fetch work and enforces VM memory limits when a response is materialized', async () => {
	let aborted = false;
	const pending: typeof fetch = async (_input, options) =>
		new Promise((_resolve, reject) => {
			options?.signal?.addEventListener(
				'abort',
				() => {
					aborted = true;
					reject(new DOMException('Aborted', 'AbortError'));
				},
				{ once: true }
			);
		});
	await expect(
		evaluateAction(input(`fetch('https://api.example').catch(()=>{});return state;`), {
			fetch: pending
		})
	).rejects.toMatchObject({ code: 'execution' });
	expect(aborted).toBe(true);
	await expect(
		evaluateAction(input(`await (await fetch('https://api.example')).text();return state;`), {
			fetch: async () => new Response('x'.repeat(20 * 1024 * 1024))
		})
	).rejects.toThrow();
});
it('bounds native Blob construction before large parts can allocate outside the VM heap', async () => {
	const result = await evaluateAction(
		input(`
 const part=new Blob([new Uint8Array(65536)]);
 let rejected=false;try{new Blob(new Array(513).fill(part));}catch(error){rejected=error.name==='TypeError';}
 if(!rejected)throw Error('Blob body limit');return state;
 `)
	);
	expect(result.state).toEqual({ gold: 100 });
});
