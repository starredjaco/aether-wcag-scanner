#!/usr/bin/env node
/**
 * Dependency bootstrap for the aether-wcag-scanner plugin.
 *
 * Installs the plugin's runtime dependencies INTO THE PLUGIN'S OWN DIRECTORY the
 * first time it runs, then no-ops. Node's ES-module resolver ignores NODE_PATH, so
 * node_modules has to live next to the source.
 *
 * Used two ways:
 *   - as the SessionStart hook (CLI mode). It must not hold up the session
 *     (Claude Code waits for SessionStart hooks before Claude's first reply), so
 *     it does a fast check (~0.1 s) and exits when everything is present. When
 *     something is missing it starts a DETACHED copy of itself
 *     (`--foreground`, output to <CLAUDE_PLUGIN_DATA or tmp>/aether-deps-install.log)
 *     that installs node_modules and pre-downloads Chromium's headless shell, and
 *     exits 0 immediately (#23);
 *   - imported by scripts/start.js, which installs ONLY node_modules, synchronously,
 *     before launching the MCP server (the server cannot start without it). Chromium
 *     is NOT downloaded on the server's startup path: Claude Code allows a stdio MCP
 *     server roughly 60 s to answer the handshake. The server downloads it lazily on
 *     the first scan instead (src/concepts/a11y-scanner/browser-bootstrap.ts), or
 *     waits for this script's background download if one is running.
 *
 * Chromium (#25): only the headless shell is installed
 * (`playwright install --only-shell chromium`, about 100-125 MB to download and 200-300 MB
 * on disk, instead of about 300 MB / 580 MB for the full browser + shell). Every
 * launch is `headless: true`, which is what the shell is for. An existing full
 * install is accepted as-is (no re-download).
 *
 * Locks (both mkdir-based, so atomic on every OS):
 *   - node_modules: <CLAUDE_PLUGIN_DATA or plugin root>/.aether-install.lock. The
 *     hook's background child and start.js may start together on a fresh session;
 *     the second waits for the first's sentinel.
 *   - Chromium: <Playwright browsers dir>/.aether-chromium-install.lock, shared with
 *     browser-bootstrap.ts (same path, same owner.json + heartbeat protocol), so the
 *     MCP server waits for a background download instead of starting a second one.
 *   A lock is stale when its owner pid is dead (same host) or its heartbeat / age
 *   exceeds the limit; stale locks are renamed away and retaken.
 *
 * Windows: `npm` is a .cmd shim and cannot be spawned without a shell, so npm is
 * run through the node binary and npm-cli.js that ships next to it.
 *
 * All progress goes to stderr (stdout of a SessionStart hook is fed to the model;
 * stdout of the MCP server is the JSON-RPC channel).
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, hostname, tmpdir } from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLUGIN_ROOT =
  process.env.CLAUDE_PLUGIN_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `playwright install` arguments. browser-bootstrap.ts uses the same list. */
export const CHROMIUM_INSTALL_ARGS = ['install', '--only-shell', 'chromium'];
export const CHROMIUM_LOCK_NAME = '.aether-chromium-install.lock';
export const CHROMIUM_LOCK_STALE_MS = 2 * 60 * 1000; // heartbeat-based
const NPM_LOCK_STALE_MS = 15 * 60 * 1000; // age-based (npm runs synchronously, no heartbeat)
const HEARTBEAT_MS = 15 * 1000;
const WAIT_MS = 10 * 60 * 1000;
const IS_WINDOWS = process.platform === 'win32';
const TAG = '[aether-wcag-scanner]';

function log(msg) {
  process.stderr.write(`${TAG} ${msg}\n`);
}

