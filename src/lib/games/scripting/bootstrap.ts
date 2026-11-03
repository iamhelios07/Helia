/** Runs inside QuickJS only. The returned control handle is never exposed to creator scripts.
 * No host functions or host object references enter the VM. */
export const BOOTSTRAP = String.raw`
(() => {
  'use strict';
  const parse = JSON.parse, stringify = JSON.stringify;
  const freeze = Object.freeze, create = Object.create;
  const prototype = Object.getPrototypeOf, setPrototype = Object.setPrototypeOf;
  const names = Object.getOwnPropertyNames, symbols = Object.getOwnPropertySymbols;
  const descriptor = Object.getOwnPropertyDescriptor, isArray = Array.isArray;
  const objectPrototype = Object.prototype, finite = Number.isFinite;
  const apply = Reflect.apply;
  const definitions = new Map();
  const put = Map.prototype.set.bind(definitions), get = Map.prototype.get.bind(definitions);
  const has = Map.prototype.has.bind(definitions);
  const metadata = {actions:[],filters:[],hooks:[]};
  let sealed = false, failed = false, scriptId = null, phase = null, events = [];

  // Validate before encoding: JSON.stringify alone silently changes NaN, undefined and accessors.
  function copy(value, ancestors = [], depth = 0) {
    if (depth > 256) throw Error('value-depth');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && finite(value)) return value;
    if (typeof value !== 'object' || value === null || ancestors.includes(value)) throw Error('invalid-json');
    const array = isArray(value), proto = prototype(value);
    if ((!array && proto !== objectPrototype && proto !== null) || symbols(value).length) throw Error('invalid-json');
    const result = array ? setPrototype([], null) : create(null);
    const keys = names(value);
    const next = [...ancestors, value];
    if (array) {
      if (keys.length !== value.length + 1) throw Error('invalid-array');
      for (let index = 0; index < value.length; index++) {
        const item = descriptor(value, String(index));
        if (!item || !('value' in item)) throw Error('invalid-array');
        result[index] = copy(item.value, next, depth + 1);
      }
    } else {
      for (const key of keys) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw Error('invalid-key');
        const item = descriptor(value, key);
        if (!item.enumerable || !('value' in item)) throw Error('invalid-property');
        result[key] = copy(item.value, next, depth + 1);
      }
    }
    return result;
  }
  function readonly(value) {
    if (value !== null && typeof value === 'object') {
      for (const key of names(value)) readonly(value[key]);
      freeze(value);
    }
    return value;
  }
  const define = (kind, definition) => {
    try {
      const entries = metadata[kind + 's'];
      if (sealed || entries.length >= 256 || !definition || typeof definition !== 'object') throw Error('registration');
      const {name, arguments: args, description, run} = definition;
      const key = kind + ':' + name;
      if (typeof name !== 'string' || !name.trim() || name.length > 128 || has(key) || typeof run !== 'function') throw Error('registration');
      if (description !== undefined && (typeof description !== 'string' || !description.trim() || description.length > 1024)) throw Error('description');
      const info = {name,scriptId};
      if (kind === 'action') info.arguments = copy(args);
      else {
        info.priority = definition.priority === undefined ? 0 : definition.priority;
        info.actions = definition.actions === undefined ? null : copy(definition.actions);
        if (kind === 'hook') info.mode = definition.mode === undefined ? 'included' : definition.mode;
      }
      if (description !== undefined) info.description = description;
      put(key, run);
      entries[entries.length] = copy(info);
    } catch (error) { failed = true; throw error; }
  };
  const emit = (name, payload = {}) => {
    try {
      if ((phase !== 'action' && phase !== 'hook') || events.length >= 128 || typeof name !== 'string' || !name.trim() || name.length > 128) throw Error('event');
      events[events.length] = copy({name,payload});
    } catch (error) { failed = true; throw error; }
  };
  Object.defineProperty(globalThis, 'helia', {value: freeze({
    defineAction: definition => define('action',definition),
    defineFilter: definition => define('filter',definition),
    defineHook: definition => define('hook',definition),
    emit
  }), writable: false, configurable: false});
  return freeze({
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
        if (kind === 'hook' && value === undefined) value = [];
        if (failed) throw Error('invocation');
        return stringify(copy({value, events}));
      } finally {phase = null; events = [];}
    }
  });
})()
`;
