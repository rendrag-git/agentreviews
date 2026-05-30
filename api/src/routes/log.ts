import type { Env } from '../types';
import { verifySignedPayload } from '../lib/signing';
import {
  consistencyProof,
  inclusionProof,
  merkleRoot,
  verifyConsistencyProof,
  verifyInclusionProof,
} from '../lib/merkle';
import { ulid } from '../lib/ulid';
import {
  type LogEntry,
  type LogRoot,
  signTreeHead,
  verifyLogEntryHash,
  verifyTreeHeadSignature,
} from '../lib/transparency-log';

const MAX_LOG_ENTRIES_LIMIT = 100;
type LogEventType = LogEntry['event_type'];

interface OperatorKey {
  publicKey: string;
  privateKey: string;
}

export async function handleWellKnownLogKey(env: Env): Promise<Response> {
  const key = getOperatorKey(env);
  if (!key) {
    return Response.json({ error: 'Operator log key is not configured' }, { status: 503 });
  }

  return Response.json({
    alg: 'Ed25519',
    operator_pub: key.publicKey,
  });
}

export async function handleGetLogRoot(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const treeSizeParam = url.searchParams.get('tree_size');

  const root = treeSizeParam
    ? await env.DB.prepare('SELECT * FROM log_roots WHERE tree_size = ?')
      .bind(parseInt(treeSizeParam, 10))
      .first<LogRoot>()
    : await env.DB.prepare('SELECT * FROM log_roots ORDER BY tree_size DESC LIMIT 1')
      .first<LogRoot>();

  if (!root) {
    return Response.json({ error: 'Log root not found' }, { status: 404 });
  }

  return Response.json({ root: extractRoot(root) });
}

export async function handleGetLogEntries(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const fromSeq = Math.max(1, parseInt(url.searchParams.get('from_seq') ?? '1', 10) || 1);
  const limit = Math.min(
    MAX_LOG_ENTRIES_LIMIT,
    Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50),
  );

  const result = await env.DB.prepare(
    'SELECT * FROM log_entries WHERE seq >= ? ORDER BY seq ASC LIMIT ?',
  )
    .bind(fromSeq, limit)
    .all<LogEntry>();

  const entries = result.results || [];
  return Response.json({
    entries: entries.map(extractEntry),
    next_seq: entries.length === limit ? entries[entries.length - 1].seq + 1 : null,
  });
}

export async function handleGetInclusionProof(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const reviewId = url.searchParams.get('review_id');
  const eventType = parseLogEventType(url.searchParams.get('event_type') ?? 'review.create');
  if (!reviewId) {
    return Response.json({ error: 'review_id is required' }, { status: 400 });
  }
  if (!eventType) {
    return Response.json({ error: 'event_type must be review.create or review.erase' }, { status: 400 });
  }

  const proof = await inclusionProofForReview(env, reviewId, eventType);
  if (!proof.ok) {
    return Response.json({ error: proof.error }, { status: proof.status });
  }

  return Response.json(proof.body);
}

export async function handleGetConsistencyProof(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const oldSize = parseTreeSize(url.searchParams.get('first') ?? url.searchParams.get('old_size'));
  const newSize = parseTreeSize(url.searchParams.get('second') ?? url.searchParams.get('new_size'));

  if (oldSize == null || newSize == null) {
    return Response.json({ error: 'first and second are required positive integers' }, { status: 400 });
  }

  if (oldSize >= newSize) {
    return Response.json({ error: 'first must be less than second' }, { status: 400 });
  }

  const [oldRoot, newRoot] = await Promise.all([
    rootAtTreeSize(env, oldSize),
    rootAtTreeSize(env, newSize),
  ]);

  if (!oldRoot || !newRoot) {
    return Response.json({ error: 'Published log root not found for requested tree size' }, { status: 404 });
  }

  const entriesResult = await env.DB.prepare(
    'SELECT leaf_hash FROM log_entries WHERE seq <= ? ORDER BY seq ASC',
  )
    .bind(newSize)
    .all<{ leaf_hash: string }>();
  const leafHashes = (entriesResult.results || []).map((row) => row.leaf_hash);
  if (leafHashes.length !== newSize) {
    return Response.json({ error: 'Log entries for requested tree size are incomplete' }, { status: 409 });
  }

  const proof = await consistencyProof(oldSize, leafHashes);
  const checks = {
    consistency_proof: await verifyConsistencyProof(oldSize, newSize, proof, oldRoot.root_hash, newRoot.root_hash),
    old_root_signature: await verifyTreeHeadSignature(
      {
        tree_size: oldRoot.tree_size,
        root_hash: oldRoot.root_hash,
        published_at: oldRoot.published_at,
        root_sig: oldRoot.root_sig,
      },
      oldRoot.operator_pub,
    ),
    new_root_signature: await verifyTreeHeadSignature(
      {
        tree_size: newRoot.tree_size,
        root_hash: newRoot.root_hash,
        published_at: newRoot.published_at,
        root_sig: newRoot.root_sig,
      },
      newRoot.operator_pub,
    ),
  };

  return Response.json({
    first_tree_size: oldSize,
    second_tree_size: newSize,
    first_root_hash: oldRoot.root_hash,
    second_root_hash: newRoot.root_hash,
    old_size: oldSize,
    new_size: newSize,
    old_root_hash: oldRoot.root_hash,
    new_root_hash: newRoot.root_hash,
    proof,
    hash_alg: 'SHA-256',
    node_domain: 'RFC6962_NODE_0x01',
    old_root: extractRoot(oldRoot),
    new_root: extractRoot(newRoot),
    first_root: extractRoot(oldRoot),
    second_root: extractRoot(newRoot),
    checks,
    verified: checks.consistency_proof && checks.old_root_signature && checks.new_root_signature,
  });
}

