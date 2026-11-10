'use strict';
                                                                            
function connectionRecord(bot, accountId, client) {
  const socket = bot?._client?.socket;
  const status = client?.getStatus?.();
  const field = value => typeof value === 'string' && value.length <= 500 ? value : null;
  return {
    accountId: field(accountId), holderIgn: field(bot?.username),
    requestedHost: field(status?.host || bot?._client?.options?.host), remoteAddress: field(socket?.remoteAddress),
    remotePort: Number.isInteger(socket?.remotePort) ? socket.remotePort : null,
    protocolVersion: field(bot?.version), serverBrand: field(bot?.game?.serverBrand),
    capturedAt: new Date().toISOString(), monotonicNs: process.hrtime.bigint().toString(),
    scope: 'Observed Minecraft client connection. Host, address and server-supplied brand are not third-party authentication or independent DonutSMP attestation.',
  };
}
module.exports = { connectionRecord };
