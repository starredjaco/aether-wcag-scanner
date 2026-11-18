/**
 * Verify Service — deterministic fix verification on the real browser engine.
 *
 * Every "did this fix work?" answer here is MEASURED by the same headless
 * Chromium + axe-core engine that `aether_scan_url` / `aether_scan_and_fix` use
 * — never by regex heuristics or model opinion. Two modes:
 *
 *   - `verifySnippet`  → runs real axe on the original HTML and the fixed HTML
 *                        (via `ClusterScanner.scanHtml`) and DIFFS them. Fast,
 *                        deploy-free, but can't reproduce external-CSS or true
 *                        page-context rules (see `note`).
 *   - `verifyUrl`      → full real scan of a live URL (`scanUrl`). Optionally
 *                        diffs against a prior baseline for a full delta.
 *
 * Both reuse the shared warm Chromium via `withScanner`, and the same delta
 * engine (`snapshotViolations` + `diffSnapshots`) used by the scan scheduler.
 *
 * We NEVER read raw snippet violations: `page.setContent` wraps a fragment in a
 * full document, so page-level rules (html-has-lang, document-title, region,
 * landmark-*) appear as wrapper noise. Diffing original vs fixed cancels those
 * artifacts, leaving only what the fix changed.
 */

import { withScanner } from './scanner-manager.ts';
import { rootTagOf, semanticRegressions } from '../../concepts/a11y-scanner/element-semantics.ts';
import {
  snapshotViolations,
  diffSnapshots,
  type ViolationSnapshot,
} from '../../concepts/a11y-scanner/scan-scheduler.ts';

/** A minimal violation identity surfaced in verification output. */
export interface ViolationRef {
  ruleId: string;
  target: string;
  impact?: string;
}

/**
 * One verdict per verification (#29). `verified` = target cleared, nothing
 * blocking added, nothing lost. `not_measurable_in_snippet` = the rule depends
 * on page CSS/layout/context a snippet can't reproduce (re-scan the URL).
 * `failed` = measured and the target persists, or a blocking new violation
 * appeared. `regressed` = the element lost something assistive technology
 * relied on, or hidden content was exposed.
 */
export type VerificationStatus = 'verified' | 'not_measurable_in_snippet' | 'failed' | 'regressed';

export interface VerificationResult {
  /** Always the real browser engine — no static analysis in verification. */
  engine: 'browser-axe';
  /** `snippet` = HTML string diff; `url` = live re-scan. */
  scope: 'snippet' | 'url';
  /** The axe rule the fix was meant to resolve. */
  targetRule: string;
  /** MEASURED: the target rule fired before and no longer fires after. */
  targetCleared: boolean;
  /**
   * MEASURED (snippet mode): what the fix took away from the element — a control
   * state (aria-expanded …), keyboard focus, its accessible name, or an
   * interactive role (#18). Empty = nothing lost; absent = not measured.
   */
  regressions?: string[];
  /** The verdict (#29). `verified` below is kept for compatibility: status === 'verified'. */
  status: VerificationStatus;
  /** targetCleared AND no regressions AND no blocking new violations. The one flag that means "this fix worked". */
  verified: boolean;
  /**
   * Violations the fix introduced (present after, absent before). In snippet
   * mode these are the BLOCKING ones; page-context rules go to `contextDependent`.
   */
  newViolations: ViolationRef[];
  /**
   * Snippet mode: new violations of page-context rules (region, landmark-*, …)
   * that a bare snippet can't judge (#30). Not blocking; confirm on the live page.
   */
  contextDependent?: ViolationRef[];
  /** SSR/framework caveat for fixes that hide or expose content (#30). */
  caveat?: string;
  /** Improvements (present before, absent after). */
  resolvedViolations: ViolationRef[];
  /** Total violation counts before/after and the net reduction (positive = fewer). */
  complianceDelta: { before: number; after: number; net: number };
  /** If the target still fires, the nodes still flagged for it. */
  remaining?: ViolationRef[];
  /** Human-readable delta summary from `diffSnapshots`. */
  summary: string;
  /** Honest caveat (engine limitation / missing baseline). */
  note?: string;
}

export interface VerifySnippetArgs {
  ruleId: string;
  originalHtml: string;
  fixedHtml: string;
}

export interface VerifyUrlArgs {
  ruleId: string;
  url: string;
  /** Prior violation set (e.g. from an earlier scan) for a full delta. */
  baseline?: ViolationRef[];
}

/**
 * Rules that snippet mode cannot faithfully reproduce because they depend on
 * external stylesheets, computed layout, or true page context. When the target
 * is one of these we tell the caller to prefer a live URL re-scan.
 */
