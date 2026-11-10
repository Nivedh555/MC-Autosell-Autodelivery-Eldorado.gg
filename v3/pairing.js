"use strict";

function validatePairing(services, accountId, ign) {
  if (!/^(buyer|seller)[1-9][0-9]?$/.test(accountId) || !/^\.?[A-Za-z0-9_]{3,16}$/.test(ign))
    throw Error("Choose an account slot and enter the exact Minecraft IGN");
  const index = Number(accountId.match(/\d+$/)[0]);
  const role = accountId.startsWith("buyer") ? "buyer" : "seller";
  const pair = services.pairsRepo.getPairByIndex(index);
  if (!pair) throw Error("Create this account pair in AutoSell Pairs first");
  require("../treasury/trading-controls").assertEditable(pair);
  return { pair, index, role };
}
async function configurePairing(services, accountId, ign, { reuseExisting = false } = {}) {
  const { pair, index, role } = validatePairing(services, accountId, ign);
  let config = reuseExisting && await services.gameBridge.existingPairing(accountId, ign);
  if (!config) config = await services.gameBridge.pair(accountId, ign);
  services.pairsRepo.savePair({ ...pair, [role + "Ign"]: ign, disabled: false });
  const roles = await services.settings.get("treasury.accountRoles") || {};
  roles[accountId] = { ...roles[accountId], role: role === "buyer" ? "intake" : "holder", ign };
  const buyer = "buyer" + index;
  if (roles[buyer]) roles[buyer].holderAccount = role === "seller" || pair.sellerIgn ? "seller" + index : buyer;
  await services.settings.set("treasury.accountRoles", roles, "v3-pairing");
  return config;
}

module.exports = { configurePairing, validatePairing };
