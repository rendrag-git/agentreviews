import { describe, expect, it } from 'vitest';
import { canonicalize } from './canonicalize';

describe('canonicalize', () => {
  it('produces the same deterministic JSON for reordered keys and whitespace differences', () => {
    const parsedWithWhitespace = JSON.parse(`{
      "rating": 5,
      "body": "quiet and clean",
      "venue_id": "01J00000000000000000000000"
    }`);
    const reordered = {
      venue_id: '01J00000000000000000000000',
      body: 'quiet and clean',
      rating: 5,
    };

    expect(canonicalize(parsedWithWhitespace)).toBe(canonicalize(reordered));
    expect(canonicalize(reordered)).toBe(
      '{"body":"quiet and clean","rating":5,"venue_id":"01J00000000000000000000000"}',
    );
  });

  it('omits null and undefined object fields when requested', () => {
    const payload = {
      body: 'signed review',
      nickname: null,
      photo_url: undefined,
      rating: 4,
    };

    expect(canonicalize(payload, { omitNullish: true })).toBe(
      '{"body":"signed review","rating":4}',
    );
    expect(canonicalize({ rating: 4, body: 'signed review' }, { omitNullish: true })).toBe(
      canonicalize(payload, { omitNullish: true }),
    );
  });

  it('sorts property names by RFC 8785 UTF-16 code unit order', () => {
    const canonical = canonicalize({
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\ud83d\ude00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    });

    const orderedValues = [
      'Carriage Return',
      'One',
      'Control',
      'Latin Small Letter O With Diaeresis',
      'Euro Sign',
      'Emoji: Grinning Face',
      'Hebrew Letter Dalet With Dagesh',
    ];

    for (const value of orderedValues) {
      expect(canonical.indexOf(JSON.stringify(value))).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < orderedValues.length; i++) {
      expect(canonical.indexOf(JSON.stringify(orderedValues[i - 1]))).toBeLessThan(
        canonical.indexOf(JSON.stringify(orderedValues[i])),
      );
    }
  });
});
