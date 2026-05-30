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

export interface ReviewEraseLogEntryInput extends ReviewCreateLogEntryInput {}
export interface VouchLogEntryInput extends Omit<ReviewCreateLogEntryInput, 'reviewId'> {
  vouchId: string;
}

type LogEventType = 'review.create' | 'review.erase' | 'agent.vouch';
type LogLeafVersion = 1 | 2;

export interface LogEntry {
  seq: number;
  event_id: string;
  event_type: LogEventType;
  object_type: 'review' | 'vouch';
  object_id: string;
  agent_pub: string;
  sig: string;
  sig_nonce: string;
  content_hash: string;
  canon_payload: string | null;
  sig_alg: string;
  prev_hash: string;
  leaf_hash: string;
  created_at: number;
  leaf_version?: LogLeafVersion;
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
  return buildSignedLogEntry('review.create', 'review', input.reviewId, input);
}

export async function buildReviewEraseLogEntry(input: ReviewEraseLogEntryInput): Promise<LogEntry> {
  return buildSignedLogEntry('review.erase', 'review', input.reviewId, input);
}

export async function buildVouchLogEntry(input: VouchLogEntryInput): Promise<LogEntry> {
  return buildSignedLogEntry('agent.vouch', 'vouch', input.vouchId, input);
}

async function buildSignedLogEntry(
  eventType: LogEventType,
  objectType: LogEntry['object_type'],
  objectId: string,
  input: ReviewCreateLogEntryInput | VouchLogEntryInput,
): Promise<LogEntry> {
  const entryWithoutHash = {
    seq: input.seq,
    event_id: input.eventId,
    event_type: eventType,
    object_type: objectType,
    object_id: objectId,
    agent_pub: input.agentPub,
    sig: input.sig,
    sig_nonce: input.sigNonce,
    content_hash: input.contentHash,
    canon_payload: input.canonPayload,
    sig_alg: input.sigAlg,
    prev_hash: input.prevHash,
    created_at: input.createdAt,
    leaf_version: 2 as const,
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
  return leafHash(canonicalize(leafMaterial(entry) as unknown as CanonicalJson, { omitNullish: true }));
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
    leaf_version: entry.leaf_version,
  };
}

function leafMaterial(entry: Omit<LogEntry, 'leaf_hash'>): Omit<LogEntry, 'leaf_hash'> {
  if (entry.leaf_version === 2) {
    const { canon_payload: _canonPayload, ...withoutPayload } = entry;
    return withoutPayload as Omit<LogEntry, 'leaf_hash'>;
  }

  const { leaf_version: _leafVersion, ...withoutLeafVersion } = entry;
  return withoutLeafVersion as Omit<LogEntry, 'leaf_hash'>;
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
