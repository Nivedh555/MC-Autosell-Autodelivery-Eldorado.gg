'use strict';
                                                                            
                                                                               
function monitoring(database,listing,now=Date.now()){
 const db=database.raw(),seller=listing.observedSellerHref||listing.apiBinding?.sellerHref;
 if(!seller)return null;
 const scope=seller;
 let row=db.prepare('SELECT * FROM marketplace_monitoring WHERE scope=?').get(scope);
 if(!row){
  const key=require('./seller-protocol').bindingKey(listing.apiBinding);
  const generation=key?db.prepare('SELECT min(created_ms) started FROM automatic_offer_runs WHERE template_id=?').get(key)?.started:null;
                                                                              
                                                                             
  const since=Number.isSafeInteger(generation)&&generation>0?Math.min(generation,now):now;
  db.prepare('INSERT OR IGNORE INTO marketplace_monitoring(scope,seller_href,since_ms) VALUES(?,?,?)').run(scope,seller,since);
  row=db.prepare('SELECT * FROM marketplace_monitoring WHERE scope=?').get(scope);
 }
 return {scope,sellerHref:row.seller_href,sinceMs:row.since_ms,scanState:JSON.parse(row.scan_state)};
}
function withinMonitoring(order,monitor){
 if(!monitor)return true;
 const time=Date.parse(order.orderedAt||order.createdDate||'');
 return Number.isFinite(time)?time>=monitor.sinceMs:(order.first_ms??Date.now())>=monitor.sinceMs;
}
module.exports={monitoring,withinMonitoring};
