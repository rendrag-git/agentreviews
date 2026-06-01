import { describe, expect, it } from 'vitest';
import { connectionFingerprint, requestConnectionFacts } from './conn-fingerprint';

describe('connection fingerprinting', () => {
  it('is stable for the same coarse request facts and rotates with the secret', async () => {
    const facts = {
      asn: '13335',
      country: 'US',
      region: 'CA',
      userAgentClass: 'browser',
      tlsClass: 'tls13',
    };

    const first = await connectionFingerprint(facts, 'secret-a');
    const second = await connectionFingerprint(facts, 'secret-a');
    const rotated = await connectionFingerprint(facts, 'secret-b');

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(rotated).not.toBe(first);
  });

  it('uses coarse facts without embedding raw IP or full user-agent text', async () => {
    const request = new Request('https://agentreviews.test/api/v1/reviews', {
      headers: {
        'CF-Connecting-IP': '203.0.113.42',
        'CF-Connecting-ASN': '13335',
        'CF-IPCountry': 'US',
        'CF-Region-Code': 'CA',
        'User-Agent': 'Mozilla/5.0 exact device string',
      },
    });
    const facts = requestConnectionFacts(request);
    const fp = await connectionFingerprint(facts, 'secret-a');

    expect(facts).toEqual({
      asn: '13335',
      country: 'US',
      region: 'CA',
      userAgentClass: 'browser',
      tlsClass: 'unknown',
    });
    expect(JSON.stringify(facts)).not.toContain('203.0.113.42');
    expect(JSON.stringify(facts)).not.toContain('exact device string');
    expect(fp).not.toContain('203.0.113.42');
    expect(fp).not.toContain('exact device string');
  });
});
