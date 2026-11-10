"use strict";
const services = require("../services");
async function collect(order) {
  const client = services.mcBot,
    status = require("../discord/seller-status");
  if (!client?.isOnline())
    return { success: false, reason: "The intake Minecraft client is offline" };
  let accepting = false;
  try {
    if ((client.snapshot.inventory || []).some((item) => item.count > 0))
      throw Error("Empty the intake inventory before accepting a sale");
    await status.post(
      order.id,
      "Your turn. Accept the in-game teleport request, then wait for the drop instruction.",
    );
    await services.gameBridge.request(client.accountId, "command", {
      command: "/tpa " + order.sellerUsername,
    });
    await services.gameBridge.request(
      client.accountId,
      "collect",
      { phase: "prepare", ign: order.sellerUsername, count: order.requested },
      60000,
    );
    accepting = true;
    await status.post(
      order.id,
      "Drop exactly " +
        order.requested +
        " skeleton spawners at the bot’s feet. Keep other players and items away.",
    );
    const received = await services.gameBridge.request(
      client.accountId,
      "collect",
      { phase: "receive", ign: order.sellerUsername, count: order.requested },
      60000,
    );
    if (received.count !== order.requested || received.verified !== true)
      throw Error("Received item count or type did not match the sale");
    await status.post(
      order.id,
      "Received your spawners. Securing them before sending Litecoin.",
    );
    await client.goHome();
    const stored = await client.syncAndDepositEnderChest();
    if (!stored.success || stored.depositedCount !== order.requested)
      throw Error("Storage custody did not match the collected items");
    return { success: true, count: order.requested };
  } catch (error) {
    return {
      success: false,
      needsReview: accepting,
      reason:
        error.message +
        (accepting
          ? " Do not drop more items; this sale needs operator reconciliation."
          : " Do not drop any items."),
    };
  }
}
module.exports = { collect };
