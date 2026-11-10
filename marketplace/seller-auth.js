'use strict';
const {field}=require('./contract/runtime');
class SellerAuth {
  constructor(contract,vault,transport){this.contract=contract;this.vault=vault;this.transport=transport;this.token=null;this.pending=null;}
  invalidate(token){if(this.token?.value===token)this.token=null;}
  async credential(){
    const auth=this.contract.auth;
    if(auth.kind==='apiKey')return this.vault?.retrieve(auth.vaultKey);
    if(this.token&&this.token.expiresAt>Date.now()+30000)return this.token.value;
    if(!this.pending)this.pending=this.refresh().finally(()=>{this.pending=null;});
    return this.pending;
  }
  async refresh(){
    const auth=this.contract.auth;
    if(auth.kind!=='clientCredentials'||!auth.tokenPath||!auth.tokenPointer||!auth.body||!['json','form'].includes(auth.requestFormat))throw Error('Seller API authentication needs its documented token request and response fields.');
    const url=new URL(auth.tokenPath,this.contract.baseUrl);
    if(url.origin!==new URL(this.contract.baseUrl).origin||url.username||url.password)throw Error('Seller token endpoint must use the documented API origin.');
    const values={clientId:await this.vault?.retrieve(auth.clientIdKey||'eldorado.api.clientId'),clientSecret:await this.vault?.retrieve(auth.clientSecretKey||'eldorado.api.clientSecret')};
    if(!values.clientId||!values.clientSecret)throw Error('Enter your Seller API Client ID and Client secret in Eldorado Setup.');
    const body={...auth.constants};
    for(const [remote,local] of Object.entries(auth.body)){
      if(!Object.hasOwn(values,local)||['__proto__','constructor','prototype'].includes(remote))throw Error('Invalid seller token field mapping.');
      body[remote]=values[local];
    }
    const encoded=auth.requestFormat==='form'?new URLSearchParams(body).toString():JSON.stringify(body);
    const response=await this.transport.request(url.href,{method:'POST',headers:{'Content-Type':auth.requestFormat==='form'?'application/x-www-form-urlencoded':'application/json','Content-Length':String(Buffer.byteLength(encoded)),Accept:'application/json'},body:encoded});
    if(response.status!==200)throw Error('Seller API sign-in failed (HTTP '+response.status+'). '+(response.status===401?'Eldorado rejected the saved Client ID and Client secret. Copy both from the same active credential, using the full secret shown when it was created, not the last four characters in the credentials list. Browser login and Minecraft do not authenticate the API.':'Check the credential expiry and seller API access.'));
    const data=await response.json();
    let token;
    if(auth.tokenPointer==='auto'){
                                                                             
                                                                             
      if(typeof data==='string')token=data;
      else {const candidates=Object.entries(data||{}).filter(([key,value])=>/^(access_?token|token)$/i.test(key)&&typeof value==='string');if(candidates.length===1)token=candidates[0][1];}
    }else token=field(data,auth.tokenPointer);
    const seconds=auth.expiresInPointer?Number(field(data,auth.expiresInPointer)):900;
    if(typeof token!=='string'||!token||token.length>20000||/[\r\n]/.test(token)||!Number.isFinite(seconds)||seconds<=30)throw Error('Seller API returned an invalid access token or expiry.');
    this.token={value:token,expiresAt:Date.now()+Math.min(seconds,900)*1000};return token;
  }
}
module.exports={SellerAuth};
