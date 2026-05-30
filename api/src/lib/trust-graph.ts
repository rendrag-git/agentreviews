export interface TrustEdge {
  from: string;
  to: string;
  weight?: number;
}

export interface ComputeTrustScoresInput {
  agents: string[];
  roots: string[];
  edges: TrustEdge[];
  damping?: number;
  iterations?: number;
  tolerance?: number;
}

export type TrustScores = Record<string, number>;

export function vouchBudget(earnedTrust: number): number {
  if (!Number.isFinite(earnedTrust) || earnedTrust <= 0) return 0;
  return Math.floor(Math.log2(1 + earnedTrust));
}

export function computeTrustScores(input: ComputeTrustScoresInput): TrustScores {
  const agents = uniqueSorted(input.agents);
  const scores = zeroScores(agents);
  if (agents.length === 0) return scores;

  const agentSet = new Set(agents);
  const roots = uniqueSorted(input.roots).filter((root) => agentSet.has(root));
  if (roots.length === 0) return scores;

  const damping = input.damping ?? 0.85;
  const iterations = input.iterations ?? 50;
  const tolerance = input.tolerance ?? 1e-12;
  const teleport = zeroScores(agents);
  for (const root of roots) {
    teleport[root] = 1 / roots.length;
    scores[root] = 1 / roots.length;
  }

  const outgoing = normalizedOutgoingEdges(agents, input.edges);

  for (let iteration = 0; iteration < iterations; iteration++) {
    const next = zeroScores(agents);
    for (const agent of agents) {
      next[agent] = (1 - damping) * teleport[agent];
    }

    for (const from of agents) {
      const edges = outgoing.get(from) ?? [];
      if (edges.length === 0) {
        for (const root of roots) {
          next[root] += damping * scores[from] / roots.length;
        }
        continue;
      }

      for (const edge of edges) {
        next[edge.to] += damping * scores[from] * edge.weight;
      }
    }

    const delta = l1Delta(scores, next, agents);
    for (const agent of agents) {
      scores[agent] = next[agent];
    }
    if (delta <= tolerance) break;
  }

  return maxNormalizedScores(scores, agents);
}

function normalizedOutgoingEdges(agents: string[], edges: TrustEdge[]): Map<string, Array<{ to: string; weight: number }>> {
  const agentSet = new Set(agents);
  const raw = new Map<string, Array<{ to: string; weight: number }>>();
  for (const edge of edges) {
    if (!agentSet.has(edge.from) || !agentSet.has(edge.to) || edge.from === edge.to) continue;
    const weight = edge.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    const list = raw.get(edge.from) ?? [];
    list.push({ to: edge.to, weight });
    raw.set(edge.from, list);
  }

  const normalized = new Map<string, Array<{ to: string; weight: number }>>();
  for (const [from, list] of raw) {
    const merged = new Map<string, number>();
    for (const edge of list) {
      merged.set(edge.to, (merged.get(edge.to) ?? 0) + edge.weight);
    }

    const total = [...merged.values()].reduce((sum, weight) => sum + weight, 0);
    normalized.set(
      from,
      [...merged.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([to, weight]) => ({ to, weight: weight / total })),
    );
  }

  return normalized;
}

function maxNormalizedScores(scores: TrustScores, agents: string[]): TrustScores {
  const max = agents.reduce((currentMax, agent) => Math.max(currentMax, scores[agent]), 0);
  if (max <= 0) return zeroScores(agents);

  const output = zeroScores(agents);
  for (const agent of agents) {
    output[agent] = scores[agent] / max;
  }
  return output;
}

function zeroScores(agents: string[]): TrustScores {
  return Object.fromEntries(agents.map((agent) => [agent, 0]));
}

function l1Delta(left: TrustScores, right: TrustScores, agents: string[]): number {
  return agents.reduce((sum, agent) => sum + Math.abs(left[agent] - right[agent]), 0);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