const SNIPPET_UNRELIABLE_RULES = new Set([
  'color-contrast',
  'color-contrast-enhanced',
  'link-in-text-block',
  'target-size',
  'scrollable-region-focusable',
]);

/**
 * Rules that judge the page around the element (landmarks, headings outline,
 * skip links, document metadata). A snippet has none of that context, so a new
 * hit from one of these after a fix is reported separately and doesn't block
 * `verified` (#30). The single source of truth for "page-context rule".
 */
export const PAGE_CONTEXT_RULES = new Set([
  'region',
  'bypass',
  'skip-link',
  'page-has-heading-one',
  'heading-order',
  'document-title',
  'html-has-lang',
  'html-lang-valid',
]);

export function isPageContextRule(ruleId: string): boolean {
  return PAGE_CONTEXT_RULES.has(ruleId) || ruleId.startsWith('landmark-');
}

/** Rules whose fixes hide or expose content; snippet mode can't see what the framework renders. */
const HIDE_EXPOSE_RULES = new Set(['aria-hidden-focus', 'aria-hidden-body', 'presentation-role-conflict']);

export const CONTEXT_DEPENDENT_NOTE = 'page-context rule; confirm on the live page';

export const SSR_CAVEAT =
  "Snippet mode measures the HTML you'd ship, not what your framework renders (e.g. SSR can drop spread " +
  'attributes). Confirm on the live page.';

export function isSnippetUnreliableRule(ruleId: string): boolean {
  return SNIPPET_UNRELIABLE_RULES.has(ruleId);
}

/** Derive the snippet verdict (#29/#30). Order matters: regressions outrank everything. */
export function snippetStatus(args: {
  ruleId: string;
  firedBefore: boolean;
  targetCleared: boolean;
  regressions: number;
  blockingNew: number;
}): VerificationStatus {
  if (args.regressions > 0) return 'regressed';
  if (args.blockingNew > 0) return 'failed';
  if (SNIPPET_UNRELIABLE_RULES.has(args.ruleId)) return 'not_measurable_in_snippet';
  // The rule never fired on the bare snippet: it depends on context the snippet lacks.
  if (!args.firedBefore) return 'not_measurable_in_snippet';
  return args.targetCleared ? 'verified' : 'failed';
}

function toRef(s: ViolationSnapshot): ViolationRef {
  return { ruleId: s.ruleId, target: s.target, impact: s.impact };
}

/** Build snapshots from a caller-supplied baseline `{ruleId,target}[]`. */
function baselineToSnapshots(baseline: ViolationRef[]): ViolationSnapshot[] {
  return baseline.map((b) => ({
    key: `${b.ruleId}::${b.target}`,
    ruleId: b.ruleId,
    target: b.target,
    impact: b.impact,
  }));
}

/**
 * Verify a fix by running real axe on the original and fixed HTML strings and
 * diffing the results. Deterministically flags no-ops (nothing changes) and bad
 * fixes (target persists or a new rule appears).
 */
