import { WEB_TYPES } from './web-api.js';

/** Executed inside QuickJS; RPC callbacks and object IDs stay in this closure. */
export const WEB_BOOTSTRAP = String.raw`
(function(sync,async,encodeBuffer,decodeBuffer,canFetch){
 const parse=JSON.parse,stringify=JSON.stringify,entries=Object.entries,define=Object.defineProperty;
 const refs=new WeakMap(),cache=new Map(),classes={};
 const specs=${JSON.stringify(WEB_TYPES)};
 class DOMException extends Error{constructor(message='',name='Error'){super(message);this.name=name;}}
 define(globalThis,'DOMException',{value:DOMException});
 function pack(value){
  if(value===undefined)return {$web:'undefined'};
  if(value===null||typeof value!=='object')return value;
  const ref=refs.get(value);if(ref)return {$web:'ref',id:ref};
  if(value instanceof ArrayBuffer)return {$web:'bytes',type:'ArrayBuffer',data:encodeBuffer(value)};
  if(ArrayBuffer.isView(value))return {$web:'bytes',type:'Uint8Array',data:encodeBuffer(value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength))};
  if(Array.isArray(value))return value.map(pack);
  return {$web:'object',value:Object.fromEntries(entries(value).map(([key,item])=>[key,pack(item)]))};
 }
 function unpack(value){
  if(value===null||typeof value!=='object')return value;
  if(value.$web==='undefined')return undefined;
  if(value.$web==='error')return new DOMException(value.message,value.name);
  if(value.$web==='bytes'){const bytes=decodeBuffer(value.data);return value.type==='ArrayBuffer'?bytes:new Uint8Array(bytes);}
  if(value.$web==='ref'){
   if(cache.has(value.id))return cache.get(value.id);
   const object=Object.create(classes[value.type].prototype);refs.set(object,value.id);cache.set(value.id,object);return object;
  }
  if(value.$web==='object')return Object.fromEntries(entries(value.value).map(([key,item])=>[key,unpack(item)]));
  if(Array.isArray(value))return value.map(unpack);
  return Object.fromEntries(entries(value).map(([key,item])=>[key,unpack(item)]));
 }
 function result(json){const value=parse(json);if(!value.ok)throw new DOMException(value.message,value.name);return unpack(value.value);}
 const wire=value=>stringify({...value,args:pack(value.args),value:pack(value.value)});
 const call=value=>result(sync(wire(value)));
 const wait=async value=>{canFetch();return result(await async(wire(value)));};
 for(const [type,spec] of entries(specs)){
  const Class=function(...args){if(!new.target||!spec.construct)throw new TypeError('Illegal constructor');return call({op:'new',type,args});};
  classes[type]=Class;define(globalThis,type,{value:Class});
  for(const name of spec.properties??[])define(Class.prototype,name,{get(){return call({op:'get',id:refs.get(this),name});},...(spec.writable?.includes(name)?{set(value){call({op:'set',id:refs.get(this),name,value});}}:{})});
  for(const name of spec.asyncProperties??[])define(Class.prototype,name,{get(){return wait({op:'get',id:refs.get(this),name});}});
  for(const name of spec.sync??[])define(Class.prototype,name,{value:function(...args){return call({op:'call',id:refs.get(this),name,args});},configurable:true});
  for(const name of spec.async??[])define(Class.prototype,name,{value:function(...args){return wait({op:'call',id:refs.get(this),name,args});}});
  for(const name of spec.statics??[])define(Class,name,{value:function(...args){return call({op:'static',type,name,args});}});
  if(spec.iterator){
   for(const name of ['entries','keys','values']){const method=Class.prototype[name];define(Class.prototype,name,{value:function(){return method.call(this)[Symbol.iterator]();},configurable:true});}
   define(Class.prototype,Symbol.iterator,{value:Class.prototype[spec.iterator]});
   define(Class.prototype,'forEach',{value:function(fn,that){for(const [key,value] of this.entries())fn.call(that,value,key,this);}});
  }
 }
 Object.setPrototypeOf(classes.File.prototype,classes.Blob.prototype);
 define(classes.ReadableStream.prototype,Symbol.asyncIterator,{value:async function*(){const reader=this.getReader();let done=false;try{for(;;){const part=await reader.read();if(part.done){done=true;return;}yield part.value;}}finally{if(!done)await reader.cancel();reader.releaseLock();}}});
 const fetch=function(input,init){canFetch();return wait({op:'fetch',args:[input,init]});};
 return Object.assign(fetch,{secrets:Object.freeze({has:name=>wait({op:'secret',name:'has',args:[name]}),ref:name=>wait({op:'secret',name:'ref',args:[name]})})});
})
`;
