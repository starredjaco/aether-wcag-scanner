/**
 * Browser bootstrap — make sure Playwright's Chromium is present before the
 * first `chromium.launch()`.
 *
 * Why lazy: the Claude Code plugin used to download Chromium inside the MCP
 * server launcher, before the server could answer the MCP handshake. Claude Code
 * gives a stdio server ~60 s to start, so on an ordinary connection the plugin
 * showed up as "not connected" on first use. Installing lazily, on the first
 * scan, keeps startup fast. The plugin's SessionStart hook
 * (docs/marketplace-draft/scripts/ensure-deps.js) pre-warms the same download in
 * a detached background process, so most users never wait here.
 *
 * What gets installed (#25): every launch in this codebase is `headless: true`
 * with no `channel`, and for that Playwright runs `chromium-headless-shell`, not
 * the full browser. So only the shell is installed
 * (`playwright install --only-shell chromium`, ~100-125 MB download / ~200-300 MB on disk
 * instead of ~300 MB / ~580 MB for browser + shell + ffmpeg). A machine that
 * already has the full browser but no shell (`--no-shell` installs) is NOT made
 * to download anything: the launch is pointed at the full browser's executable
 * via `executablePath` (see chromiumLaunchOverrides()).
 *
 * Concurrency: the SessionStart background install and this lazy install share
 * one lock directory inside the Playwright browsers directory
 * (`<registry>/.aether-chromium-install.lock`). Whoever holds it downloads; the
 * other side waits for it instead of starting a second download. ensure-deps.js
 * implements the same protocol in plain JS — keep the two in step (the unit test
 * cross-checks them). Playwright's own `__dirlock` additionally serialises the
 * actual extraction, so a lost race costs time, never a corrupt install.
 *
 * All output goes to stderr: in the MCP server stdout is the JSON-RPC channel.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

/** `playwright install` arguments. ensure-deps.js uses the same list. */
export const CHROMIUM_INSTALL_ARGS = ['install', '--only-shell', 'chromium'] as const;
export const LOCK_NAME = '.aether-chromium-install.lock';
/** A lock whose heartbeat is older than this is considered abandoned. */
export const LOCK_STALE_MS = 2 * 60 * 1000;
const HEARTBEAT_MS = 15 * 1000;
const WAIT_POLL_MS = 1000;
const WAIT_LIMIT_MS = 20 * 60 * 1000;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

/** Playwright's getFromENV: plain var, then npm_config_*, then npm_package_config_*. */
function fromEnv(env: Env, name: string): string | undefined {
  const lower = name.toLowerCase();
  return env[name] ?? env[`npm_config_${lower}`] ?? env[`npm_package_config_${lower}`];
}

export interface RegistryDirInput {
  platform: NodeJS.Platform;
  env: Env;
  homedir: string;
  /** playwright-core package directory (for PLAYWRIGHT_BROWSERS_PATH=0). */
  coreDir: string;
  cwd: string;
}

/**
 * Where Playwright keeps its browsers. Mirrors playwright-core's
 * `registryDirectory` exactly (PLAYWRIGHT_BROWSERS_PATH, `0` = inside
 * node_modules, per-OS cache dir). Pure so it can be tested for every OS; the
 * live value from Playwright's registry is preferred when it can be loaded.
 */
export function resolveRegistryDirectory(input: RegistryDirInput): string {
  const p = input.platform === 'win32' ? path.win32 : path.posix;
  const envDefined = fromEnv(input.env, 'PLAYWRIGHT_BROWSERS_PATH');
  let result: string;
  if (envDefined === '0') {
    result = p.join(input.coreDir, '.local-browsers');
  } else if (envDefined) {
    result = envDefined;
  } else {
    let cache: string;
    if (input.platform === 'linux') cache = input.env.XDG_CACHE_HOME || p.join(input.homedir, '.cache');
    else if (input.platform === 'darwin') cache = p.join(input.homedir, 'Library', 'Caches');
    else if (input.platform === 'win32') cache = input.env.LOCALAPPDATA || p.join(input.homedir, 'AppData', 'Local');
    else throw new Error(`Unsupported platform: ${input.platform}`);
    result = p.join(cache, 'ms-playwright');
  }
  if (!p.isAbsolute(result)) result = p.resolve(fromEnv(input.env, 'INIT_CWD') || input.cwd, result);
  return result;
}

