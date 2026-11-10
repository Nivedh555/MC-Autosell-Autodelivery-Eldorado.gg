"use strict";
module.exports =
  process.env.AUTOSELL_GAME_TRANSPORT === "fabric"
    ? require("./fabric-client")
    : require("../minecraft/account-client");
