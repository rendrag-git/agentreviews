import { computeTrustScores, type TrustEdge } from './trust-graph';

export interface TrustAgentRow {
  id: string;
  earned_trust: number | null;
}

export interface TrustRootRow {
  agent_id: string;
  weight: number | null;
}

export interface VouchRow {
  voucher_id: string;
  vouchee_id: string;
  weight: number | null;
}

export interface TrustMaterializationInput {
  epoch: number;
  agents: TrustAgentRow[];
  roots: TrustRootRow[];
  vouches: VouchRow[];
}

export interface TrustMaterializationUpdate {
  id: string;
  trust_score: number;
  vouch_trust: number;
  earned_trust: number;
  trust_epoch: number;
}

export function planTrustMaterialization(input: TrustMaterializationInput): TrustMaterializationUpdate[] {
  const agents = [...input.agents].sort((left, right) => left.id.localeCompare(right.id));
  const agentIds = agents.map((agent) => agent.id);
  const roots = input.roots
    .filter((root) => Number.isFinite(root.weight ?? 1) && (root.weight ?? 1) > 0)
    .map((root) => root.agent_id);
  const rootSet = new Set(roots);

  if (roots.length === 0) {
    return agents.map((agent) => ({
      id: agent.id,
      trust_score: 0,
      vouch_trust: 0,
      earned_trust: 0,
      trust_epoch: input.epoch,
    }));
  }

  const edges: TrustEdge[] = input.vouches.map((vouch) => ({
    from: vouch.voucher_id,
    to: vouch.vouchee_id,
    weight: vouch.weight ?? 1,
  }));
  const scores = computeTrustScores({ agents: agentIds, roots, edges });
  const inboundTrust = computeInboundVouchTrust(edges, scores);

  return agents.map((agent) => {
    const trustScore = scores[agent.id] ?? 0;
    return {
      id: agent.id,
      trust_score: trustScore,
      vouch_trust: inboundTrust.get(agent.id) ?? 0,
      earned_trust: rootSet.has(agent.id) ? Math.max(agent.earned_trust ?? 0, trustScore) : trustScore,
      trust_epoch: input.epoch,
    };
  });
}

function computeInboundVouchTrust(edges: TrustEdge[], scores: Record<string, number>): Map<string, number> {
  const inbound = new Map<string, number>();
  for (const edge of edges) {
    const weight = edge.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0 || edge.from === edge.to) continue;
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + (scores[edge.from] ?? 0) * weight);
  }
  return inbound;
}
