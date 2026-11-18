/**
 * Fix-slot allocation for aether_scan_and_fix (#19, #20).
 *
 * 1. Group node entries by root cause: rule + a normalised HTML signature, so ten
 *    instances of one repeated component (or one element kept once per viewport
 *    because its classes differ by breakpoint) become ONE group with ONE fix.
 * 2. Allocate slots in rounds: every rule present gets its first group before any
 *    rule gets a second, rules ordered by severity (critical first). Each group
 *    takes at most one slot.
 * 3. `remaining` is every entry not covered by a chosen group, by identity (#20).
 *
 * Why not finding.ts `computeFingerprint`: it hashes the *chosen technique*, which
 * is only known after the fix is generated. Slots are allocated before any fix
 * exists, so grouping here uses a pre-fix structural signature instead.
 */
export interface RuleEntryLike {
  violation: {
    id: string;
    impact?: string | null;
    nodes?: Array<{ html?: string; target?: string | string[] }>;
  };
  nodeIndex?: number;
  route?: string;
}

/** One root cause: a representative to fix plus every entry the fix covers. */
export interface FixGroup<T extends RuleEntryLike> {
  key: string;
  representative: T;
  members: T[];
  /** One member per distinct element (route + target); viewport duplicates count once. */
  instances: T[];
  /** instances.length */
  occurrences: number;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 4, serious: 3, moderate: 2, minor: 1 };

const severityOf = (e: RuleEntryLike) => SEVERITY_ORDER[e.violation.impact ?? 'minor'] ?? 1;

// Class tokens that vary per instance, per state or per breakpoint: hashed /
// generated names (digits, css-in-js prefixes), utility variants (md:, [..]),
// state words and viewport words.
const VOLATILE_CLASS =
  /\d|[:[\]/!@]|^(sc|css|jsx|emotion|svelte|ng)-|(^|[-_])(is|has)[-_]|(^|[-_])(active|current|selected|open|opened|closed|collapsed|expanded|hidden|visible|show|shown|disabled|focus|focused|hover|mobile|desktop|tablet|xs|sm|md|lg|xl|xxl)($|[-_])/i;

function normaliseClass(value: string): string {
  const tokens = new Set<string>();
  for (const raw of value.split(/\s+/)) {
    const t = raw.replace(/--.*$/, ''); // BEM modifier → block/element
    if (t && !VOLATILE_CLASS.test(t)) tokens.add(t.toLowerCase());
  }
  return [...tokens].sort().join('.');
}

// Attributes dropped entirely: per-instance ids/state, framework scoping hashes.
const DROPPED_ATTR = /^(id|style|nonce|data-.*|_ng.*|ng-.*|jsaction|jscontroller|jsname)$|\d/i;
// Attributes whose VALUE defines the component kind; all others keep only their name.
const VALUE_ATTRS = new Set(['role', 'type']);

