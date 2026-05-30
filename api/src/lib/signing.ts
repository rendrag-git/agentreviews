import * as ed25519 from '@noble/ed25519';
import { canonicalize, type CanonicalJson } from './canonicalize';

const SIGNATURE_ALG = 'Ed25519';
const SIGNING_DOMAIN = 0x00;
const PRIVATE_KEY_PKCS8_PREFIX = 'pkcs8:';
const PRIVATE_KEY_SEED_PREFIX = 'seed:';

export interface SigningKeyPair {
  alg: typeof SIGNATURE_ALG;
  runtime: SigningRuntime;
  publicKey: string;
  privateKey: string;
}

export interface SignedPayload {
  sigAlg: typeof SIGNATURE_ALG;
  signature: string;
  contentHash: string;
  canonPayload: string;
}

export type SigningRuntime = 'webcrypto' | 'noble';

export interface GenerateSigningKeyPairOptions {
  runtime?: SigningRuntime;
}

let runtimePromise: Promise<SigningRuntime> | undefined;

export async function getSigningRuntime(): Promise<SigningRuntime> {
  runtimePromise ??= detectSigningRuntime();
  return runtimePromise;
}

export async function generateSigningKeyPair(
  options: GenerateSigningKeyPairOptions = {},
): Promise<SigningKeyPair> {
  const runtime = options.runtime ?? (await getSigningRuntime());

  if (runtime === 'webcrypto') {
    const keyPair = await crypto.subtle.generateKey(
      { name: SIGNATURE_ALG },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const publicKey = await crypto.subtle.exportKey('raw', keyPair.publicKey) as ArrayBuffer;
    const privateKey = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey) as ArrayBuffer;

    return {
      alg: SIGNATURE_ALG,
      runtime,
      publicKey: bytesToBase64Url(new Uint8Array(publicKey)),
      privateKey: PRIVATE_KEY_PKCS8_PREFIX + bytesToBase64Url(new Uint8Array(privateKey)),
    };
  }

  const { secretKey, publicKey } = await ed25519.keygenAsync();
  return {
    alg: SIGNATURE_ALG,
    runtime,
    publicKey: bytesToBase64Url(publicKey),
    privateKey: PRIVATE_KEY_SEED_PREFIX + bytesToBase64Url(secretKey),
  };
}

export async function signPayload(
  payload: CanonicalJson,
  privateKey: string,
): Promise<SignedPayload> {
  const canonPayload = canonicalize(payload, { omitNullish: true });
  const signedBytes = signingBytes(canonPayload);
  const signature = await signBytes(signedBytes, privateKey);
  const contentHash = await sha256(signedBytes);

  return {
    sigAlg: SIGNATURE_ALG,
    signature: bytesToBase64Url(signature),
    contentHash: bytesToBase64Url(contentHash),
    canonPayload,
  };
}

export async function verifySignedPayload(
  signed: SignedPayload,
  publicKey: string,
): Promise<boolean> {
  if (signed.sigAlg !== SIGNATURE_ALG) return false;

  const signedBytes = signingBytes(signed.canonPayload);
  const expectedHash = bytesToBase64Url(await sha256(signedBytes));
  if (signed.contentHash !== expectedHash) return false;

  return verifyBytes(
    base64UrlToBytes(signed.signature),
    signedBytes,
    base64UrlToBytes(publicKey),
  );
}

async function signBytes(bytes: Uint8Array, privateKey: string): Promise<Uint8Array> {
  if (privateKey.startsWith(PRIVATE_KEY_PKCS8_PREFIX)) {
    const key = await crypto.subtle.importKey(
      'pkcs8',
      base64UrlToBytes(privateKey.slice(PRIVATE_KEY_PKCS8_PREFIX.length)),
      { name: SIGNATURE_ALG },
      false,
      ['sign'],
    );
    return new Uint8Array(await crypto.subtle.sign(SIGNATURE_ALG, key, bytes));
  }

  if (privateKey.startsWith(PRIVATE_KEY_SEED_PREFIX)) {
    return ed25519.signAsync(
      bytes,
      base64UrlToBytes(privateKey.slice(PRIVATE_KEY_SEED_PREFIX.length)),
    );
  }

  throw new TypeError('Unsupported private key encoding');
}

async function verifyBytes(
  signature: Uint8Array,
  bytes: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  if (await getSigningRuntime() === 'webcrypto') {
    try {
      const key = await crypto.subtle.importKey(
        'raw',
        publicKey,
        { name: SIGNATURE_ALG },
        false,
        ['verify'],
      );
      return crypto.subtle.verify(SIGNATURE_ALG, key, signature, bytes);
    } catch {
      return false;
    }
  }

  try {
    return await ed25519.verifyAsync(signature, bytes, publicKey);
  } catch {
    return false;
  }
}

async function detectSigningRuntime(): Promise<SigningRuntime> {
  try {
    const keyPair = await crypto.subtle.generateKey(
      { name: SIGNATURE_ALG },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const message = new Uint8Array([SIGNING_DOMAIN, 1, 2, 3]);
    const signature = await crypto.subtle.sign(SIGNATURE_ALG, keyPair.privateKey, message);
    const valid = await crypto.subtle.verify(SIGNATURE_ALG, keyPair.publicKey, signature, message);
    return valid ? 'webcrypto' : 'noble';
  } catch {
    return 'noble';
  }
}

function signingBytes(canonPayload: string): Uint8Array {
  const payloadBytes = new TextEncoder().encode(canonPayload);
  const bytes = new Uint8Array(payloadBytes.length + 1);
  bytes[0] = SIGNING_DOMAIN;
  bytes.set(payloadBytes, 1);
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
