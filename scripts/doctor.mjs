import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
console.log(`Node: ${process.version}`);
console.log(`Node packages: ${existsSync('node_modules') ? 'installed' : 'run npm ci'}`);
const python =
  process.env.TANTEI_PYTHON ||
  path.resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const check = spawnSync(
  python,
  ['-c', 'import sys, aiortc, av, numpy, websockets; print(sys.version.split()[0])'],
  { encoding: 'utf8' },
);
console.log(
  `Audio: ${check.status === 0 ? `ready (Python ${check.stdout.trim()})` : 'not ready — run npm run setup:audio'}`,
);
console.log(`Web: http://127.0.0.1:${process.env.TANTEI_PORT || 4317}`);
if (check.status !== 0) process.exitCode = 1;
