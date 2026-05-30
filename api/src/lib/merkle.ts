const LEAF_DOMAIN = 0x00;
const NODE_DOMAIN = 0x01;

export async function leafHash(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return bytesToBase64Url(await sha256(withPrefix(LEAF_DOMAIN, bytes)));
}

export async function nodeHash(left: string, right: string): Promise<string> {
  return bytesToBase64Url(await sha256(concatBytes(
    new Uint8Array([NODE_DOMAIN]),
    base64UrlToBytes(left),
    base64UrlToBytes(right),
  )));
}

export async function merkleRoot(leafHashes: string[]): Promise<string> {
  if (leafHashes.length === 0) {
    return bytesToBase64Url(await sha256(new Uint8Array()));
  }

  if (leafHashes.length === 1) {
    return leafHashes[0];
  }

  const split = largestPowerOfTwoLessThan(leafHashes.length);
  return nodeHash(
    await merkleRoot(leafHashes.slice(0, split)),
    await merkleRoot(leafHashes.slice(split)),
  );
}

export async function inclusionProof(leafIndex: number, leafHashes: string[]): Promise<string[]> {
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leafHashes.length) {
    throw new RangeError('leafIndex out of range');
  }

  return auditPath(leafIndex, leafHashes);
}

export async function verifyInclusionProof(
  leaf: string,
  leafIndex: number,
  treeSize: number,
  proof: string[],
  expectedRoot: string,
): Promise<boolean> {
  if (!Number.isInteger(leafIndex) || !Number.isInteger(treeSize) || leafIndex < 0 || treeSize < 1 || leafIndex >= treeSize) {
    return false;
  }

  try {
    const result = await rootFromProof(leaf, leafIndex, treeSize, proof, 0);
    return result.used === proof.length && result.hash === expectedRoot;
  } catch {
    return false;
  }
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function auditPath(leafIndex: number, leafHashes: string[]): Promise<string[]> {
  if (leafHashes.length === 1) {
    return [];
  }

  const split = largestPowerOfTwoLessThan(leafHashes.length);
  if (leafIndex < split) {
    return [
      ...(await auditPath(leafIndex, leafHashes.slice(0, split))),
      await merkleRoot(leafHashes.slice(split)),
    ];
  }

  return [
    ...(await auditPath(leafIndex - split, leafHashes.slice(split))),
    await merkleRoot(leafHashes.slice(0, split)),
  ];
}

async function rootFromProof(
  leaf: string,
  leafIndex: number,
  treeSize: number,
  proof: string[],
  offset: number,
): Promise<{ hash: string; used: number }> {
  if (treeSize === 1) {
    return { hash: leaf, used: offset };
  }

  const split = largestPowerOfTwoLessThan(treeSize);
  if (leafIndex < split) {
    const left = await rootFromProof(leaf, leafIndex, split, proof, offset);
    const right = proof[left.used];
    if (!right) throw new RangeError('inclusion proof is too short');
    return { hash: await nodeHash(left.hash, right), used: left.used + 1 };
  }

  const right = await rootFromProof(leaf, leafIndex - split, treeSize - split, proof, offset);
  const left = proof[right.used];
  if (!left) throw new RangeError('inclusion proof is too short');
  return { hash: await nodeHash(left, right.hash), used: right.used + 1 };
}

function largestPowerOfTwoLessThan(value: number): number {
  let power = 1;
  while (power * 2 < value) {
    power *= 2;
  }
  return power;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function withPrefix(prefix: number, bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(bytes.length + 1);
  output[0] = prefix;
  output.set(bytes, 1);
  return output;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
