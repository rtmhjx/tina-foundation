#!/usr/bin/env node
// audio-play custom backend replacement: --file PATH --volume 0..100
import { connect } from 'node:net';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2), index = key => args.indexOf(key);
const fileIndex = index('--file'), volumeIndex = index('--volume');
const file = args[fileIndex + 1], volume = Number(args[volumeIndex + 1]), socketPath = process.env.CANBOT_MEDIA_SOCKET;
if (args.length !== 4 || fileIndex < 0 || volumeIndex < 0 || !isAbsolute(file ?? '') || !Number.isInteger(volume)
    || volume < 0 || volume > 100 || !isAbsolute(socketPath ?? '')) process.exit(2);
const socket = connect(socketPath); let body = '', done = false;
const requestId = randomUUID();
process.stderr.write(`CANBOT media request ${requestId}\n`);
const finish = code => { if (done) return; done = true; socket.destroy(); process.exitCode = code; };
socket.on('connect', () => socket.write(JSON.stringify({ action: 'play', requestId, file, volume }) + '\n'));
socket.on('data', chunk => { body += chunk.toString('utf8'); if (body.length > 4096) return finish(76);
  if (body.includes('\n')) { try { const reply = JSON.parse(body.slice(0, body.indexOf('\n')));
    if (reply.outcome === 'rejected' && /^[a-z_]{1,80}$/.test(reply.code ?? '')) process.stderr.write(`CANBOT media rejected: ${reply.code}\n`);
    finish(reply.outcome === 'completed' ? 0 : reply.outcome === 'rejected' ? 2 : 76);
  } catch { finish(76); } } });
socket.on('error', () => finish(76));
socket.on('close', () => { if (!done) finish(76); });
process.on('SIGTERM', () => { socket.destroy(); process.exitCode = 130; });
process.on('SIGINT', () => { socket.destroy(); process.exitCode = 130; });
