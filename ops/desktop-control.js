"use strict";
const crypto = require("node:crypto");
function tokenGuard(env = process.env) {
  if (env.AUTOSELL_DESKTOP !== "1") return (_req, _res, next) => next();
  const token = env.AUTOSELL_DESKTOP_TOKEN;
  if (typeof token !== "string" || token.length < 32 || token.length > 256)
    throw Error("Desktop session token missing");
  const expected = Buffer.from(token);
  return (req, res, next) => {
    const supplied = Buffer.from(
      String(req.headers["x-autosell-desktop"] || ""),
    );
    if (
      supplied.length !== expected.length ||
      !crypto.timingSafeEqual(supplied, expected)
    )
      return res
        .status(403)
        .json({ error: "This dashboard belongs to the desktop application" });
    next();
  };
}
function attach(services, channel = process) {
  let busy = false;
  const listener = async (message) => {
    if (
      !message ||
      message.type !== "control" ||
      typeof message.id !== "string" ||
      !/^[A-Za-z0-9:_-]{1,100}$/.test(message.id)
    )
      return;
    const reply = (value) =>
      channel.send?.({ type: "result", id: message.id, ...value });
    if (
      !["maintenance", "status", "resume", "shutdown"].includes(message.action)
    )
      return reply({ safe: false, reason: "Unknown control action" });
    if (busy)
      return reply({
        safe: false,
        reason: "Another desktop operation is finishing",
      });
    busy = true;
    try {
      let result;
      if (message.action === "maintenance")
        result = services.maintenance.begin(message.targetVersion ?? null);
      else if (message.action === "resume")
        result = services.maintenance.resume();
      else result = services.maintenance.status();
      reply(result);
      if (message.action === "shutdown" && result.safe)
        await services.shutdown("DESKTOP");
    } catch (error) {
      reply({ safe: false, reason: error.message });
    } finally {
      busy = false;
    }
  };
  channel.on("message", listener);
  return () => channel.removeListener("message", listener);
}
module.exports = { tokenGuard, attach };
