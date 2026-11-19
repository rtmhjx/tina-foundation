// A real subprocess with no media, credentials, HTTP, or device access.
import { existsSync, writeFileSync } from 'node:fs';
const [file, mode, codeText = '76'] = process.argv.slice(2);
const code = Number(codeText);
const finish = () => {
  writeFileSync(file + '.closed', String(code));
  console.log(JSON.stringify({ outcome: code === 76 ? 'unknown' : code === 0 ? 'completed' : 'cancelled', settled: code !== 76 }));
  process.exit(code);
};
process.on('SIGTERM', () => writeFileSync(file + '.signal', 'SIGTERM'));
writeFileSync(file + '.ready', String(process.pid));
if (mode === 'immediate') finish();
setInterval(() => { if (existsSync(file + '.release')) finish(); }, 10);
setTimeout(() => process.exit(90), 10000);
