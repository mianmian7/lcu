// Spawn the macOS CUA server from a background ChatGPT.app (`com.openai.codex`) process so that
// macOS kernel `responsibility_get_pid_responsible_for_pid` attributes `trusted-worker.js` to
// `com.openai.codex` (Team ID `2DC432GLL2`), satisfying `SkyComputerUseService`'s
// `ComputerUseIPCSenderContext.allowsLockScreenAutoUnlock` check for Locked Use.
const { spawn } = process.getBuiltinModule('node:child_process');
const fs = process.getBuiltinModule('node:fs');
const net = process.getBuiltinModule('node:net');
const { homedir, constants: osConstants } = process.getBuiltinModule('node:os');
const { dirname, join } = process.getBuiltinModule('node:path');
const { fileURLToPath } = process.getBuiltinModule('node:url');

const THIS_FILE = fileURLToPath(import.meta.url);
const CHATGPT_APP = '/Applications/ChatGPT.app';
const WAKE_URL = 'codex://threads/wake/00000000-0000-4000-8000-000000000000';

function stateDir() {
  return join(homedir(), '.codex/computer-use');
}

export function defaultSpawnerSocket() {
  return join(stateDir(), 'lcu-spawner.sock');
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeFrame(socket, type, payload) {
  if (socket.destroyed) return;
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.allocUnsafe(5);
  header[0] = type;
  header.writeUInt32BE(buf.length, 1);
  try {
    socket.write(Buffer.concat([header, buf]));
  } catch {}
}

function startDaemon(socketPath, parentPid) {
  fs.mkdirSync(dirname(socketPath), { recursive: true });
  try { fs.unlinkSync(socketPath); } catch {}

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let headerBuf = Buffer.alloc(0);
    let initialized = false;
    let child = null;

    const onData = (chunk) => {
      if (!initialized) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const nl = headerBuf.indexOf(10);
        if (nl < 0) return;
        initialized = true;
        const line = headerBuf.subarray(0, nl).toString('utf8');
        const remainder = headerBuf.subarray(nl + 1);
        headerBuf = null;

        let req;
        try {
          req = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        if (req?.type === 'ping') {
          socket.end(JSON.stringify({ ok: true, pid: process.pid, parentPid }) + '\n');
          return;
        }
        const { command, env, cwd } = req ?? {};
        if (!Array.isArray(command) || !command.length) {
          socket.destroy();
          return;
        }
        try {
          child = spawn(command[0], command.slice(1), {
            env,
            cwd: cwd || '/',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch (err) {
          socket.end(JSON.stringify({ ok: false, error: String(err?.message || err) }) + '\n');
          return;
        }

        socket.write(JSON.stringify({ ok: true, childPid: child.pid, parentPid }) + '\n');
        if (remainder.length > 0) {
          try { child.stdin.write(remainder); } catch {}
        }

        child.stdout.on('data', (d) => writeFrame(socket, 1, d));
        child.stderr.on('data', (d) => writeFrame(socket, 2, d));
        child.once('error', (err) => {
          writeFrame(socket, 2, Buffer.from(`Spawner child error: ${err.message}\n`));
        });
        child.once('close', (status, signal) => {
          const code = status ?? 128 + (osConstants.signals[signal] ?? 0);
          writeFrame(socket, 3, Buffer.from(JSON.stringify({ status: code, signal })));
          try { socket.end(); } catch {}
        });
      } else if (child && child.stdin && !child.stdin.destroyed) {
        try { child.stdin.write(chunk); } catch {}
      }
    };

    socket.on('data', onData);
    socket.once('end', () => {
      try { child?.stdin?.end(); } catch {}
    });
    socket.once('close', () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM'); } catch {}
      }
    });
    socket.on('error', () => {});
  });

  server.listen(socketPath, () => {
    try { fs.chmodSync(socketPath, 0o600); } catch {}
  });

  const timer = setInterval(() => {
    if (!isPidAlive(parentPid)) {
      clearInterval(timer);
      try { fs.unlinkSync(socketPath); } catch {}
      process.exit(0);
    }
  }, 3000);
  timer.unref();
}

