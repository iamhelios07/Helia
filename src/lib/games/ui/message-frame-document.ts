import purifierSource from 'dompurify/dist/purify.min.js?raw';

const styles = `
html,body{margin:0;padding:0;min-width:0;background:transparent;color:inherit}
*{box-sizing:border-box}body{font:14px/1.85 sans-serif;overflow-wrap:anywhere}
#helia-message-root{display:flow-root;min-width:0;white-space:pre-wrap}
img,video,canvas{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}
table{max-width:100%;border-collapse:collapse;white-space:normal}th,td{padding:4px 8px;border:1px solid currentColor}
p:first-child{margin-top:0}p:last-child{margin-bottom:0}summary{cursor:pointer}
`;

/** Only this trusted bootstrap executes. Message HTML never becomes script source. */
const bootstrap = String.raw`
const content=document.getElementById('helia-message-root');
let port,frame=0,observer,mutations;
function measure(){
 frame=0;
 port?.postMessage({kind:'height',height:Math.ceil(Math.max(content.scrollHeight,content.getBoundingClientRect().height,20))});
}
function resized(){if(!frame)frame=requestAnimationFrame(measure);}
function receive(event){
 const value=event.data;
 if(value?.kind==='dispose'){
  observer.disconnect();mutations.disconnect();cancelAnimationFrame(frame);port.close();return;
 }
 if(value?.kind!=='content'||typeof value.html!=='string')return;
 for(const key of ['color','fontFamily','fontSize','lineHeight','colorScheme']){
  if(typeof value.appearance?.[key]==='string')document.body.style[key]=value.appearance[key];
 }
 content.innerHTML=DOMPurify.sanitize(value.html,{
  USE_PROFILES:{html:true},FORCE_BODY:true,ADD_TAGS:['style'],
  FORBID_TAGS:['script','iframe','object','embed','base','meta','link','form'],
  FORBID_ATTR:['nonce','srcdoc','href','action','formaction','autofocus','popover','popovertarget']
 });
 resized();
}
function initialize(event){
 if(event.source!==parent||event.data?.token!==token||event.ports.length!==1||port)return;
 window.removeEventListener('message',initialize);
 port=event.ports[0];port.onmessage=receive;port.start();
 observer=new ResizeObserver(resized);observer.observe(content);
 mutations=new MutationObserver(resized);mutations.observe(content,{subtree:true,childList:true,attributes:true,characterData:true});
 content.addEventListener('load',resized,true);
 content.addEventListener('toggle',resized,true);
}
window.addEventListener('message',initialize);
parent.postMessage({kind:'helia-message-ready',token},'*');
`;

export function messageFrameDocument(token: string): string {
	const nonce = token.replace(/-/g, '');
	const code = `${purifierSource}\n;(()=>{const token=${JSON.stringify(token)};${bootstrap}})();`;
	const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-src 'none'`;
	return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><style>${styles}</style></head><body><div id="helia-message-root"></div><script nonce="${nonce}">${code.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
