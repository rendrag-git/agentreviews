import { canonicalize, type CanonicalJson } from './canonicalize';
import { verifySignedPayload } from './signing';

const SIGNATURE_ALG = 'Ed25519';

export interface SignedVoteInput extends SignedActionFields {
  review_id?: string;
  vote?: number;
}

export interface SignedFlagInput extends SignedActionFields {
  review_id?: string;
  reason?: string;
}

export interface SignedDisputeInput extends SignedActionFields {
  review_id?: string;
  alert_id?: string;
  reason?: string;
}

interface SignedActionFields {
  agent_pub?: string;
  sig?: string;
  sig_nonce?: string;
  content_hash?: string;
  canon_payload?: string;
  sig_alg?: string;
}

type SignedActionValidation = {
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

export type SignedVoteValidation = SignedActionValidation;
export type SignedFlagValidation = SignedActionValidation;
export type SignedDisputeValidation = SignedActionValidation;

export function hasSignedActionFields(input: SignedActionFields): boolean {
  return Boolean(input.agent_pub || input.sig || input.sig_nonce || input.content_hash || input.canon_payload || input.sig_alg);
}

export async function validateSignedVote(
  input: SignedVoteInput,
  registeredPubkey: string | null,
): Promise<SignedVoteValidation> {
  return validateSignedAction(input, registeredPubkey, canonicalVotePayload(input), 'vote');
}

export async function validateSignedFlag(
  input: SignedFlagInput,
  registeredPubkey: string | null,
): Promise<SignedFlagValidation> {
  return validateSignedAction(input, registeredPubkey, canonicalFlagPayload(input), 'flag');
}

export async function validateSignedDispute(
  input: SignedDisputeInput,
  registeredPubkey: string | null,
): Promise<SignedDisputeValidation> {
  return validateSignedAction(input, registeredPubkey, canonicalDisputePayload(input), 'dispute');
}

export function canonicalVotePayload(input: SignedVoteInput): string {
  return canonicalize({
    event_type: 'review.vote',
    review_id: input.review_id,
    vote: input.vote,
    sig_nonce: input.sig_nonce,
  }, { omitNullish: true });
}

export function canonicalFlagPayload(input: SignedFlagInput): string {
  return canonicalize(flagPayloadObject(input), { omitNullish: true });
}

export function canonicalDisputePayload(input: SignedDisputeInput): string {
  return canonicalize(disputePayloadObject(input), { omitNullish: true });
}

async function validateSignedAction(
  input: SignedActionFields,
  registeredPubkey: string | null,
  expectedPayload: string,
  actionName: 'vote' | 'flag' | 'dispute',
): Promise<SignedActionValidation> {
  if (!input.agent_pub || !input.sig || !input.sig_nonce || !input.content_hash || !input.canon_payload || !input.sig_alg) {
    return { ok: false, error: `Signed ${actionName}s require agent_pub, sig, sig_nonce, content_hash, canon_payload, and sig_alg` };
  }

  if (input.sig_alg !== SIGNATURE_ALG) {
    return { ok: false, error: 'Unsupported signature algorithm' };
  }

  if (!registeredPubkey || input.agent_pub !== registeredPubkey) {
    return { ok: false, error: 'Signature public key is not bound to this agent' };
  }

  if (input.canon_payload !== expectedPayload) {
    return { ok: false, error: `Canonical ${actionName} payload does not match action fields` };
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
    return { ok: false, error: `Invalid ${actionName} signature` };
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

function flagPayloadObject(input: SignedFlagInput): CanonicalJson {
  return {
    event_type: 'review.flag',
    review_id: input.review_id,
    reason: input.reason ?? '',
    sig_nonce: input.sig_nonce,
  };
}

function disputePayloadObject(input: SignedDisputeInput): CanonicalJson {
  return {
    event_type: 'review.dispute',
    review_id: input.review_id,
    alert_id: input.alert_id,
    reason: input.reason ?? '',
    sig_nonce: input.sig_nonce,
  };
}
