#!/usr/bin/env node

const LEAF_DOMAIN = 0x00;
const NODE_DOMAIN = 0x01;
const SIGNING_DOMAIN = 0x00;
const TREE_HEAD_SIGNING_DOMAIN = 'agentreviews-log-root-v1';
const GENESIS_PREV_HASH = bytesToBase64Url(new Uint8Array(32));

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage: node scripts/reference-auditor.mjs [--base URL] [--previous-tree-size N] [--self-test]

Audits the AgentReviews transparency log using public endpoints only.

Options:
  --base URL                API base URL (default: https://revclaw-api.aws-cce.workers.dev/api/v1)
  --previous-tree-size N    Also verify a consistency proof from N to the latest root
  --self-test               Mutate fetched entries locally and verify tampering is detected
`);
  process.exit(0);
}

const baseUrl = stripTrailingSlash(args.base ?? 'https://revclaw-api.aws-cce.workers.dev/api/v1');

try {
  const result = await auditPublicLog(baseUrl, args.previousTreeSize, Boolean(args.selfTest));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function auditPublicLog(base, previousTreeSize, selfTest) {
  const operatorKey = await getJson(wellKnownUrl(base));
  const rootResponse = await getJson(`${base}/log/root`);
  const root = rootResponse.root;
  if (!root || !Number.isInteger(root.tree_size)) {
    throw new Error('Latest root response is missing root.tree_size');
  }
  if (operatorKey.alg !== 'Ed25519' || operatorKey.operator_pub !== root.operator_pub) {
    throw new Error('Latest root operator key does not match well-known log key');
  }

  const entries = await fetchEntries(base, root.tree_size);
  const audit = await auditEntries(entries, root, operatorKey.operator_pub);
  const output = {
    ok: true,
    tree_size: root.tree_size,
    root_hash: root.root_hash,
    entries_verified: entries.length,
    author_signatures_verified: audit.authorSignaturesVerified,
    operator_signature_verified: audit.operatorSignatureVerified,
    operator_pub: root.operator_pub,
    consistency_verified: null,
    tamper_self_test: null,
  };

  if (previousTreeSize != null) {
    output.consistency_verified = await verifyRemoteConsistency(base, previousTreeSize, root.tree_size);
  }

  if (selfTest) {
    output.tamper_self_test = await runTamperSelfTest(entries, root);
  }

  return output;
}

async function fetchEntries(base, treeSize) {
  const entries = [];
  let nextSeq = 1;
  while (entries.length < treeSize) {
    const page = await getJson(`${base}/log/entries?from_seq=${nextSeq}&limit=100`);
    const pageEntries = page.entries ?? [];
    if (pageEntries.length === 0) break;
    entries.push(...pageEntries);
    nextSeq = page.next_seq ?? (pageEntries[pageEntries.length - 1].seq + 1);
  }

  if (entries.length !== treeSize) {
    throw new Error(`Expected ${treeSize} log entries, fetched ${entries.length}`);
  }

  return entries;
}

async function auditEntries(entries, root, expectedOperatorPub) {
  let previousLeafHash = GENESIS_PREV_HASH;
  let authorSignaturesVerified = 0;

  for (const [index, entry] of entries.entries()) {
    const expectedSeq = index + 1;
    if (entry.seq !== expectedSeq) {
      throw new Error(`Entry sequence mismatch at index ${index}: expected ${expectedSeq}, got ${entry.seq}`);
    }

    if (entry.prev_hash !== previousLeafHash) {
      throw new Error(`Entry ${entry.seq} has invalid prev_hash`);
    }

    const leaf = await logEntryLeafHash(entryWithoutLeafHash(entry));
    if (entry.leaf_hash !== leaf) {
      throw new Error(`Entry ${entry.seq} leaf_hash does not match entry contents`);
    }

    if (!(await verifySignedPayload(entry))) {
      throw new Error(`Entry ${entry.seq} author signature is invalid`);
    }
    authorSignaturesVerified++;

    previousLeafHash = entry.leaf_hash;
  }

  const computedRoot = await merkleRoot(entries.map((entry) => entry.leaf_hash));
  if (computedRoot !== root.root_hash) {
    throw new Error('Computed Merkle root does not match published root');
  }

  const operatorSignatureVerified = await verifySignature(
    root.operator_pub,
    root.root_sig,
    treeHeadSigningMessage(root),
  );
  if (!operatorSignatureVerified) {
    throw new Error('Published root signature is invalid');
  }
  if (expectedOperatorPub && root.operator_pub !== expectedOperatorPub) {
    throw new Error('Published root operator key does not match expected operator key');
  }

  return { authorSignaturesVerified, operatorSignatureVerified };
}

async function verifyRemoteConsistency(base, oldSize, newSize) {
  const proofResponse = await getJson(`${base}/log/proof/consistency?old_size=${oldSize}&new_size=${newSize}`);
  if (!proofResponse.verified) {
    throw new Error('Remote consistency proof response is not verified');
  }

  const ok = await verifyConsistencyProof(
    proofResponse.first_tree_size ?? proofResponse.old_size,
    proofResponse.second_tree_size ?? proofResponse.new_size,
    proofResponse.proof,
    proofResponse.first_root_hash ?? proofResponse.old_root_hash,
    proofResponse.second_root_hash ?? proofResponse.new_root_hash,
  );
  if (!ok) {
    throw new Error('Remote consistency proof failed local verification');
  }

  return true;
}

async function runTamperSelfTest(entries, root) {
  if (entries.length < 2) {
    throw new Error('--self-test requires at least two log entries');
  }

  const checks = {};

  checks.edited = await rejectsAudit(() => {
    const copy = cloneEntries(entries);
    if (copy.length === 0) return copy;
    copy[0].canon_payload = copy[0].canon_payload.replace('{', '{"tampered":true,');
    return copy;
  }, root);

  checks.deleted = await rejectsAudit(() => cloneEntries(entries).slice(1), root);

  checks.reordered = await rejectsAudit(() => {
    const copy = cloneEntries(entries);
    if (copy.length > 1) {
      [copy[0], copy[1]] = [copy[1], copy[0]];
    }
    return copy;
  }, root);

  if (!checks.edited || !checks.deleted || !checks.reordered) {
    throw new Error('Tamper self-test failed to detect one or more mutations');
  }

  return checks;
}

async function rejectsAudit(makeEntries, root) {
  try {
    await auditEntries(makeEntries(), root, root.operator_pub);
    return false;
  } catch {
    return true;
  }
}

function cloneEntries(entries) {
  return entries.map((entry) => ({ ...entry }));
}

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.text();
  let json;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${body.slice(0, 200)}`);
  }

  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}: ${body}`);
  }

  return json;
}

async function verifySignedPayload(entry) {
  if (entry.sig_alg !== 'Ed25519') return false;
  const signedBytes = signingBytes(entry.canon_payload);
  const expectedContentHash = bytesToBase64Url(await sha256(signedBytes));
  if (entry.content_hash !== expectedContentHash) return false;

  return verifySignature(entry.agent_pub, entry.sig, signedBytes);
}

async function verifySignature(publicKey, signature, message) {
  const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  const signatureBytes = base64UrlToBytes(signature);
  const publicKeyBytes = base64UrlToBytes(publicKey);

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return crypto.subtle.verify('Ed25519', key, signatureBytes, bytes);
  } catch {
    const ed25519 = await import('@noble/ed25519');
    return ed25519.verifyAsync(signatureBytes, bytes, publicKeyBytes);
  }
}

function signingBytes(canonPayload) {
  const payloadBytes = new TextEncoder().encode(canonPayload);
  const bytes = new Uint8Array(payloadBytes.length + 1);
  bytes[0] = SIGNING_DOMAIN;
  bytes.set(payloadBytes, 1);
  return bytes;
}

async function logEntryLeafHash(entry) {
  return leafHash(canonicalize(entry, { omitNullish: true }));
}

function entryWithoutLeafHash(entry) {
  return {
    seq: entry.seq,
    event_id: entry.event_id,
    event_type: entry.event_type,
    object_type: entry.object_type,
    object_id: entry.object_id,
    agent_pub: entry.agent_pub,
    sig: entry.sig,
    sig_nonce: entry.sig_nonce,
    content_hash: entry.content_hash,
    canon_payload: entry.canon_payload,
    sig_alg: entry.sig_alg,
    prev_hash: entry.prev_hash,
    created_at: entry.created_at,
  };
}

async function leafHash(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return bytesToBase64Url(await sha256(withPrefix(LEAF_DOMAIN, bytes)));
}

async function nodeHash(left, right) {
  return bytesToBase64Url(await sha256(concatBytes(
    new Uint8Array([NODE_DOMAIN]),
    base64UrlToBytes(left),
    base64UrlToBytes(right),
  )));
}

async function merkleRoot(leafHashes) {
  if (leafHashes.length === 0) {
    return bytesToBase64Url(await sha256(new Uint8Array()));
  }
  if (leafHashes.length === 1) return leafHashes[0];

  const split = largestPowerOfTwoLessThan(leafHashes.length);
  return nodeHash(
    await merkleRoot(leafHashes.slice(0, split)),
    await merkleRoot(leafHashes.slice(split)),
  );
}

async function verifyConsistencyProof(oldSize, newSize, proof, oldRoot, newRoot) {
  if (!Number.isInteger(oldSize) || !Number.isInteger(newSize) || oldSize < 1 || newSize < oldSize) {
    return false;
  }
  if (oldSize === newSize) return proof.length === 0 && oldRoot === newRoot;

  try {
    let fn = oldSize - 1;
    let sn = newSize - 1;
    while (isOdd(fn)) {
      fn = Math.floor(fn / 2);
      sn = Math.floor(sn / 2);
    }

    let index = 0;
    let oldHash;
    let newHash;
    if (fn === 0) {
      oldHash = oldRoot;
      newHash = oldRoot;
    } else {
      oldHash = proof[index++];
      newHash = oldHash;
    }

    while (fn !== 0) {
      const next = proof[index++];
      if (!next) return false;
      if (isOdd(fn)) {
        oldHash = await nodeHash(next, oldHash);
        newHash = await nodeHash(next, newHash);
      } else if (fn < sn) {
        newHash = await nodeHash(newHash, next);
      } else {
        index--;
      }
      fn = Math.floor(fn / 2);
      sn = Math.floor(sn / 2);
    }

    while (sn !== 0) {
      const next = proof[index++];
      if (!next) return false;
      newHash = await nodeHash(newHash, next);
      sn = Math.floor(sn / 2);
    }

    return index === proof.length && oldHash === oldRoot && newHash === newRoot;
  } catch {
    return false;
  }
}

function treeHeadSigningMessage(root) {
  return `${TREE_HEAD_SIGNING_DOMAIN}\n${canonicalize({
    tree_size: root.tree_size,
    root_hash: root.root_hash,
    published_at: root.published_at,
  })}`;
}

function canonicalize(value, options = {}) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item, options)).join(',')}]`;
  }

  const entries = Object.entries(value)
    .filter(([, entryValue]) => !(options.omitNullish && entryValue == null))
    .sort(([left], [right]) => left.localeCompare(right));

  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize(entryValue, options)}`).join(',')}}`;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--self-test') parsed.selfTest = true;
    else if (arg === '--base') parsed.base = argv[++index];
    else if (arg === '--previous-tree-size') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--previous-tree-size must be a positive integer');
      }
      parsed.previousTreeSize = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function wellKnownUrl(base) {
  const url = new URL(base);
  return `${url.origin}/.well-known/agentreviews-log-key.json`;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function withPrefix(prefix, bytes) {
  const output = new Uint8Array(bytes.length + 1);
  output[0] = prefix;
  output.set(bytes, 1);
  return output;
}

function concatBytes(...chunks) {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function largestPowerOfTwoLessThan(value) {
  let power = 1;
  while (power * 2 < value) {
    power *= 2;
  }
  return power;
}

function isOdd(value) {
  return value % 2 === 1;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlToBytes(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
