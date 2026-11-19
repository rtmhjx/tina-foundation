import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'upstream', 'cortico');
const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(metadata.version)) throw new Error('Invalid Cortico source version.');
const declarations = await readFile(join(source, 'src/extensions/manifest.ts'), 'utf8');
const apiBlock = declarations.match(/EXTENSION_API_VERSIONS[^=]*=\s*\{([^}]+)\}/)?.[1];
if (!apiBlock) throw new Error('Cortico extension contract declaration is missing.');
const contracts = Object.fromEntries([...apiBlock.matchAll(/\b(world|provider|bot)\s*:\s*(\d+)/g)].map(([, name, value]) => [name, Number(value)]));
if (Object.keys(contracts).length !== 3) throw new Error('Cortico extension contract declaration changed; review the snapshot adapter.');
const retainedGit = join(root, '.tina-fusion-dev', 'source-git', 'cortico.git');
const originalGit = join(source, '.git');
const gitDir = await lstat(originalGit).then(() => originalGit, error => {
  if (error.code === 'ENOENT') return retainedGit;
  throw error;
});
const git = args => execFileSync('git', ['--git-dir', gitDir, '--work-tree', source, ...args], { encoding: 'utf8' });
const integrationRevision = git(['rev-parse', 'HEAD']).trim();
const requestedBase = process.argv[2];
if (requestedBase !== undefined && !/^[a-f0-9]{40}$/i.test(requestedBase)) throw new Error('Pass an exact upstream commit hash.');
const revision = requestedBase ? git(['rev-parse', requestedBase + '^{commit}']).trim() : integrationRevision;
if (requestedBase) git(['merge-base', '--is-ancestor', revision, integrationRevision]);
const paths = [...new Set([
  ...git(['ls-files', '-z']).split('\0'),
  ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
].filter(Boolean))].sort();
for (const path of paths) {
  if (isAbsolute(path) || path.split(/[/\\]/).includes('..') || /[\r\n]/.test(path)
    || (path !== '.env.example' && /(^|\/)(?:node_modules|deployments|\.env(?:\..*)?|\.credentials(?:\..*)?)(\/|$)/.test(path))) {
    throw new Error('Unexpected private or unsafe file in source snapshot.');
  }
}
const vendor = join(root, 'vendor');
const scratch = join(root, '.tina-fusion-dev', 'source-snapshot');
await mkdir(vendor, { recursive: true });
await mkdir(scratch, { recursive: true });
const fileList = join(scratch, 'cortico-files.txt');
await writeFile(fileList, paths.join('\n') + '\n');
const files = [];
for (const path of paths) {
  const bytes = await readFile(join(source, path));
  files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const patch = git(['diff', '--binary', '--no-ext-diff', revision]);
await writeFile(join(vendor, 'cortico-source-local.patch'), patch);
const archiveName = `cortico-source-${metadata.version}-fusion.tgz`;
const archive = join(vendor, archiveName);
execFileSync('tar', ['-czf', archive, '-C', source, '-T', fileList]);
const archiveHash = createHash('sha256').update(await readFile(archive)).digest('hex');
const sourceTreeHash = createHash('sha256').update(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 })))).digest('hex');
const lock = {
  format: 1, upstream: 'https://github.com/Pal-AI-Lab/Cortico.git', revision,
  integrationRevision,
  version: metadata.version, license: metadata.license, contracts,
  archive: archiveName, archiveSha256: archiveHash,
  sourceTreeSha256: sourceTreeHash,
  trackedDiff: 'cortico-source-local.patch', addedFiles: [...new Set([
    ...git(['diff', '--name-only', '--diff-filter=A', revision, '-z']).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))].sort(),
  files,
};
await writeFile(join(vendor, 'cortico-source-lock.json'), JSON.stringify(lock, null, 2) + '\n');
console.log(JSON.stringify({ revision, files: files.length, archive, archiveSha256: archiveHash }));
