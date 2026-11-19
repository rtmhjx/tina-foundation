import { pathToFileURL } from 'node:url';

const [entry, ...args] = process.argv.slice(2);

function stop() {
  // The native CLI owns teardown. IPC also works on Windows, where a parent
  // sending SIGTERM to the child terminates it before Node can handle it.
  if (!process.emit('SIGTERM')) process.exit(0);
}

process.on('message', (message) => {
  if (message?.type === 'tina-dsh:stop') stop();
});
process.once('disconnect', stop);

try {
  const { runCli } = await import(pathToFileURL(entry));
  process.argv = [process.execPath, entry, ...args];
  await runCli();
} catch {
  process.exit(1);
}