const TAG_RE = /<\s*([a-zA-Z][\w:-]*)([^>]*)>/g;
const ATTR_RE = /([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function tagSignature(name: string, attrs: string, withAttrs: boolean): string {
  const tag = name.toLowerCase();
  const parts: string[] = [];
  let role = '';
  for (const m of attrs.matchAll(ATTR_RE)) {
    const attr = m[1].toLowerCase();
    const value = (m[2] ?? m[3] ?? m[4] ?? '').trim().toLowerCase();
    if (attr === 'role') role = value;
    if (!withAttrs || DROPPED_ATTR.test(attr)) continue;
    if (attr === 'class') {
      const cls = normaliseClass(value);
      if (cls) parts.push(`.${cls}`);
    } else if (VALUE_ATTRS.has(attr)) {
      parts.push(`${attr}=${value}`);
    } else {
      parts.push(attr);
    }
  }
  if (!withAttrs) return role ? `${tag}[role=${role}]` : tag;
  return `${tag}[${[...new Set(parts)].sort().join(',')}]`;
}

/**
 * Normalised structural signature of an element's markup: the root tag with its
 * attribute NAMES (values only for role/type, stable class tokens only) plus the
 * set of descendant tag/role kinds. Text, ids, per-instance attribute values,
 * child counts and hashed/state/breakpoint classes are ignored, so instances of
 * one component (and one element seen at several viewports) share a signature.
 */
export function htmlSignature(html: string | undefined): string {
  if (!html) return '';
  const tags = [...html.matchAll(TAG_RE)];
  if (tags.length === 0) return '';
  const root = tagSignature(tags[0][1], tags[0][2], true);
  const descendants = new Set(tags.slice(1).map((t) => tagSignature(t[1], t[2], false)));
  return descendants.size ? `${root}>${[...descendants].sort().join(',')}` : root;
}

function instanceKey(e: RuleEntryLike, fallback: number): string {
  const target = e.violation.nodes?.[e.nodeIndex ?? 0]?.target;
  if (target === undefined) return `#${fallback}`;
  return `${e.route ?? ''}::${Array.isArray(target) ? target.join(' ') : target}`;
}

/** Group entries by rule + normalised HTML signature, preserving first-seen order. */
export function groupByRootCause<T extends RuleEntryLike>(entries: T[]): FixGroup<T>[] {
  const groups = new Map<string, FixGroup<T>>();
  const seen = new Map<string, Set<string>>();
  entries.forEach((e, i) => {
    const html = e.violation.nodes?.[e.nodeIndex ?? 0]?.html;
    const key = `${e.violation.id}\u0000${htmlSignature(html)}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, representative: e, members: [], instances: [], occurrences: 0 };
      groups.set(key, g);
      seen.set(key, new Set());
    }
    g.members.push(e);
    const ids = seen.get(key)!;
    const id = instanceKey(e, i);
    if (!ids.has(id)) {
      ids.add(id);
      g.instances.push(e);
      g.occurrences = g.instances.length;
    }
  });
  return [...groups.values()];
}

/**
 * Order groups for slot allocation: round r takes the r-th largest group of every
 * rule, rules in severity order (ties: first seen). So each rule gets one fix
 * before any rule gets a second, and a critical rule's second group comes after
 * every lower-severity rule's first.
 */
export function allocateFixSlots<T extends RuleEntryLike>(groups: FixGroup<T>[]): FixGroup<T>[] {
  const byRule = new Map<string, FixGroup<T>[]>();
  for (const g of groups) {
    const id = g.representative.violation.id;
    byRule.set(id, [...(byRule.get(id) ?? []), g]);
  }
  const rules = [...byRule.values()]
    .map((gs, order) => ({
      order,
      sev: Math.max(...gs.map((g) => Math.max(...g.members.map(severityOf)))),
      // Stable sort: biggest group (most instances cleared) first within a rule.
      queue: [...gs].sort((a, b) => b.occurrences - a.occurrences),
    }))
    .sort((a, b) => b.sev - a.sev || a.order - b.order);
  const out: FixGroup<T>[] = [];
  for (let round = 0; out.length < groups.length; round++) {
    for (const r of rules) if (r.queue[round]) out.push(r.queue[round]);
  }
  return out;
}

/**
 * Pick the groups that get a fix slot and return the uncovered entries in their
 * original order. `remaining` is computed by identity against every member of
 * the chosen groups, so a node covered by a group fix is never listed as unfixed
 * and none is lost (#20).
 */
export function splitFixTargets<T extends RuleEntryLike>(
  entries: T[],
  maxFixes: number,
): { toFix: FixGroup<T>[]; remaining: T[] } {
  const toFix = allocateFixSlots(groupByRootCause(entries)).slice(0, Math.max(0, maxFixes));
  const covered = new Set<T>(toFix.flatMap((g) => g.members));
  return { toFix, remaining: entries.filter((e) => !covered.has(e)) };
}