function pingSpawner(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, 1000);
    socket.once('connect', () => {
      socket.write(JSON.stringify({ type: 'ping' }) + '\n');
    });
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      const nl = data.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        socket.destroy();
        try {
          const res = JSON.parse(data.slice(0, nl));
          resolve(res?.ok && isPidAlive(res.parentPid) ? res : null);
        } catch {
          resolve(null);
        }
      }
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function quoteSh(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function writeTrampoline(dir, socketPath) {
  const trampolinePath = join(dir, 'lcu-codex-trampoline.sh');
  const nodeBin = `${CHATGPT_APP}/Contents/Resources/cua_node/bin/node`;
  const realCodex = `${CHATGPT_APP}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`;
  const script = [
    '#!/bin/sh',
    'unset CODEX_CLI_PATH',
    `${quoteSh(nodeBin)} ${quoteSh(THIS_FILE)} --daemon ${quoteSh(socketPath)} "$PPID" >/dev/null 2>&1 &`,
    `exec ${quoteSh(realCodex)} "$@"`,
    '',
  ].join('\n');
  fs.writeFileSync(trampolinePath, script, { mode: 0o700 });
  fs.chmodSync(trampolinePath, 0o700);
  return trampolinePath;
}

async function ensureSpawner(socketPath) {
  const existing = await pingSpawner(socketPath);
  if (existing) return existing;

  const dir = dirname(socketPath);
  const userDataDir = join(dir, 'lcu-host-userdata');
  fs.mkdirSync(userDataDir, { recursive: true });
  const trampolinePath = writeTrampoline(dir, socketPath);

  const opener = spawn('/usr/bin/open', [
    '-gj', '-n', '-a', CHATGPT_APP,
    '--env', `CODEX_ELECTRON_USER_DATA_PATH=${userDataDir}`,
    '--env', `CODEX_CLI_PATH=${trampolinePath}`,
    '--args', WAKE_URL,
  ], { stdio: 'ignore' });
  await new Promise((resolve) => opener.once('close', resolve));

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const res = await pingSpawner(socketPath);
    if (res) return res;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

export async function runChildViaCodex(command, env, fallbackRunChild) {
  if (process.platform !== 'darwin' || env?.LCU_MACOS_CODEX_SPAWNER === '0' ||
      !env?.NODE_REPL_NODE_PATH?.startsWith(`${CHATGPT_APP}/`)) {
    return fallbackRunChild(command, env);
  }
  const socketPath = defaultSpawnerSocket();
  const ready = await ensureSpawner(socketPath);
  if (!ready) return fallbackRunChild(command, env);

  return new Promise((resolveStatus, reject) => {
    const socket = net.createConnection(socketPath);
    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    let settled = false;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      process.stdin.off('data', onStdinData);
      process.stdin.off('end', onStdinEnd);
      try { socket.destroy(); } catch {}
      resolveStatus(code);
    };

    const onStdinData = (chunk) => {
      if (!socket.destroyed) {
        try { socket.write(chunk); } catch {}
      }
    };
    const onStdinEnd = () => {
      if (!socket.destroyed) {
        try { socket.end(); } catch {}
      }
    };

    socket.once('connect', () => {
      let cwd = '/';
      try { cwd = process.cwd(); } catch {}
      socket.write(JSON.stringify({ command, env, cwd }) + '\n');
    });

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        handshakeDone = true;
        const line = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 1);
        let res;
        try { res = JSON.parse(line); } catch {}
        if (!res?.ok) {
          try { socket.destroy(); } catch {}
          settled = true;
          fallbackRunChild(command, env).then(resolveStatus, reject);
          return;
        }
        process.stdin.on('data', onStdinData);
        process.stdin.once('end', onStdinEnd);
        process.stdin.resume();
      }

      while (buf.length >= 5) {
        const type = buf[0];
        const len = buf.readUInt32BE(1);
        if (buf.length < 5 + len) break;
        const payload = buf.subarray(5, 5 + len);
        buf = buf.subarray(5 + len);
        if (type === 1) {
          process.stdout.write(payload);
        } else if (type === 2) {
          process.stderr.write(payload);
        } else if (type === 3) {
          try {
            const info = JSON.parse(payload.toString('utf8'));
            finish(info.status ?? 0);
          } catch {
            finish(0);
          }
          return;
        }
      }
    });

    socket.once('error', () => {
      if (!handshakeDone && !settled) {
        settled = true;
        fallbackRunChild(command, env).then(resolveStatus, reject);
      } else {
        finish(1);
      }
    });

    socket.once('close', () => {
      if (!settled) finish(0);
    });
  });
}

if (process.argv[2] === '--daemon') {
  startDaemon(process.argv[3] || defaultSpawnerSocket(), Number(process.argv[4]));
}
