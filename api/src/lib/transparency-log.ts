import { canonicalize, type CanonicalJson } from './canonicalize';
import { bytesToBase64Url, leafHash } from './merkle';
import { signMessage, verifySignature } from './signing';

export const GENESIS_PREV_HASH = bytesToBase64Url(new Uint8Array(32));
const TREE_HEAD_SIGNING_DOMAIN = 'agentreviews-log-root-v1';

export interface ReviewCreateLogEntryInput {
  seq: number;
  eventId: string;
  reviewId: string;
  agentPub: string;
  sig: string;
  sigNonce: string;
  contentHash: string;
  canonPayload: string;
  sigAlg: string;
  prevHash: string;
  createdAt: number;
}

export interface LogEntry {
  seq: number;
  event_id: string;
  event_type: 'review.create';
  object_type: 'review';
  object_id: string;
  agent_pub: string;
  sig: string;
  sig_nonce: string;
  content_hash: string;
  canon_payload: string;
  sig_alg: string;
  prev_hash: string;
  leaf_hash: string;
  created_at: number;
}

export interface LogRoot {
  id: string;
  tree_size: number;
  root_hash: string;
  root_sig: string;
  sig_alg: 'Ed25519';
  operator_pub: string;
  published_at: number;
  anchor_proof: string | null;
}

export interface TreeHead {
  tree_size: number;
  root_hash: string;
  published_at: number;
}

export interface SignedTreeHead extends TreeHead {
  root_sig: string;
}

export async function buildReviewCreateLogEntry(input: ReviewCreateLogEntryInput): Promise<LogEntry> {
  const entryWithoutHash = {
    seq: input.seq,
    event_id: input.eventId,
    event_type: 'review.create' as const,
    object_type: 'review' as const,
    object_id: input.reviewId,
    agent_pub: input.agentPub,
    sig: input.sig,
    sig_nonce: input.sigNonce,
    content_hash: input.contentHash,
    canon_payload: input.canonPayload,
    sig_alg: input.sigAlg,
    prev_hash: input.prevHash,
    created_at: input.createdAt,
  };

  return {
    ...entryWithoutHash,
    leaf_hash: await logEntryLeafHash(entryWithoutHash),
  };
}

export async function verifyLogEntryHash(entry: LogEntry): Promise<boolean> {
  return entry.leaf_hash === await logEntryLeafHash(entryWithoutLeafHash(entry));
}

export async function logEntryLeafHash(entry: Omit<LogEntry, 'leaf_hash'>): Promise<string> {
  return leafHash(canonicalize(entry as unknown as CanonicalJson, { omitNullish: true }));
}

export function entryWithoutLeafHash(entry: LogEntry): Omit<LogEntry, 'leaf_hash'> {
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

export async function signTreeHead(treeHead: TreeHead, privateKey: string): Promise<string> {
  return signMessage(treeHeadSigningMessage(treeHead), privateKey);
}

export async function verifyTreeHeadSignature(
  treeHead: SignedTreeHead,
  publicKey: string,
): Promise<boolean> {
  return verifySignature(publicKey, treeHead.root_sig, treeHeadSigningMessage(treeHead));
}

export function treeHeadSigningMessage(treeHead: TreeHead): string {
  return `${TREE_HEAD_SIGNING_DOMAIN}\n${canonicalize({
    tree_size: treeHead.tree_size,
    root_hash: treeHead.root_hash,
    published_at: treeHead.published_at,
  })}`;
}
