/** Trusted Preact shell, emitted inside an opaque-origin iframe alongside the packaged modules. */
export const FRAME_BOOTSTRAP = String.raw`
let port, preact, api, latest, uiValues, initialized=false, booting=true, nextRequest=0;
let views=[];
const cache=new Map(), panels=new Map(), stateListeners=new Set(), uiListeners=new Set(), eventListeners=new Map(), pending=new Map(), disposers=new Set();
const send=(message)=>port.postMessage(JSON.stringify(message));
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const copy=value=>JSON.parse(JSON.stringify(value));
const name=value=>{if(typeof value!=='string'||!/^[\w-]{1,80}$/.test(value))throw Error('Invalid name');return value;};
function load(id){
  if(id==='@helia/ui')return api;
  if(cache.has(id))return cache.get(id).exports;
  if(!Object.hasOwn(factories,id))throw Error('Module unavailable');
  const module={exports:{}};cache.set(id,module);
  factories[id](module,module.exports,spec=>load(dependencies[id]?.[spec]??spec),preact?.h,preact?.Fragment);
  return module.exports;
}
function request(kind, payload){
  if(pending.size>=16)return Promise.reject(Error('Too many requests'));
  const id=String(++nextRequest);
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Request timed out'));},30000);pending.set(id,{resolve,reject,timer});send({kind,id,...payload});});
}
function setUI(key,value){
  if(typeof key!=='string'||key.length>128||['__proto__','constructor','prototype'].includes(key))throw Error('Invalid UI key');
  const next=copy(value);uiValues={...uiValues,[key]:next};
  send({kind:'ui-state',values:uiValues});for(const listener of [...uiListeners])listener();
}
function publishPanels(){if(!booting)send({kind:'panels',panels:[...panels.values()].map(({id,title})=>({id,title}))});}
function redraw(){if(!booting)preact.render(preact.h('div',{},views.filter(view=>panels.has(view.id)).map(view=>preact.h(Panel,{key:view.id,...view}))),document.getElementById('workbench'));}
let hooks,Boundary;
function receive(message){
  if(message.kind==='views'){views=message.views;redraw();
  }else if(message.kind==='state'){
    latest=freeze(message.state);
    for(const listener of [...stateListeners]){try{listener(latest);}catch{}}
  }else if(message.kind==='event'){
    for(const listener of [...(eventListeners.get(message.event.name)??[])]){try{listener(freeze(message.event.payload));}catch{}}
  }else if(message.kind==='response'){
    const job=pending.get(message.id);if(!job)return;pending.delete(message.id);clearTimeout(job.timer);
    if(message.ok)job.resolve(message.result);else job.reject(Error(message.error));
  }else if(message.kind==='dispose'){
    booting=true;
    preact.render(null,document.getElementById('workbench'));
    for(const dispose of disposers){try{dispose();}catch{}}
    for(const job of pending.values()){clearTimeout(job.timer);job.reject(Error('UI closed'));}
    pending.clear();stateListeners.clear();uiListeners.clear();eventListeners.clear();panels.clear();port.close();
  }
}
function Panel({id,x,y,width,height}){
  const panel=panels.get(id);const h=preact.h;
  if(!panel)return null;
  return h('section',{class:'content','aria-label':panel.title,style:{position:'absolute',left:x+'px',top:y+'px',width:width+'px',height:height+'px'},ref:element=>{if(element&&uiValues['scroll:'+id]!==undefined)element.scrollTop=uiValues['scroll:'+id];},onScroll:event=>setUI('scroll:'+id,event.currentTarget.scrollTop)},h(Boundary,{key:id},h(panel.component)));
}
function start(initial){
  latest=freeze(initial.state);uiValues=initial.uiState??{};
  preact=load('preact');hooks=load('preact/hooks');
  Boundary=class extends preact.Component{constructor(){super();this.state={failed:false};}componentDidCatch(){this.setState({failed:true});}render(){return this.state.failed?preact.h('p',{role:'alert'},'패널을 표시하지 못했어요.'):this.props.children;}};
  const subscribeState=listener=>{stateListeners.add(listener);listener(latest);return ()=>stateListeners.delete(listener);};
  const onEvent=(event,listener)=>{if(typeof event!=='string'||!event.trim()||event.length>128||typeof listener!=='function')throw Error('Invalid event subscription');const entries=eventListeners.get(event)??new Set();entries.add(listener);eventListeners.set(event,entries);return ()=>{entries.delete(listener);if(!entries.size)eventListeners.delete(event);};};
  const registerPanel=definition=>{
    const id=name(definition.id);
    if(panels.has(id)||panels.size>=16||typeof definition.title!=='string'||definition.title.length>100||!definition.title.trim()||typeof definition.component!=='function')throw Error('Invalid panel');
    panels.set(id,{id,title:definition.title,component:definition.component});publishPanels();redraw();
    return ()=>{panels.delete(id);publishPanels();redraw();};
  };
  const useGameState=()=>{const [value,set]=hooks.useState(latest);hooks.useEffect(()=>subscribeState(set),[]);return value;};
  const useUIState=(key,initialValue)=>{
    const [,refresh]=hooks.useState(0);
    hooks.useEffect(()=>{const listener=()=>refresh(value=>value+1);uiListeners.add(listener);return ()=>uiListeners.delete(listener);},[key]);
    const value=Object.hasOwn(uiValues,key)?uiValues[key]:initialValue;
    return [value,next=>setUI(key,typeof next==='function'?next(Object.hasOwn(uiValues,key)?uiValues[key]:initialValue):next)];
  };
  const useUIEvent=(event,listener)=>hooks.useEffect(()=>onEvent(event,listener),[event,listener]);
  const h=preact.h;
  const Button=({children,...props})=>h('button',{type:'button',...props},children);
  const Text=({children,...props})=>h('span',props,children);
  const Progress=({value,max=100,label})=>h('label',{},label,h('progress',{value,max,'aria-label':label}));
  const Inventory=({items=[],renderItem=item=>String(item),label='인벤토리'})=>h('ul',{'aria-label':label},items.map((item,index)=>h('li',{key:index},renderItem(item,index))));
  const Stats=({items=[],label='스탯'})=>h('dl',{'aria-label':label},items.map(item=>h(preact.Fragment,{},h('dt',{},item.label),h('dd',{},String(item.value)))));
  const QuestList=({items=[],renderItem=item=>String(item),label='퀘스트'})=>h(Inventory,{items,renderItem,label});
  api={registerPanel,subscribeState,useGameState,useUIState,useUIEvent,onEvent,onDispose:fn=>{disposers.add(fn);return ()=>disposers.delete(fn);},getState:()=>latest,action:(action,args={})=>request('action',{action:{name:action,args}}),transaction:(action,state)=>request('transaction',{action,state}),Button,Text,Progress,Inventory,Stats,QuestList};
  api.helia=api;Object.freeze(api);Object.defineProperty(globalThis,'helia',{value:api,writable:false,configurable:false});
  try{const module=load(entry);if(typeof module.default==='function'){const dispose=module.default(api);if(dispose!==undefined&&typeof dispose!=='function'){if(dispose&&typeof dispose.then==='function')Promise.resolve(dispose).catch(()=>{});throw Error('Entry must initialize synchronously');}if(typeof dispose==='function')disposers.add(dispose);}booting=false;publishPanels();redraw();send({kind:'ready'});}
  catch{send({kind:'error',message:'게임 UI를 시작하지 못했어요.'});}
}
window.addEventListener('message',function initialize(event){
  if(initialized||event.source!==parent||event.data?.token!==token||event.ports.length!==1)return;
  initialized=true;window.removeEventListener('message',initialize);port=event.ports[0];
  port.onmessage=event=>{try{const message=JSON.parse(event.data);if(!latest&&message.kind==='init')start(message);else receive(message);}catch{send({kind:'error',message:'게임 UI 메시지를 처리하지 못했어요.'});}};
  port.start();
});
parent.postMessage({heliaUI:token},'*');
`;

export const FRAME_STYLES = `
:root{font:14px system-ui,sans-serif;color:#e6e3ed;background:#17151e;color-scheme:dark}*{box-sizing:border-box}html,body,#workbench{margin:0;width:100%;height:100%;overflow:hidden}button,select,input{font:inherit}button,select{background:#302b3e;border:1px solid #514960;border-radius:5px;color:inherit;padding:5px 8px}button:focus-visible,select:focus-visible{outline:2px solid #b6a1ff;outline-offset:2px}button:disabled{opacity:.5}.content{overflow:auto;padding:12px;background:#201c29}progress{max-width:100%}ul{padding-left:22px}
`;
