import type { AgentAuth, DisputeReviewRequest, Env } from '../types';
import { connectionFingerprint, requestConnectionFacts } from '../lib/conn-fingerprint';
import { buildMitigationClearLogEntries } from '../lib/mitigation-log';
import { hasSignedActionFields, validateSignedDispute, type SignedDisputeValidation } from '../lib/signed-action';
import {
  buildReviewDisputeLogEntry,
  GENESIS_PREV_HASH,
  type LogEntry,
} from '../lib/transparency-log';
import { ulid } from '../lib/ulid';

interface ReviewAuthorRow {
  id: string;
  agent_id: string;
}

interface ActiveMitigationRow {
  alert_id: string;
}

// --------------------------------------------------------------------------
// POST /api/v1/reviews/:id/dispute — Signed author dispute for L4 mitigations
// --------------------------------------------------------------------------

export async function handleDisputeReview(
  request: Request,
  env: Env,
  auth: AgentAuth,
  reviewId: string,
  now = Date.now(),
): Promise<Response> {
  const review = await env.DB.prepare('SELECT id, agent_id FROM reviews WHERE id = ?')
    .bind(reviewId)
    .first<ReviewAuthorRow>();
  if (!review) {
    return Response.json({ error: 'Review not found' }, { status: 404 });
  }
  if (review.agent_id !== auth.agent_id) {
    return Response.json({ error: 'Only the review author can dispute this review' }, { status: 403 });
  }

  const body = await request.json<DisputeReviewRequest>().catch(() => ({} as DisputeReviewRequest));
  if (!hasSignedActionFields(body)) {
    return Response.json({ error: 'Disputes require a signed review.dispute payload' }, { status: 400 });
  }
  if (!body.alert_id) {
    return Response.json({ error: 'Disputes require alert_id' }, { status: 400 });
  }

  const existing = await env.DB.prepare('SELECT id FROM review_disputes WHERE review_id = ? AND alert_id = ?')
    .bind(reviewId, body.alert_id)
    .first<{ id: string }>();
  if (existing) {
    return Response.json({ error: 'Review dispute already exists for this alert' }, { status: 409 });
  }

  const activeMitigation = await env.DB.prepare(
    `SELECT rm.alert_id
     FROM review_mitigations rm
     JOIN alerts a ON a.id = rm.alert_id
     WHERE rm.review_id = ?
       AND rm.cleared_at IS NULL
       AND a.status = ?
       AND a.cleared_at IS NULL
     ORDER BY rm.created_at DESC
     LIMIT 1`,
  )
    .bind(reviewId, 'open')
    .first<ActiveMitigationRow>();
  if (!activeMitigation) {
    return Response.json({ error: 'Review has no active alert mitigation to dispute' }, { status: 409 });
  }
  if (body.alert_id !== activeMitigation.alert_id) {
    return Response.json({ error: 'Dispute alert_id does not match the active review mitigation' }, { status: 400 });
  }

  const agent = await env.DB.prepare('SELECT pubkey, key_status FROM agents WHERE id = ?')
    .bind(auth.agent_id)
    .first<{ pubkey: string | null; key_status: string | null }>();
  if (agent?.key_status !== 'active' || !agent.pubkey) {
    return Response.json({ error: 'Disputes require an active key-bound agent' }, { status: 403 });
  }

  const reason = body.reason ?? '';
  const signed = await validateSignedDispute({
    ...body,
    review_id: reviewId,
    alert_id: activeMitigation.alert_id,
    reason,
  }, agent.pubkey);
  if (!signed.ok) {
    return Response.json({ error: signed.error }, { status: 400 });
  }

  const disputeId = disputeRowId(reviewId, activeMitigation.alert_id);
  try {
    await insertSignedDisputeWithLog(env, {
      disputeId,
      reviewId,
      alertId: activeMitigation.alert_id,
      agentId: auth.agent_id,
      reason,
      signed,
      createdAt: now,
      connFp: await connectionFingerprint(requestConnectionFacts(request), env.CONN_FP_SECRET),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('review_disputes.review_id, review_disputes.alert_id') ||
        msg.includes('idx_review_disputes_review_alert')) {
      return Response.json({ error: 'Review dispute already exists for this alert' }, { status: 409 });
    }
    if (msg.includes('review_disputes.agent_pub, review_disputes.sig_nonce') ||
        msg.includes('idx_review_disputes_agent_pub_sig_nonce')) {
      return Response.json({ error: 'Signature nonce already used' }, { status: 409 });
    }
    throw err;
  }

  return Response.json({
    dispute_id: disputeId,
    alert_id: activeMitigation.alert_id,
    status: 'disputed',
  }, { status: 201 });
}

async function insertSignedDisputeWithLog(
  env: Env,
  input: {
    disputeId: string;
    reviewId: string;
    alertId: string;
    agentId: string;
    reason: string;
    signed: Extract<SignedDisputeValidation, { ok: true }>;
    createdAt: number;
    connFp: string | null;
  },
): Promise<void> {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const tail = await env.DB.prepare('SELECT seq, leaf_hash FROM log_entries ORDER BY seq DESC LIMIT 1')
      .first<Pick<LogEntry, 'seq' | 'leaf_hash'>>();
    const seq = tail ? tail.seq + 1 : 1;
    const prevHash = tail ? tail.leaf_hash : GENESIS_PREV_HASH;
    const entry = await buildReviewDisputeLogEntry({
      seq,
      eventId: ulid(),
      disputeId: input.disputeId,
      agentPub: input.signed.agent_pub,
      sig: input.signed.sig,
      sigNonce: input.signed.sig_nonce,
      contentHash: input.signed.content_hash,
      canonPayload: input.signed.canon_payload,
      sigAlg: input.signed.sig_alg,
      prevHash,
      createdAt: input.createdAt,
    });
    const clearEntries = await buildMitigationClearLogEntries({
      env,
      mitigations: [{ review_id: input.reviewId, alert_id: input.alertId }],
      reason: input.reason,
      now: input.createdAt,
      startSeq: seq + 1,
      prevHash: entry.leaf_hash,
    });

    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO review_disputes (
             id, review_id, alert_id, agent_id, reason,
             agent_pub, sig, sig_nonce, content_hash, canon_payload, sig_alg,
             log_seq, created_at, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            input.disputeId,
            input.reviewId,
            input.alertId,
            input.agentId,
            input.reason,
            input.signed.agent_pub,
            input.signed.sig,
            input.signed.sig_nonce,
            input.signed.content_hash,
            input.signed.canon_payload,
            input.signed.sig_alg,
            seq,
            input.createdAt,
            'open',
          ),
        insertLogEntryStatement(env, entry, input.connFp),
        ...clearEntries.map((clearEntry) => insertLogEntryStatement(env, clearEntry, null)),
        env.DB.prepare(
          'UPDATE review_mitigations SET cleared_at = ? WHERE review_id = ? AND alert_id = ? AND cleared_at IS NULL',
        )
          .bind(input.createdAt, input.reviewId, input.alertId),
        env.DB.prepare('UPDATE alerts SET status = ?, cleared_at = ? WHERE id = ? AND status = ?')
          .bind('disputed', input.createdAt, input.alertId, 'open'),
      ]);
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const staleTail = msg.includes('UNIQUE constraint failed: log_entries.seq');
      if (staleTail && attempt < maxAttempts) continue;
      throw err;
    }
  }
}

function insertLogEntryStatement(env: Env, entry: LogEntry, connFp: string | null): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO log_entries (
      seq, event_id, event_type, object_type, object_id,
      agent_pub, sig, sig_nonce, content_hash, canon_payload, sig_alg,
      prev_hash, leaf_hash, created_at, conn_fp, leaf_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      entry.seq,
      entry.event_id,
      entry.event_type,
      entry.object_type,
      entry.object_id,
      entry.agent_pub,
      entry.sig,
      entry.sig_nonce,
      entry.content_hash,
      entry.canon_payload,
      entry.sig_alg,
      entry.prev_hash,
      entry.leaf_hash,
      entry.created_at,
      connFp,
      entry.leaf_version ?? 1,
    );
}

function disputeRowId(reviewId: string, alertId: string): string {
  return `dispute:${reviewId}:${alertId}`;
}
