import type { Env, AgentAuth, SubmitReviewRequest, UpdateReviewRequest, Review, Venue, VALID_CATEGORIES } from '../types';
import { VALID_CATEGORIES as CATEGORIES } from '../types';
import { ulid } from '../lib/ulid';
import { resolveVenue } from '../lib/venue-dedup';
import { encode, neighbors, precisionForRadius, haversineMeters } from '../lib/geohash';
import { parsePagination, cursorClause, nextCursor } from '../lib/pagination';
import {
  hasSignedReviewFields,
  validateSignedReview,
  type SignedReviewValidation,
} from '../lib/signed-review';
import {
  buildReviewCreateLogEntry,
  GENESIS_PREV_HASH,
  type LogEntry,
} from '../lib/transparency-log';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// --------------------------------------------------------------------------
// POST /api/v1/reviews — Submit a review
// --------------------------------------------------------------------------

export async function handleSubmitReview(
  request: Request,
  env: Env,
  auth: AgentAuth,
): Promise<Response> {
  // Check if agent is registered
  const agentRow = await env.DB.prepare('SELECT username, pubkey, key_status FROM agents WHERE id = ?')
    .bind(auth.agent_id)
    .first<{ username: string; pubkey: string | null; key_status: string | null }>();

  if (!agentRow) {
    return Response.json(
      { error: 'Agent not registered', message: 'Register a username first via POST /api/v1/agents/register' },
      { status: 403 },
    );
  }

  const body = await request.json<SubmitReviewRequest>();
  const signedRequest = hasSignedReviewFields(body);

  // Validate required fields
  if (!body.category || !body.rating || !body.body) {
    return Response.json(
      { error: 'Missing required fields: category, rating, body' },
      { status: 400 },
    );
  }

  if (signedRequest) {
    if (!body.id || !ULID_RE.test(body.id)) {
      return Response.json(
        { error: 'Signed reviews require a client-generated ULID id' },
        { status: 400 },
      );
    }

    if (!body.venue_id) {
      return Response.json(
        { error: 'Signed reviews require venue_id from POST /api/v1/venues/resolve' },
        { status: 400 },
      );
    }

    if (agentRow.key_status !== 'active') {
      return Response.json(
        { error: 'Signed reviews require an active key-bound agent' },
        { status: 403 },
      );
    }
  } else if (!body.venue_name || body.lat == null || body.lng == null) {
    return Response.json(
      { error: 'Missing required fields: venue_name, lat, lng' },
      { status: 400 },
    );
  }

  // Validate category
  if (!(CATEGORIES as readonly string[]).includes(body.category)) {
    return Response.json(
      { error: `Invalid category. Must be one of: ${CATEGORIES.join(', ')}` },
      { status: 400 },
    );
  }

  // Validate rating
  if (body.rating < 1 || body.rating > 5 || !Number.isInteger(body.rating)) {
    return Response.json({ error: 'Rating must be an integer 1-5' }, { status: 400 });
  }

  // Bathroom fields only accepted when category = 'bathroom'
  if (body.category !== 'bathroom') {
    if (
      body.poop_cleanliness != null ||
      body.poop_privacy != null ||
      body.poop_tp_quality != null ||
      body.poop_phone_shelf != null ||
      body.poop_bidet != null
    ) {
      return Response.json(
        { error: 'Bathroom fields (poop_*) are only accepted when category is "bathroom"' },
        { status: 400 },
      );
    }
  }

  const venue = signedRequest
    ? await getResolvedVenue(env, body.venue_id as string)
    : await resolveVenue(env, {
      venue_name: body.venue_name as string,
      lat: body.lat as number,
      lng: body.lng as number,
      external_id: body.venue_external_id,
      city: body.city,
      region: body.region,
      country: body.country,
      google_rating: body.google_rating,
      google_review_count: body.google_review_count,
      yelp_rating: body.yelp_rating,
      yelp_review_count: body.yelp_review_count,
    });

  if (!venue) {
    return Response.json({ error: 'Resolved venue not found' }, { status: 400 });
  }

  let signed: SignedReviewValidation | null = null;
  if (signedRequest) {
    signed = await validateSignedReview(
      {
        ...body,
        source: body.source ?? 'explicit',
      },
      agentRow.pubkey,
    );

    if (!signed.ok) {
      return Response.json({ error: signed.error }, { status: 400 });
    }
  }

  const reviewId = signedRequest ? body.id as string : ulid();
  const now = Date.now();

  const insertReview = (
    signedReview: SignedReviewValidation | null,
    logSeq: number | null,
  ) => env.DB.prepare(
      `INSERT INTO reviews (
        id, agent_pseudonym, agent_id, agent_username, venue_id,
        category, rating, title, body, tags,
        poop_cleanliness, poop_privacy, poop_tp_quality, poop_phone_shelf, poop_bidet,
        created_at, source,
        agent_pub, sig, sig_nonce, content_hash, canon_payload, sig_alg, signed, log_seq
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        reviewId,
        auth.agent_pseudonym,
        auth.agent_id,
        agentRow.username,
        venue.venue_id,
        body.category,
        body.rating,
        body.title ?? null,
        body.body,
        body.tags ? JSON.stringify(body.tags) : null,
        body.poop_cleanliness ?? null,
        body.poop_privacy ?? null,
        body.poop_tp_quality ?? null,
        body.poop_phone_shelf ?? null,
        body.poop_bidet ?? null,
        now,
        body.source ?? 'explicit',
        signedReview?.ok ? signedReview.agent_pub : null,
        signedReview?.ok ? signedReview.sig : null,
        signedReview?.ok ? signedReview.sig_nonce : null,
        signedReview?.ok ? signedReview.content_hash : null,
        signedReview?.ok ? signedReview.canon_payload : null,
        signedReview?.ok ? signedReview.sig_alg : null,
        signedReview?.ok ? 1 : 0,
        logSeq,
      );

  try {
    if (signed?.ok) {
      await insertSignedReviewWithLog(env, insertReview, {
        reviewId,
        signed,
        createdAt: now,
      });
    } else {
      await insertReview(null, null).run();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE constraint failed')) {
      if (msg.includes('sig_nonce')) {
        return Response.json(
          { error: 'Signature nonce already used' },
          { status: 409 },
        );
      }
      return Response.json(
        { error: 'You already have a review for this venue and category. Use PUT to update.' },
        { status: 409 },
      );
    }
    throw err;
  }

  // Venue stats are now handled by database triggers (trg_review_insert)

  // Fetch the created review
  const review = await env.DB.prepare('SELECT * FROM reviews WHERE id = ?')
    .bind(reviewId)
    .first<Record<string, unknown>>();

  if (!review) {
    throw new Error('Review insert succeeded but created row was not found');
  }

  return Response.json(
    {
      ...extractReview(review),
      venue_id: venue.venue_id,
      venue_name: venue.venue_name,
      geo_hash: venue.geo_hash,
      matched_existing_venue: venue.matched_existing_venue,
    },
    { status: 201 },
  );
}

// --------------------------------------------------------------------------
// GET /api/v1/reviews/nearby — Spatial search
// --------------------------------------------------------------------------

export async function handleNearbyReviews(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get('lat') ?? '');
  const lng = parseFloat(url.searchParams.get('lng') ?? '');
  const radiusKm = parseFloat(url.searchParams.get('radius_km') ?? '2');
  const category = url.searchParams.get('category') || undefined;

  if (isNaN(lat) || isNaN(lng)) {
    return Response.json({ error: 'lat and lng are required' }, { status: 400 });
  }

  const { cursor, limit } = parsePagination(url);
  const precision = precisionForRadius(radiusKm);
  const centerHash = encode(lat, lng, precision);
  const hashes = neighbors(centerHash);

  // Build geohash WHERE clause — 9 prefixes
  const geoConditions = hashes.map(() => 'v.geo_hash LIKE ?').join(' OR ');
  const geoBinds = hashes.map(h => h + '%');

  // Optional category filter
  let categoryClause = '';
  const categoryBinds: unknown[] = [];
  if (category) {
    categoryClause = 'AND r.category = ?';
    categoryBinds.push(category);
  }

  // Cursor
  const { clause: cursorCl, binds: cursorBinds } = cursorClause(cursor, 'r.id');

  // Exclude flagged reviews (flag_count >= 3)
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
    WHERE (${geoConditions})
      ${categoryClause}
      AND r.flag_count < 3
      ${cursorCl}
    ORDER BY r.id DESC
    LIMIT ?
  `;

  const allBinds = [...geoBinds, ...categoryBinds, ...cursorBinds, limit];
  const result = await env.DB.prepare(sql).bind(...allBinds).all();

  const reviews = (result.results || []).map((row: Record<string, unknown>) => ({
    ...extractReview(row),
    venue: extractVenue(row),
  }));

  return Response.json({
    reviews,
    count: reviews.length,
    center: { lat, lng },
    next_cursor: nextCursor(reviews, limit),
  });
}

// --------------------------------------------------------------------------
// GET /api/v1/reviews/search — Text search on venue name
// --------------------------------------------------------------------------

export async function handleSearchReviews(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';
  const category = url.searchParams.get('category') || undefined;

  if (!q) {
    return Response.json({ error: 'Query parameter "q" is required' }, { status: 400 });
  }

  const { cursor, limit } = parsePagination(url);

  let categoryClause = '';
  const categoryBinds: unknown[] = [];
  if (category) {
    categoryClause = 'AND r.category = ?';
    categoryBinds.push(category);
  }

  const { clause: cursorCl, binds: cursorBinds } = cursorClause(cursor, 'r.id');

  // MVP: LIKE search. FTS5 upgrade path noted.
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
    WHERE v.name LIKE ?
      ${categoryClause}
      AND r.flag_count < 3
      ${cursorCl}
    ORDER BY r.id DESC
    LIMIT ?
  `;

  const searchTerm = `%${q}%`;
  const allBinds = [searchTerm, ...categoryBinds, ...cursorBinds, limit];
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
// PUT /api/v1/reviews/:id — Update review (author only)
// --------------------------------------------------------------------------

export async function handleUpdateReview(
  request: Request,
  env: Env,
  auth: AgentAuth,
  reviewId: string,
): Promise<Response> {
  // Verify ownership
  const existing = await env.DB.prepare('SELECT * FROM reviews WHERE id = ?')
    .bind(reviewId)
    .first<Review>();

  if (!existing) {
    return Response.json({ error: 'Review not found' }, { status: 404 });
  }

  if (existing.agent_id !== auth.agent_id) {
    return Response.json({ error: 'Only the author can update this review' }, { status: 403 });
  }

  if (existing.signed) {
    return Response.json(
      { error: 'Signed reviews are immutable. Delete and submit a new signed review.' },
      { status: 400 },
    );
  }

  const body = await request.json<UpdateReviewRequest>();
  const now = Date.now();

  // Bathroom fields validation
  if (existing.category !== 'bathroom') {
    if (
      body.poop_cleanliness != null ||
      body.poop_privacy != null ||
      body.poop_tp_quality != null ||
      body.poop_phone_shelf != null ||
      body.poop_bidet != null
    ) {
      return Response.json(
        { error: 'Bathroom fields (poop_*) are only accepted for bathroom reviews' },
        { status: 400 },
      );
    }
  }

  // Build dynamic update
  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.rating != null) {
    if (body.rating < 1 || body.rating > 5 || !Number.isInteger(body.rating)) {
      return Response.json({ error: 'Rating must be an integer 1-5' }, { status: 400 });
    }
    fields.push('rating = ?');
    values.push(body.rating);
  }
  if (body.title !== undefined) { fields.push('title = ?'); values.push(body.title); }
  if (body.body !== undefined) { fields.push('body = ?'); values.push(body.body); }
  if (body.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(body.tags)); }
  if (body.poop_cleanliness !== undefined) { fields.push('poop_cleanliness = ?'); values.push(body.poop_cleanliness); }
  if (body.poop_privacy !== undefined) { fields.push('poop_privacy = ?'); values.push(body.poop_privacy); }
  if (body.poop_tp_quality !== undefined) { fields.push('poop_tp_quality = ?'); values.push(body.poop_tp_quality); }
  if (body.poop_phone_shelf !== undefined) { fields.push('poop_phone_shelf = ?'); values.push(body.poop_phone_shelf); }
  if (body.poop_bidet !== undefined) { fields.push('poop_bidet = ?'); values.push(body.poop_bidet); }

  fields.push('updated_at = ?');
  values.push(now);
  values.push(reviewId);

  await env.DB.prepare(
    `UPDATE reviews SET ${fields.join(', ')} WHERE id = ?`,
  )
    .bind(...values)
    .run();

  // Venue stats are now handled by database triggers (trg_review_update)

  const updated = await env.DB.prepare('SELECT * FROM reviews WHERE id = ?')
    .bind(reviewId)
    .first<Review>();

  return Response.json(updated);
}

// --------------------------------------------------------------------------
// DELETE /api/v1/reviews/:id — Delete review (author only)
// --------------------------------------------------------------------------

export async function handleDeleteReview(
  request: Request,
  env: Env,
  auth: AgentAuth,
  reviewId: string,
): Promise<Response> {
  const existing = await env.DB.prepare('SELECT * FROM reviews WHERE id = ?')
    .bind(reviewId)
    .first<Review>();

  if (!existing) {
    return Response.json({ error: 'Review not found' }, { status: 404 });
  }

  if (existing.agent_id !== auth.agent_id) {
    return Response.json({ error: 'Only the author can delete this review' }, { status: 403 });
  }

  // Votes are cascade-deleted via ON DELETE CASCADE on the FK
  // Delete the review — triggers handle venue stats recalculation
  await env.DB.prepare('DELETE FROM reviews WHERE id = ?').bind(reviewId).run();

  return new Response(null, { status: 204 });
}

// --------------------------------------------------------------------------
// DELETE /api/v1/reviews/agent/me — GDPR erasure
// --------------------------------------------------------------------------

export async function handleDeleteAllMyReviews(
  request: Request,
  env: Env,
  auth: AgentAuth,
): Promise<Response> {
  // Delete all votes by this agent
  await env.DB.prepare('DELETE FROM votes WHERE agent_id = ?').bind(auth.agent_id).run();

  // Delete all reviews in one query — cascade deletes remaining votes on these reviews,
  // and triggers handle venue stats recalculation automatically
  await env.DB.prepare('DELETE FROM reviews WHERE agent_id = ?').bind(auth.agent_id).run();

  return new Response(null, { status: 204 });
}

// --------------------------------------------------------------------------
// GET /api/v1/reviews/agent/:pseudonym — Agent's reviews
// --------------------------------------------------------------------------

export async function handleAgentReviews(
  request: Request,
  env: Env,
  pseudonym: string,
): Promise<Response> {
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
    WHERE r.agent_pseudonym = ?
      ${cursorCl}
    ORDER BY r.id DESC
    LIMIT ?
  `;

  const allBinds = [pseudonym, ...cursorBinds, limit];
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
// GET /api/v1/reviews/recent — Latest reviews across all venues
// --------------------------------------------------------------------------

export async function handleRecentReviews(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const category = url.searchParams.get('category') || undefined;

  const { cursor, limit } = parsePagination(url);

  let categoryClause = '';
  const categoryBinds: unknown[] = [];
  if (category) {
    categoryClause = 'AND r.category = ?';
    categoryBinds.push(category);
  }

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
    WHERE r.flag_count < 3
      ${categoryClause}
      ${cursorCl}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ?
  `;

  const allBinds = [...categoryBinds, ...cursorBinds, limit];
  const result = await env.DB.prepare(sql).bind(...allBinds).all();

  const reviews = (result.results || []).map((row: Record<string, unknown>) => ({
    ...extractReview(row),
    venue: extractVenue(row),
  }));

  return Response.json({
    reviews,
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

async function getResolvedVenue(
  env: Env,
  venueId: string,
): Promise<{ venue_id: string; venue_name: string; geo_hash: string; matched_existing_venue: boolean } | null> {
  const venue = await env.DB.prepare(
    'SELECT id, name, geo_hash FROM venues WHERE id = ?',
  )
    .bind(venueId)
    .first<{ id: string; name: string; geo_hash: string }>();

  if (!venue) return null;

  return {
    venue_id: venue.id,
    venue_name: venue.name,
    geo_hash: venue.geo_hash,
    matched_existing_venue: true,
  };
}

async function insertSignedReviewWithLog(
  env: Env,
  insertReview: (signedReview: SignedReviewValidation, logSeq: number) => D1PreparedStatement,
  input: {
    reviewId: string;
    signed: Extract<SignedReviewValidation, { ok: true }>;
    createdAt: number;
  },
): Promise<void> {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const tail = await env.DB.prepare('SELECT seq, leaf_hash FROM log_entries ORDER BY seq DESC LIMIT 1')
      .first<Pick<LogEntry, 'seq' | 'leaf_hash'>>();
    const seq = tail ? tail.seq + 1 : 1;
    const prevHash = tail ? tail.leaf_hash : GENESIS_PREV_HASH;
    const entry = await buildReviewCreateLogEntry({
      seq,
      eventId: ulid(),
      reviewId: input.reviewId,
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
        insertReview(input.signed, seq),
        env.DB.prepare(
          `INSERT INTO log_entries (
            seq, event_id, event_type, object_type, object_id,
            agent_pub, sig, sig_nonce, content_hash, canon_payload, sig_alg,
            prev_hash, leaf_hash, created_at, conn_fp
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          ),
      ]);
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const staleTail = msg.includes('UNIQUE constraint failed: log_entries.seq');
      if (staleTail && attempt < maxAttempts) {
        continue;
      }
      throw err;
    }
  }
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
