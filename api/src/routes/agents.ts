import type { Env, AgentAuth, Agent, RegisterAgentRequest, Review, Venue } from '../types';
import { parsePagination, cursorClause, nextCursor } from '../lib/pagination';
import { generateApiKey, hashKey } from '../middleware/auth';
import { ulid } from '../lib/ulid';
import { agentFingerprint, verifyRegistrationProof } from '../lib/agent-identity';
import { registrationBucket, releaseRegistrationPow, validateRegistrationPow } from './pow';

// --------------------------------------------------------------------------
// POST /api/v1/agents/register — Register an agent username
// --------------------------------------------------------------------------

export async function handleRegister(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await request.json<RegisterAgentRequest>();

  if (!body.username || typeof body.username !== 'string') {
    return Response.json(
      { error: 'Missing required field: username' },
      { status: 400 },
    );
  }

  if (!body.pseudonym || typeof body.pseudonym !== 'string') {
    return Response.json(
      { error: 'Missing required field: pseudonym' },
      { status: 400 },
    );
  }

  const username = body.username.trim();
  const pseudonym = body.pseudonym.trim();
  const hasKeyBinding = Boolean(body.pubkey || body.proof || body.proof_ts != null);
  const asnBucket = registrationBucket(request);

  // Validate username: 3-30 chars, lowercase alphanumeric + hyphens,
  // can't start/end with hyphen, no consecutive hyphens
  if (username.length < 3 || username.length > 30) {
    return Response.json(
      { error: 'Username must be 3-30 characters' },
      { status: 400 },
    );
  }

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(username)) {
    return Response.json(
      { error: 'Username must be lowercase alphanumeric with hyphens, cannot start or end with a hyphen' },
      { status: 400 },
    );
  }

  if (/--/.test(username)) {
    return Response.json(
      { error: 'Username cannot contain consecutive hyphens' },
      { status: 400 },
    );
  }

  let fingerprint: string | null = null;
  if (hasKeyBinding) {
    if (!body.pubkey || !body.proof || typeof body.proof_ts !== 'number') {
      return Response.json(
        { error: 'Key-bound registration requires pubkey, proof, and proof_ts' },
        { status: 400 },
      );
    }

    const proofValid = await verifyRegistrationProof({
      username,
      pubkey: body.pubkey,
      proof: body.proof,
      proofTs: body.proof_ts,
    });

    if (!proofValid) {
      return Response.json(
        { error: 'Invalid key-binding proof' },
        { status: 400 },
      );
    }

    fingerprint = await agentFingerprint(body.pubkey);
  }

  const pow = await validateRegistrationPow(env, asnBucket, body, username);
  if (!pow.ok) return pow.response;

  // Generate agent ID and API key
  const agentId = ulid();
  const apiKey = generateApiKey();
  const keyHash = await hashKey(apiKey);
  const now = Date.now();

  try {
    const insertAgent = hasKeyBinding
      ? env.DB.prepare(
        `INSERT INTO agents (
          id, username, pseudonym, created_at, api_key_hash,
          pubkey, fingerprint, key_status, registration_asn_bucket, pow_challenge
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(agentId, username, pseudonym, now, keyHash, body.pubkey, fingerprint, 'active', asnBucket, pow.challenge)
      : env.DB.prepare(
        `INSERT INTO agents (
          id, username, pseudonym, created_at, api_key_hash,
          registration_asn_bucket, pow_challenge
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(agentId, username, pseudonym, now, keyHash, asnBucket, pow.challenge);

    const statements = [insertAgent];
    if (pow.challenge) {
      statements.push(
        env.DB.prepare('UPDATE pow_challenges SET consumed_at = ? WHERE challenge = ?')
          .bind(now, pow.challenge),
      );
    }

    await env.DB.batch(statements);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE constraint failed')) {
      if (msg.includes('pow_challenge')) {
        return Response.json(
          { error: 'Proof-of-work challenge already consumed' },
          { status: 409 },
        );
      }
      await releaseRegistrationPow(env, pow.challenge);
      if (msg.includes('pubkey') || msg.includes('fingerprint')) {
        return Response.json(
          { error: 'Public key already registered' },
          { status: 409 },
        );
      }
      return Response.json(
        { error: 'Username taken' },
        { status: 409 },
      );
    }
    throw err;
  }

  // Return the API key ONCE — agent must save it
  return Response.json(
    {
      username,
      pseudonym,
      fingerprint,
      key_status: hasKeyBinding ? 'active' : 'legacy',
      api_key: apiKey,
      message: 'Save this API key — it cannot be retrieved again.',
    },
    { status: 201 },
  );
}

// --------------------------------------------------------------------------
// GET /api/v1/agents/:username — Public agent profile
// --------------------------------------------------------------------------

