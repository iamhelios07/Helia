export const SECRET_BOOTSTRAP = String.raw`
function secretRequest(operation){
 if(pending.size>=16)return Promise.reject(Error('Game secret unavailable'));
 const id=String(++nextRequest);
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Game secret unavailable'));},30000);pending.set(id,{resolve,reject,timer});port.postMessage({kind:'secrets',id,operation});});
}
const secrets=Object.freeze({
 set:(name,value,options)=>secretRequest({kind:'set',name,value,url:options?.url}).then(()=>undefined),
 has:name=>secretRequest({kind:'has',name}),
 remove:name=>secretRequest({kind:'remove',name}).then(()=>undefined)
});
`;