/** Executable file names chromium-headless-shell has used across Playwright releases. */
export function headlessShellNames(platform: NodeJS.Platform): string[] {
  // <=1.56: chrome-<os>/headless_shell ; Chrome-for-Testing builds (1.57+):
  // chrome-headless-shell-<platform>/chrome-headless-shell
  const base = ['headless_shell', 'chrome-headless-shell'];
  return platform === 'win32' ? base.map((n) => `${n}.exe`) : base;
}

export interface FsLike {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
}

/**
 * Find the shell executable inside a `chromium_headless_shell-<rev>` directory
 * without assuming its sub-directory name: look one level down for any of the
 * known file names. Used only when Playwright's registry API is unavailable.
 */
export function findHeadlessShellIn(
  browserDir: string,
  platform: NodeJS.Platform,
  fsl: FsLike = fs,
): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const names = headlessShellNames(platform);
  let subdirs: string[];
  try {
    subdirs = fsl.readdirSync(browserDir);
  } catch {
    return null;
  }
  for (const sub of subdirs.sort()) {
    for (const name of names) {
      const candidate = p.join(browserDir, sub, name);
      if (fsl.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The INSTALLATION_COMPLETE marker Playwright writes after extracting a browser:
 * `<registry>/<first path segment of exe>/INSTALLATION_COMPLETE`. An executable
 * without its marker is a half-finished (possibly in-progress) extraction.
 */
export function markerFor(exe: string, registryDir: string, platform: NodeJS.Platform): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const rel = p.relative(registryDir, exe);
  if (!rel || rel.startsWith('..') || p.isAbsolute(rel)) return null;
  const top = rel.split(p.sep)[0];
  return p.join(registryDir, top, 'INSTALLATION_COMPLETE');
}

const require = createRequire(import.meta.url);

interface RegistryApi {
  registryDirectory: string;
  registry: { findExecutable(name: string): { executablePath(): string | undefined; directory?: string } | undefined };
}

function loadRegistry(): RegistryApi | null {
  try {
    // Exported subpath of playwright-core 1.56, but not semver-public: newer
    // releases (e.g. 1.64, which the published plugin resolves ^1.56.1 to) bundle
    // the registry and drop the export. Callers fall back to the mirrored logic.
    return require('playwright-core/lib/server/registry/index') as RegistryApi;
  } catch {
    return null;
  }
}

function coreDir(): string {
  try {
    return path.dirname(require.resolve('playwright-core/package.json'));
  } catch {
    return process.cwd();
  }
}

/** Revision Playwright expects for a browser, from playwright-core/browsers.json. */
function expectedRevision(name: string): string | null {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(coreDir(), 'browsers.json'), 'utf8'));
    const entry = (json.browsers as Array<{ name: string; revision: string }>).find((b) => b.name === name);
    return entry?.revision ?? null;
  } catch {
    return null;
  }
}

export function registryDirectory(): string {
  const api = loadRegistry();
  if (api?.registryDirectory) return api.registryDirectory;
  return resolveRegistryDirectory({
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    coreDir: coreDir(),
    cwd: process.cwd(),
  });
}

/** Path Playwright launches for `headless: true` (installed or not). */
export function headlessShellExecutablePath(): string | null {
  const api = loadRegistry();
  try {
    const exe = api?.registry.findExecutable('chromium-headless-shell')?.executablePath();
    if (exe) return exe;
  } catch {
    /* fall through */
  }
  const rev = expectedRevision('chromium-headless-shell');
  if (!rev) return null;
  return findHeadlessShellIn(path.join(registryDirectory(), `chromium_headless_shell-${rev}`), process.platform);
}

