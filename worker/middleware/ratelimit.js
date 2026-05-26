// worker/middleware/ratelimit.js

import { err } from '../lib/response.js';

// Simple sliding window rate limiter stored in KV or D1
// Uses IP + path prefix as key

const LIMITS = {
  '/api/auth/login':    { max: 10,  windowSec: 60  },
  '/api/auth/register': { max: 5,   windowSec: 300 },
  '/api/':              { max: 120, windowSec: 60  },
};

export async function rateLimiter(request, env) {
  // Only rate limit if KV namespace is available
  if (!env.RATE_LIMIT) return null;

  const ip   = request.headers.get('CF-Connecting-IP') || 'unknown';
  const path = new URL(request.url).pathname;

  // Find matching limit rule
  let rule = null;
  for (const [prefix, cfg] of Object.entries(LIMITS)) {
    if (path.startsWith(prefix)) {
      rule = cfg;
      break;
    }
  }
  if (!rule) return null;

  const key     = `rl:${ip}:${path.split('/').slice(0, 3).join('/')}`;
  const now     = Math.floor(Date.now() / 1000);
  const window  = rule.windowSec;

  let data;
  try {
    const raw = await env.RATE_LIMIT.get(key);
    data = raw ? JSON.parse(raw) : { count: 0, reset: now + window };
  } catch {
    return null;
  }

  if (now > data.reset) {
    data = { count: 0, reset: now + window };
  }

  data.count++;
  await env.RATE_LIMIT.put(key, JSON.stringify(data), { expirationTtl: window });

  if (data.count > rule.max) {
    return err('Too many requests. Please try again shortly.', 429);
  }

  return null;
}
