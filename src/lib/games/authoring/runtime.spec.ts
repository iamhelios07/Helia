import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

import { authoringBindings } from './environment.js';
import { HELIA_AUTHORING_DECLARATIONS, HELIA_AUTHORING_LIBRARIES } from './runtime.js';

function diagnostics(files: Record<string, string>) {
	const root = path.resolve('data/authoring-typecheck').replaceAll('\\', '/') + '/';
	const sources = new Map(Object.entries(files).map(([file, source]) => [root + file, source]));
	for (const [file, binding] of authoringBindings(ts, sources)) {
		sources.set(file, sources.get(file)! + binding);
	}
	sources.set(root + '.helia/runtime.d.ts', HELIA_AUTHORING_DECLARATIONS);
	sources.set(
		root + '.helia/GameState.d.ts',
		`export type GameState = {
		gold: number; optional?: { hp: number }; nullable: { hp: number } | null;
		list: { hp: number }[];
	};`
	);
	for (const [file, source] of Object.entries(HELIA_AUTHORING_LIBRARIES)) {
		sources.set(root + file, source);
	}
	const options: ts.CompilerOptions = {
		strict: true,
		exactOptionalPropertyTypes: true,
		noEmit: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		moduleDetection: ts.ModuleDetectionKind.Force,
		jsx: ts.JsxEmit.Preserve,
		types: [],
		lib: ['lib.es2022.d.ts', 'lib.dom.d.ts']
	};
	const host = ts.createCompilerHost(options);
	const original = {
		getSourceFile: host.getSourceFile,
		fileExists: host.fileExists,
		directoryExists: host.directoryExists
	};
	host.getSourceFile = (file, target, ...rest) =>
		sources.has(file)
			? ts.createSourceFile(file, sources.get(file)!, target, true)
			: original.getSourceFile(file, target, ...rest);
	host.fileExists = (file) => sources.has(file) || original.fileExists(file);
	host.directoryExists = (directory) =>
		[...sources.keys()].some((file) => file.startsWith(directory + '/')) ||
		!!original.directoryExists?.(directory);
	return ts
		.getPreEmitDiagnostics(ts.createProgram([...sources.keys()], options, host))
		.map(
			(item) =>
				`${item.file?.fileName}:${item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start).line + 1 : ''}: ${ts.flattenDiagnosticMessageText(item.messageText, ' ')}`
		);
}

it('separates logic and UI contracts, including imported UI helpers and shared modules', () => {
	expect(
		diagnostics({
			'main.ts': `import './ui'; import './shared';
helia.defineAction<{amount:number}>({name:'add',run({state,args}){state.gold += args.amount;return state;}});
helia.appendMessage({role:'assistant',content:'done'});
helia.queueTurn('Continue');
// @ts-expect-error UI reads are unavailable in logic
helia.getState();
// @ts-expect-error persistent file IO is asynchronous and belongs to UI
helia.storage.list();
helia.defineAction({name:'remote',async run({state}){const response=await helia.fetch('https://example.com');state.gold=(await response.json()).gold;return state;}});
// @ts-expect-error old scheduling name was removed
helia.runTurn('Continue');
// @ts-expect-error synchronous message buffering has no Promise
helia.appendMessage({role:'user',content:'hi'}).then(()=>{});`,
			'ui.tsx': `'use ui'; import './helper'; import './shared';
const done: Promise<{revision:number}> = helia.runTurn('Continue');
const bytes: Promise<Blob> = helia.storage.read('helia-file:ref');
// @ts-expect-error external IO belongs to logic Actions
helia.fetch('https://example.com');
// @ts-expect-error UI does not export fetch
import {fetch as fetchExternal} from '@helia/ui';
// @ts-expect-error global fetch is unavailable in UI
fetch('https://example.com');
helia.storage.save(new Blob(['hello'],{type:'text/plain'})).then(file=>file.ref.toUpperCase());
helia.useAssetURL(null).loading.valueOf();
// @ts-expect-error storage saves Blobs, not state objects
helia.storage.save({name:'bad'});
const write: Promise<{revision:number}> = helia.appendMessage({role:'user',content:'hi'});
helia.action('add', {amount:1}).then(result => result.revision.toFixed());
helia.commitState({name:'manual',args:{}}, {gold:1,nullable:null,list:[]});
// @ts-expect-error registration is unavailable in UI
helia.defineAction({name:'bad',run(){}});
// @ts-expect-error old generation name was removed
helia.ai('Continue');
// @ts-expect-error old state proposal name was removed
helia.transaction({name:'manual',args:{}}, {});
// @ts-expect-error scheduling belongs to logic
helia.queueTurn('Continue');`,
			'helper.ts': `helia.getState().gold.toFixed();`,
			'shared.ts': `helia.appendMessage({role:'assistant',content:'Shared'});
// @ts-expect-error IO is not a shared runtime capability
helia.fetch('https://example.com');
// @ts-expect-error not available in both runtimes
helia.getState();`
		})
	).toEqual([]);
});

