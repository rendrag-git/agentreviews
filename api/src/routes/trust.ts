import type { AgentAuth, Env } from '../types';
import { ulid } from '../lib/ulid';
import { validateSignedVouch } from '../lib/signed-vouch';
import { vouchBudget } from '../lib/trust-graph';
import { planTrustMaterialization } from '../lib/trust-recompute';
import {
  buildVouchLogEntry,
  GENESIS_PREV_HASH,
  type LogEntry,
} from '../lib/transparency-log';
import { connectionFingerprint, requestConnectionFacts } from '../lib/conn-fingerprint';

interface VouchRequest {
  weight?: number;
  agent_pub?: string;
  sig?: string;
  sig_nonce?: string;
  content_hash?: string;
  canon_payload?: string;
  sig_alg?: string;
}

interface AgentTrustRow {
  id: string;
  pubkey: string | null;
  key_status: string | null;
  earned_trust: number | null;
}

export async function handlePostVouch(
  request: Request,
  env: Env,
  auth: AgentAuth,
  targetFingerprint: string,
): Promise<Response> {
  const [voucher, vouchee] = await Promise.all([
    env.DB.prepare('SELECT id, pubkey, key_status, earned_trust FROM agents WHERE id = ?')
      .bind(auth.agent_id)
      .first<AgentTrustRow>(),
    env.DB.prepare('SELECT id FROM agents WHERE fingerprint = ? AND key_status = ?')
      .bind(targetFingerprint, 'active')
      .first<{ id: string }>(),
  ]);

  if (!voucher) {
    return Response.json({ error: 'Agent not registered' }, { status: 403 });
  }
  if (voucher.key_status !== 'active' || !voucher.pubkey) {
    return Response.json({ error: 'Signed vouches require an active key-bound agent' }, { status: 403 });
  }
  if (!vouchee) {
    return Response.json({ error: 'Target agent not found' }, { status: 404 });
  }
  if (voucher.id === vouchee.id) {
    return Response.json({ error: 'Agents cannot vouch for themselves' }, { status: 400 });
  }

  const body = await request.json<VouchRequest>();
  const weight = body.weight ?? 1;
  if (!Number.isFinite(weight) || weight <= 0) {
    return Response.json({ error: 'Vouch weight must be positive' }, { status: 400 });
  }

  const signed = await validateSignedVouch(
    {
      ...body,
      voucher_id: voucher.id,
      vouchee_id: vouchee.id,
      weight,
    },
    voucher.pubkey,
  );
  if (!signed.ok) {
    return Response.json({ error: signed.error }, { status: 400 });
  }

  const activeCount = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM vouches WHERE voucher_id = ? AND revoked_at IS NULL',
  )
    .bind(voucher.id)
    .first<{ count: number }>();
  const budget = vouchBudget(voucher.earned_trust ?? 0);
  if ((activeCount?.count ?? 0) >= budget) {
    return Response.json({ error: 'Vouch budget exceeded', vouch_budget: budget }, { status: 403 });
  }

  const vouchId = ulid();
  const now = Date.now();
  try {
    await insertSignedVouchWithLog(env, {
      vouchId,
      voucherId: voucher.id,
      voucheeId: vouchee.id,
      weight,
      signed,
      createdAt: now,
      connFp: await connectionFingerprint(requestConnectionFacts(request), env.CONN_FP_SECRET),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('idx_vouches_active_pair') || msg.includes('vouches.voucher_id, vouches.vouchee_id')) {
      return Response.json({ error: 'Active vouch already exists for this agent pair' }, { status: 409 });
    }
    if (msg.includes('idx_vouches_agent_pub_sig_nonce')) {
      return Response.json({ error: 'Signature nonce already used' }, { status: 409 });
    }
    throw err;
  }

  return Response.json(
    {
      id: vouchId,
      voucher_id: voucher.id,
      vouchee_id: vouchee.id,
      weight,
      signed: true,
    },
    { status: 201 },
  );
}

export async function recomputeTrustScores(env: Env, epoch = Date.now()): Promise<number> {
  const [agentsResult, rootsResult, vouchesResult] = await Promise.all([
    env.DB.prepare('SELECT id, earned_trust FROM agents ORDER BY id ASC').all<{ id: string; earned_trust: number | null }>(),
    env.DB.prepare('SELECT agent_id, weight FROM trust_roots WHERE revoked_at IS NULL ORDER BY agent_id ASC').all<{ agent_id: string; weight: number | null }>(),
    env.DB.prepare(
      `SELECT voucher_id, vouchee_id, weight
       FROM vouches
       WHERE revoked_at IS NULL
       ORDER BY voucher_id ASC, vouchee_id ASC`,
    ).all<{ voucher_id: string; vouchee_id: string; weight: number | null }>(),
  ]);

  const updates = planTrustMaterialization({
    epoch,
    agents: agentsResult.results || [],
    roots: rootsResult.results || [],
    vouches: vouchesResult.results || [],
  });
  if (updates.length === 0) return 0;

  await env.DB.batch(updates.map((update) => env.DB.prepare(
    `UPDATE agents
     SET trust_score = ?, vouch_trust = ?, earned_trust = ?, trust_epoch = ?
     WHERE id = ?`,
  )
    .bind(update.trust_score, update.vouch_trust, update.earned_trust, update.trust_epoch, update.id)));

  return updates.length;
}

async function insertSignedVouchWithLog(
  env: Env,
  input: {
    vouchId: string;
    voucherId: string;
    voucheeId: string;
    weight: number;
    signed: Extract<Awaited<ReturnType<typeof validateSignedVouch>>, { ok: true }>;
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
    const entry = await buildVouchLogEntry({
      seq,
      eventId: ulid(),
      vouchId: input.vouchId,
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
          `INSERT INTO vouches (
             id, voucher_id, vouchee_id, weight,
             agent_pub, sig, sig_nonce, content_hash, canon_payload, sig_alg,
             created_at, log_seq
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            input.vouchId,
            input.voucherId,
            input.voucheeId,
            input.weight,
            input.signed.agent_pub,
            input.signed.sig,
            input.signed.sig_nonce,
            input.signed.content_hash,
            input.signed.canon_payload,
            input.signed.sig_alg,
            input.createdAt,
            seq,
          ),
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