export async function handleVerifyReview(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const reviewId = url.searchParams.get('review_id');
  if (!reviewId) {
    return Response.json({ error: 'review_id is required' }, { status: 400 });
  }

  const proof = await inclusionProofForReview(env, reviewId, 'review.create');
  if (!proof.ok) {
    return Response.json({
      review_id: reviewId,
      logged: false,
      verified: false,
      error: proof.error,
    }, { status: proof.status });
  }

  const { checks } = proof.body;
  const review = await env.DB.prepare('SELECT erased_at, erasure_log_seq FROM reviews WHERE id = ?')
    .bind(reviewId)
    .first<{ erased_at: number | null; erasure_log_seq: number | null }>();
  const erased = Boolean(review?.erased_at);
  const eraseProof = erased ? await inclusionProofForReview(env, reviewId, 'review.erase') : null;
  return Response.json({
    review_id: reviewId,
    logged: true,
    erased,
    payload_available: proof.body.payload_available,
    erase_logged: eraseProof?.ok ?? false,
    verified: checks.log_entry_hash &&
      checks.review_signature !== false &&
      checks.inclusion_proof &&
      checks.root_signature &&
      (!erased || eraseProof?.ok === true),
    checks,
    proof: proof.body,
    erasure: eraseProof?.ok ? eraseProof.body : null,
  });
}

async function rootAtTreeSize(env: Env, treeSize: number): Promise<LogRoot | null> {
  return env.DB.prepare('SELECT * FROM log_roots WHERE tree_size = ?')
    .bind(treeSize)
    .first<LogRoot>();
}

