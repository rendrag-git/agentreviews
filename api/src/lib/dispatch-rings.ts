export type DispatchSeverity = 'warn' | 'critical';

export interface DispatchRingReview {
  id: string;
  venue_id: string;
  agent_id: string;
  body: string | null;
  tags?: string[] | string | null;
  rating?: number | null;
  created_at: number;
  agent_created_at: number;
  vouch_ancestor_id?: string | null;
  conn_fp?: string | null;
  conn_fp_prevalence?: number | null;
}

export interface DispatchRingInput {
  now: number;
  reviews: DispatchRingReview[];
  minMembers?: number;
}

export interface DispatchRingDetection {
  type: 'dispatch.suspected';
  severity: DispatchSeverity;
  ring_id: string;
  venue_id: string;
  score: number;
  member_agent_ids: string[];
  suspect_review_ids: string[];
  cluster_id: string;
  evidence: {
    feature_count: number;
    f_lineage: number;
    f_content: number;
    f_temporal: number;
    f_cohort: number;
    f_infra: number;
  };
}

const SIGNATURE_SIZE = 32;
const SHINGLE_SIZE = 3;
const WARN_THRESHOLD = 0.6;
const CRITICAL_THRESHOLD = 0.8;
const MIN_FEATURES = 3;
const DEFAULT_MIN_MEMBERS = 4;
const TEMPORAL_WINDOW_MS = 120_000;
const COHORT_WINDOW_MS = 24 * 60 * 60 * 1000;
const FIRST_ACTION_WINDOW_MS = 60 * 60 * 1000;

export function minhashSignature(text: string, size = SIGNATURE_SIZE): number[] {
  const shingles = shinglesFor(text);
  return Array.from({ length: size }, (_, seed) => {
    let min = 0xffffffff;
    for (const shingle of shingles) {
      min = Math.min(min, hash32(`${seed}:${shingle}`));
    }
    return min;
  });
}

export function estimateJaccard(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  if (size === 0) return 0;
  let matches = 0;
  for (let index = 0; index < size; index += 1) {
    if (left[index] === right[index]) matches += 1;
  }
  return round(matches / size);
}

export function trueShingleJaccard(left: string, right: string): number {
  const leftSet = new Set(shinglesFor(left));
  const rightSet = new Set(shinglesFor(right));
  if (leftSet.size === 0 && rightSet.size === 0) return 1;
  const intersection = [...leftSet].filter((value) => rightSet.has(value)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return round(intersection / union);
}

export function shingleCount(text: string): number {
  return shinglesFor(text).length;
}

export function detectDispatchRings(input: DispatchRingInput): DispatchRingDetection[] {
  const minMembers = input.minMembers ?? DEFAULT_MIN_MEMBERS;
  const byVenue = new Map<string, DispatchRingReview[]>();
  for (const review of input.reviews) {
    const reviews = byVenue.get(review.venue_id) ?? [];
    reviews.push(review);
    byVenue.set(review.venue_id, reviews);
  }

  return [...byVenue.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([venueId, reviews]) => detectVenueRings(venueId, reviews, input.now, minMembers));
}

function detectVenueRings(
  venueId: string,
  reviews: DispatchRingReview[],
  now: number,
  minMembers: number,
): DispatchRingDetection[] {
  const candidates = reviews.filter((review) => review.body && review.body.trim().length > 0);
  if (candidates.length < minMembers) return [];

  const signatures = new Map(candidates.map((review) => [review.id, minhashSignature(review.body ?? '')]));
  const links = new Map(candidates.map((review) => [review.agent_id, new Set<string>()]));
  let strongest: DispatchRingDetection['evidence'] | null = null;
  let strongestScore = 0;

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      const evidence = pairEvidence(left, right, signatures, now);
      const featureCount = Object.values(evidence).filter((value) => value > 0).length;
      const score = dispatchScore(evidence);
      if (featureCount >= MIN_FEATURES && score >= WARN_THRESHOLD) {
        links.get(left.agent_id)?.add(right.agent_id);
        links.get(right.agent_id)?.add(left.agent_id);
        if (score > strongestScore) {
          strongestScore = score;
          strongest = { ...evidence, feature_count: featureCount };
        }
      }
    }
  }

  const components = connectedComponents(links)
    .map((agentIds) => candidates.filter((review) => agentIds.includes(review.agent_id)))
    .filter((component) => component.length >= minMembers);

  return components.map((component) => {
    const memberAgentIds = component.map((review) => review.agent_id).sort();
    const suspectReviewIds = component.map((review) => review.id).sort();
    const clusterId = `ring:${venueId}:${stableHash(memberAgentIds.join('|'))}`;
    return {
      type: 'dispatch.suspected',
      severity: strongestScore >= CRITICAL_THRESHOLD ? 'critical' : 'warn',
      ring_id: clusterId,
      venue_id: venueId,
      score: round(strongestScore),
      member_agent_ids: memberAgentIds,
      suspect_review_ids: suspectReviewIds,
      cluster_id: clusterId,
      evidence: strongest ?? {
        feature_count: 0,
        f_lineage: 0,
        f_content: 0,
        f_temporal: 0,
        f_cohort: 0,
        f_infra: 0,
      },
    };
  });
}

