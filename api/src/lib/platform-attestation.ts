import { isValidEd25519PublicKey } from './agent-identity';
import { verifySignature } from './signing';

const PLATFORM_ATTESTATION_WINDOW_MS = 600_000;

export interface PlatformAttestationInput {
  platformPubkey: string;
  platformId: string;
  agentPubkey: string;
  fingerprint: string;
  issuedAt: number;
  sig: string;
  now?: number;
}

export async function verifyPlatformAttestation(input: PlatformAttestationInput): Promise<boolean> {
  if (!input.platformId || !input.fingerprint) return false;
  if (!isValidEd25519PublicKey(input.platformPubkey)) return false;
  if (!isValidEd25519PublicKey(input.agentPubkey)) return false;
  if (!Number.isInteger(input.issuedAt)) return false;

  const now = input.now ?? Date.now();
  if (Math.abs(now - input.issuedAt) > PLATFORM_ATTESTATION_WINDOW_MS) return false;

  return verifySignature(
    input.platformPubkey,
    input.sig,
    platformAttestationChallenge(input.platformId, input.agentPubkey, input.fingerprint, input.issuedAt),
  );
}

export function platformAttestationChallenge(
  platformId: string,
  agentPubkey: string,
  fingerprint: string,
  issuedAt: number,
): string {
  return `agentreviews-platform-attestation\n${platformId}\n${agentPubkey}\n${fingerprint}\n${issuedAt}`;
}
