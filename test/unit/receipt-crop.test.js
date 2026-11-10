'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {PNG} = require('pngjs');
const {cropReceipt,receiptSpec} = require('../../marketplace/receipt-crop');
test('customer receipt is enlarged with exact captured pixels and no padded canvas',()=>{
  const source=new PNG({width:214,height:18});for(let i=0;i<source.data.length;i++)source.data[i]=i%256;
  const {bytes,presentation}=require('../../marketplace/receipt-crop').presentReceipt(PNG.sync.write(source));
  const output=PNG.sync.read(bytes);assert.equal(presentation.scale,3);assert.equal(output.width,642);assert.equal(output.height,54);
  for(let y=0;y<output.height;y++)for(let x=0;x<output.width;x++){
    const a=(y*output.width+x)*4,b=(Math.floor(y/3)*source.width+Math.floor(x/3))*4;
    assert.deepEqual(output.data.subarray(a,a+4),source.data.subarray(b,b+4));
  }
});

test('three chunked receipts require three separately verified rendered messages at multiple framebuffer sizes', () => {
  const order = {id:'chunked-order',buyerIgn:'.Sample',amount:'212000000'};
  const chunks = ['100000000','100000000','12000000'].map(amount => ({
    order_id:order.id, state:'PAY_VERIFIED', amount, command_amount:amount,
    result:{verified:true,signal:{recipient:order.buyerIgn,amount,capture:{fabricReceiptId:randomUUID(),
      raw:'You paid .Sample $ '+(BigInt(amount)/1000000n)+'M',command:'/pay .Sample '+amount,position:'system',sender:null}}}
  }));
  const spec=receiptSpec(order,chunks);
  for (const [scale,fw,fh,x,y] of [[1,320,180,4,69],[2,853,480,25,279],[3,1000,750,50,382]]) {
    const frame=new PNG({width:fw,height:fh});
    const width=125*scale, height=45*scale;
    const observed=spec.lines.map((line,i)=>{
      const y0=y+18*scale*i,y1=y0+9*scale;
      for(let py=y0;py<y1;py++)for(let px=x;px<x+width;px++) {
        const offset=(py*fw+px)*4;
        frame.data.fill(px%3===0?250:12,offset,offset+3);
        frame.data[offset+3]=255;
      }
      return {...line,boxes:[[x,y0,x+width,y1]]};
    });
    const receipt={version:1,orderId:order.id,frameWidth:fw,frameHeight:fh,x,y,width,height,lines:observed};
    const data=PNG.sync.write(frame);
    const crop=PNG.sync.read(cropReceipt(data,receipt,spec));
    assert.equal(crop.width,width);assert.equal(crop.height,height);
    assert.throws(()=>cropReceipt(data,{...receipt,lines:observed.slice(0,2)},spec),/verified render geometry/);
    assert.throws(()=>cropReceipt(data,{...receipt,lines:[observed[1],observed[0],observed[2]]},spec),/verified render geometry/);
    assert.throws(()=>cropReceipt(data,{...receipt,width:width+3},spec),/outside the verified text/);
    assert.throws(()=>cropReceipt(data,{...receipt,x:fw},spec),/bounds/);
    assert.throws(()=>cropReceipt(data,{...receipt,lines:[{...observed[0],boxes:[[x,y+10*scale,x+width,y+12*scale]]},...observed.slice(1)]},spec),/contrast/);
  }
  const repeated=structuredClone(chunks);
  repeated[1].result.signal.capture.fabricReceiptId=repeated[0].result.signal.capture.fabricReceiptId;
  assert.throws(()=>receiptSpec(order,repeated),/distinct Fabric receipt identity/);
  assert.throws(()=>receiptSpec(order,chunks.slice(1)),/full verified order amount/);
  assert.throws(()=>receiptSpec({...order,buyerIgn:'.Different'},chunks),/distinct Fabric receipt identity/);
});
