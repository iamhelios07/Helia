/** UI file RPC uses structured-cloned Blobs, independently of the bounded JSON state bridge. */
export const FILE_BOOTSTRAP = String.raw`
const fileListeners=new Set();
function fileRequest(operation){
 if(pending.size>=16)return Promise.reject(Error('FILE_UNAVAILABLE'));
 const id=String(++nextRequest);
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('FILE_UNAVAILABLE'));},30000);pending.set(id,{resolve,reject,timer});port.postMessage({kind:'files',id,operation});});
}
const storage=Object.freeze({
 save:(blob,options={})=>{if(!(blob instanceof Blob)||blob.size>8388608)return Promise.reject(Error('FILE_INPUT'));return fileRequest({kind:'save',blob,name:options.name??'file'});},
 read:ref=>fileRequest({kind:'read',ref}),stat:ref=>fileRequest({kind:'stat',ref}),
 list:(options={})=>fileRequest({kind:'list',...options}),remove:ref=>fileRequest({kind:'remove',ref})
});
function useAssetURL(ref){
 const [value,set]=hooks.useState({ref,url:null,loading:!!ref,error:null});
 hooks.useEffect(()=>{
  let disposed=false,generation=0,url;
  const load=async()=>{
   const version=++generation;
   if(url){URL.revokeObjectURL(url);url=undefined;}
   set({ref,url:null,loading:!!ref,error:null});
   if(!ref)return;
   try{
    const blob=await storage.read(ref);
    if(disposed||version!==generation)return;
    if(!['image/png','image/jpeg','image/webp','image/gif','audio/mpeg','audio/wav','audio/ogg','video/mp4','video/webm'].includes(blob.type.split(';',1)[0].trim()))throw Error('FILE_UNSUPPORTED_MEDIA');
    url=URL.createObjectURL(blob);set({ref,url,loading:false,error:null});
   }catch(error){if(!disposed&&version===generation)set({ref,url:null,loading:false,error});}
  };
  void load();const changed=changedRef=>{if(changedRef===ref)void load();};fileListeners.add(changed);
  return ()=>{disposed=true;generation++;fileListeners.delete(changed);if(url)URL.revokeObjectURL(url);};
 },[ref]);
 return value.ref===ref?{url:value.url,loading:value.loading,error:value.error}:{url:null,loading:!!ref,error:null};
}
`;
