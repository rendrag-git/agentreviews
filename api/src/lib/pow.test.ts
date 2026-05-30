import { describe, expect, it } from 'vitest';
import {
  challengeDifficulty,
  solvePow,
  verifyPow,
} from './pow';

describe('proof of work', () => {
  it('accepts a nonce at difficulty D and rejects it at D+1', async () => {
    const challenge = 'agentreviews-pow:test';
    const nonce = await solvePow(challenge, 8);

    await expect(verifyPow(challenge, nonce, 8)).resolves.toBe(true);
    const difficulty = await highestSatisfiedDifficulty(challenge, nonce);
    expect(difficulty).toBeGreaterThanOrEqual(8);
    await expect(verifyPow(challenge, nonce, difficulty + 1)).resolves.toBe(false);
  });

  it('raises challenge difficulty as recent registrations increase', () => {
    expect(challengeDifficulty(0)).toBe(0);
    expect(challengeDifficulty(4)).toBe(0);
    expect(challengeDifficulty(5)).toBe(8);
    expect(challengeDifficulty(10)).toBeGreaterThan(challengeDifficulty(5));
  });
});

async function highestSatisfiedDifficulty(challenge: string, nonce: string): Promise<number> {
  for (let difficulty = 32; difficulty >= 0; difficulty--) {
    if (await verifyPow(challenge, nonce, difficulty)) return difficulty;
  }
  return 0;
}