export async function verifySnippet(args: VerifySnippetArgs): Promise<VerificationResult> {
  const { ruleId, originalHtml, fixedHtml } = args;

  return withScanner(async (scanner) => {
    const [before, after] = await Promise.all([
      scanner.scanHtml(originalHtml, { semantics: true }),
      // Measure the fixed element that corresponds to the original root, even if the fix wrapped it.
      scanner.scanHtml(fixedHtml, { semantics: true, semanticsTag: rootTagOf(originalHtml) }),
    ]);

    const beforeSnaps = snapshotViolations(before.violations);
    const afterSnaps = snapshotViolations(after.violations);
    const diff = diffSnapshots(beforeSnaps, afterSnaps);

    const firedBefore = beforeSnaps.some((s) => s.ruleId === ruleId);
    const firesAfter = afterSnaps.some((s) => s.ruleId === ruleId);
    const targetCleared = firedBefore && !firesAfter;

    const remaining = afterSnaps.filter((s) => s.ruleId === ruleId).map(toRef);
    const regressions =
      before.semantics && after.semantics ? semanticRegressions(before.semantics, after.semantics) : undefined;

    const allNew = diff.newViolations.map(toRef);
    const contextDependent = allNew.filter((v) => isPageContextRule(v.ruleId));
    const blockingNew = allNew.filter((v) => !isPageContextRule(v.ruleId));
    const status = snippetStatus({
      ruleId,
      firedBefore,
      targetCleared,
      regressions: regressions?.length ?? 0,
      blockingNew: blockingNew.length,
    });
    const hiddenChanged =
      (before.semantics?.hiddenFromAT ?? 0) !== (after.semantics?.hiddenFromAT ?? 0);
    const caveat = HIDE_EXPOSE_RULES.has(ruleId) || hiddenChanged ? SSR_CAVEAT : undefined;

    const notes: string[] = [];
    if (blockingNew.length > 0) {
      notes.push(
        `The fix introduces ${blockingNew.map((v) => v.ruleId).join(', ')}. Not counted as verified.`,
      );
    }
    if (contextDependent.length > 0) {
      notes.push(
        `New ${[...new Set(contextDependent.map((v) => v.ruleId))].join(', ')}: ${CONTEXT_DEPENDENT_NOTE}.`,
      );
    }
    if (regressions && regressions.length > 0) {
      notes.push(
        `axe ${targetCleared ? 'no longer flags' : 'still flags'} "${ruleId}", but the fix makes the element worse for assistive technology: ` +
          `${regressions.join('; ')}. Not counted as verified. Snippet mode cannot test click or keyboard handlers.`,
      );
    }
    if (!firedBefore) {
      notes.push(
        `Target rule "${ruleId}" did not fire on the original snippet (snippet mode wraps fragments in a full document, so element-level context may differ). Re-scan the live URL to confirm.`,
      );
    }
    if (SNIPPET_UNRELIABLE_RULES.has(ruleId)) {
      notes.push(
        `Rule "${ruleId}" depends on external CSS / computed layout that snippet mode cannot reproduce. Prefer verifyUrl against the live page for an authoritative result.`,
      );
    }

    return {
      engine: 'browser-axe' as const,
      scope: 'snippet' as const,
      targetRule: ruleId,
      targetCleared,
      ...(regressions ? { regressions } : {}),
      status,
      verified: status === 'verified',
      newViolations: blockingNew,
      ...(contextDependent.length > 0 ? { contextDependent } : {}),
      ...(caveat ? { caveat } : {}),
      resolvedViolations: diff.fixedViolations.map(toRef),
      complianceDelta: {
        before: beforeSnaps.length,
        after: afterSnaps.length,
        net: beforeSnaps.length - afterSnaps.length,
      },
      ...(remaining.length > 0 ? { remaining } : {}),
      summary: diff.summary,
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    };
  });
}

/**
 * Verify against a live URL with a full real scan. With a `baseline` the result
 * carries a true new/resolved delta; without one it reports the current state
 * and notes that a baseline is required for a full delta.
 */
export async function verifyUrl(args: VerifyUrlArgs): Promise<VerificationResult> {
  const { ruleId, url, baseline } = args;

  return withScanner(async (scanner) => {
    const result = await scanner.scanUrl(url);

    if (!result || !result.success) {
      throw new Error(result?.error ?? 'Scan failed');
    }

    const currentSnaps = snapshotViolations(result.violations);
    const targetCleared = !currentSnaps.some((s) => s.ruleId === ruleId);
    const remaining = currentSnaps.filter((s) => s.ruleId === ruleId).map(toRef);

    if (baseline && baseline.length > 0) {
      const baseSnaps = baselineToSnapshots(baseline);
      const diff = diffSnapshots(baseSnaps, currentSnaps);
      return {
        engine: 'browser-axe' as const,
        scope: 'url' as const,
        targetRule: ruleId,
        targetCleared,
        status: targetCleared ? ('verified' as const) : ('failed' as const),
        verified: targetCleared,
        newViolations: diff.newViolations.map(toRef),
        resolvedViolations: diff.fixedViolations.map(toRef),
        complianceDelta: {
          before: baseSnaps.length,
          after: currentSnaps.length,
          net: baseSnaps.length - currentSnaps.length,
        },
        ...(remaining.length > 0 ? { remaining } : {}),
        summary: diff.summary,
      };
    }

    // No baseline: report current state only.
    return {
      engine: 'browser-axe' as const,
      scope: 'url' as const,
      targetRule: ruleId,
      targetCleared,
      status: targetCleared ? ('verified' as const) : ('failed' as const),
      verified: targetCleared,
      newViolations: [],
      resolvedViolations: [],
      complianceDelta: {
        before: currentSnaps.length,
        after: currentSnaps.length,
        net: 0,
      },
      ...(remaining.length > 0 ? { remaining } : {}),
      summary: targetCleared
        ? `Rule "${ruleId}" is not present after scan. ${currentSnaps.length} total violation(s) on the page.`
        : `Rule "${ruleId}" still fires (${remaining.length} node(s)). ${currentSnaps.length} total violation(s) on the page.`,
      note: 'No baseline supplied — reporting current state only. Pass the pre-fix violation set as `baseline` for a full new/resolved delta.',
    };
  });
}