it('describes Filter and Hook inputs and results without permitting invalid contracts', () => {
	expect(
		diagnostics({
			'main.ts': `
helia.defineFilter({name:'gold',run({state,before,after,action,changes}) {
 state.gold.toFixed(); before.gold.toFixed(); after.gold.toFixed(); action.name.trim();
 changes.forEach(change=>change.path.join('.'));
 return {allow: state.gold >= 0, reason:'gold'};
}});
helia.defineHook({name:'bonus',mode:'included',run({state}){return [{name:'bonus',args:{gold:state.gold}}];}});
helia.defineHook({name:'notice',run(){helia.emit('notice',{ok:true});}});
// @ts-expect-error Filters return decisions
helia.defineFilter({name:'bad',run(){return [];}});
// @ts-expect-error Hooks return Actions
helia.defineHook({name:'bad',run(){return {allow:true};}});
// @ts-expect-error Filters have no execution mode
helia.defineFilter({name:'bad',mode:'independent',run(){return {allow:true};}});
helia.defineFilter({name:'readonly',run(context){
 // @ts-expect-error no args field on a rule context
 context.args;
 // @ts-expect-error proposed state is immutable
 context.state.gold++;
 return {allow:true};
}});
// @ts-expect-error event payloads must be objects
helia.emit('bad', 1);
`
		})
	).toEqual([]);
});

it('types turn APIs and multimodal model responses without old aliases or provider parameters', () => {
	expect(
		diagnostics({
			'main.ts': `helia.defineAction({name:'ask',run({state}){helia.queueTurn('Continue');return state;}});
// @ts-expect-error old scheduling name is unavailable
helia.queueAI('Continue');
// @ts-expect-error waiting for a model is not a synchronous logic operation
helia.callModel({messages:[]});`,
			'ui.tsx': `import {callModel,runTurn,type ModelResponse} from '@helia/ui';
runTurn('Continue').then(result=>result.revision.toFixed());
const result:Promise<ModelResponse> = callModel({model:'auxiliary',messages:[{role:'user',content:[{type:'image',mimeType:'image/png',data:'AA=='}]}]});
result.then(response=>response.content.forEach(part=>{if(part.type==='text')part.text.trim();else part.data.trim();}));
// @ts-expect-error generation parameters belong in model settings
callModel({messages:[],temperature:0});
// @ts-expect-error old turn name is unavailable
helia.requestAI('Continue');
// @ts-expect-error roles are bounded
callModel({model:'another',messages:[]});`
		})
	).toEqual([]);
});

it('protects nested nullable state and enforces the explicit schema profile', () => {
	expect(
		diagnostics({
			'main.ts': `
helia.defineQuery({name:'read',run({state}){
 if(state.optional) {
  // @ts-expect-error optional nested state is read-only
  state.optional.hp = 1;
 }
 if(state.nullable) {
  // @ts-expect-error nullable nested state is read-only
  state.nullable.hp = 1;
 }
 // @ts-expect-error arrays are read-only
 state.list.push({hp:1});
 // @ts-expect-error array elements are read-only
 state.list[0].hp = 1;
 return state.gold;
}});
helia.defineAction({name:'schema',arguments:{type:'object',properties:{amount:{type:'number'}},required:['amount'],additionalProperties:false},run({state,args}){if(typeof args.amount === 'number') state.gold += args.amount; return state;}});
// @ts-expect-error explicit schemas cannot be combined with generics
helia.defineAction<{amount:number}>({name:'bad',arguments:{type:'object',properties:{},additionalProperties:false},run({state}){return state;}});
// @ts-expect-error schemas must be closed objects
helia.defineAction({name:'bad',arguments:{type:'object',properties:{},additionalProperties:true},run({state}){return state;}});
`
		})
	).toEqual([]);
});

it('uses Preact JSX, DOM event types and typed presentation components', () => {
	expect(
		diagnostics({
			'ui.tsx': `'use ui';
import {Button, Text, Progress, Inventory, Stats, QuestList, helia} from '@helia/ui';
const valid = <><Button disabled onClick={event => { event.currentTarget.disabled = true; }}>Buy</Button>
<input onInput={event => event.currentTarget.value.trim()} />
<Text class="label">Gold</Text><Progress value={2} max={5} label="Health" />
<Inventory items={[{name:'ore'}]} renderItem={item => <b>{item.name}</b>} />
<QuestList items={['quest']} renderItem={item => item.toUpperCase()} />
<Stats items={[{label:'Gold', value:1}]} /><svg><path d="M0 0" /></svg></>;
// @ts-expect-error misspelled intrinsic element
const badTag = <buton />;
// @ts-expect-error invalid button prop
const badProp = <Button disabld />;
// @ts-expect-error invalid intrinsic prop
const badIntrinsic = <button disabld />;
// @ts-expect-error progress requires a number
const badProgress = <Progress value="2" />;
// @ts-expect-error array item inference
const badList = <Inventory items={[{name:'ore'}]} renderItem={item => item.missing} />;
// @ts-expect-error imported UI helia excludes logic registration
helia.defineQuery({name:'bad',run(){return 1;}});
`
		})
	).toEqual([]);
});
