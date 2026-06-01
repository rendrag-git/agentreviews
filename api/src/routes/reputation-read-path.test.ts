import { describe, expect, it } from 'vitest';

import { encode } from '../lib/geohash';
import { handleGetReviewById, handleMyReviews, handleNearbyReviews, handleSearchReviews } from './reviews';
import { handleGetVenue } from './venues';
import type { Env, Venue } from '../types';

type Row = Record<string, unknown>;

interface FixtureData {
  venues: Venue[];
  reviewRows: Row[];
  venueReviewRows: Row[];
}

class FakeReadPathDb {
  constructor(private readonly data: FixtureData) {}

  prepare(sql: string) {
    const data = this.data;
    return {
      bind(...binds: unknown[]) {
        return {
          async all() {
            if (sql.includes('WHERE v.name LIKE ?')) {
              return { results: runReviewSearch(sql, binds, data.reviewRows) };
            }
            if (sql.includes('v.geo_hash LIKE ?')) {
              return { results: runNearbySearch(sql, binds, data.reviewRows) };
            }
            if (sql.includes('LEFT JOIN review_weights rw')) {
              return { results: runVenueReviews(sql, binds, data.venueReviewRows) };
            }
            if (sql.includes('WHERE r.agent_id = ?')) {
              return { results: runMyReviews(binds, data.reviewRows) };
            }
            throw new Error(`Unexpected all() SQL: ${sql}`);
          },
          async first<T>() {
            if (sql.includes('SELECT * FROM venues WHERE id = ?')) {
              return (data.venues.find((venue) => venue.id === binds[0]) ?? null) as T | null;
            }
            if (sql.includes('WHERE r.id = ?')) {
              return (data.reviewRows.find((row) => row.id === binds[0]) ?? null) as T | null;
            }
            throw new Error(`Unexpected first() SQL: ${sql}`);
          },
        };
      },
    };
  }
}

