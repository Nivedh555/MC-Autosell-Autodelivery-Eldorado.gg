'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const {FairBatch}=require('../../marketplace/fair-batch');
test('all 100 waiting conversations receive bounded turns even when input ordering changes',()=>{
 const queue=new FairBatch(),rows=Array.from({length:100},(_,i)=>({id:'order'+String(i).padStart(3,'0')})),seen=new Set();
 for(let cycle=0;cycle<25;cycle++){const batch=queue.take(cycle%2?[...rows].reverse():rows,4);assert.equal(batch.length,4);batch.forEach(row=>seen.add(row.id));}
 assert.equal(seen.size,100);assert.deepEqual(queue.take(rows,0),[]);
 assert.equal(queue.take([rows[0],rows[0]],4).length,1);assert.deepEqual(queue.take([],4),[]);
});
