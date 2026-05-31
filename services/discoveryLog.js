const crypto = require('crypto');

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

function createDiscoveryTrace() {
  return { traceId: crypto.randomBytes(4).toString('hex') };
}

/**
 * Human-readable step log + JSON payload for grep-friendly debugging.
 */
function logPipelineStep(traceId, stepIndex, totalSteps, phase, details = {}) {
  const safe = { traceId, phase, ...details };
  for (const k of Object.keys(safe)) {
    if (safe[k] === undefined) delete safe[k];
  }

  const parts = [
    `STEP ${stepIndex}/${totalSteps}`,
    phase,
    traceId ? `trace=${traceId}` : null,
    safe.method && safe.path ? `${safe.method} ${safe.path}` : safe.path || null,
    safe.actionId ? `action=${safe.actionId}` : null,
    safe.jobId ? `jobId=${safe.jobId}` : null,
    safe.durationMs != null ? `${safe.durationMs}ms` : null,
    safe.status || null,
    safe.resultCount != null ? `results=${safe.resultCount}` : null,
    safe.platform || null,
  ].filter(Boolean);

  console.log('[discovery]', parts.join(' | '));
  logDiscovery('pipeline_step', safe);
}

module.exports = {
  logDiscovery,
  createDiscoveryTrace,
  logPipelineStep,
};
