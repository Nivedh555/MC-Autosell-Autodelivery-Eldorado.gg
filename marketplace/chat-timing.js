'use strict';
                                                                              
function chatTiming(config = {}) {
  const fast = config.fastReplies !== false;
  const min = fast ? 0 : Math.max(0, config.typingMinMs ?? 5000);
  return {
    min, max: fast ? 0 : Math.max(min, config.typingMaxMs ?? 15000),
    interval: fast ? 0 : Math.max(1000, config.minIntervalMs ?? 8000),
    poll: fast ? Math.max(1000, Math.min(config.pollMs ?? 1000, 1000)) : config.pollMs,
  };
}
module.exports = { chatTiming };