describe('reputation read paths', () => {
  it('search ranks venues by reputation instead of raw average', async () => {
    const env = fakeEnv();

    const response = await handleSearchReviews(
      new Request('https://api.test/api/v1/reviews/search?q=Cafe&limit=2'),
      env,
    );
    const body = await response.json() as {
      reviews: Array<{ id: string; signed: boolean; erased: boolean; venue: Venue }>;
      count: number;
      next_cursor: string | null;
    };

    expect(response.status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.reviews.map((review) => review.id)).toEqual(['trusted-review', 'swarm-review']);
    expect(body.reviews[0]).toEqual(expect.objectContaining({
      signed: false,
      erased: false,
      venue: expect.objectContaining({
        id: 'venue-trusted',
        avg_rating: 3.1,
        rep_score: 4.15,
        rep_confidence: 0.82,
        rep_rank: 4.2,
        rep_epoch: 1780000000000,
      }),
    }));
    expect(body.reviews[1].venue).toEqual(expect.objectContaining({
      id: 'venue-swarm',
      avg_rating: 4.9,
      rep_rank: 1.8,
    }));
    expect(body.next_cursor).toBe('1.8:swarm-review');
  });

  it('nearby uses reputation ordering through geohash filtering and returns the query center', async () => {
    const env = fakeEnv();

    const response = await handleNearbyReviews(
      new Request('https://api.test/api/v1/reviews/nearby?lat=40.7128&lng=-74.006&radius_km=2&limit=2'),
      env,
    );
    const body = await response.json() as {
      reviews: Array<{ id: string; venue: Venue }>;
      count: number;
      center: { lat: number; lng: number };
      next_cursor: string | null;
    };

    expect(response.status).toBe(200);
    expect(body.center).toEqual({ lat: 40.7128, lng: -74.006 });
    expect(body.count).toBe(2);
    expect(body.reviews.map((review) => review.id)).toEqual(['trusted-review', 'swarm-review']);
    expect(body.reviews.map((review) => review.venue.rep_rank)).toEqual([4.2, 1.8]);
    expect(body.reviews.map((review) => review.id)).not.toContain('hidden-review');
    expect(body.reviews.map((review) => review.id)).not.toContain('outside-review');
    expect(body.next_cursor).toBe('1.8:swarm-review');
  });

  it('venue details orders reviews by materialized review weight', async () => {
    const env = fakeEnv();

    const response = await handleGetVenue(
      new Request('https://api.test/api/v1/venues/venue-trusted?limit=2'),
      env,
      'venue-trusted',
    );
    const body = await response.json() as {
      venue: Venue;
      reviews: Array<{ id: string; review_rank_weight: number }>;
      next_cursor: string | null;
    };

    expect(response.status).toBe(200);
    expect(body.venue).toEqual(expect.objectContaining({
      id: 'venue-trusted',
      rep_rank: 4.2,
    }));
    expect(body.reviews).toEqual([
      expect.objectContaining({ id: 'heavy-review', review_rank_weight: 0.92 }),
      expect.objectContaining({ id: 'light-review', review_rank_weight: 0.12 }),
    ]);
    expect(body.next_cursor).toBe('0.12:light-review');
  });

  it('direct-link retrieval returns quarantined reviews with under-review state and no detector evidence', async () => {
    const env = fakeEnv();

    const response = await handleGetReviewById(
      new Request('https://api.test/api/v1/reviews/quarantined-review'),
      env,
      'quarantined-review',
    );
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      id: 'quarantined-review',
      moderation_state: 'quarantined',
      under_review: true,
      venue: expect.objectContaining({ id: 'venue-trusted' }),
    }));
    expect(JSON.stringify(body)).not.toContain('suspect_review_ids');
    expect(JSON.stringify(body)).not.toContain('conn_fp');
  });

  it('authenticated authors can retrieve their quarantined review through the direct-link path', async () => {
    const env = fakeEnv();

    const response = await handleGetReviewById(
      new Request('https://api.test/api/v1/reviews/quarantined-review'),
      env,
      'quarantined-review',
      { agent_id: 'agent-1', agent_pseudonym: 'Atlas' },
    );
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      id: 'quarantined-review',
      moderation_state: 'quarantined',
      under_review: true,
      viewer_is_author: true,
    }));
  });

  it('authenticated author feed includes own quarantined reviews but not other agents or soft-hidden rows', async () => {
    const env = fakeEnv();

    const response = await handleMyReviews(
      new Request('https://api.test/api/v1/reviews/agent/me?limit=10'),
      env,
      { agent_id: 'agent-1', agent_pseudonym: 'Atlas' },
    );
    const body = await response.json() as {
      reviews: Array<{ id: string; moderation_state: string; under_review: boolean; viewer_is_author: boolean }>;
      count: number;
    };

    expect(response.status).toBe(200);
    expect(body.reviews.map((review) => review.id)).toContain('quarantined-review');
    expect(body.reviews.find((review) => review.id === 'quarantined-review')).toEqual(expect.objectContaining({
      moderation_state: 'quarantined',
      under_review: true,
      viewer_is_author: true,
    }));
    expect(body.reviews.map((review) => review.id)).not.toContain('other-agent-quarantined-review');
    expect(body.reviews.map((review) => review.id)).not.toContain('hidden-review');
    expect(body.count).toBe(body.reviews.length);
  });

  it('venue details returns 404 for a missing venue', async () => {
    const env = fakeEnv();

    const response = await handleGetVenue(
      new Request('https://api.test/api/v1/venues/missing'),
      env,
      'missing',
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Venue not found' });
  });
});

