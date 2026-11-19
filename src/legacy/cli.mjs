import process from 'node:process';
import { openRuntime, inspectRuntime } from './runtime.mjs';

function waitForExit() {
  return new Promise((resolve) => {
    function stop() {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.stdin.off('end', stop);
      process.stdin.pause();
      resolve();
    }

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.stdin.once('end', stop);
    process.stdin.resume();
  });
}

async function main(args) {
  const paths = args.filter((arg) => arg !== '--inspect');
  if (paths.length > 1 || paths.some((arg) => arg.startsWith('-'))) {
    throw new Error('Usage: npm start -- [path-to-cordis.yml] [--inspect]');
  }

  const inspect = args.includes('--inspect');
  const ctx = await openRuntime(paths[0] ?? 'cordis.yml');
  try {
    console.log(JSON.stringify({ ...(inspect ? {} : { event: 'ready' }), entries: inspectRuntime(ctx) }));
    if (!inspect) await waitForExit();
  } finally {
    await ctx.fiber.dispose();
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
