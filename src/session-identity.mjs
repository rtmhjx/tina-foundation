import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function getSessionId(stateDir) {
  await mkdir(stateDir, { recursive: true });
  const file = join(stateDir, 'dsh-session-id');
  try {
    await writeFile(file, randomUUID() + '\n', { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const id = (await readFile(file, 'utf8')).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Invalid Tina DSH session identity: ' + file);
  }
  return id;
}
