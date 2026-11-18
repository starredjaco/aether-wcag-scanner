/**
 * Fix history: repeat detection across scans (#31).
 *
 * A beta tester ran scan → fix → re-scan three times and got the identical
 * suggestion for `landmark-no-duplicate-contentinfo` each time, with nothing
 * saying it had already been suggested. `findingId` changes with every scanId,
 * so nothing linked the scans.
 *
 * This module remembers, per `origin + path + ruleId + target`, which fix was
 * given and in which scan. When a later scan still reports that rule on that
 * target, the fix entry gets `repeat: {count, previousScanId, sameFixAgain}`
 * plus a fixed note telling the agent not to re-apply the same change blindly.
 *
 * Storage: an in-process map, mirrored to a small JSON file so the history
 * survives the MCP server's restarts:
 *   $CLAUDE_PLUGIN_DATA/fix-history.json          when CLAUDE_PLUGIN_DATA is set
 *   $XDG_CACHE_HOME/aether/fix-history.json       else, when XDG_CACHE_HOME is set
 *   ~/.cache/aether/fix-history.json              otherwise
 * `AETHER_FIX_HISTORY=off` keeps it in memory only. Entries expire after
 * 30 days, the file holds at most 2000 entries (oldest evicted), writes are
 * atomic (temp file + rename), and a corrupt or unwritable file is tolerated:
 * the history just falls back to memory. Logging goes to stderr only.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface FixHistoryEntry {
  /** sha1 of the whitespace-normalised fixHtml that was suggested. */
  fixHtmlHash: string;
  /** The scan that last gave a fix for this key. */
  scanId: string;
  /** How many scans have given a fix for this key. */
  count: number;
  firstSeen: number;
  lastSeen: number;
}

/** Added to a fix entry whose rule/target was already given a fix in an earlier scan. */
export interface RepeatInfo {
  /** How many earlier scans gave a fix for this rule/target. */
  count: number;
  previousScanId: string;
  /** true when this scan's fixHtml is the same suggestion as last time. */
  sameFixAgain: boolean;
  note: string;
}

/** Added to a remainingViolations row whose rule/target had a fix before. */
export interface RemainingRepeatInfo {
  count: number;
  previousScanId: string;
  note: string;
}

export const REPEAT_NOTE =
  'This rule/target was given a fix in an earlier scan and still fires. The earlier fix did not work here ' +
  "or was not applied; don't re-apply it unchanged. Inspect the surrounding page (e.g. conflicting elements) instead.";

export const REMAINING_REPEAT_NOTE =
  'This rule/target was given a fix in an earlier scan and still fires (no fix slot this scan). The earlier fix ' +
  'did not work here or was not applied; inspect the surrounding page (e.g. conflicting elements) before retrying it.';

export const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_ENTRIES = 2000;
/** Instance targets recorded per grouped fix (matches the instances list cap). */
const MAX_KEYS_PER_FIX = 20;
const FILE_VERSION = 1;

export interface FixHistoryOptions {
  /** JSON file to persist to; null = memory only. */
  file?: string | null;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/** Resolve the persistence file from the environment (null = memory only). */
export function defaultHistoryFile(env: NodeJS.ProcessEnv = process.env): string | null {
  if (/^(off|0|false|no)$/i.test(env.AETHER_FIX_HISTORY ?? '')) return null;
  if (env.CLAUDE_PLUGIN_DATA) return join(env.CLAUDE_PLUGIN_DATA, 'fix-history.json');
  const cacheRoot = env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cacheRoot, 'aether', 'fix-history.json');
}

/** sha1 of whitespace-normalised markup, so formatting-only differences still match. */
export function hashFixHtml(fixHtml: string): string {
  return createHash('sha1').update(fixHtml.replace(/\s+/g, ' ').trim()).digest('hex');
}

/**
 * `origin + path + ruleId + target`. Query strings are dropped; a hash route
 * (`#/x`, `#!/x`) is kept because it is the SPA's path.
 */
