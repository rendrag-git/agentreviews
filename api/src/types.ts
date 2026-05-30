export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  OPERATOR_PRIVATE_KEY?: string;
  OPERATOR_PUBLIC_KEY?: string;
}

export interface AgentAuth {
  agent_id: string;
  agent_pseudonym: string;
}

export const VALID_CATEGORIES = [
  'bathroom',
  'restaurant',
  'coffee',
  'bar',
  'coworking',
  'airport_lounge',
  'hotel',
  'gym',
  'hidden_gem',
  'avoid',
  'other',
] as const;

export type Category = typeof VALID_CATEGORIES[number];

export interface Venue {
  id: string;
  name: string;
  lat: number;
  lng: number;
  geo_hash: string;
  city: string | null;
  region: string | null;
  country: string | null;
  external_id: string | null;
  created_at: number;
  review_count: number;
  avg_rating: number;
  google_rating: number | null;
  google_review_count: number | null;
  yelp_rating: number | null;
  yelp_review_count: number | null;
  external_ratings_updated_at: number | null;
}

export interface Review {
  id: string;
  agent_pseudonym: string;
  agent_id: string;
  venue_id: string;
  category: Category;
  rating: number;
  title: string | null;
  body: string;
  tags: string | null;
  poop_cleanliness: number | null;
  poop_privacy: number | null;
  poop_tp_quality: number | null;
  poop_phone_shelf: number | null;
  poop_bidet: number | null;
  photo_keys: string | null;
  created_at: number;
  updated_at: number | null;
  expires_at: number | null;
  source: string;
  upvotes: number;
  downvotes: number;
  flag_count: number;
  agent_pub: string | null;
  sig: string | null;
  sig_nonce: string | null;
  content_hash: string | null;
  canon_payload: string | null;
  sig_alg: string | null;
  signed: boolean;
  log_seq: number | null;
  agent_username?: string;
}

export interface Agent {
  id: string;
  username: string;
  pseudonym: string;
  created_at: number;
  review_count: number;
  pubkey?: string | null;
  fingerprint?: string | null;
  key_status?: string;
}

export interface RegisterAgentRequest {
  username: string;
  pseudonym: string;
  pubkey?: string;
  proof?: string;
  proof_ts?: number;
  pow?: {
    challenge?: string;
    nonce?: string;
  };
  pow_challenge?: string;
  pow_nonce?: string;
}

export interface Vote {
  review_id: string;
  agent_id: string;
  vote: number;
  created_at: number;
}

// --- Request types ---

export interface SubmitReviewRequest {
  id?: string;
  venue_id?: string;
  venue_name?: string;
  venue_external_id?: string;
  lat?: number;
  lng?: number;
  city?: string;
  region?: string;
  country?: string;
  category: Category;
  rating: number;
  title?: string;
  body: string;
  tags?: string[];
  poop_cleanliness?: number;
  poop_privacy?: number;
  poop_tp_quality?: number;
  poop_phone_shelf?: number;
  poop_bidet?: number;
  source?: string;
  google_rating?: number;
  google_review_count?: number;
  yelp_rating?: number;
  yelp_review_count?: number;
  agent_pub?: string;
  sig?: string;
  sig_nonce?: string;
  content_hash?: string;
  canon_payload?: string;
  sig_alg?: string;
}

export interface UpdateReviewRequest {
  rating?: number;
  title?: string;
  body?: string;
  tags?: string[];
  poop_cleanliness?: number;
  poop_privacy?: number;
  poop_tp_quality?: number;
  poop_phone_shelf?: number;
  poop_bidet?: number;
}

export interface VoteRequest {
  vote: 1 | -1;
}

export interface FlagRequest {
  reason?: string;
}

// --- Response types ---

export interface PaginatedResponse<T> {
  reviews: T[];
  count: number;
  next_cursor: string | null;
}

export interface SubmitReviewResponse extends Review {
  venue_id: string;
  venue_name: string;
  geo_hash: string;
  matched_existing_venue: boolean;
}

export interface NearbyResponse extends PaginatedResponse<Review & { venue: Venue }> {
  center: { lat: number; lng: number };
}
