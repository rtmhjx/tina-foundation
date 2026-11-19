import { readFile, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireFrameworkResolver } from '../upstream/cortico/src/extensions/runtime.ts';

export const MARKET_PROVIDERS = Object.freeze({
  official: { name: 'cortico-provider-coo', version: '0.3.1', exportName: 'CHATGPT_PROVIDER',
    integrity: 'sha512-mudXlHjEJ7cATie3iU5o1ly1ohPDwDkJjB/V+QVUqJnuLW+3AqeYnYUyFqoxAVDtIzb4I7sWvwmcvLWKH6aAJQ==' },
  community: { name: 'cortico-provider-chatgpt', version: '0.1.6', exportName: 'default',
    integrity: 'sha512-AK/O5t3Mw8Kx2ZwYyZ52JeRZvAaRbaMKF7Hevl7ilzUGkMtZYdRnuEDwzdECNUjInON1lwsq4KJBrKEqyfcPog==' },
});

/** Resolve a pinned market export through Cortico's public API-6 contract.
 * Auth, endpoint state, transport, refresh and sign-out remain package-owned.
 * Caller adds the returned module to its existing registration lifecycle.
 */
export async function loadMarketProviderModule({ packageDir, selection = 'community' }) {
  const pin = MARKET_PROVIDERS[selection];
  if (!pin) throw new Error('Unknown pinned market Provider selection.');
  const root = await realpath(packageDir);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== pin.name || manifest.version !== pin.version || manifest.cortico?.kind !== 'provider'
    || manifest.cortico?.api !== 6 || manifest.type !== 'module') throw new Error('Market Provider package identity or API contract differs from the reviewed pin.');
  const entry = await realpath(resolve(root, manifest.main));
  const local = relative(root, entry);
  if (local.startsWith('..') || isAbsolute(local)) throw new Error('Market Provider entry escapes its package.');
  const release = acquireFrameworkResolver({ roots: [pathToFileURL(root).href,
    // Dependencies import the same public cortico/* API and must share its classes.
    pathToFileURL(join(root, '..')).href] });
  try {
    const exports = await import(pathToFileURL(entry).href);
    const module = exports[pin.exportName];
    if (module?.id !== 'chatgpt' || typeof module.create !== 'function') throw new Error('Reviewed ChatGPT Provider export is unavailable.');
    return { module, identity: { ...pin, api: 6, packageDir: root, source: selection === 'official' ? 'Pal AI Lab' : 'zhiyuxl community' },
      // This is a source-level capability statement, not account/model access.
      execution: { ultra: false, scope: 'codex-ultra-orchestration',
        apiUltraEffort: selection === 'community' ? 'rejected-by-SIWC-direct-2026-11-15' : 'same-route-not-independently-probed', code: 'ULTRA_UNSUPPORTED',
        reasoningEfforts: module.reasoningTiers.filter(tier => tier.thinking).map(tier => tier.effort ?? tier.id),
        reason: 'This market module provides Responses inference, not the Codex Ultra agent orchestration runtime.' },
      dispose: release };
  } catch (error) { release(); throw error; }
}
