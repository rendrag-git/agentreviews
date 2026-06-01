const FREE_REGISTRATIONS_PER_WINDOW = 5;
const BASE_DIFFICULTY = 8;
const MAX_DIFFICULTY = 20;

export function challengeDifficulty(recentRegistrations: number): number {
  if (recentRegistrations < FREE_REGISTRATIONS_PER_WINDOW) return 0;
  return Math.min(
    MAX_DIFFICULTY,
    BASE_DIFFICULTY + Math.floor((recentRegistrations - FREE_REGISTRATIONS_PER_WINDOW) / 5) * 2,
  );
}

export async function verifyPow(
  challenge: string,
  nonce: string,
  difficulty: number,
): Promise<boolean> {
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > MAX_DIFFICULTY) return false;
  if (difficulty === 0) return true;

  const hash = await powHash(challenge, nonce);
  return leadingZeroBits(hash) >= difficulty;
}

export async function solvePow(challenge: string, difficulty: number): Promise<string> {
  for (let counter = 0; ; counter++) {
    const nonce = counter.toString(36);
    if (await verifyPow(challenge, nonce, difficulty)) {
      return nonce;
    }
  }
}

async function powHash(challenge: string, nonce: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${challenge}\n${nonce}`)));
}

function leadingZeroBits(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      count += 8;
      continue;
    }

    for (let bit = 7; bit >= 0; bit--) {
      if ((byte & (1 << bit)) !== 0) return count;
      count++;
    }
  }
  return count;
}
