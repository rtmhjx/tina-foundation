import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const backendProfileName = 'tina-backend';
export const backendProfileVersion = '0.1.5-rc.2';

const baseBundle = '@deepseek-ai/dsh-base';
const webBundle = '@deepseek-ai/dsh-web-app';
const nativeWebRows = new Set([
  'agent-presets', 'code-runtime', 'connection', 'cordis-host-runner',
  'file-reference-local', 'file-upload', 'message-feedback', 'plugin-inventory',
  'session-controller', 'session-reference', 'session-stats', 'session-turn-outline',
  'settings-controller', 'subagent-model-selection-settings', 'workspace',
  'workspace-controller', 'workspace-files',
]);

/** Reuse the pinned distribution's host capabilities and agent preset defaults. */
export async function loadBackendProfile(appBoot, binName, installAnchor, homeDir) {
  const dir = appBoot.resolveProfileDir(backendProfileName, homeDir);
  appBoot.initProfile(dir, [baseBundle], 'live');
  const profile = appBoot.loadProfileDirectory(binName, dir, installAnchor);
  if (profile.layers[0]?.packageName !== baseBundle) {
    throw new Error('Tina backend requires DSH base as its first profile bundle.');
  }

  const webDir = appBoot.resolveBundleDir(binName, webBundle, installAnchor, dir);
  const manifest = JSON.parse(await readFile(join(webDir, 'package.json'), 'utf8'));
  const webPatches = appBoot.loadOverlayPatches(binName, join(webDir, manifest.dsh.bundle.patch));
  const nativePatches = [];
  const remainingRows = new Set(nativeWebRows);
  for (const patch of webPatches) {
    if (!patch.insert) {
      // These restatements move the host tool entries into the standard preset,
      // or tune native services shared by all interactive sessions.
      nativePatches.push(patch);
      continue;
    }
    const insert = [];
    for (const row of patch.insert) {
      if (!remainingRows.delete(row.id)) continue;
      if (row.id === 'connection') {
        // FileUploads uses the original in-memory fetch registry. Connection
        // attaches browser routes only when a Web server service is present.
        insert.push({ id: row.id, name: row.name });
      } else {
        insert.push(row);
      }
    }
    if (insert.length) nativePatches.push({ ...patch, insert });
  }
  if (remainingRows.size) throw new Error(`DSH backend profile rows missing: ${[...remainingRows].join(', ')}.`);
  const [base, ...additional] = profile.layers;
  const bundlePatches = [...base.patches, ...nativePatches, ...additional.flatMap(layer => layer.patches)];
  return { profile, bundlePatches };
}

/** Compose native user overlays without a product-specific package blacklist. */
export function assertBackendPatches(appBoot, patches) {
  return appBoot.composeEntries([patches]);
}
