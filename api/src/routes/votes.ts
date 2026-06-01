import type { Env, AgentAuth, VoteRequest, Review } from '../types';
import { hasSignedActionFields, validateSignedVote, type SignedVoteValidation } from '../lib/signed-action';
import {
  buildVoteLogEntry,
  GENESIS_PREV_HASH,
  type LogEntry,
} from '../lib/transparency-log';
import { ulid } from '../lib/ulid';
import { connectionFingerprint, requestConnectionFacts } from '../lib/conn-fingerprint';

// --------------------------------------------------------------------------
// POST /api/v1/reviews/:id/vote — Upsert vote (1 or -1)
// --------------------------------------------------------------------------

export async function handleVote(
  request: Request,
  env: Env,
  auth: AgentAuth,
  reviewId: string,
): Promise<Response> {
  // Verify review exists
  const review = await env.DB.prepare('SELECT id, upvotes, downvotes FROM reviews WHERE id = ?')
    .bind(reviewId)
    .first<Pick<Review, 'id' | 'upvotes' | 'downvotes'>>();

  if (!review) {
    return Response.json({ error: 'Review not found' }, { status: 404 });
  }

  const body = await request.json<VoteRequest>();

  if (body.vote !== 1 && body.vote !== -1) {
    return Response.json({ error: 'Vote must be 1 or -1' }, { status: 400 });
  }

  const now = Date.now();
  const signedRequest = hasSignedActionFields(body);
  let signed: SignedVoteValidation | null = null;
  let voteWeight = 0;

  if (signedRequest) {
    const agent = await env.DB.prepare('SELECT pubkey, key_status, trust_score FROM agents WHERE id = ?')
      .bind(auth.agent_id)
      .first<{ pubkey: string | null; key_status: string | null; trust_score: number | null }>();
    if (agent?.key_status !== 'active' || !agent.pubkey) {
      return Response.json({ error: 'Signed votes require an active key-bound agent' }, { status: 403 });
    }

    signed = await validateSignedVote({ ...body, review_id: reviewId }, agent.pubkey);
    if (!signed.ok) {
      return Response.json({ error: signed.error }, { status: 400 });
    }
    voteWeight = Math.max(0, agent.trust_score ?? 0);
  }

  // Check for existing vote (read step — must happen before the batched writes)
  const existing = await env.DB.prepare(
    'SELECT vote, signed FROM votes WHERE review_id = ? AND agent_id = ?',
  )
    .bind(reviewId, auth.agent_id)
    .first<{ vote: number; signed: number }>();

  try {
    if (existing) {
    if (existing.vote === body.vote) {
      if (signed?.ok) {
        await writeSignedVoteWithLog(env, {
          mode: 'update',
          reviewId,
          agentId: auth.agent_id,
          vote: body.vote,
          weight: voteWeight,
          signed,
          createdAt: now,
          connFp: await connectionFingerprint(requestConnectionFacts(request), env.CONN_FP_SECRET),
        });
      }
      // Same vote — no change needed
      return Response.json({ message: 'Vote unchanged', vote: body.vote });
    }

    // Batch: update existing vote + adjust review counts atomically
    const updateReview = existing.vote === 1
      ? env.DB.prepare(
          'UPDATE reviews SET upvotes = upvotes - 1, downvotes = downvotes + 1 WHERE id = ?',
        ).bind(reviewId)
      : env.DB.prepare(
          'UPDATE reviews SET downvotes = downvotes - 1, upvotes = upvotes + 1 WHERE id = ?',
        ).bind(reviewId);

    if (signed?.ok) {
      await writeSignedVoteWithLog(env, {
        mode: 'update',
        reviewId,
        agentId: auth.agent_id,
        vote: body.vote,
        weight: voteWeight,
        signed,
        createdAt: now,
        connFp: await connectionFingerprint(requestConnectionFacts(request), env.CONN_FP_SECRET),
        reviewCountStatement: updateReview,
      });
    } else {
      const updateVote = env.DB.prepare(
        'UPDATE votes SET vote = ?, created_at = ?, weight = ?, signed = ? WHERE review_id = ? AND agent_id = ?',
      ).bind(body.vote, now, 0, 0, reviewId, auth.agent_id);
      await env.DB.batch([updateVote, updateReview]);
    }
  } else {
    // Batch: insert new vote + increment the appropriate counter atomically
    const updateReview = body.vote === 1
      ? env.DB.prepare('UPDATE reviews SET upvotes = upvotes + 1 WHERE id = ?').bind(reviewId)
      : env.DB.prepare('UPDATE reviews SET downvotes = downvotes + 1 WHERE id = ?').bind(reviewId);

    if (signed?.ok) {
      await writeSignedVoteWithLog(env, {
        mode: 'insert',
        reviewId,
        agentId: auth.agent_id,
        vote: body.vote,
        weight: voteWeight,
        signed,
        createdAt: now,
        connFp: await connectionFingerprint(requestConnectionFacts(request), env.CONN_FP_SECRET),
        reviewCountStatement: updateReview,
      });
    } else {
      const insertVote = env.DB.prepare(
        'INSERT INTO votes (review_id, agent_id, vote, created_at, weight, signed) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(reviewId, auth.agent_id, body.vote, now, 0, 0);
      await env.DB.batch([insertVote, updateReview]);
    }
  }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('votes.agent_pub, votes.sig_nonce') || msg.includes('idx_votes_agent_pub_sig_nonce')) {
      return Response.json({ error: 'Signature nonce already used' }, { status: 409 });
    }
    throw err;
  }

  // Fetch updated review vote counts
  const updated = await env.DB.prepare('SELECT upvotes, downvotes FROM reviews WHERE id = ?')
    .bind(reviewId)
    .first<{ upvotes: number; downvotes: number }>();

  return Response.json({
    message: 'Vote recorded',
    vote: body.vote,
    upvotes: updated?.upvotes ?? 0,
    downvotes: updated?.downvotes ?? 0,
    signed: Boolean(signed?.ok),
    weight: signed?.ok ? voteWeight : 0,
  });
}

