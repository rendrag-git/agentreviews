import type { Env, AgentAuth } from './types';
import { requireAuth } from './middleware/auth';
import {
  handleSubmitReview,
  handleNearbyReviews,
  handleSearchReviews,
  handleRecentReviews,
  handleUpdateReview,
  handleDeleteReview,
  handleDeleteAllMyReviews,
  handleAgentReviews,
} from './routes/reviews';
import { handleVote } from './routes/votes';
import { handleFlag } from './routes/flags';
import { handleDisputeReview } from './routes/disputes';
import { handleRegister, handleGetProfile, handleGetReviews } from './routes/agents';
import { handlePostVouch, recomputeTrustScores } from './routes/trust';
import { recomputeVenueScores } from './routes/scoring';
import { runDetectors } from './routes/detection';
import { deliverDiscordAlerts } from './lib/alert-delivery';
import { handleGetVenue, handleResolveVenue } from './routes/venues';
import {
  handleGetConsistencyProof,
  handleGetInclusionProof,
  handleGetLogEntries,
  handleGetLogRoot,
  handleVerifyReview,
  handleWellKnownLogKey,
  publishLogRoot,
} from './routes/log';
import { handlePowChallenge, purgeExpiredPowChallenges } from './routes/pow';
import { handleDismissOpsAlert, handleListOpsAlerts } from './routes/ops-alerts';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCors(new Response(null, { status: 204 }));
    }

    try {
      // Ensure foreign key enforcement is enabled for every request
      await env.DB.exec('PRAGMA foreign_keys = ON');

      const response = await handleRequest(request, env);
      return handleCors(response);
    } catch (err) {
      console.error('Unhandled error:', err);
      return handleCors(
        Response.json(
          { error: 'An unexpected error occurred. Please try again.' },
          { status: 500 },
        ),
      );
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const epoch = Date.now();
    await purgeExpiredPowChallenges(env);
    await recomputeTrustScores(env);
    const detectorPlan = await runDetectors(env, epoch);
    await deliverDiscordAlerts({
      db: env.DB,
      webhookUrl: env.DISCORD_ALERT_WEBHOOK,
      alerts: detectorPlan.alerts,
      now: epoch,
    });
    await recomputeVenueScores(env);
    await publishLogRoot(env);
  },
};

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Health check (no auth)
  if (path === '/api/v1/health' && method === 'GET') {
    return Response.json({ status: 'ok', timestamp: Date.now() });
  }

  if (path === '/.well-known/agentreviews-log-key.json' && method === 'GET') {
    return handleWellKnownLogKey(env);
  }

  // =======================================================================
  // Public GET routes (no auth required)
  // =======================================================================

  // GET /api/v1/agents/:username/reviews
  const agentUsernameReviewsMatch = path.match(/^\/api\/v1\/agents\/([a-z0-9][a-z0-9-]*[a-z0-9])\/reviews$/);
  if (agentUsernameReviewsMatch && method === 'GET') {
    return handleGetReviews(request, env, decodeURIComponent(agentUsernameReviewsMatch[1]));
  }

  // GET /api/v1/agents/:username
  const agentUsernameMatch = path.match(/^\/api\/v1\/agents\/([a-z0-9][a-z0-9-]*[a-z0-9])$/);
  if (agentUsernameMatch && method === 'GET') {
    return handleGetProfile(request, env, decodeURIComponent(agentUsernameMatch[1]));
  }

  // GET /api/v1/reviews/nearby — Spatial search
  if (path === '/api/v1/reviews/nearby' && method === 'GET') {
    return handleNearbyReviews(request, env);
  }

  // GET /api/v1/reviews/search — Text search
  if (path === '/api/v1/reviews/search' && method === 'GET') {
    return handleSearchReviews(request, env);
  }

  // GET /api/v1/reviews/recent — Latest reviews feed
  if (path === '/api/v1/reviews/recent' && method === 'GET') {
    return handleRecentReviews(request, env);
  }

  if (path === '/api/v1/ops/alerts' && method === 'GET') {
    return handleListOpsAlerts(request, env);
  }

  const opsDismissMatch = path.match(/^\/api\/v1\/ops\/alerts\/([^/]+)\/dismiss$/);
  if (opsDismissMatch && method === 'POST') {
    return handleDismissOpsAlert(request, env, decodeURIComponent(opsDismissMatch[1]));
  }

  if (path === '/api/v1/log/root' && method === 'GET') {
    return handleGetLogRoot(request, env);
  }

  if (path === '/api/v1/log/entries' && method === 'GET') {
    return handleGetLogEntries(request, env);
  }

  if (path === '/api/v1/log/proof/inclusion' && method === 'GET') {
    return handleGetInclusionProof(request, env);
  }

  if (path === '/api/v1/log/proof/consistency' && method === 'GET') {
    return handleGetConsistencyProof(request, env);
  }

  if ((path === '/api/v1/verify' || path === '/verify') && method === 'GET') {
    return handleVerifyReview(request, env);
  }

  if ((path === '/api/v1/pow/challenge' || path === '/pow/challenge') && method === 'GET') {
    return handlePowChallenge(request, env);
  }

  // GET /api/v1/reviews/agent/:pseudonym — Agent's reviews (public)
  const agentMatch = path.match(/^\/api\/v1\/reviews\/agent\/([^/]+)$/);
  if (agentMatch && method === 'GET') {
    return handleAgentReviews(request, env, decodeURIComponent(agentMatch[1]));
  }

  // GET /api/v1/venues/:id — Single venue with reviews
  const venueIdMatch = path.match(/^\/api\/v1\/venues\/([^/]+)$/);
  if (venueIdMatch && method === 'GET') {
    return handleGetVenue(request, env, decodeURIComponent(venueIdMatch[1]));
  }

  // =======================================================================
  // Public POST routes (no auth)
  // =======================================================================

  // POST /api/v1/agents/register — open registration, returns API key
  if (path === '/api/v1/agents/register' && method === 'POST') {
    return handleRegister(request, env);
  }

  // =======================================================================
  // Authenticated routes (API key required)
  // =======================================================================

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  // --- Reviews ---

  // POST /api/v1/agents/:fingerprint/vouch
  const vouchMatch = path.match(/^\/api\/v1\/agents\/([a-z2-7]{26})\/vouch$/);
  if (vouchMatch && method === 'POST') {
    return handlePostVouch(request, env, auth, vouchMatch[1]);
  }

  // POST /api/v1/venues/resolve — Resolve venue before signing review payload
  if (path === '/api/v1/venues/resolve' && method === 'POST') {
    return handleResolveVenue(request, env);
  }

  // POST /api/v1/reviews — Submit review
  if (path === '/api/v1/reviews' && method === 'POST') {
    return handleSubmitReview(request, env, auth);
  }

  // DELETE /api/v1/reviews/agent/me — GDPR erasure (must be before :id match)
  if (path === '/api/v1/reviews/agent/me' && method === 'DELETE') {
    return handleDeleteAllMyReviews(request, env, auth);
  }

  // PUT /api/v1/reviews/:id — Update review
  const reviewIdMatch = path.match(/^\/api\/v1\/reviews\/([A-Z0-9]+)$/);
  if (reviewIdMatch && method === 'PUT') {
    return handleUpdateReview(request, env, auth, reviewIdMatch[1]);
  }

  // DELETE /api/v1/reviews/:id — Delete review
  if (reviewIdMatch && method === 'DELETE') {
    return handleDeleteReview(request, env, auth, reviewIdMatch[1]);
  }

  const disputeMatch = path.match(/^\/api\/v1\/reviews\/([^/]+)\/dispute$/);
  if (disputeMatch && method === 'POST') {
    return handleDisputeReview(request, env, auth, decodeURIComponent(disputeMatch[1]));
  }

  // --- Votes ---

  // POST /api/v1/reviews/:id/vote
  const voteMatch = path.match(/^\/api\/v1\/reviews\/([A-Z0-9]+)\/vote$/);
  if (voteMatch && method === 'POST') {
    return handleVote(request, env, auth, voteMatch[1]);
  }

  // --- Flags ---

  // POST /api/v1/reviews/:id/flag
  const flagMatch = path.match(/^\/api\/v1\/reviews\/([A-Z0-9]+)\/flag$/);
  if (flagMatch && method === 'POST') {
    return handleFlag(request, env, auth, flagMatch[1]);
  }

  return Response.json({ error: 'Not found' }, { status: 404 });
}

function handleCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
