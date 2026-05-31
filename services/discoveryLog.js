/**
 * Structured discovery logs. Never pass API keys or full prompts here.
 */
function logDiscovery(event, fields) {
  const payload = { ...fields };
  for (const k of Object.keys(payload)) {
    if (payload[k] === undefined) delete payload[k];
  }
  console.log('[discovery]', event, JSON.stringify(payload));
}

module.exports = { logDiscovery };