export function historyKey(pageUrl: string, ruleId: string, target: string | string[] | undefined): string {
  let page = pageUrl;
  try {
    const u = new URL(pageUrl);
    const hashRoute = /^#!?\//.test(u.hash) ? u.hash : '';
    page = `${u.origin}${u.pathname}${hashRoute}`;
  } catch {
    // Not a URL: use it verbatim.
  }
  const t = Array.isArray(target) ? target.join(' >> ') : (target ?? '');
  return `${page}|${ruleId}|${t}`;
}

function isEntry(v: unknown): v is FixHistoryEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.fixHtmlHash === 'string' &&
    typeof e.scanId === 'string' &&
    typeof e.count === 'number' && Number.isFinite(e.count) && e.count >= 1 &&
    typeof e.firstSeen === 'number' && Number.isFinite(e.firstSeen) &&
    typeof e.lastSeen === 'number' && Number.isFinite(e.lastSeen)
  );
}

export class FixHistory {
  private entries = new Map<string, FixHistoryEntry>();
  private readonly file: string | null;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private loaded = false;
  private persistFailed = false;

  constructor(opts: FixHistoryOptions = {}) {
    this.file = opts.file === undefined ? defaultHistoryFile() : opts.file;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    this.ensureLoaded();
    return this.entries.size;
  }