export interface ChromiumStatus {
  /** 'shell' = chromium-headless-shell (preferred); 'full' = only the full browser is present. */
  kind: 'shell' | 'full' | null;
  executablePath?: string;
}

function completeInstall(exe: string | null | undefined, registry: string): boolean {
  if (!exe || !fs.existsSync(exe)) return false;
  const marker = markerFor(exe, registry, process.platform);
  // No marker path (exe outside the registry, e.g. a custom build): trust the file.
  return marker ? fs.existsSync(marker) : true;
}

export function chromiumStatus(): ChromiumStatus {
  const registry = registryDirectory();
  const shell = headlessShellExecutablePath();
  if (completeInstall(shell, registry)) return { kind: 'shell', executablePath: shell! };
  let full: string | undefined;
  try {
    full = chromium.executablePath();
  } catch {
    full = undefined;
  }
  if (completeInstall(full, registry)) return { kind: 'full', executablePath: full };
  return { kind: null };
}

/** True when a Chromium Playwright can launch headless is already on disk. */
export function isChromiumInstalled(): boolean {
  return chromiumStatus().kind !== null;
}

/**
 * Extra `chromium.launch()` options. Empty when the headless shell is present
 * (Playwright picks it for `headless: true`); `{ executablePath }` when only the
 * full browser is installed, so existing installs keep working without a
 * download.
 */
export function chromiumLaunchOverrides(status: ChromiumStatus = chromiumStatus()): { executablePath?: string } {
  return status.kind === 'full' && status.executablePath ? { executablePath: status.executablePath } : {};
}

// ---------------------------------------------------------------------------
// Install lock (same protocol as ensure-deps.js)
// ---------------------------------------------------------------------------

export interface LockOwner {
  pid: number;
  host: string;
  started: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLockOwner(lock: string): LockOwner | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')) as LockOwner;
  } catch {
    return null;
  }
}

/**
 * A lock is stale when its owner is a dead process on this host, or when its
 * heartbeat (the lock directory's mtime, touched every 15 s by the owner) is
 * older than staleMs. A lock without owner.json (mid-creation, or written by
 * an older plugin version) is judged by its age alone.
 */
export function isLockStale(lock: string, staleMs = LOCK_STALE_MS, now = Date.now()): boolean {
  let mtime: number;
  try {
    mtime = fs.statSync(lock).mtimeMs;
  } catch {
    return false; // gone: not stale, just free
  }
  const owner = readLockOwner(lock);
  if (!owner) return now - mtime > staleMs;
  if (owner.host === os.hostname() && !pidAlive(owner.pid)) return true;
  return now - mtime > staleMs;
}

/** Try to take the lock (atomic mkdir). Breaks a stale lock once. */
export function tryAcquireLock(lock: string, staleMs = LOCK_STALE_MS): boolean {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lock);
      const owner: LockOwner = { pid: process.pid, host: os.hostname(), started: Date.now() };
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(owner));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (attempt > 0 || !isLockStale(lock, staleMs)) return false;
      // Rename first so only one of two concurrent breakers removes it.
      const grave = `${lock}.stale-${process.pid}-${Date.now()}`;
      try {
        fs.renameSync(lock, grave);
        fs.rmSync(grave, { recursive: true, force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function releaseLock(lock: string): void {
  const owner = readLockOwner(lock);
  if (owner && (owner.pid !== process.pid || owner.host !== os.hostname())) return; // not ours
  fs.rmSync(lock, { recursive: true, force: true });
}

function heartbeat(lock: string): NodeJS.Timeout {
  const t = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lock, now, now);
    } catch {
      /* lock removed underneath us; nothing useful to do */
    }
  }, HEARTBEAT_MS);
  t.unref();
  return t;
}

