import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importBotDefinition, loadExtensions, locateBotPackage, readInstalled } from '../upstream/cortico/src/extensions.ts';
import { withWorlds } from '../upstream/cortico/src/world.ts';

const defaultCorticoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'upstream', 'cortico');
const referencePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

export class FusionBotSelectionError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.code = code;
  }
}

function botReference(value) {
  if (typeof value !== 'string' || !referencePattern.test(value) || value.length > 214) {
    throw new FusionBotSelectionError('INVALID_BOT_REFERENCE', 'Bot must be a built-in ID or an installed npm package name.');
  }
  return value;
}

async function deploymentManifest(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  let manifest;
  try { manifest = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (error) { throw new FusionBotSelectionError('INVALID_DEPLOYMENT_MANIFEST', 'Cannot parse ' + path, error); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new FusionBotSelectionError('INVALID_DEPLOYMENT_MANIFEST', 'Expected an object in ' + path);
  }
  if ('bot' in manifest) botReference(manifest.bot);
  return manifest;
}

export async function saveFusionBotSelection({ stateDir, bot }) {
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new Error('stateDir must be absolute.');
  const reference = botReference(bot);
  const file = join(resolve(stateDir), 'deployment.json');
  const previous = await deploymentManifest(file);
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid + '-' + randomUUID();
  await writeFile(temporary, JSON.stringify({ ...previous, bot: reference }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
  return file;
}

/** Select code only from this runtime's explicit package roots and deployment. */
export async function selectFusionBot({
  stateDir, bot, corticoRoot = defaultCorticoRoot,
  builtinWorlds = [], reservedProviders = [], log,
  persistSelection = bot !== undefined,
} = {}) {
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new Error('stateDir must be absolute.');
  const state = resolve(stateDir);
  const source = resolve(corticoRoot);
  const selectionFile = join(state, 'deployment.json');
  const manifest = await deploymentManifest(selectionFile);
  const reference = botReference(bot ?? manifest?.bot ?? 'cormini');
  const extensionDir = join(state, 'extensions');
  await mkdir(extensionDir, { recursive: true });
  const treeDir = join(source, 'bots', ...reference.split('/'));
  let location;
  try { location = locateBotPackage(source, reference, treeDir, { dir: extensionDir }); }
  catch (error) {
    const installed = readInstalled(extensionDir).some(item => item.name === reference);
    throw new FusionBotSelectionError(installed ? 'INVALID_BOT_PACKAGE' : 'BOT_PACKAGE_NOT_FOUND',
      'Cannot select Bot ' + reference + ': ' + error.message, error);
  }
  let definition;
  try {
    definition = await importBotDefinition(location, {
      treeHas: id => referencePattern.test(id) && existsSync(join(source, 'bots', id, 'index.ts')),
    });
  } catch (error) {
    throw new FusionBotSelectionError('INVALID_BOT_DEFINITION', 'Cannot load Bot ' + reference + ': ' + error.message, error);
  }
  const botPackage = location.source === 'extension' ? { name: location.name, id: definition.id } : undefined;
  const extensions = await loadExtensions(source, {
    dir: extensionDir,
    reserved: [...builtinWorlds, ...definition.worlds ?? []].map(world => world.id),
    reservedProviders,
    ...(botPackage ? { activeBot: botPackage } : {}),
    ...(log ? { log } : {}),
  });
  const worlds = new Map([...builtinWorlds, ...extensions.worlds, ...definition.worlds ?? []].map(world => [world.id, world]));
  const assembled = withWorlds(definition, [...worlds.values()]);
  if (persistSelection) await saveFusionBotSelection({ stateDir: state, bot: reference });
  return {
    reference, source: location.source, definition: assembled, rawDefinition: definition,
    pkgDir: location.pkgDir, botPackage, extensions, extensionDir,
    deployDir: join(state, 'deployment'), selectionFile,
  };
}