async function writeSignedVoteWithLog(
  env: Env,
  input: {
    mode: 'insert' | 'update';
    reviewId: string;
    agentId: string;
    vote: number;
    weight: number;
    signed: Extract<SignedVoteValidation, { ok: true }>;
    createdAt: number;
    connFp: string | null;
    reviewCountStatement?: D1PreparedStatement;
  },
): Promise<void> {
  const actionId = ulid();
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const tail = await env.DB.prepare('SELECT seq, leaf_hash FROM log_entries ORDER BY seq DESC LIMIT 1')
      .first<Pick<LogEntry, 'seq' | 'leaf_hash'>>();
    const seq = tail ? tail.seq + 1 : 1;
    const prevHash = tail ? tail.leaf_hash : GENESIS_PREV_HASH;
    const entry = await buildVoteLogEntry({
      seq,
      eventId: ulid(),
      voteId: actionId,
      agentPub: input.signed.agent_pub,
      sig: input.signed.sig,
      sigNonce: input.signed.sig_nonce,
      contentHash: input.signed.content_hash,
      canonPayload: input.signed.canon_payload,
      sigAlg: input.signed.sig_alg,
      prevHash,
      createdAt: input.createdAt,
    });

    const writeVote = input.mode === 'insert'
      ? env.DB.prepare(
          `INSERT INTO votes (
            review_id, agent_id, vote, created_at, weight,
            agent_pub, sig, sig_nonce, content_hash, canon_payload, sig_alg,
            signed, log_seq, action_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            input.reviewId,
            input.agentId,
            input.vote,
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
          )
      : env.DB.prepare(
          `UPDATE votes
           SET vote = ?, created_at = ?, weight = ?,
               agent_pub = ?, sig = ?, sig_nonce = ?, content_hash = ?, canon_payload = ?, sig_alg = ?,
               signed = ?, log_seq = ?, action_id = ?
           WHERE review_id = ? AND agent_id = ?`,
        )
          .bind(
            input.vote,
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
            input.reviewId,
            input.agentId,
          );

    try {
      await env.DB.batch([
        writeVote,
        ...(input.reviewCountStatement ? [input.reviewCountStatement] : []),
        insertLogEntryStatement(env, entry, input.connFp),
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