function pairEvidence(
  left: DispatchRingReview,
  right: DispatchRingReview,
  signatures: Map<string, number[]>,
  now: number,
): Omit<DispatchRingDetection['evidence'], 'feature_count'> {
  const content = estimateJaccard(signatures.get(left.id) ?? [], signatures.get(right.id) ?? []);
  const sameLineage = Boolean(left.vouch_ancestor_id && left.vouch_ancestor_id === right.vouch_ancestor_id);
  const temporalGap = Math.abs(left.created_at - right.created_at);
  const sameCohort = Math.abs(left.agent_created_at - right.agent_created_at) <= COHORT_WINDOW_MS &&
    now - left.agent_created_at <= COHORT_WINDOW_MS &&
    now - right.agent_created_at <= COHORT_WINDOW_MS;
  const quickFirstAction = left.created_at - left.agent_created_at <= FIRST_ACTION_WINDOW_MS &&
    right.created_at - right.agent_created_at <= FIRST_ACTION_WINDOW_MS;
  const sharedConn = Boolean(left.conn_fp && left.conn_fp === right.conn_fp);
  const prevalence = Math.max(
    0,
    Math.min(1, Math.max(left.conn_fp_prevalence ?? 1, right.conn_fp_prevalence ?? 1)),
  );

  return {
    f_lineage: sameLineage ? 1 : 0,
    f_content: content >= 0.6 ? content : 0,
    f_temporal: temporalGap <= TEMPORAL_WINDOW_MS ? 1 : 0,
    f_cohort: sameCohort && quickFirstAction ? 1 : 0,
    f_infra: sharedConn ? round(1 - prevalence) : 0,
  };
}

function dispatchScore(evidence: Omit<DispatchRingDetection['evidence'], 'feature_count'>): number {
  const z = -4 +
    2.5 * evidence.f_lineage +
    2.0 * evidence.f_content +
    1.5 * evidence.f_temporal +
    1.5 * evidence.f_cohort +
    1.0 * evidence.f_infra;
  return round(1 / (1 + Math.exp(-z)));
}

function connectedComponents(links: Map<string, Set<string>>): string[][] {
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const agentId of [...links.keys()].sort()) {
    if (seen.has(agentId)) continue;
    const stack = [agentId];
    const component: string[] = [];
    while (stack.length > 0) {
      const next = stack.pop();
      if (!next || seen.has(next)) continue;
      seen.add(next);
      component.push(next);
      stack.push(...[...(links.get(next) ?? [])].filter((linked) => !seen.has(linked)));
    }
    components.push(component.sort());
  }
  return components;
}

function shinglesFor(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (tokens.length <= SHINGLE_SIZE) return [tokens.join(' ')].filter(Boolean);
  const shingles: string[] = [];
  for (let index = 0; index <= tokens.length - SHINGLE_SIZE; index += 1) {
    shingles.push(tokens.slice(index, index + SHINGLE_SIZE).join(' '));
  }
  return shingles.length > 0 ? shingles : [''];
}

function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function stableHash(value: string): string {
  return hash32(value).toString(16).padStart(8, '0');
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
