import type { Env } from '../types';
import { signPayload } from './signing';
import {
  buildMitigationApplyLogEntry,
  buildMitigationClearLogEntry,
  type LogEntry,
} from './transparency-log';

export interface MitigationClearTarget {
  review_id: string;
  alert_id: string;
}

export interface MitigationApplyTarget extends MitigationClearTarget {
  reason: string;
  multiplier: number;
}

export async function buildMitigationApplyLogEntries(input: {
  env: Pick<Env, 'OPERATOR_PRIVATE_KEY' | 'OPERATOR_PUBLIC_KEY'>;
  mitigations: MitigationApplyTarget[];
  now: number;
  startSeq: number;
  prevHash: string;
}): Promise<LogEntry[]> {
  return buildMitigationLogEntries({
    ...input,
    eventType: 'mitigation.apply',
    noncePrefix: 'mitigation-apply',
    payloadFor: (mitigation, sigNonce) => ({
      event_type: 'mitigation.apply',
      review_id: mitigation.review_id,
      alert_id: mitigation.alert_id,
      reason: mitigation.reason,
      multiplier: mitigation.multiplier,
      sig_nonce: sigNonce,
    }),
    buildEntry: buildMitigationApplyLogEntry,
  });
}

export async function buildMitigationClearLogEntries(input: {
  env: Pick<Env, 'OPERATOR_PRIVATE_KEY' | 'OPERATOR_PUBLIC_KEY'>;
  mitigations: MitigationClearTarget[];
  reason: string | null;
  now: number;
  startSeq: number;
  prevHash: string;
}): Promise<LogEntry[]> {
  return buildMitigationLogEntries({
    ...input,
    eventType: 'mitigation.clear',
    noncePrefix: 'mitigation-clear',
    payloadFor: (mitigation, sigNonce) => ({
      event_type: 'mitigation.clear',
      review_id: mitigation.review_id,
      alert_id: mitigation.alert_id,
      reason: input.reason ?? '',
      sig_nonce: sigNonce,
    }),
    buildEntry: buildMitigationClearLogEntry,
  });
}

async function buildMitigationLogEntries<TMitigation extends MitigationClearTarget>(input: {
  env: Pick<Env, 'OPERATOR_PRIVATE_KEY' | 'OPERATOR_PUBLIC_KEY'>;
  mitigations: TMitigation[];
  now: number;
  startSeq: number;
  prevHash: string;
  eventType: 'mitigation.apply' | 'mitigation.clear';
  noncePrefix: 'mitigation-apply' | 'mitigation-clear';
  payloadFor: (mitigation: TMitigation, sigNonce: string) => Record<string, string | number>;
  buildEntry: (input: {
    seq: number;
    eventId: string;
    mitigationId: string;
    agentPub: string;
    sig: string;
    sigNonce: string;
    contentHash: string;
    canonPayload: string;
    sigAlg: 'Ed25519';
    prevHash: string;
    createdAt: number;
  }) => Promise<LogEntry>;
}): Promise<LogEntry[]> {
  if (input.mitigations.length === 0) return [];
  if (!input.env.OPERATOR_PRIVATE_KEY || !input.env.OPERATOR_PUBLIC_KEY) {
    throw new Error(`Operator signing key is required to append ${input.eventType}`);
  }

  let seq = input.startSeq;
  let prevHash = input.prevHash;
  const entries: LogEntry[] = [];

  for (const mitigation of input.mitigations) {
    const sigNonce = `${input.noncePrefix}:${mitigation.review_id}:${mitigation.alert_id}:${input.now}`;
    const signed = await signPayload(input.payloadFor(mitigation, sigNonce), input.env.OPERATOR_PRIVATE_KEY);
    const entry = await input.buildEntry({
      seq,
      eventId: `log:${sigNonce}`,
      mitigationId: mitigationRowId(mitigation.review_id, mitigation.alert_id),
      agentPub: input.env.OPERATOR_PUBLIC_KEY,
      sig: signed.signature,
      sigNonce,
      contentHash: signed.contentHash,
      canonPayload: signed.canonPayload,
      sigAlg: signed.sigAlg,
      prevHash,
      createdAt: input.now,
    });

    entries.push(entry);
    seq += 1;
    prevHash = entry.leaf_hash;
  }

  return entries;
}

export function mitigationRowId(reviewId: string, alertId: string): string {
  return `${reviewId}:${alertId}`;
}