  /** Live (non-expired) entry for a key. */
  get(key: string): FixHistoryEntry | undefined {
    this.ensureLoaded();
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.now() - e.lastSeen > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  /**
   * The repeat a key represents for `scanId`: an entry written by a DIFFERENT
   * scan. Entries from this same scan (two groups sharing a target) are not repeats.
   */
  previous(key: string, scanId: string): FixHistoryEntry | undefined {
    const e = this.get(key);
    return e && e.scanId !== scanId ? e : undefined;
  }

  /** Record that `scanId` gave `fixHtmlHash` for every key (idempotent within one scan). */
  record(keys: string[], fixHtmlHash: string, scanId: string): void {
    this.ensureLoaded();
    const now = this.now();
    for (const key of new Set(keys)) {
      const prev = this.get(key);
      if (prev && prev.scanId === scanId) {
        // Already counted for this scan; keep the first fix recorded for it.
        continue;
      }
      // Re-insert so Map order tracks recency (used for eviction).
      this.entries.delete(key);
      this.entries.set(key, {
        fixHtmlHash,
        scanId,
        count: (prev?.count ?? 0) + 1,
        firstSeen: prev?.firstSeen ?? now,
        lastSeen: now,
      });
    }
    this.prune();
  }

  /** Write the history to disk (merged with whatever another server wrote). */
  save(): void {
    if (!this.file || this.persistFailed) return;
    try {
      // Merge with the file's current content so concurrent MCP servers don't
      // drop each other's entries; the newer lastSeen wins per key.
      for (const [key, e] of this.readFile()) {
        const mine = this.entries.get(key);
        if (!mine || e.lastSeen > mine.lastSeen) this.entries.set(key, e);
      }
      this.prune();
      const sorted = [...this.entries.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      this.entries = new Map(sorted);
      const body = JSON.stringify({ version: FILE_VERSION, entries: Object.fromEntries(sorted) });
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        writeFileSync(tmp, body, { mode: 0o600 });
        renameSync(tmp, this.file);
      } catch (err) {
        try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
        throw err;
      }
    } catch (err) {
      // Unwritable cache dir (read-only home, sandbox): keep working in memory.
      this.persistFailed = true;
      console.error(
        `[aether] fix-history: cannot write ${this.file}; repeat detection is in-memory only (${(err as Error).message})`,
      );
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const fromDisk = [...this.readFile()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [key, e] of fromDisk) {
      if (!this.entries.has(key)) this.entries.set(key, e);
    }
    this.prune();
  }

  /** Valid, non-expired entries from the file; [] for a missing or corrupt file. */
  private readFile(): Array<[string, FixHistoryEntry]> {
    if (!this.file) return [];
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return []; // missing or unreadable
    }
    try {
      const parsed = JSON.parse(raw) as { entries?: Record<string, unknown> };
      const out: Array<[string, FixHistoryEntry]> = [];
      const now = this.now();
      for (const [key, e] of Object.entries(parsed?.entries ?? {})) {
        if (isEntry(e) && now - e.lastSeen <= this.ttlMs) out.push([key, e]);
      }
      return out;
    } catch {
      console.error(`[aether] fix-history: ignoring corrupt ${this.file}`);
      return [];
    }
  }

  /** Drop expired entries, then evict the least recently seen beyond the cap. */
  private prune(): void {
    const now = this.now();
    for (const [key, e] of this.entries) {
      if (now - e.lastSeen > this.ttlMs) this.entries.delete(key);
    }
    if (this.entries.size <= this.maxEntries) return;
    const byAge = [...this.entries.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [key] of byAge.slice(0, this.entries.size - this.maxEntries)) this.entries.delete(key);
  }
}

let shared: FixHistory | null = null;

/** The process-wide history (lazily created from the environment). */
export function getFixHistory(): FixHistory {
  shared ??= new FixHistory();
  return shared;
}

/** Test hook: replace (or reset with null) the process-wide history. */
export function setFixHistory(h: FixHistory | null): void {
  shared = h;
}

/** The fields of a scan_and_fix fix entry this module reads and annotates. */
export interface RepeatFixLike {
  ruleId: string;
  target?: string | string[];
  route?: string;
  fixHtml: string;
  source: string;
  instances?: Array<{ target?: string | string[]; route?: string }>;
  repeat?: RepeatInfo;
}

/** The fields of a remainingViolations row this module reads and annotates. */
export interface RepeatRemainingLike {
  ruleId: string;
  target?: string | string[];
  route?: string;
  repeat?: RemainingRepeatInfo;
}

/** Every key a fix covers: its own target plus each listed group instance (#19). */
function fixKeys(fix: RepeatFixLike, urlFor: (route?: string) => string): string[] {
  const keys = [historyKey(urlFor(fix.route), fix.ruleId, fix.target)];
  for (const inst of (fix.instances ?? []).slice(0, MAX_KEYS_PER_FIX)) {
    keys.push(historyKey(urlFor(inst.route ?? fix.route), fix.ruleId, inst.target));
  }
  return [...new Set(keys)];
}

/**
 * Annotate a scan's fixes and remaining rows with `repeat` (in place), then
 * record this scan's fixes. Lookups all happen before recording, so nothing in
 * the current scan matches itself. Never throws; returns the number of fixes
 * flagged as repeats.
 *
 * `urlFor(route)` maps an entry's route (SPA) to its page URL; single-page
 * scans ignore the route and return the scanned URL.
 */
export function applyRepeatHistory(
  scanId: string,
  fixes: RepeatFixLike[],
  remaining: RepeatRemainingLike[],
  urlFor: (route?: string) => string,
  history: FixHistory = getFixHistory(),
): number {
  try {
    let repeated = 0;
    const toRecord: Array<{ keys: string[]; hash: string }> = [];
    for (const fix of fixes) {
      if (fix.source === 'error') continue; // no suggestion was given
      const keys = fixKeys(fix, urlFor);
      const hash = hashFixHtml(fix.fixHtml);
      // Representative first, then any instance: the most-repeated match wins.
      const prev = keys
        .map((k) => history.previous(k, scanId))
        .filter((e): e is FixHistoryEntry => !!e)
        .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)[0];
      if (prev) {
        fix.repeat = {
          count: prev.count,
          previousScanId: prev.scanId,
          sameFixAgain: prev.fixHtmlHash === hash,
          note: REPEAT_NOTE,
        };
        repeated++;
      }
      toRecord.push({ keys, hash });
    }
    for (const row of remaining) {
      const prev = history.previous(historyKey(urlFor(row.route), row.ruleId, row.target), scanId);
      if (prev) row.repeat = { count: prev.count, previousScanId: prev.scanId, note: REMAINING_REPEAT_NOTE };
    }
    for (const r of toRecord) history.record(r.keys, r.hash, scanId);
    if (toRecord.length > 0) history.save();
    return repeated;
  } catch (err) {
    console.error(`[aether] fix-history: repeat detection skipped (${(err as Error).message})`);
    return fixes.filter((f) => f.repeat).length;
  }
}