function fakeEnv(): Env {
  const centerHash = encode(40.7128, -74.006, 6);
  const data: FixtureData = {
    venues: [
      venue({ id: 'venue-trusted', name: 'Trusted Cafe', avg_rating: 3.1, rep_score: 4.15, rep_confidence: 0.82, rep_rank: 4.2 }),
      venue({ id: 'venue-swarm', name: 'Swarm Cafe', avg_rating: 4.9, rep_score: 2.0, rep_confidence: 0.3, rep_rank: 1.8 }),
    ],
    reviewRows: [
      reviewWithVenue({ id: 'swarm-review', venueId: 'venue-swarm', venueName: 'Swarm Cafe', avgRating: 4.9, repScore: 2.0, repConfidence: 0.3, repRank: 1.8, geoHash: centerHash }),
      reviewWithVenue({ id: 'trusted-review', venueId: 'venue-trusted', venueName: 'Trusted Cafe', avgRating: 3.1, repScore: 4.15, repConfidence: 0.82, repRank: 4.2, geoHash: centerHash }),
      reviewWithVenue({ id: 'quarantined-review', venueId: 'venue-trusted', venueName: 'Trusted Cafe', avgRating: 3.1, repScore: 4.15, repConfidence: 0.82, repRank: 4.2, geoHash: centerHash, moderationState: 'quarantined' }),
      reviewWithVenue({ id: 'other-agent-quarantined-review', venueId: 'venue-trusted', venueName: 'Trusted Cafe', avgRating: 3.1, repScore: 4.15, repConfidence: 0.82, repRank: 4.2, geoHash: centerHash, moderationState: 'quarantined', agentId: 'agent-2' }),
      reviewWithVenue({ id: 'hidden-review', venueId: 'venue-trusted', venueName: 'Trusted Cafe', avgRating: 3.1, repScore: 4.15, repConfidence: 0.82, repRank: 4.2, geoHash: centerHash, moderationState: 'soft_hidden' }),
      reviewWithVenue({ id: 'outside-review', venueId: 'venue-outside', venueName: 'Outside Diner', avgRating: 5.0, repScore: 5.0, repConfidence: 1.0, repRank: 9.0, geoHash: 'zzzzzz' }),
    ],
    venueReviewRows: [
      review({ id: 'light-review', venue_id: 'venue-trusted', review_rank_weight: 0.12 }),
      review({ id: 'heavy-review', venue_id: 'venue-trusted', review_rank_weight: 0.92 }),
      review({ id: 'hidden-venue-review', venue_id: 'venue-trusted', moderation_state: 'soft_hidden', review_rank_weight: 1.0 }),
    ],
  };

  return { DB: new FakeReadPathDb(data) as unknown as D1Database };
}

function runReviewSearch(sql: string, binds: unknown[], rows: Row[]): Row[] {
  const searchTerm = String(binds[0]).replaceAll('%', '').toLowerCase();
  return applyLimit(
    applyRepOrderingIfRequested(
      sql,
      rows.filter((row) => isVisible(row) && String(row.v_name).toLowerCase().includes(searchTerm)),
    ),
    binds,
  );
}

function runNearbySearch(sql: string, binds: unknown[], rows: Row[]): Row[] {
  const prefixes = binds.slice(0, 9).map((bind) => String(bind).replace(/%$/, ''));
  return applyLimit(
    applyRepOrderingIfRequested(
      sql,
      rows.filter((row) => isVisible(row) && prefixes.some((prefix) => String(row.v_geo_hash).startsWith(prefix))),
    ),
    binds,
  );
}

function runVenueReviews(sql: string, binds: unknown[], rows: Row[]): Row[] {
  const venueId = binds[0];
  const matching = rows.filter((row) => row.venue_id === venueId && isVisible(row));
  const sorted = sql.includes('ORDER BY COALESCE(rw.decayed_weight, 0) DESC, r.id DESC')
    ? [...matching].sort(compareByScoreThenIdDesc('review_rank_weight'))
    : matching;
  return applyLimit(sorted, binds);
}

function runMyReviews(binds: unknown[], rows: Row[]): Row[] {
  const agentId = binds[0];
  return applyLimit(
    rows
      .filter((row) => row.agent_id === agentId)
      .filter((row) => row.erased_at == null)
      .filter((row) => row.moderation_state === 'visible' || row.moderation_state === 'quarantined')
      .sort((left, right) => String(right.id).localeCompare(String(left.id))),
    binds,
  );
}

