const readRoutes = new Set([
  '/api/extensions',
  '/api/extensions/comments',
  '/api/extensions/github',
  '/api/extensions/icon',
  '/api/extensions/index-base',
  '/api/extensions/package',
  '/api/extensions/registry',
  '/api/extensions/search',
  '/api/extensions/updates',
  '/api/run/lifecycle',
  '/api/worlds',
]);

const writeRoutes = new Set([
  '/api/extensions/check',
  '/api/extensions/comments',
  '/api/extensions/github/login',
  '/api/extensions/github/logout',
  '/api/extensions/index-base',
  '/api/extensions/install',
  '/api/extensions/registry',
  '/api/extensions/uninstall',
  '/api/extensions/vote',
  '/api/run/restart',
  '/api/worlds/activation',
  '/api/worlds/restart',
  '/api/worlds/visibility',
]);

/** Access the native market and World management on the existing Cortico host. */
export function createCorticoMarket(value) {
  const base = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (!loopback || base.protocol !== 'http:' || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash) {
    throw new TypeError('Cortico market requires the native loopback HTTP origin.');
  }

  return {
    origin: base.origin,
    url: new URL('/#/extensions/world', base).href,
    request(path, { method = 'GET', ...options } = {}) {
      const url = new URL(path, base);
      const allowed = method === 'GET' ? readRoutes : method === 'POST' ? writeRoutes : null;
      if (url.origin !== base.origin || url.username || url.password || url.hash ||
          !allowed?.has(url.pathname)) {
        throw new TypeError('Invalid Cortico market route.');
      }
      return fetch(url, { ...options, method, redirect: 'error' });
    },
  };
}
