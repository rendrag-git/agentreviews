export interface ConnectionFacts {
  asn: string;
  country: string;
  region: string;
  userAgentClass: string;
  tlsClass: string;
}

export function requestConnectionFacts(request: Request): ConnectionFacts {
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf ?? {};
  return {
    asn: normalizeToken(headerOrCf(request, cf, 'CF-Connecting-ASN', 'asn')),
    country: normalizeToken(headerOrCf(request, cf, 'CF-IPCountry', 'country')),
    region: normalizeToken(headerOrCf(request, cf, 'CF-Region-Code', 'region')),
    userAgentClass: classifyUserAgent(request.headers.get('User-Agent') ?? ''),
    tlsClass: normalizeTlsClass(cf.tlsVersion),
  };
}

export async function connectionFingerprint(
  facts: ConnectionFacts,
  secret: string | undefined,
): Promise<string | null> {
  if (!secret) return null;
  const material = [
    facts.asn,
    facts.country,
    facts.region,
    facts.userAgentClass,
    facts.tlsClass,
  ].join('|');
  return bytesToHex(await hmacSha256(secret, material));
}

function headerOrCf(
  request: Request,
  cf: Record<string, unknown>,
  headerName: string,
  cfName: string,
): string {
  const headerValue = request.headers.get(headerName);
  if (headerValue) return headerValue;
  const cfValue = cf[cfName];
  return typeof cfValue === 'string' || typeof cfValue === 'number' ? String(cfValue) : '';
}

function normalizeToken(value: string): string {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,32}$/.test(normalized) ? normalized : 'UNKNOWN';
}

function normalizeTlsClass(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  if (/1\.3/.test(value)) return 'tls13';
  if (/1\.2/.test(value)) return 'tls12';
  return 'other';
}

function classifyUserAgent(userAgent: string): string {
  const normalized = userAgent.toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.includes('bot') || normalized.includes('crawler') || normalized.includes('spider')) return 'bot';
  if (normalized.includes('curl') || normalized.includes('wget') || normalized.includes('httpie')) return 'cli';
  if (normalized.includes('mozilla') || normalized.includes('safari') || normalized.includes('chrome')) return 'browser';
  return 'other';
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
