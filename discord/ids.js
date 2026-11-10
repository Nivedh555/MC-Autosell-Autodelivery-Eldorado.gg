'use strict';
function isSnowflake(value) {
  return typeof value === 'string' && /^\d{15,20}$/.test(value) && BigInt(value) > 0n && BigInt(value) <= 18446744073709551615n;
}
module.exports = { isSnowflake };
