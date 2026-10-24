'use strict';

const { MetadataClientError, text } = require('./protocol');

/** Port for a completed OHF read of cluster 0x0039 / attribute 0x0012. */
function ohfEndpointIdentity({ nodeId, endpointId, uniqueId } = {}) {
  // Node IDs are strings to preserve all 64 bits through Qt/JSON transports.
  if (!text(nodeId, 128) || !Number.isInteger(endpointId) || endpointId < 0 || endpointId > 65535
    || (uniqueId !== null && uniqueId !== undefined && !text(uniqueId))) {
    throw new MetadataClientError('invalid_controller_endpoint');
  }
  return { id: JSON.stringify([nodeId, endpointId]), uniqueId: uniqueId ?? null };
}

module.exports = { ohfEndpointIdentity };
