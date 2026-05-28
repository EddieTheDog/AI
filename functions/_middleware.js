// functions/_middleware.js

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  const pathname = url.pathname;

  // ── Allow static assets through directly ───────────────────────────

  if (
    pathname.startsWith('/js/') ||
    pathname.startsWith('/css/') ||
    pathname.startsWith('/images/') ||
    pathname.startsWith('/fonts/') ||
    pathname.startsWith('/assets/') ||

    pathname.endsWith('.js')   ||
    pathname.endsWith('.mjs')  ||
    pathname.endsWith('.css')  ||
    pathname.endsWith('.map')  ||
    pathname.endsWith('.png')  ||
    pathname.endsWith('.jpg')  ||
    pathname.endsWith('.jpeg') ||
    pathname.endsWith('.webp') ||
    pathname.endsWith('.gif')  ||
    pathname.endsWith('.svg')  ||
    pathname.endsWith('.ico')  ||
    pathname.endsWith('.woff') ||
    pathname.endsWith('.woff2')||
    pathname.endsWith('.ttf')
  ) {
    return env.ASSETS.fetch(request);
  }

  // ── Continue to Pages Functions / routes ──────────────────────────

  return next();
}
