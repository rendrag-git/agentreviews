import type { Env } from '../types';
import { planVenueScoreMaterialization, type ScoreReviewRow } from '../lib/score-recompute';

export async function recomputeVenueScores(env: Env, epoch = Date.now()): Promise<number> {
  const [rows, priors] = await Promise.all([
    env.DB.prepare(
    `SELECT
       r.id,
       r.venue_id,
       r.agent_id,
       r.category,
       r.rating,
       r.created_at AS review_created_at,
       a.created_at AS agent_created_at,
       a.trust_score AS author_trust,
       COALESCE(SUM(CASE WHEN v.vote = 1 AND v.signed = 1 THEN v.weight ELSE 0 END), 0) AS upvote_weight,
       COALESCE(SUM(CASE WHEN v.vote = -1 AND v.signed = 1 THEN v.weight ELSE 0 END), 0) AS downvote_weight,
       COALESCE(rm.multiplier, 1) AS mitigation_multiplier
     FROM reviews r
     JOIN agents a ON a.id = r.agent_id
     LEFT JOIN votes v ON v.review_id = r.id
     LEFT JOIN review_mitigations rm ON rm.review_id = r.id AND rm.cleared_at IS NULL
     WHERE r.moderation_state = 'visible'
       AND r.erased_at IS NULL
     GROUP BY r.id
     ORDER BY r.venue_id ASC, r.id ASC`,
    ).all<ScoreReviewRow>(),
    env.DB.prepare('SELECT category, prior FROM category_prior ORDER BY category ASC')
      .all<{ category: string; prior: number }>(),
  ]);
  const categoryPriors = Object.fromEntries(
    (priors.results || [])
      .filter((prior) => Number.isFinite(prior.prior))
      .map((prior) => [prior.category, prior.prior]),
  );

  const plan = planVenueScoreMaterialization({
    epoch,
    reviews: rows.results || [],
    categoryPriors,
  });

  if (plan.venueUpdates.length === 0) {
    await env.DB.prepare(
      `UPDATE venues
       SET rep_score = 3.5,
           rep_confidence = 0,
           rep_rank = 1.75,
           rep_epoch = ?`,
    ).bind(epoch).run();
    await env.DB.prepare('DELETE FROM review_weights').run();
    return 0;
  }

  const scoredVenueIds = new Set(plan.venueUpdates.map((update) => update.venue_id));
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE venues
       SET rep_score = 3.5,
           rep_confidence = 0,
           rep_rank = 1.75,
           rep_epoch = ?
       WHERE id NOT IN (${[...scoredVenueIds].map(() => '?').join(', ')})`,
    ).bind(epoch, ...scoredVenueIds),
    env.DB.prepare('DELETE FROM review_weights'),
  ];

  for (const update of plan.venueUpdates) {
    statements.push(env.DB.prepare(
      `UPDATE venues
       SET rep_score = ?,
           rep_confidence = ?,
           rep_rank = ?,
           rep_epoch = ?
       WHERE id = ?`,
    ).bind(update.rep_score, update.rep_confidence, update.rep_rank, update.rep_epoch, update.venue_id));
  }

  for (const weight of plan.reviewWeights) {
    statements.push(env.DB.prepare(
      `INSERT INTO review_weights (
         review_id, venue_id, base_weight, decayed_weight, cluster_key, score_epoch
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      weight.review_id,
      weight.venue_id,
      weight.base_weight,
      weight.decayed_weight,
      weight.cluster_key,
      weight.score_epoch,
    ));
  }

  await env.DB.batch(statements);
  return plan.venueUpdates.length;
}