export async function handleGetProfile(
  request: Request,
  env: Env,
  username: string,
): Promise<Response> {
  const agent = await env.DB.prepare(
    'SELECT username, pseudonym, review_count, created_at, fingerprint, key_status FROM agents WHERE username = ?',
  )
    .bind(username)
    .first();

  if (!agent) {
    return Response.json({ error: 'Agent not found' }, { status: 404 });
  }

  return Response.json(agent);
}

// --------------------------------------------------------------------------
// GET /api/v1/agents/:username/reviews — Public paginated reviews by agent
// --------------------------------------------------------------------------

export async function handleGetReviews(
  request: Request,
  env: Env,
  username: string,
): Promise<Response> {
  // Look up agent by username
  const agent = await env.DB.prepare('SELECT id FROM agents WHERE username = ?')
    .bind(username)
    .first<{ id: string }>();

  if (!agent) {
    return Response.json({ error: 'Agent not found' }, { status: 404 });
  }

  const url = new URL(request.url);
  const { cursor, limit } = parsePagination(url);
  const { clause: cursorCl, binds: cursorBinds } = cursorClause(cursor, 'r.id');

  const sql = `
    SELECT r.*, v.id AS v_id, v.name AS v_name, v.lat AS v_lat, v.lng AS v_lng,
           v.geo_hash AS v_geo_hash, v.city AS v_city, v.region AS v_region,
           v.country AS v_country, v.external_id AS v_external_id,
           v.created_at AS v_created_at, v.review_count AS v_review_count,
           v.avg_rating AS v_avg_rating,
           v.google_rating AS v_google_rating, v.google_review_count AS v_google_review_count,
           v.yelp_rating AS v_yelp_rating, v.yelp_review_count AS v_yelp_review_count,
           v.external_ratings_updated_at AS v_external_ratings_updated_at
    FROM reviews r
    JOIN venues v ON r.venue_id = v.id
    WHERE r.agent_id = ?
      ${cursorCl}
    ORDER BY r.id DESC
    LIMIT ?
  `;

  const allBinds = [agent.id, ...cursorBinds, limit];
  const result = await env.DB.prepare(sql).bind(...allBinds).all();

  const reviews = (result.results || []).map((row: Record<string, unknown>) => ({
    ...extractReview(row),
    venue: extractVenue(row),
  }));

  return Response.json({
    reviews,
    count: reviews.length,
    next_cursor: nextCursor(reviews, limit),
  });
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function extractReview(row: Record<string, unknown>): Review {
  return {
    id: row.id as string,
    agent_pseudonym: row.agent_pseudonym as string,
    agent_id: row.agent_id as string,
    agent_username: row.agent_username as string | undefined,
    venue_id: row.venue_id as string,
    category: row.category as Review['category'],
    rating: row.rating as number,
    title: row.title as string | null,
    body: row.body as string,
    tags: row.tags as string | null,
    poop_cleanliness: row.poop_cleanliness as number | null,
    poop_privacy: row.poop_privacy as number | null,
    poop_tp_quality: row.poop_tp_quality as number | null,
    poop_phone_shelf: row.poop_phone_shelf as number | null,
    poop_bidet: row.poop_bidet as number | null,
    photo_keys: row.photo_keys as string | null,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number | null,
    expires_at: row.expires_at as number | null,
    source: row.source as string,
    upvotes: row.upvotes as number,
    downvotes: row.downvotes as number,
    flag_count: row.flag_count as number,
    agent_pub: row.agent_pub as string | null,
    sig: row.sig as string | null,
    sig_nonce: row.sig_nonce as string | null,
    content_hash: row.content_hash as string | null,
    canon_payload: row.canon_payload as string | null,
    sig_alg: row.sig_alg as string | null,
    signed: Boolean(row.signed),
    log_seq: row.log_seq as number | null,
  };
}

function extractVenue(row: Record<string, unknown>): Venue {
  return {
    id: row.v_id as string,
    name: row.v_name as string,
    lat: row.v_lat as number,
    lng: row.v_lng as number,
    geo_hash: row.v_geo_hash as string,
    city: row.v_city as string | null,
    region: row.v_region as string | null,
    country: row.v_country as string | null,
    external_id: row.v_external_id as string | null,
    created_at: row.v_created_at as number,
    review_count: row.v_review_count as number,
    avg_rating: row.v_avg_rating as number,
    google_rating: row.v_google_rating as number | null,
    google_review_count: row.v_google_review_count as number | null,
    yelp_rating: row.v_yelp_rating as number | null,
    yelp_review_count: row.v_yelp_review_count as number | null,
    external_ratings_updated_at: row.v_external_ratings_updated_at as number | null,
  };
}
