import { canonicalize, type CanonicalJson } from './canonicalize';
import { verifySignedPayload } from './signing';

const SIGNATURE_ALG = 'Ed25519';

export interface SignedReviewInput {
  id?: string;
  venue_id?: string;
  category?: string;
  rating?: number;
  title?: string | null;
  body?: string;
  tags?: string[];
  poop_cleanliness?: number | null;
  poop_privacy?: number | null;
  poop_tp_quality?: number | null;
  poop_phone_shelf?: number | null;
  poop_bidet?: number | null;
  source?: string;
  agent_pub?: string;
  sig?: string;
  sig_nonce?: string;
  content_hash?: string;
  canon_payload?: string;
  sig_alg?: string;
}

export interface SignedReviewEraseInput {
  review_id?: string;
  erased_content_hash?: string;
  agent_pub?: string;
  sig?: string;
  sig_nonce?: string;
  content_hash?: string;
  canon_payload?: string;
  sig_alg?: string;
}

export type SignedReviewValidation = {
  ok: true;
  canon_payload: string;
  content_hash: string;
  sig: string;
  sig_alg: typeof SIGNATURE_ALG;
  agent_pub: string;
  sig_nonce: string;
} | {
  ok: false;
  error: string;
};

export type SignedReviewEraseValidation = SignedReviewValidation;

export function hasSignedReviewFields(input: SignedReviewInput): boolean {
  return Boolean(
    input.agent_pub ||
    input.sig ||
    input.sig_nonce ||
    input.content_hash ||
    input.canon_payload ||
    input.sig_alg,
  );
}

export async function validateSignedReview(
  input: SignedReviewInput,
  registeredPubkey: string | null,
): Promise<SignedReviewValidation> {
  if (!input.agent_pub || !input.sig || !input.sig_nonce || !input.content_hash || !input.canon_payload || !input.sig_alg) {
    return { ok: false, error: 'Signed reviews require agent_pub, sig, sig_nonce, content_hash, canon_payload, and sig_alg' };
  }

  if (input.sig_alg !== SIGNATURE_ALG) {
    return { ok: false, error: 'Unsupported signature algorithm' };
  }

  if (!registeredPubkey || input.agent_pub !== registeredPubkey) {
    return { ok: false, error: 'Signature public key is not bound to this agent' };
  }

  const expectedPayload = canonicalReviewPayload(input);
  if (input.canon_payload !== expectedPayload) {
    return { ok: false, error: 'Canonical payload does not match review fields' };
  }

  const valid = await verifySignedPayload(
    {
      sigAlg: SIGNATURE_ALG,
      signature: input.sig,
      contentHash: input.content_hash,
      canonPayload: input.canon_payload,
    },
    input.agent_pub,
  );

  if (!valid) {
    return { ok: false, error: 'Invalid review signature' };
  }

  return {
    ok: true,
    agent_pub: input.agent_pub,
    sig: input.sig,
    sig_nonce: input.sig_nonce,
    content_hash: input.content_hash,
    canon_payload: input.canon_payload,
    sig_alg: SIGNATURE_ALG,
  };
}

export async function validateSignedReviewErase(
  input: SignedReviewEraseInput,
  registeredPubkey: string | null,
): Promise<SignedReviewEraseValidation> {
  if (!input.agent_pub || !input.sig || !input.sig_nonce || !input.content_hash || !input.canon_payload || !input.sig_alg) {
    return { ok: false, error: 'Signed review erasure requires agent_pub, sig, sig_nonce, content_hash, canon_payload, and sig_alg' };
  }

  if (input.sig_alg !== SIGNATURE_ALG) {
    return { ok: false, error: 'Unsupported signature algorithm' };
  }

  if (!registeredPubkey || input.agent_pub !== registeredPubkey) {
    return { ok: false, error: 'Signature public key is not bound to this agent' };
  }

  const expectedPayload = canonicalReviewErasePayload(input);
  if (input.canon_payload !== expectedPayload) {
    return { ok: false, error: 'Canonical erase payload does not match review fields' };
  }

  const valid = await verifySignedPayload(
    {
      sigAlg: SIGNATURE_ALG,
      signature: input.sig,
      contentHash: input.content_hash,
      canonPayload: input.canon_payload,
    },
    input.agent_pub,
  );

  if (!valid) {
    return { ok: false, error: 'Invalid review erase signature' };
  }

  return {
    ok: true,
    agent_pub: input.agent_pub,
    sig: input.sig,
    sig_nonce: input.sig_nonce,
    content_hash: input.content_hash,
    canon_payload: input.canon_payload,
    sig_alg: SIGNATURE_ALG,
  };
}

export function canonicalReviewPayload(input: SignedReviewInput): string {
  return canonicalize(reviewPayloadObject(input), { omitNullish: true });
}

export function canonicalReviewErasePayload(input: SignedReviewEraseInput): string {
  return canonicalize(reviewErasePayloadObject(input), { omitNullish: true });
}

function reviewPayloadObject(input: SignedReviewInput): CanonicalJson {
  return {
    id: input.id,
    venue_id: input.venue_id,
    category: input.category,
    rating: input.rating,
    title: input.title,
    body: input.body,
    tags: input.tags,
    poop_cleanliness: input.poop_cleanliness,
    poop_privacy: input.poop_privacy,
    poop_tp_quality: input.poop_tp_quality,
    poop_phone_shelf: input.poop_phone_shelf,
    poop_bidet: input.poop_bidet,
    source: input.source ?? 'explicit',
    sig_nonce: input.sig_nonce,
  };
}

function reviewErasePayloadObject(input: SignedReviewEraseInput): CanonicalJson {
  return {
    event_type: 'review.erase',
    review_id: input.review_id,
    erased_content_hash: input.erased_content_hash,
    sig_nonce: input.sig_nonce,
  };
}
