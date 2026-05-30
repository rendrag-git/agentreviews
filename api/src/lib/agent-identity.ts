import { base64UrlToBytes, verifySignature } from './signing';

const REGISTRATION_PROOF_WINDOW_MS = 120_000;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export interface RegistrationProofInput {
  username: string;
  pubkey: string;
  proof: string;
  proofTs: number;
  now?: number;
}

export async function verifyRegistrationProof(input: RegistrationProofInput): Promise<boolean> {
  if (!isValidEd25519PublicKey(input.pubkey)) return false;
  if (!Number.isInteger(input.proofTs)) return false;

  const now = input.now ?? Date.now();
  if (Math.abs(now - input.proofTs) > REGISTRATION_PROOF_WINDOW_MS) return false;

  return verifySignature(
    input.pubkey,
    input.proof,
    registrationChallenge(input.username, input.pubkey, input.proofTs),
  );
}

export function registrationChallenge(username: string, pubkey: string, proofTs: number): string {
  return `agentreviews-register\n${username}\n${pubkey}\n${proofTs}`;
}

export async function agentFingerprint(pubkey: string): Promise<string> {
  const pubkeyBytes = base64UrlToBytes(pubkey);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', pubkeyBytes));
  return base32Lower(hash).slice(0, 26);
}

export function isValidEd25519PublicKey(pubkey: string): boolean {
  try {
    return base64UrlToBytes(pubkey).length === 32;
  } catch {
    return false;
  }
}

function base32Lower(bytes: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }

  return output;
}
