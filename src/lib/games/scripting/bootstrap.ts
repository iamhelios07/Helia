/** Runs inside QuickJS only. The returned control handle is never exposed to creator scripts.
 * Web RPC callbacks exchange only JSON and byte buffers, never host object references. */
export const BOOTSTRAP = String.raw`
(() => {
  'use strict';
  const parse = JSON.parse, stringify = JSON.stringify;
  const freeze = Object.freeze, create = Object.create;
  const prototype = Object.getPrototypeOf, setPrototype = Object.setPrototypeOf;
  const names = Object.getOwnPropertyNames, symbols = Object.getOwnPropertySymbols;
  const descriptor = Object.getOwnPropertyDescriptor, isArray = Array.isArray;
  const own = Object.hasOwn;
  const objectPrototype = Object.prototype, finite = Number.isFinite;
  const string = String;
  const apply = Reflect.apply;
  const resolvePromise = Promise.resolve.bind(Promise), then = Promise.prototype.then;
  const definitions = new Map();
  const put = Map.prototype.set.bind(definitions), get = Map.prototype.get.bind(definitions);
  const has = Map.prototype.has.bind(definitions);
  const metadata = {actions:[],queries:[],filters:[],hooks:[],migrations:[]};
  let sealed = false, failed = false, scriptId = null, phase = null, events = [];
  let badMigrationRegistration = false;
  let webFetch;
  const checkWeb = () => {if(phase !== 'action'){failed=true;throw Error('Web IO requires an Action');}};
  const fetch = (...args) => {checkWeb();return webFetch(...args);};

  // Validate before encoding: JSON.stringify alone silently changes NaN, undefined and accessors.
  function copy(value, ancestors = [], depth = 0) {
    if (depth > 256) throw Error('value-depth');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && finite(value)) return value;
    if (typeof value !== 'object' || value === null) throw Error('invalid-json');
    for (let index = 0; index < ancestors.length; index++) if (ancestors[index] === value) throw Error('invalid-json');
    const array = isArray(value), proto = prototype(value);
    if ((!array && proto !== objectPrototype && proto !== null) || symbols(value).length) throw Error('invalid-json');
    const result = array ? setPrototype([], null) : create(null);
    const keys = names(value);
    const next = setPrototype([], null);
    for (let index = 0; index < ancestors.length; index++) next[index] = ancestors[index];
    next[ancestors.length] = value;
    if (array) {
      if (keys.length !== value.length + 1) throw Error('invalid-array');
      for (let index = 0; index < value.length; index++) {
        const item = descriptor(value, string(index));
        if (!item || !own(item, 'value')) throw Error('invalid-array');
        result[index] = copy(item.value, next, depth + 1);
      }
    } else {
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw Error('invalid-key');
        const item = descriptor(value, key);
        if (!item.enumerable || !own(item, 'value')) throw Error('invalid-property');
        result[key] = copy(item.value, next, depth + 1);
      }
    }
    return result;
  }
  function readonly(value) {
    if (value !== null && typeof value === 'object') {
      const keys = names(value);
      for (let index = 0; index < keys.length; index++) readonly(value[keys[index]]);
      freeze(value);
    }
    return value;
  }
  const define = (kind, definition) => {
    try {
      const entries = metadata[kind === 'query' ? 'queries' : kind + 's'];
      if (sealed || entries.length >= (kind === 'migration' ? 16 : 256) || !definition || typeof definition !== 'object') throw Error('registration');
      const {name, arguments: args, description, run} = definition;
      const key = kind + ':' + name;
      if (typeof name !== 'string' || !name.trim() || name.length > 128 || has(key) || typeof run !== 'function') throw Error('registration');
      if (name.startsWith('$helia.')) throw Error('reserved-name');
      if (description !== undefined && (typeof description !== 'string' || !description.trim() || description.length > 1024)) throw Error('description');
      const info = {name,scriptId};
      if (kind === 'action' || kind === 'query') {info.arguments = copy(args === undefined ? {type:'object',properties:{},additionalProperties:false} : args);info.ai = definition.ai === true;}
      else if (kind === 'migration') {
        const from = definition.from;
        if (from !== undefined) {
          if (typeof from !== 'string' || from.length > 256) throw Error('from');
          info.from = from;
        }
      } else {
        info.priority = definition.priority === undefined ? 0 : definition.priority;
        info.actions = definition.actions === undefined ? null : copy(definition.actions);
        if (kind === 'hook') info.mode = definition.mode === undefined ? 'included' : definition.mode;
      }
      if (description !== undefined) info.description = description;
      put(key, run);
      entries[entries.length] = copy(info);
    } catch (error) { if(kind === 'migration')badMigrationRegistration = true; failed = true; throw error; }
  };
  const emit = (name, payload = {}) => {
    try {
      if ((phase !== 'action' && phase !== 'hook') || events.length >= 128 || typeof name !== 'string' || !name.trim() || name.length > 128) throw Error('event');
      events[events.length] = copy({name,payload});
    } catch (error) { failed = true; throw error; }
  };
  const queueTurn = (text, options = {}) => emit('$helia.ai', {text, visible: options.visible === true});
  Object.defineProperty(globalThis, 'helia', {value: freeze({
    defineAction: definition => define('action',definition),
    defineQuery: definition => define('query',definition),
    defineFilter: definition => define('filter',definition),
    defineHook: definition => define('hook',definition),
    defineMigration: definition => define('migration',definition),
    emit,
    appendMessage: message => emit('$helia.message', message),
    queueTurn,
    fetch,
    secrets:freeze({has:name=>{checkWeb();return webFetch.secrets.has(name);},ref:name=>{checkWeb();return webFetch.secrets.ref(name);}})
  }), writable: false, configurable: false});
  return freeze({
    migrationRegistrationFailed() {return badMigrationRegistration ? 'true' : 'false';},
    migrationMode() {
      if (sealed || scriptId !== null) throw Error('registration');
      const forbidden = () => {throw Error('Non-deterministic API');};
      Object.defineProperty(Math,'random',{value:forbidden,writable:false,configurable:false});
      for (const key of ['now','parse','UTC']) Object.defineProperty(forbidden,key,{value:forbidden});
      Object.defineProperty(globalThis,'Date',{value:forbidden,writable:false,configurable:false});
      for (const key of ['WeakRef','FinalizationRegistry']) Object.defineProperty(globalThis,key,{value:undefined,writable:false,configurable:false});
    },
    installWeb(factory,sync,async,encode,decode) {
      if(sealed || webFetch)throw Error('Web registration');
      webFetch=apply(factory,undefined,[sync,async,encode,decode,checkWeb]);
      Object.defineProperty(globalThis,'fetch',{value:fetch,writable:false,configurable:false});
    },
    beginScript(id) {if (sealed) throw Error('registration'); scriptId = id;},
    list() {
      sealed = true;
      if (failed) throw Error('registration');
      return stringify(copy(metadata));
    },
    invoke(kind, name, json) {
      const key = kind + ':' + name;
      if (!sealed || failed || !has(key) || phase !== null) throw Error('invocation');
      const context = parse(json);
      if (kind === 'action') {readonly(context.args); freeze(context);}
      else readonly(context);
      phase = kind; events = [];
      try {
        let value = apply(get(key), undefined, [context]);
        if (kind === 'action') {
          return apply(then,resolvePromise(value),[value => {
            try {if(failed)throw Error('invocation');return stringify(copy({value,events}));}
            finally {phase=null;events=[];}
          }, error=>{phase=null;events=[];throw error;}]);
        }
        if (kind === 'hook' && value === undefined) value = [];
        if (failed) throw Error('invocation');
        if (kind === 'migration') {
          try {return stringify(copy({ok:true,value}));}
          catch {return stringify(copy({ok:false,reason:'non-json'}));}
        }
        return stringify(copy({value, events}));
      } finally {if(kind !== 'action'){phase = null; events = [];}}
    }
  });
})()
`;