function run(cmd, args, cwd, extra = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...extra });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const tail = `${res.stdout || ''}\n${res.stderr || ''}`.trim().split('\n').slice(-15).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}\n${tail}`);
  }
}

/**
 * Locate npm's JS entry point so it can be run with the current node binary on
 * every platform (no .cmd shim, no shell). Falls back to the `npm` on PATH.
 */
function npmCli() {
  const candidates = [];
  if (process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath)) {
    candidates.push(process.env.npm_execpath);
  }
  const nodeDir = dirname(process.execPath);
  candidates.push(
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows layout
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // unix layout
  );
  return candidates.find((p) => existsSync(p)) || null;
}

function runNpm(args, cwd) {
  const cli = npmCli();
  if (cli) {
    run(process.execPath, [cli, ...args], cwd);
    return;
  }
  // No bundled npm found next to node (e.g. a bare node binary). Use PATH; on
  // Windows that is npm.cmd, which needs a shell.
  run(IS_WINDOWS ? 'npm.cmd' : 'npm', args, cwd, IS_WINDOWS ? { shell: true } : {});
}

function sleep(ms) {
  spawnSync(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`]);
}

// ---------------------------------------------------------------------------
// Lock protocol (mirrors browser-bootstrap.ts)
// ---------------------------------------------------------------------------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function readLockOwner(lock) {
  try {
    return JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function isLockStale(lock, staleMs, now = Date.now()) {
  let mtime;
  try {
    mtime = statSync(lock).mtimeMs;
  } catch {
    return false;
  }
  const owner = readLockOwner(lock);
  // No owner.json: a lock from an older plugin version, or one mid-creation.
  if (!owner) return now - mtime > staleMs;
  if (owner.host === hostname() && !pidAlive(owner.pid)) return true;
  return now - mtime > staleMs;
}

export function tryAcquireLock(lock, staleMs) {
  mkdirSync(dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), started: Date.now() }));
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (attempt > 0 || !isLockStale(lock, staleMs)) return false;
      const grave = `${lock}.stale-${process.pid}-${Date.now()}`;
      try {
        renameSync(lock, grave);
        rmSync(grave, { recursive: true, force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function releaseLock(lock) {
  const owner = readLockOwner(lock);
  if (owner && (owner.pid !== process.pid || owner.host !== hostname())) return;
  rmSync(lock, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Layout + node_modules
// ---------------------------------------------------------------------------

function layout() {
  const root = PLUGIN_ROOT;
  const data = process.env.CLAUDE_PLUGIN_DATA || '';
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const installDir = data ? join(data, 'deps') : root;
  const nodeModules = join(installDir, 'node_modules');
  return {
    root,
    data,
    pkg,
    installDir,
    nodeModules,
    linkPath: join(root, 'node_modules'),
    sentinel: join(nodeModules, `.aether-${pkg.version}.installed`),
    lock: join(data || root, '.aether-install.lock'),
  };
}

function waitFor(sentinel, lock) {
  const deadline = Date.now() + WAIT_MS;
  log('another process is installing dependencies; waiting…');
  while (Date.now() < deadline) {
    if (existsSync(sentinel)) return true;
    // The installer died without finishing: let the caller take over.
    if (!existsSync(lock) || isLockStale(lock, NPM_LOCK_STALE_MS)) return false;
    sleep(1000);
  }
  throw new Error('timed out waiting for a concurrent dependency install');
}

function linkReady({ root, installDir, nodeModules, linkPath }) {
  if (installDir === root) return true;
  try {
    if (existsSync(linkPath)) return true;
    symlinkSync(nodeModules, linkPath, 'junction');
    return true;
  } catch (err) {
    log(`could not link node_modules into the plugin directory (${err.code ?? err.message})`);
    return false;
  }
}

/** Cheap: node_modules for this plugin version is installed and linked. */
export function nodeModulesReady(l = layout()) {
  return existsSync(l.sentinel) && linkReady(l);
}

/**
 * Ensure node_modules exists for this plugin version. Returns true when ready.
 * Synchronous: start.js calls it before launching the MCP server.
 *
 * Layout: CLAUDE_PLUGIN_ROOT (the install dir) may be replaced on update, while
 * CLAUDE_PLUGIN_DATA (~/.claude/plugins/data/<id>/) is the writable store that
 * survives updates. Dependencies are installed into DATA and linked into
 * ROOT/node_modules (a junction on Windows, no admin rights needed) so Node's
 * ES-module resolver finds them next to the source. Without CLAUDE_PLUGIN_DATA
 * (local dev, `npm start`) they are installed into ROOT.
 */
export function ensureNodeModules() {
  const l = layout();
  const { root, data, installDir, sentinel, lock } = l;

  if (nodeModulesReady(l)) return true;

  if (data) mkdirSync(data, { recursive: true });
  for (let attempt = 0; !tryAcquireLock(lock, NPM_LOCK_STALE_MS); attempt++) {
    if (waitFor(sentinel, lock)) return linkReady(l);
    if (attempt >= 2) throw new Error(`could not take the dependency install lock ${lock}`);
  }
  try {
    if (!existsSync(sentinel)) {
      log('first run: installing dependencies (one-time, ~1 min)…');
      mkdirSync(installDir, { recursive: true });
      if (installDir !== root) {
        // npm installs whatever package.json it finds in cwd; mirror the plugin's manifest there.
        copyFileSync(join(root, 'package.json'), join(installDir, 'package.json'));
      }
      runNpm(['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], installDir);
      writeFileSync(sentinel, `${new Date().toISOString()}\n`);
      log('dependencies ready.');
    }
    return linkReady(l);
  } finally {
    releaseLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Chromium (headless shell)
// ---------------------------------------------------------------------------

function fromEnv(env, name) {
  const lower = name.toLowerCase();
  return env[name] ?? env[`npm_config_${lower}`] ?? env[`npm_package_config_${lower}`];
}

/** Mirror of playwright-core's registryDirectory (see browser-bootstrap.ts). */
export function resolveRegistryDirectory({ platform, env, homedir: home, coreDir, cwd }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const envDefined = fromEnv(env, 'PLAYWRIGHT_BROWSERS_PATH');
  let result;
  if (envDefined === '0') result = p.join(coreDir, '.local-browsers');
  else if (envDefined) result = envDefined;
  else {
    let cache;
    if (platform === 'linux') cache = env.XDG_CACHE_HOME || p.join(home, '.cache');
    else if (platform === 'darwin') cache = p.join(home, 'Library', 'Caches');
    else if (platform === 'win32') cache = env.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
    else throw new Error(`Unsupported platform: ${platform}`);
    result = p.join(cache, 'ms-playwright');
  }
  if (!p.isAbsolute(result)) result = p.resolve(fromEnv(env, 'INIT_CWD') || cwd, result);
  return result;
}

function markerFor(exe, registryDir) {
  const rel = path.relative(registryDir, exe);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return join(registryDir, rel.split(path.sep)[0], 'INSTALLATION_COMPLETE');
}

function complete(exe, registryDir) {
  if (!exe || !existsSync(exe)) return false;
  const marker = markerFor(exe, registryDir);
  return marker ? existsSync(marker) : true;
}

/**
 * Chromium state, asking the plugin's own playwright-core where things live.
 * Returns { registryDir, installed, kind } — kind 'shell' | 'full' | null.
 */
export function chromiumState(nodeModules = layout().nodeModules) {
  const req = createRequire(join(nodeModules, '..', 'package.json'));
  const coreDir = dirname(req.resolve('playwright-core/package.json'));
  let api = null;
  try {
    api = req('playwright-core/lib/server/registry/index');
  } catch {
    api = null;
  }
  const registryDir =
    api?.registryDirectory ||
    resolveRegistryDirectory({ platform: process.platform, env: process.env, homedir: homedir(), coreDir, cwd: process.cwd() });

  let shell = null;
  let full = null;
  try {
    shell = api?.registry.findExecutable('chromium-headless-shell')?.executablePath() ?? null;
    full = api?.registry.findExecutable('chromium')?.executablePath() ?? null;
  } catch {
    /* fall back below */
  }
  if (!shell) {
    // Registry API unavailable: find the shell for the expected revision by file name.
    try {
      const browsers = JSON.parse(readFileSync(join(coreDir, 'browsers.json'), 'utf8')).browsers;
      const rev = browsers.find((b) => b.name === 'chromium-headless-shell')?.revision;
      const dir = join(registryDir, `chromium_headless_shell-${rev}`);
      const names = ['headless_shell', 'chrome-headless-shell'].map((n) => (IS_WINDOWS ? `${n}.exe` : n));
      for (const sub of readdirSync(dir).sort()) {
        const hit = names.map((n) => join(dir, sub, n)).find((c) => existsSync(c));
        if (hit) {
          shell = hit;
          break;
        }
      }
    } catch {
      /* not installed */
    }
  }
  if (complete(shell, registryDir)) return { registryDir, installed: true, kind: 'shell' };
  if (!full) {
    // Public API; slower to load than the registry, so only on this rare path
    // (an older full-browser install without the shell, which is reused as-is).
    try {
      full = req('playwright').chromium.executablePath();
    } catch {
      full = null;
    }
  }
  const kind = complete(full, registryDir) ? 'full' : null;
  return { registryDir, installed: kind !== null, kind };
}

/**
 * Download Chromium's headless shell if no headless-capable Chromium is present.
 * Requires node_modules (call ensureNodeModules first). Takes the shared Chromium
 * lock; if another process holds it, returns without waiting (that process is
 * already doing the work).
 */
export async function ensureChromium() {
  const { nodeModules, installDir } = layout();
  const cli = join(nodeModules, 'playwright', 'cli.js');
  if (!existsSync(cli)) throw new Error('playwright is not installed; run ensureNodeModules() first');
  if (process.env.AETHER_NO_BROWSER_INSTALL === '1') return;
  const state = chromiumState(nodeModules);
  if (state.installed) return;
  const lock = join(state.registryDir, CHROMIUM_LOCK_NAME);
  if (!tryAcquireLock(lock, CHROMIUM_LOCK_STALE_MS)) {
    log('another process is already downloading Chromium; leaving it to that process.');
    return;
  }
  const beat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lock, now, now);
    } catch {
      /* lock removed */
    }
  }, HEARTBEAT_MS);
  try {
    if (chromiumState(nodeModules).installed) return;
    log(`downloading Chromium headless shell (one-time, ~100-125 MB download): playwright ${CHROMIUM_INSTALL_ARGS.join(' ')}`);
    await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [cli, ...CHROMIUM_INSTALL_ARGS], {
        cwd: installDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout.on('data', (c) => process.stderr.write(c));
      child.stderr.on('data', (c) => process.stderr.write(c));
      child.on('error', reject);
      child.on('exit', (code, signal) =>
        code === 0 ? resolvePromise() : reject(new Error(`playwright install exited with ${code ?? signal}`)),
      );
    });
    log('Chromium ready.');
  } finally {
    clearInterval(beat);
    releaseLock(lock);
  }
}

/** Everything: node_modules + Chromium. Run by the detached background child. */
export async function ensureDeps() {
  if (!ensureNodeModules()) return false;
  await ensureChromium();
  return true;
}

/** True when the SessionStart hook has nothing to do. Must stay fast (~0.1 s). */
export function everythingReady() {
  const l = layout();
  if (!nodeModulesReady(l)) return false;
  if (process.env.AETHER_NO_BROWSER_INSTALL === '1') return true;
  try {
    return chromiumState(l.nodeModules).installed;
  } catch {
    return false;
  }
}

export function backgroundLogPath() {
  return join(process.env.CLAUDE_PLUGIN_DATA || tmpdir(), 'aether-deps-install.log');
}

/** Start `ensure-deps.js --foreground` detached, output appended to the log file. */
function spawnBackground() {
  const logPath = backgroundLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  try {
    writeFileSync(fd, `\n=== ${new Date().toISOString()} background dependency install (pid ${process.pid} parent) ===\n`);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--foreground'], {
      cwd: PLUGIN_ROOT,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: process.env,
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  return logPath;
}

// CLI mode. Never fail the session; the server surfaces a clearer error.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--foreground')) {
    // The detached worker (or a manual `node scripts/ensure-deps.js --foreground`).
    ensureDeps()
      .catch((err) => log(`dependency install failed: ${err?.message ?? err}`))
      .finally(() => process.exit(0));
  } else {
    // SessionStart hook: fast check, otherwise hand off to a background worker.
    try {
      if (!everythingReady()) {
        const logPath = spawnBackground();
        log(`installing dependencies / Chromium in the background (log: ${logPath})`);
      }
    } catch (err) {
      log(`could not start the background dependency install: ${err?.message ?? err}`);
    }
    process.exit(0);
  }
}
