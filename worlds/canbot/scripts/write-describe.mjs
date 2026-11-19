import { readFile, writeFile } from 'node:fs/promises';
import { CANBOT } from '../src/definition.mjs';

// Construction only: does not start a World, bind a port or load credentials.
const content = await readFile(new URL('../src/ENV_PROMPT.md', import.meta.url), 'utf8');
const description = { ...CANBOT.describe, prompts: [{ key: 'worlds.canbot.envPrompt',
  title: 'CANBOT · 环境提示词', role: 'envPrompt', content }] };
await writeFile(new URL('../describe.json', import.meta.url), JSON.stringify(description, null, 2) + '\n');
