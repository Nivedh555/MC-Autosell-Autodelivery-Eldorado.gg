'use strict';
// A delayed preview can remain visible after TalkJS accepts a click. A second
// activation would be a new submission. The caller reconciles the outgoing bubble.
async function submit(button,{beforeActivate,check=()=>{},timeoutMs=15000}={}) {
  check();
  if (beforeActivate) await beforeActivate();
  check();
  await button.click({timeout:timeoutMs});
}
module.exports={submit};
