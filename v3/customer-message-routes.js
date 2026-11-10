"use strict";
const router = require("express").Router(),
  s = require("../services");
const { requireReauth } = require("../api/middleware");
const config = () =>
  new (require("../marketplace/customer-message-config").CustomerMessageConfig)(
    s.db,
  );
const run = (fn) => (req, res, next) => {
  try {
    res.json(fn(req));
  } catch (error) {
    if ([400, 409].includes(error.status))
      res.status(error.status).json({ error: error.message });
    else next(error);
  }
};
router.get(
  "/",
  run(() => config().snapshot()),
);
router.use(requireReauth);
router.put(
  "/guides",
  run((req) => config().guides(req.body)),
);
router.put(
  "/:event",
  run((req) => config().save(req.params.event, req.body)),
);
router.post(
  "/:event/reset",
  run((req) => config().reset(req.params.event, req.body.revision)),
);
module.exports = router;
