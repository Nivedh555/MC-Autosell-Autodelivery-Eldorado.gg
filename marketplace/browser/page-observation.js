'use strict';
function validateObservation(data) {
  if (!data || data.verified !== false || data.origin !== 'https://www.eldorado.gg' || !Array.isArray(data.elements) || data.elements.length > 400 || typeof data.truncated !== 'boolean' || !Number.isFinite(Date.parse(data.observedAt)) || Buffer.byteLength(JSON.stringify(data)) > 300000) throw Error('Invalid read-only page observation');
  const url = new URL(data.url);
  if (url.origin !== data.origin || !['/dashboard/','/order/'].some(path=>url.pathname.startsWith(path)) || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => /token|password|secret|auth|code|key/i.test(key)) || ['/dashboard/settings','/dashboard/wallet'].some(path=>url.pathname.startsWith(path))) throw Error('Unsafe page observation address');
  for (const element of data.elements) {
    if (!element || typeof element.selector !== 'string' || !element.selector || element.selector.length > 500 || typeof element.text !== 'string' || element.text.length > 500 || !/^[a-z][a-z0-9-]{0,30}$/.test(element.tag)) throw Error('Invalid page observation element');
    if (['textarea','script','style','iframe'].includes(element.tag) || element.type === 'password' || element.type === 'hidden' || element.type === 'file') throw Error('Sensitive page observation element');
    const permitted = new Set(['selector','tag','text','href','role','aria-label','title','type','data-testid','data-test']);
    for (const key of Object.keys(element)) if (!permitted.has(key) || typeof element[key] !== 'string' || element[key].length > (key==='href' ? 2000 : ['selector','text'].includes(key) ? 500 : 160)) throw Error('Unexpected page observation data');
    if (element.href) {
      const link = new URL(element.href, data.origin);
      if (link.origin !== data.origin || link.username || link.password || link.hash || [...link.searchParams.keys()].some(key => /token|password|secret|auth|code|key/i.test(key))) throw Error('Unsafe captured link');
    }
  }
  return { origin:data.origin, url:url.href, observedAt:data.observedAt, verified:false, truncated:data.truncated, elements:data.elements,
    scope:'Captured visible DOM labels and selector candidates only; developer review required. No live permission granted.' };
}
module.exports = { validateObservation };
