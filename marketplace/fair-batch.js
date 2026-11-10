'use strict';
// Stable ordering plus a cursor prevents waiting buyers from monopolizing every
// browser cycle. Durable orders remain in SQLite; this cursor only schedules reads.
class FairBatch {
 constructor(){this.cursor=null;}
 take(items,limit=4){
  const rows=[...new Map(items.map(row=>[row.id,row])).values()].sort((a,b)=>a.id.localeCompare(b.id));
  if(!rows.length||limit<1)return [];
  let start=this.cursor?rows.findIndex(row=>row.id.localeCompare(this.cursor)>0):0;if(start<0)start=0;
  const selected=Array.from({length:Math.min(limit,rows.length)},(_,i)=>rows[(start+i)%rows.length]);
  this.cursor=selected.at(-1).id;return selected;
 }
}
module.exports={FairBatch};
