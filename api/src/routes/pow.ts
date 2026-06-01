import type { Env, RegisterAgentRequest } from '../types';
import { ulid } from '../lib/ulid';
import { challengeDifficulty, verifyPow } from '../lib/pow';

const POW_WINDOW_MS = 10 * 60 * 1000;
const POW_TTL_MS = 10 * 60 * 1000;

export async function handlePowChallenge(request: Request, env: Env): Promise<Response> {
  const now = Date.now();
  const bucket = registrationBucket(request);
  const url = new URL(request.url);
  const username = normalizeUsername(url.searchParams.get('username') ?? '');

  if (!username) {
    return Response.json(
      { error: 'Missing required query parameter: username' },
      { status: 400 },
    );
  }

  const pubkeySha256 = await pubkeyHash(url.searchParams.get('pubkey'));
  const difficulty = await currentPowDifficulty(env, bucket, now);
  const challenge = challengeString(bucket, username, pubkeySha256, ulid(), now);
  const expiresAt = now + POW_TTL_MS;

  await env.DB.prepare(
    `INSERT INTO pow_challenges (
      challenge, difficulty, asn_bucket, username, pubkey_sha256, issued_at, expires_at, consumed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(challenge, difficulty, bucket, username, pubkeySha256, now, expiresAt, null)
    .run();

  return Response.json({
    challenge,
    difficulty,
    required: difficulty > 0,
    alg: 'sha256-leading-zero-bits',
    asn_bucket: bucket,
    expires_at: expiresAt,
  });
}

export async function currentPowDifficulty(
  env: Env,
  bucket: string,
  now = Date.now(),
): Promise<number> {
  const pressure = await currentPowPressure(env, bucket, now);
  return challengeDifficulty(pressure);
}

export async function validateRegistrationPow(
  env: Env,
  bucket: string,
  body: RegisterAgentRequest,
  normalizedUsername?: string,
  now = Date.now(),
): Promise<{ ok: true; challenge: string | null } | { ok: false; response: Response }> {
  const username = normalizeUsername(normalizedUsername ?? body.username);
  const pubkeySha256 = await pubkeyHash(body.pubkey);
  const powChallenge = body.pow_challenge ?? body.pow?.challenge;
  const powNonce = body.pow_nonce ?? body.pow?.nonce;

  if (!powChallenge && !powNonce) {
    const reservation = await reserveFreeRegistrationSlot(env, bucket, username, pubkeySha256, now);
    const pressureBeforeReservation = Math.max(0, reservation.pressure - 1);
    const requiredDifficulty = challengeDifficulty(pressureBeforeReservation);

    if (requiredDifficulty === 0) {
      return { ok: true, challenge: reservation.challenge };
    }

    await releaseRegistrationPow(env, reservation.challenge);
    return {
      ok: false,
      response: Response.json({
        error: 'Proof-of-work required',
        pow_required: true,
        difficulty: requiredDifficulty,
        challenge_url: challengeUrl(username, body.pubkey),
      }, { status: 429 }),
    };
  }

  const requiredDifficulty = await currentPowDifficulty(env, bucket, now);
  if (!powChallenge || !powNonce) {
    return {
      ok: false,
      response: Response.json({
        error: 'Proof-of-work required',
        pow_required: true,
        difficulty: requiredDifficulty,
        challenge_url: challengeUrl(username, body.pubkey),
      }, { status: 429 }),
    };
  }

  const challenge = await env.DB.prepare(
    `SELECT challenge, difficulty, asn_bucket, username, pubkey_sha256, expires_at, consumed_at
     FROM pow_challenges
     WHERE challenge = ?`,
  )
    .bind(powChallenge)
    .first<{
      challenge: string;
      difficulty: number;
      asn_bucket: string;
      username: string;
      pubkey_sha256: string | null;
      expires_at: number;
      consumed_at: number | null;
    }>();

  if (
    !challenge
    || challenge.asn_bucket !== bucket
    || challenge.username !== username
    || challenge.pubkey_sha256 !== pubkeySha256
    || challenge.consumed_at != null
    || challenge.expires_at < now
  ) {
    return {
      ok: false,
      response: Response.json({ error: 'Invalid or expired proof-of-work challenge' }, { status: 400 }),
    };
  }

  if (challenge.difficulty < requiredDifficulty) {
    return {
      ok: false,
      response: Response.json(
        { error: 'Stale proof-of-work challenge', pow_required: true, difficulty: requiredDifficulty },
        { status: 409 },
      ),
    };
  }

  const difficulty = challenge.difficulty;
  if (!(await verifyPow(challenge.challenge, powNonce, difficulty))) {
    return {
      ok: false,
      response: Response.json({ error: 'Invalid proof-of-work nonce', difficulty }, { status: 400 }),
    };
  }

  return { ok: true, challenge: challenge.challenge };
}

export async function purgeExpiredPowChallenges(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare(
    'DELETE FROM pow_challenges WHERE expires_at <= ? OR consumed_at IS NOT NULL',
  )
    .bind(now)
    .run();
}

export async function releaseRegistrationPow(env: Env, challenge: string | null): Promise<void> {
  if (!challenge) return;
  await env.DB.prepare('DELETE FROM pow_challenges WHERE challenge = ? AND consumed_at IS NULL')
    .bind(challenge)
    .run();
}

export function registrationBucket(request: Request): string {
  const url = new URL(request.url);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
    const localAsn = request.headers.get('x-agentreviews-asn');
    if (localAsn && /^[0-9]{1,10}$/.test(localAsn)) {
      return `asn:${localAsn}`;
    }
  }

  const cf = request.cf as { asn?: number } | undefined;
  if (cf?.asn) return `asn:${cf.asn}`;

  return 'asn:unknown';
}

async function reserveFreeRegistrationSlot(
  env: Env,
  bucket: string,
  username: string,
  pubkeySha256: string | null,
  now: number,
): Promise<{ challenge: string; pressure: number }> {
  const challenge = challengeString(bucket, username, pubkeySha256, ulid(), now);
  const expiresAt = now + POW_TTL_MS;

  await env.DB.prepare(
    `INSERT INTO pow_challenges (
      challenge, difficulty, asn_bucket, username, pubkey_sha256, issued_at, expires_at, consumed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(challenge, 0, bucket, username, pubkeySha256, now, expiresAt, null)
    .run();

  return {
    challenge,
    pressure: await currentPowPressure(env, bucket, now),
  };
}

async function currentPowPressure(env: Env, bucket: string, now: number): Promise<number> {
  const registrations = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM agents WHERE registration_asn_bucket = ? AND created_at >= ?',
  )
    .bind(bucket, now - POW_WINDOW_MS)
    .first<{ count: number }>();

  const openChallenges = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM pow_challenges WHERE asn_bucket = ? AND issued_at >= ? AND consumed_at IS NULL',
  )
    .bind(bucket, now - POW_WINDOW_MS)
    .first<{ count: number }>();

  return (registrations?.count ?? 0) + (openChallenges?.count ?? 0);
}

function challengeString(
  bucket: string,
  username: string,
  pubkeySha256: string | null,
  id: string,
  now: number,
): string {
  return [
    'agentreviews-pow',
    bucket,
    username,
    pubkeySha256 ?? 'legacy',
    id,
    String(now),
  ].join('\n');
}

function challengeUrl(username: string, pubkey?: string): string {
  const params = new URLSearchParams({ username });
  if (pubkey) params.set('pubkey', pubkey);
  return `/api/v1/pow/challenge?${params.toString()}`;
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

async function pubkeyHash(pubkey?: string | null): Promise<string | null> {
  if (!pubkey) return null;
  const bytes = new TextEncoder().encode(pubkey);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
