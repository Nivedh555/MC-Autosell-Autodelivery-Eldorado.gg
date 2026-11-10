"use strict";
const { Router } = require("express");
const { asyncHandler, requireReauth } = require("../api/middleware");
const { MinecraftOnboarding } = require("./minecraft-onboarding");

module.exports = function onboardingRoutes(services, options) {
  const router = Router();
  const onboarding = new MinecraftOnboarding(services, options);
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/", asyncHandler(async (_req, res) => res.json(await onboarding.status())));
  router.post("/root", requireReauth, asyncHandler(async (req, res) => res.json(await onboarding.registerRoot(req.body.path))));
  router.post("/install", requireReauth, asyncHandler(async (req, res) => res.json(await onboarding.install(req.body))));
  router.use((error, _req, res, _next) => {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    const errors = { ENOENT: "The selected folder or packaged mod is missing. Open Prism and refresh the detected folders.",
      EACCES: "Autosell cannot write to this Prism folder. Choose a folder owned by your Windows or Linux user.",
      EPERM: "Close Minecraft and check permission to write in the selected Prism folder.",
      EEXIST: "A file appeared during setup. Refresh and retry with Minecraft closed." };
    res.status(500).json({ error: errors[error.code] || "Minecraft setup could not finish. Close the game and refresh. Already installed files can be reused when you retry." });
  });
  return router;
};
