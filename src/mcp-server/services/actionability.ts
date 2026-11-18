/**
 * Actionability — one plain line per fix saying what to do with it (#28), and
 * the verification counts + summary line that replace verified/unverified (#29).
 *
 * `confidence.tier` and `fixTier` sat in JSON nobody acted on, so a generic KB
 * landmark example looked exactly like a precise contrast fix and got applied.
 * Every fix now carries:
 *   - fixKind:       change | reference_pattern | guidance_only
 *   - actionability: apply | apply_then_confirm | review | no_fix
 *   - actionabilityNote: a fixed sentence per actionability, relayed verbatim.
 *
 * Computed client-side from source, fixTier, confidence.tier and the measured
 * verification status. A fixHtml that normalises to the input is never a change.
 */

import type { VerificationResult, VerificationStatus } from './verify-service.ts';

export type FixKind = 'change' | 'reference_pattern' | 'guidance_only';
export type Actionability = 'apply' | 'apply_then_confirm' | 'review' | 'no_fix';

/** The fixed one-liners. Agents lead each fix with this, verbatim. */
export const ACTIONABILITY_NOTES: Record<Actionability, string> = {
  apply: 'Specific change, verified.',
  apply_then_confirm: 'Specific change; confirm on the live page.',
  review:
    'Generic pattern, placeholder text or failed check (kb_example / best_effort / abstain / verification failed or regressed): ' +
    'adapt to this element, do not paste.',
  no_fix: 'No specific fix (abstain, or fixHtml unchanged): do not apply; investigate.',
};

// ---------------------------------------------------------------------------
// No-op detection
// ---------------------------------------------------------------------------

const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|\{[^}]*\}|[^\s>]+))?/g;

function normaliseAttrValue(raw: string | undefined): string {
  if (raw === undefined) return '';
  let v = raw.trim();
  if (v.startsWith('{') && v.endsWith('}')) v = v.slice(1, -1).trim(); // JSX {true} / {"x"}
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v.replace(/\s+/g, ' ').trim();
}