export function chromiumLockPath(): string {
  return path.join(registryDirectory(), LOCK_NAME);
}

// ---------------------------------------------------------------------------
// ensureChromiumInstalled
// ---------------------------------------------------------------------------

export interface EnsureDeps {
  status: () => ChromiumStatus;
  install: () => Promise<void>;
  lockPath: string;
  pollMs?: number;
  waitLimitMs?: number;
  log?: (msg: string) => void;
}

/**
 * Core of ensureChromiumInstalled, with its collaborators injectable for tests.
 * Resolves to the launch overrides for the browser that ended up on disk.
 */
export async function ensureChromiumWith(deps: EnsureDeps): Promise<{ executablePath?: string }> {
  const log = deps.log ?? ((m: string) => process.stderr.write(`[aether] ${m}\n`));
  const pollMs = deps.pollMs ?? WAIT_POLL_MS;
  const deadline = Date.now() + (deps.waitLimitMs ?? WAIT_LIMIT_MS);
  let announcedWait = false;

  for (;;) {
    const status = deps.status();
    if (status.kind) return chromiumLaunchOverrides(status);

    if (tryAcquireLock(deps.lockPath)) {
      const beat = heartbeat(deps.lockPath);
      try {
        // Someone may have finished between our check and the lock.
        const again = deps.status();
        if (again.kind) return chromiumLaunchOverrides(again);
        await deps.install();
        const after = deps.status();
        if (!after.kind) throw new Error('Chromium install finished but the headless shell is still missing.');
        return chromiumLaunchOverrides(after);
      } finally {
        clearInterval(beat);
        releaseLock(deps.lockPath);
      }
    }

    // Another process (normally the SessionStart background install) holds the
    // lock: wait for it rather than starting a second download.
    if (!announcedWait) {
      log('Chromium is being downloaded by another process (plugin session start); waiting for it…');
      announcedWait = true;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for another process to install Chromium (lock ${deps.lockPath}). ` +
          'Run "npx playwright install --only-shell chromium" manually, then retry.',
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

let inflight: Promise<{ executablePath?: string }> | null = null;

/**
 * Ensure a headless-capable Chromium is installed, downloading the headless
 * shell once if missing. Concurrent callers in this process share one install;
 * other processes are coordinated through the lock. Resolves to options to
 * spread into `chromium.launch()`. Set AETHER_NO_BROWSER_INSTALL=1 to disable
 * the download (the launch then fails with Playwright's own error).
 */
export function ensureChromiumInstalled(): Promise<{ executablePath?: string }> {
  const status = chromiumStatus();
  if (status.kind) return Promise.resolve(chromiumLaunchOverrides(status));
  if (process.env.AETHER_NO_BROWSER_INSTALL === '1') return Promise.resolve({});
  if (!inflight) {
    inflight = ensureChromiumWith({
      status: chromiumStatus,
      install: installChromium,
      lockPath: chromiumLockPath(),
    }).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

function playwrightCli(): string {
  // `playwright/cli.js` is not in the package's `exports` map, so resolve the
  // package root via package.json and build the path by hand.
  return path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
}

function installChromium(): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stderr.write('[aether] Chromium headless shell not found — downloading it now (one-time, ~100-125 MB download)…\n');
    const child = spawn(process.execPath, [playwrightCli(), ...CHROMIUM_INSTALL_ARGS], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // Both streams go to stderr: stdout is reserved for JSON-RPC in the MCP server.
    child.stdout?.on('data', (chunk) => process.stderr.write(chunk));
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        process.stderr.write('[aether] Chromium ready.\n');
        resolve();
      } else {
        reject(
          new Error(
            `playwright ${CHROMIUM_INSTALL_ARGS.join(' ')} exited with ${code ?? signal}. ` +
              'Run "npx playwright install --only-shell chromium" manually, then retry.',
          ),
        );
      }
    });
  });
}