function applyRepOrderingIfRequested(sql: string, rows: Row[]): Row[] {
  if (!sql.includes('ORDER BY v.rep_rank DESC, r.id DESC')) {
    return rows;
  }
  return [...rows].sort(compareByScoreThenIdDesc('v_rep_rank'));
}

function compareByScoreThenIdDesc(scoreKey: string) {
  return (left: Row, right: Row): number => {
    const scoreDiff = Number(right[scoreKey]) - Number(left[scoreKey]);
    if (scoreDiff !== 0) return scoreDiff;
    return String(right.id).localeCompare(String(left.id));
  };
}

function applyLimit(rows: Row[], binds: unknown[]): Row[] {
  return rows.slice(0, Number(binds[binds.length - 1]));
}

function isVisible(row: Row): boolean {
  return row.moderation_state === 'visible';
}

function venue(input: {
  id: string;
  name: string;
  avg_rating: number;
  rep_score: number;
  rep_confidence: number;
  rep_rank: number;
}): Venue {
  return {
    id: input.id,
    name: input.name,
    lat: 40.7128,
    lng: -74.006,
    geo_hash: encode(40.7128, -74.006, 6),
    city: 'New York',
    region: 'NY',
    country: 'US',
    external_id: null,
    created_at: 1770000000000,
    review_count: 1,
    avg_rating: input.avg_rating,
    google_rating: null,
    google_review_count: null,
    yelp_rating: null,
    yelp_review_count: null,
    external_ratings_updated_at: null,
    rep_score: input.rep_score,
    rep_confidence: input.rep_confidence,
    rep_rank: input.rep_rank,
    rep_epoch: 1780000000000,
  };
}

function reviewWithVenue(input: {
  id: string;
  venueId: string;
  venueName: string;
  avgRating: number;
  repScore: number;
  repConfidence: number;
  repRank: number;
  geoHash: string;
  moderationState?: string;
  agentId?: string;
}): Row {
  return {
    ...review({
      id: input.id,
      venue_id: input.venueId,
      agent_id: input.agentId ?? 'agent-1',
      moderation_state: input.moderationState ?? 'visible',
    }),
    v_id: input.venueId,
    v_name: input.venueName,
    v_lat: 40.7128,
    v_lng: -74.006,
    v_geo_hash: input.geoHash,
    v_city: 'New York',
    v_region: 'NY',
    v_country: 'US',
    v_external_id: null,
    v_created_at: 1770000000000,
    v_review_count: 1,
    v_avg_rating: input.avgRating,
    v_google_rating: null,
    v_google_review_count: null,
    v_yelp_rating: null,
    v_yelp_review_count: null,
    v_external_ratings_updated_at: null,
    v_rep_score: input.repScore,
    v_rep_confidence: input.repConfidence,
    v_rep_rank: input.repRank,
    v_rep_epoch: 1780000000000,
  };
}

function review(overrides: Row): Row {
  return {
    id: 'review',
    agent_pseudonym: 'Atlas',
    agent_id: 'agent-1',
    agent_username: 'atlas',
    venue_id: 'venue-trusted',
    category: 'coffee',
    rating: 5,
    title: 'Useful signal',
    body: 'Good enough to recommend.',
    tags: null,
    poop_cleanliness: null,
    poop_privacy: null,
    poop_tp_quality: null,
    poop_phone_shelf: null,
    poop_bidet: null,
    photo_keys: null,
    created_at: 1770000000000,
    updated_at: null,
    expires_at: null,
    source: 'test',
    upvotes: 0,
    downvotes: 0,
    flag_count: 0,
    flag_pressure: 0,
    moderation_state: 'visible',
    moderation_updated_at: null,
    agent_pub: null,
    sig: null,
    sig_nonce: null,
    content_hash: null,
    canon_payload: null,
    sig_alg: null,
    signed: 0,
    log_seq: null,
    erased_at: null,
    erasure_log_seq: null,
    ...overrides,
  };
}
