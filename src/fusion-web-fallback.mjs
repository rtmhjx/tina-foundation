/**
 * Zero-key fallback search provider for `ctx.web` (`@deepseek-ai/dsh-web`).
 * Activates automatically ONLY when no primary search provider (such as `deepseek-official`)
 * has an active credential configured, using `ctx.web.fetch` so all requests inherit DSH's
 * SSRF public-address DNS pinning, proxy settings, and cancellation signals.
 */

const PROVIDER_ID = 'tina-public-web';

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function unwrapDuckDuckGoUrl(rawHref) {
  const href = decodeHtmlEntities(rawHref);
  if (!href) return '';
  try {
    const normalized = href.startsWith('//') ? 'https:' + href : href;
    const parsed = new URL(normalized, 'https://html.duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    if (uddg && /^https?:\/\//i.test(uddg)) return uddg;
    if (/^https?:\/\//i.test(parsed.href) && !parsed.hostname.endsWith('duckduckgo.com')) {
      return parsed.href;
    }
  } catch {}
  return /^https?:\/\//i.test(href) ? href : '';
}

export function parseDuckDuckGoHtml(html, limit = 8) {
  const sources = [];
  const seen = new Set();
  const text = String(html || '');
  const blockRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,1600}?)(?=<a[^>]*class="[^"]*result__a|$)/gi;
  for (const match of text.matchAll(blockRe)) {
    const url = unwrapDuckDuckGoUrl(match[1]);
    if (!url || seen.has(url)) continue;
    const title = decodeHtmlEntities(match[2]);
    const tail = match[3] || '';
    const snippetMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(tail);
    const snippet = snippetMatch ? decodeHtmlEntities(snippetMatch[1]) : undefined;
    seen.add(url);
    sources.push({
      url,
      ...(title ? { title } : {}),
      ...(snippet ? { snippet } : {}),
    });
    if (sources.length >= limit) break;
  }
  return sources;
}

export function mountFusionWebFallback(ctx) {
  const web = ctx.get?.('web');
  if (!web || typeof web.registerSearchProvider !== 'function' || typeof web.fetch !== 'function') {
    return () => {};
  }
  if (web.searchProviders?.has?.(PROVIDER_ID)) return () => {};

  const hasOtherAvailableSearch = () => {
    if (!web.searchProviders) return false;
    for (const [id, provider] of web.searchProviders.entries()) {
      if (id === PROVIDER_ID) continue;
      try {
        if (provider?.available?.()) return true;
      } catch {}
    }
    return false;
  };

  const dispose = web.registerSearchProvider({
    id: PROVIDER_ID,
    available: () => !hasOtherAvailableSearch(),
    async search(request, signal) {
      const query = String(request?.query ?? '').trim();
      const maxResults = Math.max(1, Math.min(10, Number(request?.maxResults ?? 6)));
      if (!query) return { sources: [], truncated: false };
      const targetUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const fetched = await web.fetch({ url: targetUrl }, signal);
      const body = typeof fetched?.body?.content === 'string'
        ? fetched.body.content
        : typeof fetched?.content === 'string'
          ? fetched.content
          : typeof fetched?.body === 'string'
            ? fetched.body
            : '';
      const allSources = parseDuckDuckGoHtml(body, maxResults + 1);
      const truncated = allSources.length > maxResults;
      return {
        sources: allSources.slice(0, maxResults),
        truncated,
      };
    },
  });

  ctx.effect(() => () => { try { dispose?.(); } catch {} });
  return dispose;
}
