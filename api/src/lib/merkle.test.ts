import { describe, expect, it } from 'vitest';
import {
  inclusionProof,
  leafHash,
  merkleRoot,
  nodeHash,
  verifyInclusionProof,
} from './merkle';

describe('RFC 6962 Merkle tree', () => {
  it('matches known empty and single-leaf hashes', async () => {
    await expect(merkleRoot([])).resolves.toBe('47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
    await expect(leafHash(new Uint8Array())).resolves.toBe('bjQLnP-zepicpUTmu3gKLHiQHT-zNzh2hRGjBhevoB0');
  });

  it('builds the RFC 6962 seven-leaf audit paths', async () => {
    const leaves = await Promise.all(
      ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((value) => leafHash(value)),
    );
    const [a, b, c, d, e, f, d6] = leaves;
    const g = await nodeHash(a, b);
    const h = await nodeHash(c, d);
    const i = await nodeHash(e, f);
    const j = d6;
    const k = await nodeHash(g, h);
    const l = await nodeHash(i, j);
    const root = await nodeHash(k, l);

    await expect(merkleRoot(leaves)).resolves.toBe(root);
    await expect(inclusionProof(0, leaves)).resolves.toEqual([b, h, l]);
    await expect(inclusionProof(3, leaves)).resolves.toEqual([c, g, l]);
    await expect(inclusionProof(4, leaves)).resolves.toEqual([f, j, k]);
    await expect(inclusionProof(6, leaves)).resolves.toEqual([i, k]);
  });

  it('verifies present leaves and rejects absent or wrong-index proofs', async () => {
    const leaves = await Promise.all(['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((value) => leafHash(value)));
    const root = await merkleRoot(leaves);
    const proof = await inclusionProof(2, leaves);

    await expect(verifyInclusionProof(leaves[2], 2, leaves.length, proof, root)).resolves.toBe(true);
    await expect(verifyInclusionProof(await leafHash('absent'), 2, leaves.length, proof, root)).resolves.toBe(false);
    await expect(verifyInclusionProof(leaves[2], 3, leaves.length, proof, root)).resolves.toBe(false);
  });
});
