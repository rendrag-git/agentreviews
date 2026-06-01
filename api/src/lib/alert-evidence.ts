const PRIVATE_EVIDENCE_KEYS = new Set([
  'conn_fp',
  'suspect_review_ids',
  'suspect_action_ids',
  'target_agent_id',
  'target_agent_ids',
  'venue_id',
  'venue_ids',
]);

export function parseAlertEvidence(evidenceJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(evidenceJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function redactAlertEvidence(evidence: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (PRIVATE_EVIDENCE_KEYS.has(key)) continue;
    redacted[key] = redactNestedEvidence(value);
  }
  return redacted;
}

function redactNestedEvidence(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactNestedEvidence);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return redactAlertEvidence(value as Record<string, unknown>);
}
