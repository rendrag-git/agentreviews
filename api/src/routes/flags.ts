import type { Env, AgentAuth, FlagRequest } from '../types';
import { projectFlagModeration } from '../lib/moderation';
import { hasSignedActionFields, validateSignedFlag, type SignedFlagValidation } from '../lib/signed-action';
import {
  buildFlagLogEntry,
  GENESIS_PREV_HASH,
  type LogEntry,
} from '../lib/transparency-log';
import { ulid } from '../lib/ulid';

// --------------------------------------------------------------------------
// POST /api/v1/reviews/:id/flag — Flag a review
// --------------------------------------------------------------------------

export async function handleFlag(
  request: Request,
  env: Env,
  auth: AgentAuth,
  reviewId: string,
): Promise<Response> {
  // Verify review exists
  const review = await env.DB.prepare('SELECT id, flag_count FROM reviews WHERE id = ?')
    .bind(reviewId)
    .first<{ id: string; flag_count: number }>();

  if (!review) {
    return Response.json({ error: 'Review not found' }, { status: 404 });
  }

  const body = await request.json<FlagRequest>().catch(() => ({} as FlagRequest));
  const reason = body.reason ?? '';
  const signedRequest = hasSignedActionFields(body);
  const now = Date.now();
  let signed: SignedFlagValidation | null = null;
  let flagWeight = 0;

  if (signedRequest) {
    const agent = await env.DB.prepare('SELECT pubkey, key_status, trust_score FROM agents WHERE id = ?')
      .bind(auth.agent_id)
      .first<{ pubkey: string | null; key_status: string | null; trust_score: number | null }>();
    if (agent?.key_status !== 'active' || !agent.pubkey) {
      return Response.json({ error: 'Signed flags require an active key-bound agent' }, { status: 403 });
    }

    signed = await validateSignedFlag({ ...body, reason, review_id: reviewId }, agent.pubkey);
    if (!signed.ok) {
      return Response.json({ error: signed.error }, { status: 400 });
    }
    flagWeight = Math.max(0, agent.trust_score ?? 0);
  }

  // Insert flag row — PRIMARY KEY (review_id, agent_id) prevents duplicates
  try {
    if (signed?.ok) {
      await insertSignedFlagWithLog(env, {
        reviewId,
        agentId: auth.agent_id,
        reason,
        weight: flagWeight,
        signed,
        createdAt: now,
      });
    } else {
      await env.DB.prepare(
        `INSERT INTO flags (
          review_id, agent_id, reason, created_at, weight, signed
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(reviewId, auth.agent_id, reason, now, 0, 0)
        .run();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('flags.agent_pub, flags.sig_nonce') || msg.includes('idx_flags_agent_pub_sig_nonce')) {
      return Response.json({ error: 'Signature nonce already used' }, { status: 409 });
    }
    if (msg.includes('UNIQUE constraint failed') || msg.includes('PRIMARY KEY')) {
      return Response.json({ error: 'Already flagged' }, { status: 409 });
    }
    throw err;
  }

  const weights = await env.DB.prepare(
    'SELECT weight FROM flags WHERE review_id = ? AND signed = 1',
  )
    .bind(reviewId)
    .all<{ weight: number }>();
  const projection = projectFlagModeration((weights.results || []).map((row) => row.weight));

  const newFlagCount = review.flag_count + 1;
  await env.DB.prepare(
    `UPDATE reviews
     SET flag_count = ?,
         flag_pressure = ?,
         moderation_state = ?,
         moderation_updated_at = ?
     WHERE id = ?`,
  )
    .bind(newFlagCount, projection.flag_pressure, projection.moderation_state, now, reviewId)
    .run();

  return Response.json({
    message: 'Review flagged',
    flag_count: newFlagCount,
    flag_pressure: projection.flag_pressure,
    moderation_state: projection.moderation_state,
    hidden: projection.moderation_state !== 'visible',
    ...(projection.moderation_state !== 'visible' ? { note: 'Review is now soft-hidden by trust-weighted flag pressure' } : {}),
  });
}

async function insertSignedFlagWithLog(
  env: Env,
  input: {
    reviewId: string;
    agentId: string;
    reason: string;
    weight: number;
    signed: Extract<SignedFlagValidation, { ok: true }>;
    createdAt: number;
  },
): Promise<void> {
  const actionId = ulid();
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const tail = await env.DB.prepare('SELECT seq, leaf_hash FROM log_entries ORDER BY seq DESC LIMIT 1')
      .first<Pick<LogEntry, 'seq' | 'leaf_hash'>>();
    const seq = tail ? tail.seq + 1 : 1;
    const prevHash = tail ? tail.leaf_hash : GENESIS_PREV_HASH;
    const entry = await buildFlagLogEntry({
      seq,
      eventId: ulid(),
      flagId: actionId,
      agentPub: input.signed.agent_pub,
      sig: input.signed.sig,
      sigNonce: input.signed.sig_nonce,
      contentHash: input.signed.content_hash,
      canonPayload: input.signed.canon_payload,
      sigAlg: input.signed.sig_alg,
      prevHash,
      createdAt: input.createdAt,
    });

    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO flags (
            review_id, agent_id, reason, created_at, weight,
            agent_pub, sig, sig_nonce, content_hash, canon_payload, sig_alg,
            signed, log_seq, action_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            input.reviewId,
            input.agentId,
            input.reason,
            input.createdAt,
            input.weight,
            input.signed.agent_pub,
            input.signed.sig,
            input.signed.sig_nonce,
            input.signed.content_hash,
            input.signed.canon_payload,
            input.signed.sig_alg,
            1,
            seq,
            actionId,
          ),
        insertLogEntryStatement(env, entry),
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

function insertLogEntryStatement(env: Env, entry: LogEntry): D1PreparedStatement {
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
      null,
      entry.leaf_version ?? 1,
    );
}
