import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
const python =
  process.env.TANTEI_PYTHON ||
  path.resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
const uv = spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0;
if (!existsSync(python)) {
  if (process.env.TANTEI_PYTHON) throw new Error('TANTEI_PYTHON does not exist.');
  if (existsSync('.venv'))
    throw new Error('.venv exists without a usable Python. Preserve it and choose TANTEI_PYTHON.');
  if (uv) run('uv', ['venv', '--python', '3.12', '.venv']);
  else run(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'venv', '.venv']);
}
if (uv) run('uv', ['pip', 'install', '--python', python, '-r', 'audio_worker/requirements.txt']);
else run(python, ['-m', 'pip', 'install', '-r', 'audio_worker/requirements.txt']);
run(python, ['-c', 'import aiortc, av, numpy, websockets; print("Audio worker is ready.")']);
