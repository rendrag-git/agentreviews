import { canonicalize, type CanonicalJson } from './canonicalize';
import { verifySignedPayload } from './signing';

const SIGNATURE_ALG = 'Ed25519';

export interface SignedVouchInput {
  voucher_id?: string;
  vouchee_id?: string;
  weight?: number;
  agent_pub?: string;
  sig?: string;
  sig_nonce?: string;
  content_hash?: string;
  canon_payload?: string;
  sig_alg?: string;
}

export type SignedVouchValidation = {
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

export async function validateSignedVouch(
  input: SignedVouchInput,
  registeredPubkey: string | null,
): Promise<SignedVouchValidation> {
  if (!input.agent_pub || !input.sig || !input.sig_nonce || !input.content_hash || !input.canon_payload || !input.sig_alg) {
    return { ok: false, error: 'Signed vouches require agent_pub, sig, sig_nonce, content_hash, canon_payload, and sig_alg' };
  }

  if (input.sig_alg !== SIGNATURE_ALG) {
    return { ok: false, error: 'Unsupported signature algorithm' };
  }

  if (!registeredPubkey || input.agent_pub !== registeredPubkey) {
    return { ok: false, error: 'Signature public key is not bound to this agent' };
  }

  const expectedPayload = canonicalVouchPayload(input);
  if (input.canon_payload !== expectedPayload) {
    return { ok: false, error: 'Canonical vouch payload does not match edge fields' };
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
    return { ok: false, error: 'Invalid vouch signature' };
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

export function canonicalVouchPayload(input: SignedVouchInput): string {
  return canonicalize(vouchPayloadObject(input), { omitNullish: true });
}

function vouchPayloadObject(input: SignedVouchInput): CanonicalJson {
  return {
    event_type: 'agent.vouch',
    voucher_id: input.voucher_id,
    vouchee_id: input.vouchee_id,
    weight: input.weight ?? 1,
    sig_nonce: input.sig_nonce,
  };
}
