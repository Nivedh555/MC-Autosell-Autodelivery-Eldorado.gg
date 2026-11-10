'use strict';
const services = require('../services');
module.exports = async function ownerWithdrawal(req, res) {
  try {
    const { WithdrawalService } = require('../payments/withdrawal-service');
    res.json(await new WithdrawalService(services).send(req.body || {}));
  } catch (error) {
    res.status(error.receipt ? 409 : 400).json(error.receipt || { success: false, error: error.message });
  }
};