function normaliseTag(tag: string): string {
  const m = /^<(\/?)([a-zA-Z][\w:.-]*)([\s\S]*?)(\/?)>$/.exec(tag);
  if (!m) return tag;
  const [, close, name, rest] = m;
  if (close) return `</${name.toLowerCase()}>`;
  const attrs: string[] = [];
  for (const a of rest.matchAll(ATTR_RE)) {
    attrs.push(`${a[1].toLowerCase()}=${normaliseAttrValue(a[2])}`);
  }
  attrs.sort();
  return `<${name.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
}

/**
 * Canonical form for comparing two HTML fragments: whitespace collapsed,
 * tag/attribute names lower-cased, attributes sorted, quote style (" ' JSX {})
 * and self-closing slashes ignored. Not a parser; just enough to spot no-ops.
 */
export function normaliseHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[a-zA-Z][^<>]*>/g, (t) => normaliseTag(t))
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

/** True when the fix would change nothing (empty, or equal to the input once normalised). */
export function isNoOpFix(html: string, fixHtml: string | null | undefined): boolean {
  if (!fixHtml || !fixHtml.trim()) return true;
  return normaliseHtml(html) === normaliseHtml(fixHtml);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface ClassifyInput {
  html: string;
  fixHtml: string | null | undefined;
  source?: string;
  fixTier?: string;
  confidenceTier?: string;
}

/** What the fixHtml is: a concrete edit, a generic KB example, or nothing usable. */
export function computeFixKind(f: ClassifyInput): FixKind {
  if (f.source === 'error' || f.source === 'heuristic') return 'guidance_only';
  if (isNoOpFix(f.html, f.fixHtml)) return 'guidance_only';
  if (f.fixTier === 'kb_example') return 'reference_pattern';
  return 'change';
}

/**
 * The mapping table (#28):
 *   guidance_only                                   → no_fix
 *   reference_pattern                               → review
 *   abstain (template change shown)                 → review
 *   verification failed / regressed                 → review
 *   best_effort, unless measured verified           → review
 *   best_effort + verified                          → apply_then_confirm
 *   verified, with contextDependent or caveat       → apply_then_confirm
 *   verified                                        → apply
 *   not_measurable_in_snippet / not verified at all → apply_then_confirm
 */
export function computeActionability(
  fixKind: FixKind,
  confidenceTier: string | undefined,
  verification: Pick<VerificationResult, 'status' | 'contextDependent' | 'caveat'> | undefined,
): Actionability {
  if (fixKind === 'guidance_only') return 'no_fix';
  if (fixKind === 'reference_pattern') return 'review';
  // Abstain: no grounded technique, but a template change may still help — show it, never as "apply".
  if (confidenceTier === 'abstain') return 'review';
  const status = verification?.status;
  if (status === 'failed' || status === 'regressed') return 'review';
  if (confidenceTier === 'best_effort') return status === 'verified' ? 'apply_then_confirm' : 'review';
  if (status === 'verified') {
    const needsPage = (verification?.contextDependent?.length ?? 0) > 0 || !!verification?.caveat;
    return needsPage ? 'apply_then_confirm' : 'apply';
  }
  return 'apply_then_confirm';
}

/** Template placeholders such as aria-label="[Button purpose]" or alt="[Describe image]". */
export function hasPlaceholder(fixHtml: string | null | undefined): boolean {
  return !!fixHtml && /\[[A-Z][^\]<>"]{2,60}\]/.test(fixHtml);
}

export interface ActionabilityFields {
  fixKind: FixKind;
  actionability: Actionability;
  actionabilityNote: string;
  /** fixHtml with anything that must not be pasted removed ('' unless fixKind is change). */
  fixHtml: string;
  /** KB example moved out of fixHtml so nobody pastes it (fixKind reference_pattern). */
  referencePattern?: string;
}

/** Per-fix fields for a tool response. `fixKind` must be computed first (it gates verification). */
export function actionabilityFields(
  fixKind: FixKind,
  fixHtml: string | null | undefined,
  confidenceTier: string | undefined,
  verification: Pick<VerificationResult, 'status' | 'contextDependent' | 'caveat'> | undefined,
): ActionabilityFields {
  let actionability = computeActionability(fixKind, confidenceTier, verification);
  // Placeholder text ("[Button purpose]") verifies but must be written per element.
  if ((actionability === 'apply' || actionability === 'apply_then_confirm') && hasPlaceholder(fixHtml)) {
    actionability = 'review';
  }
  return {
    fixKind,
    actionability,
    actionabilityNote: ACTIONABILITY_NOTES[actionability],
    fixHtml: fixKind === 'change' ? (fixHtml ?? '') : '',
    ...(fixKind === 'reference_pattern' && fixHtml ? { referencePattern: fixHtml } : {}),
  };
}

// ---------------------------------------------------------------------------
// Verification counts (#29)
// ---------------------------------------------------------------------------

export interface VerificationCounts {
  verified: number;
  notMeasurable: number;
  failed: number;
  regressed: number;
}

interface CountableFix {
  ruleId: string;
  fixKind?: FixKind;
  verification?: { status?: VerificationStatus };
}

export function verificationCounts(fixes: CountableFix[]): VerificationCounts {
  const counts: VerificationCounts = { verified: 0, notMeasurable: 0, failed: 0, regressed: 0 };
  for (const f of fixes) {
    switch (f.verification?.status) {
      case 'verified': counts.verified++; break;
      case 'not_measurable_in_snippet': counts.notMeasurable++; break;
      case 'failed': counts.failed++; break;
      case 'regressed': counts.regressed++; break;
      default: break;
    }
  }
  return counts;
}

/**
 * One plain line, e.g. "1 verified; 9 color-contrast fixes can't be measured on
 * a snippet, confirm by re-scanning the URL; 0 failed."
 */
export function verificationSummary(fixes: CountableFix[]): string {
  const c = verificationCounts(fixes);
  const parts = [`${c.verified} verified`];
  if (c.notMeasurable > 0) {
    const rules = [...new Set(fixes.filter((f) => f.verification?.status === 'not_measurable_in_snippet').map((f) => f.ruleId))];
    parts.push(
      `${c.notMeasurable} ${rules.join('/')} fix${c.notMeasurable === 1 ? '' : 'es'} can't be measured on a snippet, ` +
        'confirm by re-scanning the URL',
    );
  }
  parts.push(`${c.failed} failed`);
  if (c.regressed > 0) parts.push(`${c.regressed} regressed (made the element worse; see regressions)`);
  const noChange = fixes.filter((f) => f.fixKind && f.fixKind !== 'change').length;
  if (noChange > 0) parts.push(`${noChange} with no specific change to verify`);
  return `${parts.join('; ')}.`;
}
