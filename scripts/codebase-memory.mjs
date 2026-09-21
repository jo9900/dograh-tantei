import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = path.join(root, 'node_modules/codebase-memory-mcp');
const launcher = path.join(packageRoot, 'bin.js');
const action = process.argv[2] ?? 'serve';
const commands = {
  index: [
    'cli',
    'index_repository',
    '--repo-path',
    root,
    '--name',
    'dograh-tantei',
    '--mode',
    'full',
    '--persistence',
    'false',
  ],
  status: ['cli', 'index_status', '--project', 'dograh-tantei'],
  architecture: ['cli', 'get_architecture', '--project', 'dograh-tantei'],
  serve: [],
};

if (!Object.hasOwn(commands, action)) {
  console.error('Usage: node scripts/codebase-memory.mjs <index|status|architecture|serve>');
  process.exit(1);
}
if (!existsSync(launcher)) {
  console.error('Codebase Memory is not installed. Run npm ci in the repository first.');
  process.exit(1);
}

// Keep installer messages off the MCP JSON-RPC stdout stream on the first run.
const binary = path.join(
  packageRoot,
  'bin',
  process.platform === 'win32' ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp',
);
if (action === 'serve' && !existsSync(binary)) {
  const setup = spawnSync(process.execPath, [path.join(packageRoot, 'install.js')], {
    cwd: root,
    stdio: ['ignore', process.stderr, process.stderr],
  });
  if (setup.status !== 0) process.exit(setup.status ?? 1);
}

// The indexer uses its own local cache. It never receives the app's .env values.
const child = spawn(process.execPath, [launcher, ...commands[action]], {
  cwd: root,
  stdio: 'inherit',
});
child.on('error', (error) => {
  console.error(`Codebase Memory could not start: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
