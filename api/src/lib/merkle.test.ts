import { describe, expect, it } from 'vitest';
import {
  consistencyProof,
  inclusionProof,
  leafHash,
  merkleRoot,
  nodeHash,
  verifyConsistencyProof,
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

  it('builds and verifies RFC 6962 seven-leaf consistency proofs', async () => {
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
    const oldRoot3 = await nodeHash(g, c);
    const oldRoot4 = k;
    const oldRoot6 = await nodeHash(k, i);
    const newRoot = await nodeHash(k, l);

    await expect(consistencyProof(3, leaves)).resolves.toEqual([c, d, g, l]);
    await expect(consistencyProof(4, leaves)).resolves.toEqual([l]);
    await expect(consistencyProof(6, leaves)).resolves.toEqual([i, j, k]);

    await expect(verifyConsistencyProof(3, 7, [c, d, g, l], oldRoot3, newRoot)).resolves.toBe(true);
    await expect(verifyConsistencyProof(4, 7, [l], oldRoot4, newRoot)).resolves.toBe(true);
    await expect(verifyConsistencyProof(6, 7, [i, j, k], oldRoot6, newRoot)).resolves.toBe(true);
  });

  it('rejects consistency proofs for rewritten, reordered, or deleted prefixes', async () => {
    const leaves = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((value) => leafHash(value)));
    const proof = await consistencyProof(3, leaves);
    const honestOldRoot = await merkleRoot(leaves.slice(0, 3));
    const honestNewRoot = await merkleRoot(leaves);
    const editedOldRoot = await merkleRoot([
      leaves[0],
      await leafHash('edited'),
      leaves[2],
    ]);
    const reorderedNewRoot = await merkleRoot([leaves[1], leaves[0], leaves[2], leaves[3], leaves[4]]);
    const deletedNewRoot = await merkleRoot([leaves[0], leaves[2], leaves[3], leaves[4]]);

    await expect(verifyConsistencyProof(3, 5, proof, honestOldRoot, honestNewRoot)).resolves.toBe(true);
    await expect(verifyConsistencyProof(3, 5, proof, editedOldRoot, honestNewRoot)).resolves.toBe(false);
    await expect(verifyConsistencyProof(3, 5, proof, honestOldRoot, reorderedNewRoot)).resolves.toBe(false);
    await expect(verifyConsistencyProof(3, 4, proof, honestOldRoot, deletedNewRoot)).resolves.toBe(false);
  });
});
