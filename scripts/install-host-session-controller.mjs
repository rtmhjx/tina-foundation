/** Exact-baseline source overlay installer. No running host is restarted or rewritten implicitly. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, copyFile, mkdir, realpath, stat, unlink, rmdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeComponents, nativePackageName } from './native-components.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requestedComponent = process.argv.find(value => value.startsWith('--component='))?.slice(12) ?? 'controller';
const component = nativeComponents[requestedComponent];
if (!component) throw new Error('Unknown compatibility component.');
const source = join(root, 'upstream', component);
const args = process.argv.slice(2);
const installed = args.includes('--installed');
const upgrade = args.includes('--upgrade');
const refreshReceipt = args.includes('--refresh-receipt');
if (refreshReceipt && (installed || upgrade || args.includes('--rollback') || !args.includes('--apply'))) {
  throw new Error('--refresh-receipt requires --apply and cannot combine with rollback/upgrade/installed.');
}
if (installed && args.includes('--apply')) throw new Error('--installed is only available for inspection or rollback.');
if (upgrade && (installed || args.includes('--rollback'))) throw new Error('--upgrade is only available for plan/apply with a reviewed source build.');
const runtimeArg = args.find(value => value.startsWith('--runtime='))?.slice('--runtime='.length);
if (!runtimeArg) throw new Error('Supply --runtime=<explicit DSH runtime directory>; default action verifies only.');
const runtime = await realpath(resolve(runtimeArg));
const packageDir = await realpath(join(runtime, 'node_modules', nativePackageName(requestedComponent)));
if (!packageDir.startsWith(runtime + sep)) throw new Error('Refusing package link outside selected runtime.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const backupDir = join(packageDir, '.cortico-host-routing-v1');
const build = JSON.parse(await readFile(installed ? join(backupDir, 'receipt.json') : join(source, 'BUILD.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
const target = join(packageDir, 'lib/index.js');
const before = await readFile(target);
const beforeSha = hash(before);
if (!installed && hash(await readFile(join(source, 'lib/index.js'))) !== build.overlaySha256) throw new Error('Overlay differs from reviewed build.');
const inputBaselines = [build.baselineSha256, ...(build.compatibleInputSha256 ?? [])];
const safePayloadPath = path => /^lib\/(?:[A-Za-z0-9_-]+\.js(?:\.map)?|chunks\/[A-Za-z0-9_-]+\.js(?:\.map)?|types\/[A-Za-z0-9_-]+\.(?:js(?:\.map)?|d\.ts))$/.test(path);
let previousBuild;
if (upgrade && ![...inputBaselines, build.overlaySha256].includes(beforeSha)) {
  // An installed overlay is accepted only by its complete installation receipt
  // and the original baseline backup, never by extending a compatibility hash.
  previousBuild = JSON.parse(await readFile(join(backupDir, 'receipt.json'), 'utf8'));
  const savedBaseline = hash(await readFile(join(backupDir, 'index.baseline.js')));
  if (previousBuild.package !== build.package || previousBuild.version !== build.version
      || previousBuild.overlaySha256 !== beforeSha || !inputBaselines.includes(savedBaseline)
      || !Array.isArray(previousBuild.payloadFiles) || !previousBuild.payloadFiles.length) {
    throw new Error('Installed overlay is outside the reviewed upgrade lineage.');
  }
  for (const item of previousBuild.payloadFiles) {
    if (!safePayloadPath(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256)
        || hash(await readFile(join(packageDir, item.path))) !== item.sha256) {
      throw new Error('Installed overlay receipt/payload mismatch before upgrade.');
    }
  }
}
if (pkg.name !== build.package || pkg.version !== build.version ||
    ![...inputBaselines, build.overlaySha256, previousBuild?.overlaySha256].includes(beforeSha)) {
  throw new Error('Unsupported DSH controller baseline; source port and fresh acceptance required.');
}
const extras = (build.payloadFiles ?? []).filter(row => !['lib/index.js', 'lib/index.js.map'].includes(row.path));
for (const item of build.payloadFiles ?? []) {
  if (!safePayloadPath(item.path)) throw new Error('Unsafe payload path.');
  if (!installed && hash(await readFile(join(source, item.path))) !== item.sha256) throw new Error('Payload differs from reviewed build: ' + item.path);
}
for (const item of extras.filter(row => !row.path.endsWith('.map'))) {
  try {
    const current = hash(await readFile(join(packageDir, item.path)));
    if (![item.sha256, ...(build.entryFamily?.[item.path] ?? []), previousBuild?.payloadFiles.find(file => file.path === item.path)?.sha256].includes(current)) throw new Error('Unsupported entry family: ' + item.path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (beforeSha === build.overlaySha256) for (const item of build.payloadFiles ?? []) {
  if (hash(await readFile(join(packageDir, item.path))) !== item.sha256) throw new Error('Installed entry-family drift: ' + item.path);
}
const apply = args.includes('--apply');
const rollback = args.includes('--rollback');
if (apply && rollback) throw new Error('Choose --apply or --rollback.');
const backup = join(backupDir, 'index.baseline.js');
const mapTarget = join(packageDir, 'lib/index.js.map');
const mapBackup = join(backupDir, 'index.baseline.js.map');
let retainedExtras;
try { retainedExtras = JSON.parse(await readFile(join(backupDir, 'extra-files.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; retainedExtras = []; }
for (const item of retainedExtras) {
  // Earlier builds can have different content-addressed chunk names. Their
  // original backup is still part of this installer's rollback lineage.
  if (!safePayloadPath(item.path)
      || ['lib/index.js', 'lib/index.js.map'].includes(item.path)
      || typeof item.existed !== 'boolean' || (item.existed && !/^[a-f0-9]{64}$/.test(item.sha256))) {
    throw new Error('Unsafe rollback receipt path or hash.');
  }
}
if (previousBuild) {
  const mapReceipt = JSON.parse(await readFile(join(backupDir, 'baseline-map.json'), 'utf8'));
  if (typeof mapReceipt.exists !== 'boolean' || (mapReceipt.exists
      && hash(await readFile(mapBackup)) !== mapReceipt.sha256)) {
    throw new Error('Original source map backup is invalid before upgrade.');
  }
  for (const item of retainedExtras) if (item.existed
      && hash(await readFile(join(backupDir, 'files', item.path))) !== item.sha256) {
    throw new Error('Original entry-family backup is invalid before upgrade.');
  }
}
async function transactional(operation) {
  const paths = [...new Set([target, mapTarget, backup, mapBackup,
    join(backupDir, 'baseline-map.json'), join(backupDir, 'extra-files.json'), join(backupDir, 'receipt.json'),
    ...[...extras, ...retainedExtras].flatMap(item => [join(packageDir, item.path), join(backupDir, 'files', item.path)])])];
  const originals = [];
  const absentDirectories = new Set();
  for (const path of paths) {
    if (!path.startsWith(packageDir + sep)) throw new Error('Mutation path escapes selected package.');
    let bytes;
    try { bytes = await readFile(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    originals.push({ path, bytes });
    let parent = dirname(path);
    while (parent !== packageDir && parent.startsWith(packageDir + sep)) {
      try { await stat(parent); }
      catch (error) { if (error.code !== 'ENOENT') throw error; absentDirectories.add(parent); }
      parent = dirname(parent);
    }
  }
  try { return await operation(); }
  catch (cause) {
    const restorationErrors = [];
    for (const item of originals.reverse()) {
      try {
        if (item.bytes !== undefined) await writeFile(item.path, item.bytes);
        else { try { await unlink(item.path); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      } catch (error) { restorationErrors.push(error); }
    }
    for (const path of [...absentDirectories].sort((a, b) => b.length - a.length)) {
      try { await rmdir(path); }
      catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) restorationErrors.push(error); }
    }
    if (restorationErrors.length) throw new AggregateError([cause, ...restorationErrors], 'Component operation and file restoration failed.');
    throw new Error('Component operation failed; original files restored.', { cause });
  }
}
// A previous no-op build may leave an older receipt beside identical reviewed
// bytes. Reconcile metadata only after proving the complete current payload and
// the retained original rollback family; this never accepts new library bytes.
let receiptRefreshed = false;
if (refreshReceipt) {
  if (beforeSha !== build.overlaySha256) throw new Error('Receipt refresh requires the exact current reviewed payload.');
  const oldReceiptBytes = await readFile(join(backupDir, 'receipt.json'));
  const oldReceipt = JSON.parse(oldReceiptBytes);
  if (oldReceipt.package !== build.package || oldReceipt.version !== build.version) throw new Error('Receipt refresh package lineage mismatch.');
  const baselineSha256 = hash(await readFile(backup));
  if (!inputBaselines.includes(baselineSha256)) throw new Error('Receipt refresh original baseline is unreviewed.');
  const mapReceipt = JSON.parse(await readFile(join(backupDir, 'baseline-map.json')));
  if (typeof mapReceipt.exists !== 'boolean' || (mapReceipt.exists && hash(await readFile(mapBackup)) !== mapReceipt.sha256)) {
    throw new Error('Receipt refresh original source map backup mismatch.');
  }
  for (const item of extras) if (!retainedExtras.some(saved => saved.path === item.path)) throw new Error('Receipt refresh lacks original entry-family backup: ' + item.path);
  for (const item of retainedExtras) if (item.existed) {
    const saved = hash(await readFile(join(backupDir, 'files', item.path)));
    if (saved !== item.sha256 || (build.entryFamily?.[item.path] && !build.entryFamily[item.path].includes(saved))) {
      throw new Error('Receipt refresh original entry-family backup mismatch: ' + item.path);
    }
  }
  const oldReceiptSha256 = hash(oldReceiptBytes);
  const preserved = 'receipt-before-refresh-' + oldReceiptSha256 + '.json';
  try { await writeFile(join(backupDir, preserved), oldReceiptBytes, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (hash(await readFile(join(backupDir, preserved))) !== oldReceiptSha256) throw new Error('Preserved receipt integrity mismatch.');
  await transactional(async () => {
    const reconciliation = { reason: 'Exact reviewed payload already present; reconcile stale installation metadata without rewriting libraries.',
      previousReceipt: preserved, previousReceiptSha256: oldReceiptSha256, baselineSha256,
      baselineMap: mapReceipt, originalEntryFamily: retainedExtras, libraryBytesChanged: false };
    await writeFile(join(backupDir, 'receipt.json'), JSON.stringify({ ...build, appliedAt: new Date().toISOString(), reconciliation }, null, 2));
  });
  receiptRefreshed = true;
}
if (apply && beforeSha !== build.overlaySha256) await transactional(async () => {
  await mkdir(backupDir, { recursive: true });
  try {
    const saved = await readFile(backup);
    if ((!previousBuild && hash(saved) !== beforeSha) || !inputBaselines.includes(hash(saved))) throw new Error('Existing backup baseline hash mismatch.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(backup, before, { flag: 'wx' });
    let map;
    try { map = await readFile(mapTarget); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (map) await writeFile(mapBackup, map, { flag: 'wx' });
    await writeFile(join(backupDir, 'baseline-map.json'), JSON.stringify({ exists: map !== undefined,
      sha256: map === undefined ? null : hash(map) }), { flag: 'wx' });
  }
  const extraReceipt = [...retainedExtras];
  for (const item of extras.filter(row => !extraReceipt.some(saved => saved.path === row.path))) {
      let bytes;
      try { bytes = await readFile(join(packageDir, item.path)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (bytes) {
        const saved = join(backupDir, 'files', item.path);
        await mkdir(dirname(saved), { recursive: true });
        await writeFile(saved, bytes, { flag: 'wx' });
      }
      extraReceipt.push({ path: item.path, existed: bytes !== undefined, sha256: bytes === undefined ? null : hash(bytes) });
  }
  await writeFile(join(backupDir, 'extra-files.json'), JSON.stringify(extraReceipt, null, 2));
  for (const item of previousBuild?.payloadFiles ?? []) {
    if (['lib/index.js', 'lib/index.js.map'].includes(item.path)) continue;
    if ((build.payloadFiles ?? []).some(next => next.path === item.path)) continue;
    const original = retainedExtras.find(saved => saved.path === item.path);
    if (!original) throw new Error('Missing original backup for superseded payload: ' + item.path);
    if (original.existed) {
      const bytes = await readFile(join(backupDir, 'files', item.path));
      if (hash(bytes) !== original.sha256) throw new Error('Superseded payload baseline backup mismatch.');
      await writeFile(join(packageDir, item.path), bytes);
    } else {
      try { await unlink(join(packageDir, item.path)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  for (const item of extras) {
    await mkdir(dirname(join(packageDir, item.path)), { recursive: true });
    await copyFile(join(source, item.path), join(packageDir, item.path));
  }
  await copyFile(join(source, 'lib/index.js'), target);
  if (build.payloadFiles?.some(item => item.path === 'lib/index.js.map')) await copyFile(join(source, 'lib/index.js.map'), mapTarget);
  else { try { await unlink(mapTarget); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  await writeFile(join(backupDir, 'receipt.json'), JSON.stringify({ ...build, appliedAt: new Date().toISOString() }, null, 2));
  for (const item of build.payloadFiles ?? []) {
    if (hash(await readFile(join(packageDir, item.path))) !== item.sha256) throw new Error('Entry-family readback mismatch.');
  }
});
let restoredSha;
if (rollback && beforeSha === build.overlaySha256) await transactional(async () => {
  const saved = await readFile(backup);
  restoredSha = hash(saved);
  if (!inputBaselines.includes(restoredSha)) throw new Error('Rollback backup hash mismatch.');
  const extraReceipt = [...retainedExtras];
  for (const item of extras) {
    if (!extraReceipt.some(saved => saved.path === item.path)) throw new Error('Missing rollback entry-family backup: ' + item.path);
  }
  const restoredExtras = [];
  for (const item of extraReceipt) {
    const bytes = item.existed ? await readFile(join(backupDir, 'files', item.path)) : undefined;
    if (bytes !== undefined && hash(bytes) !== item.sha256) throw new Error('Rollback entry-family hash mismatch.');
    restoredExtras.push({ ...item, bytes });
  }
  const mapReceipt = JSON.parse(await readFile(join(backupDir, 'baseline-map.json'), 'utf8'));
  if (mapReceipt.exists) {
    const baselineMap = await readFile(mapBackup);
    if (hash(baselineMap) !== mapReceipt.sha256) throw new Error('Rollback source map hash mismatch.');
    await writeFile(mapTarget, baselineMap);
  } else {
    // This exact file was introduced by this installer and lies inside the verified package directory.
    const { unlink } = await import('node:fs/promises');
    try { await unlink(mapTarget); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const item of restoredExtras) {
    const path = join(packageDir, item.path);
    if (item.existed) await writeFile(path, item.bytes);
    else { try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  await writeFile(target, saved);
  if (hash(await readFile(target)) !== restoredSha) throw new Error('Rollback entry readback mismatch.');
});
if (apply) for (const item of extras) {
  if (hash(await readFile(join(packageDir, item.path))) !== item.sha256) throw new Error('Entry-family readback mismatch.');
}
const afterSha = hash(await readFile(target));
const expected = rollback ? restoredSha ?? beforeSha : apply ? build.overlaySha256 : beforeSha;
if (afterSha !== expected) throw new Error('Controller readback mismatch.');
console.log(JSON.stringify({ verified: true, applied: apply, rolledBack: rollback, package: pkg.name,
  runtime, sha256: afterSha, upgradeFromSha256: previousBuild?.overlaySha256,
  receiptRefreshed,
  changed: afterSha !== beforeSha, restartRequired: afterSha !== beforeSha }));
