"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { VerifiedPayments } = require("../../minecraft/verified-payments");
const {
  ProofGenerator,
  verifyPack,
} = require("../../marketplace/proof-generator");

test("a rounded balance needs matching exact server metadata before it can authorize a debit", async () => {
  const pack = {
    ...require("../../minecraft/donutsmp-profile").profile(),
    timeoutMs: 100,
  };
  const verifier = new VerifiedPayments(pack),
    bot = new EventEmitter();
  bot.transport = "fabric";
  let hover = "1000432";
  bot.chat = () =>
    queueMicrotask(() =>
      bot.emit(
        "messagestr",
        "You have $ 1M",
        "system",
        { fabricBalanceHover: hover },
        null,
      ),
    );
  assert.equal(await verifier.readBalance(bot), 1000432n);
  hover = "19000432";
  await assert.rejects(verifier.readBalance(bot), /abbreviated sender balance/);
  hover = null;
  await assert.rejects(verifier.readBalance(bot), /abbreviated sender balance/);
});
test("the signed delivery pack contains the original order-specific PNG and rejects swapped proofs", async () => {
  const old = process.cwd(),
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autosell-proof-"));
  try {
    process.chdir(tmp);
    fs.mkdirSync("data/captures", { recursive: true });
    const {PNG}=require('pngjs');
    // Synthetic checkerboard fixture exercises exact pixel identity, not game authenticity.
    const frame = new PNG({width:200,height:120});
    for (let i=0; i<frame.data.length; i+=4) {
      frame.data.fill((i/4)%3===0?220:35,i,i+3);
      frame.data[i+3]=255;
    }
    const bytes = PNG.sync.write(frame);
    const file = path.resolve("data/captures/fixture.png");
    fs.writeFileSync(file, bytes);
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const generator = new ProofGenerator(undefined, {
      signingKey: privateKey,
      renderPages: false,
    });
    const source = {
      file,
      reference: "fixture-order",
      name: "fixture.png",
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
    const line = {id:crypto.randomUUID(),text:'You paid Fixture $ 5K'};
    source.receipt={version:1,orderId:source.reference,frameWidth:200,frameHeight:120,x:5,y:70,width:120,height:10,
      lines:[{...line,boxes:[[5,70,125,80]]}]};
    const payload = {
      orderId: "fixture-order",
      buyerIgn: "Fixture",
      amount: "5000",
      screenshots: [source],
      chunks: [{order_id:source.reference,state:'PAY_VERIFIED',amount:'5000',command_amount:'5000',result:JSON.stringify({
        verified:true,signal:{recipient:'Fixture',amount:'5000',capture:{raw:line.text,fabricReceiptId:line.id,position:'system',sender:null,command:'/pay Fixture 5000'}}
      })}],
      history: [],
    };
    const proof = await generator.generateDeliveryProof(payload);
    assert.equal(proof.screenshotCaptured, true);
    assert.deepEqual(
      fs.readFileSync(path.join(proof.directory, proof.screenshotName)),
      bytes,
    );
    assert.equal(
      verifyPack(proof.directory, publicKey).artifacts[proof.screenshotName],
      source.sha256,
    );
    const original=PNG.sync.read(bytes),crop=PNG.sync.read(fs.readFileSync(path.join(proof.directory,proof.chatImage)));
    assert.equal(crop.width,120);
    assert.equal(crop.height,10);
    for(let row=0;row<crop.height;row++)assert.deepEqual(crop.data.subarray(row*crop.width*4,(row+1)*crop.width*4),
      original.data.subarray(((70+row)*original.width+5)*4,((70+row)*original.width+125)*4));
    await assert.rejects(generator.generateDeliveryProof({...payload,screenshots:[{...source,receipt:undefined}]}),/missing verified render geometry/);
    const uploads=[];
    const fulfillment=new(require('../../marketplace/browser/fulfillment').BrowserFulfillment)({
      gameBridge:{},vault:{retrieve:async()=>privateKey.export({type:'pkcs8',format:'pem'})},settings:{get:async()=>({autoSend:true})},
      deliveryService:{repo:{get:()=>({account_id:'seller1'}),chunks:()=>payload.chunks}},
      browserBridge:{sendOrderMessageObserved:async()=>({}),uploadOrderEvidenceObserved:async(_order,file)=>uploads.push(path.basename(file))}
    });
    fulfillment.authorize=async()=>{};
    const deliveryOrder={id:payload.orderId,amount:payload.amount,buyerIgn:payload.buyerIgn,browserOrder:{id:payload.orderId},browserBinding:{sellerHref:'seller'}};
    await fulfillment.uploadEvidence(deliveryOrder,proof);
    assert.deepEqual(uploads,[proof.chatImage]);
    await assert.rejects(fulfillment.uploadEvidence(deliveryOrder,{...proof,chatImage:null}),/cropped receipt is required/);
    await assert.rejects(fulfillment.uploadEvidence({...deliveryOrder,buyerIgn:'Different'},proof),/different order or recipient/);
    await assert.rejects(
      generator.generateDeliveryProof({
        ...payload,
        orderId: "different-order",
      }),
      /reference does not match/,
    );
    fs.appendFileSync(
      path.join(proof.directory, proof.screenshotName),
      "unexpected",
    );
    assert.throws(
      () => verifyPack(proof.directory, publicKey),
      /hash mismatch/,
    );
  } finally {
    process.chdir(old);
    if (
      path.dirname(tmp) === os.tmpdir() &&
      path.basename(tmp).startsWith("autosell-proof-")
    )
      fs.rmSync(tmp, { recursive: true });
  }
});