function parseTreeSize(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

function parseLogEventType(value: string): LogEventType | null {
  return value === 'review.create' || value === 'review.erase' ? value : null;
}

export async function publishLogRoot(env: Env, publishedAt = Date.now()): Promise<LogRoot> {
  const result = await env.DB.prepare('SELECT leaf_hash FROM log_entries ORDER BY seq ASC').all<{ leaf_hash: string }>();
  const leafHashes = (result.results || []).map((entry) => entry.leaf_hash);
  const treeSize = leafHashes.length;

  const existing = await env.DB.prepare('SELECT * FROM log_roots WHERE tree_size = ?')
    .bind(treeSize)
    .first<LogRoot>();
  if (existing) return existing;

  const rootHash = await merkleRoot(leafHashes);
  const key = getOperatorKey(env);
  if (!key) {
    throw new Error('Operator log key is not configured');
  }

  const rootSig = await signTreeHead(
    {
      tree_size: treeSize,
      root_hash: rootHash,
      published_at: publishedAt,
    },
    key.privateKey,
  );
  const id = ulid();

  await env.DB.prepare(
    `INSERT INTO log_roots (
      id, tree_size, root_hash, root_sig, sig_alg, operator_pub, published_at, anchor_proof
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, treeSize, rootHash, rootSig, 'Ed25519', key.publicKey, publishedAt, null)
    .run();

  const root = await env.DB.prepare('SELECT * FROM log_roots WHERE id = ?')
    .bind(id)
    .first<LogRoot>();
  if (!root) {
    throw new Error('Log root insert succeeded but created row was not found');
  }

  return root;
}

async function inclusionProofForReview(
  env: Env,
  reviewId: string,
  eventType: LogEventType,
): Promise<{ ok: true; body: InclusionProofResponse } | { ok: false; error: string; status: number }> {
  const entry = await env.DB.prepare(
    'SELECT * FROM log_entries WHERE event_type = ? AND object_type = ? AND object_id = ?',
  )
    .bind(eventType, 'review', reviewId)
    .first<LogEntry>();

  if (!entry) {
    return { ok: false, error: `${eventType} is not logged`, status: 404 };
  }

  const root = await env.DB.prepare(
    'SELECT * FROM log_roots WHERE tree_size >= ? ORDER BY tree_size DESC LIMIT 1',
  )
    .bind(entry.seq)
    .first<LogRoot>();

  if (!root) {
    return { ok: false, error: 'No published log root includes this review', status: 404 };
  }

  const entriesResult = await env.DB.prepare(
    'SELECT leaf_hash FROM log_entries WHERE seq <= ? ORDER BY seq ASC',
  )
    .bind(root.tree_size)
    .all<{ leaf_hash: string }>();
  const leafHashes = (entriesResult.results || []).map((row) => row.leaf_hash);
  const proof = await inclusionProof(entry.seq - 1, leafHashes);
  const reviewSignature = entry.canon_payload
    ? await verifySignedPayload(
      {
        sigAlg: 'Ed25519',
        signature: entry.sig,
        contentHash: entry.content_hash,
        canonPayload: entry.canon_payload,
      },
      entry.agent_pub,
    )
    : null;
  const checks = {
    log_entry_hash: await verifyLogEntryHash(entry),
    review_signature: reviewSignature,
    inclusion_proof: await verifyInclusionProof(entry.leaf_hash, entry.seq - 1, root.tree_size, proof, root.root_hash),
    root_signature: await verifyTreeHeadSignature(
      {
        tree_size: root.tree_size,
        root_hash: root.root_hash,
        published_at: root.published_at,
        root_sig: root.root_sig,
      },
      root.operator_pub,
    ),
  };

  return {
    ok: true,
    body: {
      review_id: reviewId,
      tree_size: root.tree_size,
      leaf_index: entry.seq - 1,
      leaf_hash: entry.leaf_hash,
      root_hash: root.root_hash,
      proof,
      hash_alg: 'SHA-256',
      leaf_domain: 'RFC6962_LEAF_0x00',
      node_domain: 'RFC6962_NODE_0x01',
      entry: extractEntry(entry),
      root: extractRoot(root),
      payload_available: entry.canon_payload != null,
      checks,
    },
  };
}

function getOperatorKey(env: Env): OperatorKey | null {
  if (env.OPERATOR_PRIVATE_KEY && env.OPERATOR_PUBLIC_KEY) {
    return {
      privateKey: env.OPERATOR_PRIVATE_KEY,
      publicKey: env.OPERATOR_PUBLIC_KEY,
    };
  }

  return null;
}

function extractEntry(entry: LogEntry) {
  return {
    seq: entry.seq,
    event_id: entry.event_id,
    event_type: entry.event_type,
    object_type: entry.object_type,
    object_id: entry.object_id,
    agent_pub: entry.agent_pub,
    sig: entry.sig,
    sig_nonce: entry.sig_nonce,
    content_hash: entry.content_hash,
    canon_payload: entry.canon_payload,
    sig_alg: entry.sig_alg,
    prev_hash: entry.prev_hash,
    leaf_hash: entry.leaf_hash,
    created_at: entry.created_at,
    leaf_version: entry.leaf_version ?? 1,
  };
}

function extractRoot(root: LogRoot) {
  return {
    id: root.id,
    tree_size: root.tree_size,
    root_hash: root.root_hash,
    root_sig: root.root_sig,
    sig_alg: root.sig_alg,
    operator_pub: root.operator_pub,
    published_at: root.published_at,
    anchor_proof: root.anchor_proof,
  };
}

interface InclusionProofResponse {
  review_id: string;
  tree_size: number;
  leaf_index: number;
  leaf_hash: string;
  root_hash: string;
  proof: string[];
  hash_alg: 'SHA-256';
  leaf_domain: 'RFC6962_LEAF_0x00';
  node_domain: 'RFC6962_NODE_0x01';
  entry: ReturnType<typeof extractEntry>;
  root: ReturnType<typeof extractRoot>;
  payload_available: boolean;
  checks: {
    log_entry_hash: boolean;
    review_signature: boolean | null;
    inclusion_proof: boolean;
    root_signature: boolean;
  };
}
