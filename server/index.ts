import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import express from 'express';
import { createWorkbench } from './app.js';
import { loadLocalEnvironment, readEnvironmentConfig } from './environment.js';

loadLocalEnvironment();
const environment = readEnvironmentConfig();
const port = Number(process.env.TANTEI_PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('TANTEI_PORT must be between 1024 and 65535.');
const workbench = await createWorkbench({
  dataDir: path.resolve(process.env.TANTEI_DATA_DIR || path.join(os.homedir(), '.tantei')),
  port,
  environment,
});
const dev = process.argv.includes('--dev');
let vite: import('vite').ViteDevServer | undefined;
if (dev) {
  vite = await (
    await import('vite')
  ).createServer({ server: { middlewareMode: true }, appType: 'spa' });
  workbench.app.use(vite.middlewares);
} else {
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  workbench.app.use(express.static(dist));
  workbench.app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}
const server = workbench.app.listen(port, '127.0.0.1', () =>
  console.log(
    `Dograh Tantei is ready: http://127.0.0.1:${port}\nLocal data: ${workbench.store.dir}`,
  ),
);
server.on('error', async (error) => {
  console.error(error.message);
  await workbench.close();
  process.exitCode = 1;
});
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log('Stopping calls and saving local data…');
  await workbench.close();
  await vite?.close();
  server.close();
  const deadline = setTimeout(() => process.exit(0), 12000);
  deadline.unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
