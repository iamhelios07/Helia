/** Trusted media hydration only; message HTML receives no executable API. */
export const MESSAGE_FILES_BOOTSTRAP = String.raw`
let nextFileRequest=0,fileBytes=0;
const fileMedia=new Map();
const filePattern=/^helia-file:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
DOMPurify.addHook('uponSanitizeAttribute',(node,data)=>{
 if(data.attrName==='src'&&filePattern.test(data.attrValue)&&['IMG','AUDIO','VIDEO','SOURCE'].includes(node.nodeName)){
  node.setAttribute('data-helia-file',data.attrValue);data.keepAttr=false;
 }
});
function mediaElements(ref){return [...content.querySelectorAll('img[data-helia-file],audio[data-helia-file],video[data-helia-file],source[data-helia-file]')].filter(node=>node.getAttribute('data-helia-file')===ref);}
function applyFile(ref){
 const file=fileMedia.get(ref);if(!file)return;
 for(const node of mediaElements(ref)){
  const target=node.nodeName==='SOURCE'?node.closest('audio,video')??node:node;
  target.nextElementSibling?.matches('[data-file-placeholder]')&&target.nextElementSibling.remove();
  if(file.url){target.hidden=false;node.src=file.url;if(node.nodeName==='SOURCE')target.load?.();}
  else if(file.error){
   node.removeAttribute('src');target.hidden=true;
   const placeholder=document.createElement('span');placeholder.dataset.filePlaceholder='';placeholder.setAttribute('role','status');placeholder.textContent='파일을 표시할 수 없어요. 삭제되었거나 사용할 수 없는 파일입니다.';target.after(placeholder);
  }
 }
 resized();
}
function forgetFile(ref){const file=fileMedia.get(ref);if(file?.url)URL.revokeObjectURL(file.url);fileBytes-=file?.size??0;fileMedia.delete(ref);}
function requestFile(ref){
 if(!filePattern.test(ref))return;
 const id=++nextFileRequest;fileMedia.set(ref,{id});port.postMessage({kind:'file',ref,id});
}
function syncFiles(){
 const refs=new Set([...new Set([...content.querySelectorAll('img[data-helia-file],audio[data-helia-file],video[data-helia-file],source[data-helia-file]')].map(node=>node.getAttribute('data-helia-file')).filter(ref=>filePattern.test(ref)))].slice(0,16));
 for(const ref of fileMedia.keys())if(!refs.has(ref))forgetFile(ref);
 for(const ref of refs){if(!fileMedia.has(ref))requestFile(ref);else applyFile(ref);}
}
function receiveFile(value){
 if(value.kind==='files-reset'){for(const ref of [...fileMedia.keys()])forgetFile(ref);syncFiles();return true;}
 if(value.kind==='files-changed'){
  if(fileMedia.has(value.ref)){forgetFile(value.ref);for(const node of mediaElements(value.ref)){node.removeAttribute('src');}requestFile(value.ref);}return true;
 }
 if(value.kind!=='file')return false;
 const file=fileMedia.get(value.ref);if(!file||file.id!==value.id)return true;
 const blob=value.blob;
 if(value.error||!(blob instanceof Blob)||blob.size>8388608||fileBytes+blob.size>33554432){file.error=true;}
 else{file.url=URL.createObjectURL(blob);file.size=blob.size;fileBytes+=blob.size;}
 applyFile(value.ref);return true;
}
`;
