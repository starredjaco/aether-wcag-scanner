/**
 * Coverage probe: what a load-time scan did NOT exercise (#33).
 *
 * axe only sees the DOM as it is when the scan runs. On a tester's `/uploads`
 * page Aether reported 0 violations, but two real ones only existed after a
 * file upload, and nothing in the output hinted that only the load state was
 * tested. After the scan, this probe counts the interactive states that were
 * never entered: file inputs (nothing uploaded), forms (never submitted),
 * closed dialogs, collapsed menus / disclosures, closed <details> and tab
 * lists with hidden panels, and returns a short note saying so.
 *
 * One cheap `page.evaluate`, bounded, never throws: on any error it returns
 * undefined and the scan carries no `coverage` block.
 */

import type { Page } from 'playwright';
import type { CoverageKind, CoverageReport, CoverageStateTested } from '../../types/a11y';

/** Example selectors listed per kind. */
export const MAX_COVERAGE_EXAMPLES = 3;

/** Raw per-kind result from the page. */
export interface CoverageCount {
  kind: CoverageKind;
  count: number;
  examples: string[];
}

/** Singular / plural wording per kind, in note order. */
const KIND_LABELS: Record<CoverageKind, [string, string]> = {
  'file-input': ['file input', 'file inputs'],
  form: ['form', 'forms'],
  'closed-dialog': ['closed dialog', 'closed dialogs'],
  'collapsed-menu': ['collapsed menu', 'collapsed menus'],
  'closed-details': ['closed <details> disclosure', 'closed <details> disclosures'],
  'hidden-tab-panels': ['tab list with hidden panels', 'tab lists with hidden panels'],
};

const KIND_ORDER = Object.keys(KIND_LABELS) as CoverageKind[];

/**
 * In-page probe, as a string so tsx/esbuild `keepNames` can't inject a
 * `__name(...)` helper that is undefined in the browser (see node-context.ts).
 */
const PROBE_SCRIPT = `(() => {
  var MAX = ${MAX_COVERAGE_EXAMPLES};
  var visible = function (el) {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
    }
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  var esc = function (s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s; };
  var selectorOf = function (el) {
    if (el.id) return '#' + esc(el.id);
    var parts = [];
    var cur = el;
    for (var depth = 0; cur && cur.nodeType === 1 && depth < 4; depth++) {
      if (cur.id) { parts.unshift('#' + esc(cur.id)); break; }
      var tag = cur.tagName.toLowerCase();
      var name = cur.getAttribute('name');
      var part = tag;
      if (name && depth === 0) {
        part += '[name="' + name.replace(/"/g, '\\\\"') + '"]';
      } else {
        var parent = cur.parentElement;
        if (parent) {
          var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === cur.tagName; });
          if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
        }
      }
      parts.unshift(part);
      if (tag === 'body') break;
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  var all = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
  var result = function (kind, els) {
    return { kind: kind, count: els.length, examples: els.slice(0, MAX).map(selectorOf) };
  };

  var fileInputs = all('input[type=file]');
  var forms = all('form');
  var dialogs = all('dialog:not([open]), [role=dialog], [role=alertdialog]').filter(function (el) {
    if (el.tagName === 'DIALOG') return !el.open;
    return !visible(el);
  });
  var menus = all('[aria-haspopup]:not([aria-haspopup=false]), [aria-expanded=false]').filter(function (el) {
    return el.getAttribute('aria-expanded') !== 'true' && el.getAttribute('role') !== 'tab' && visible(el);
  });
  var details = all('details:not([open])').filter(visible);
  var tablists = all('[role=tablist]').filter(function (list) {
    if (!visible(list)) return false;
    var tabs = Array.prototype.slice.call(list.querySelectorAll('[role=tab]'));
    return tabs.some(function (tab) {
      if (tab.getAttribute('aria-selected') === 'false') return true;
      var ids = (tab.getAttribute('aria-controls') || '').split(/\\s+/).filter(Boolean);
      return ids.some(function (id) {
        var panel = document.getElementById(id);
        return !!panel && !visible(panel);
      });
    });
  });

  return [
    result('file-input', fileInputs),
    result('form', forms),
    result('closed-dialog', dialogs),
    result('collapsed-menu', menus),
    result('closed-details', details),
    result('hidden-tab-panels', tablists),
  ];
})()`;

function joinPhrases(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Build the coverage block (zero-count kinds omitted) and its one-line note. */
export function buildCoverage(
  counts: CoverageCount[],
  stateTested: CoverageStateTested = 'load',
): CoverageReport {
  const notExercised = counts
    .filter((c) => c.count > 0 && KIND_LABELS[c.kind])
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    .map((c) => ({ kind: c.kind, count: c.count, examples: c.examples.slice(0, MAX_COVERAGE_EXAMPLES) }));
  const stateWord = stateTested === 'load' ? 'page-load' : 'post-interaction';
  const note = notExercised.length
    ? `${joinPhrases(
        notExercised.map((c) => `${c.count} ${KIND_LABELS[c.kind][c.count === 1 ? 0 : 1]}`),
      )} ${notExercised.length === 1 && notExercised[0].count === 1 ? 'was' : 'were'} not exercised; ` +
      'violations that only appear after interaction were not tested.'
    : `Only the ${stateWord} state was tested; no file inputs, forms, closed dialogs or collapsed controls were found.`;
  return { stateTested, notExercised, note };
}

/**
 * Probe the page for interactive states the scan did not enter. Returns
 * undefined (no coverage block) if anything goes wrong, never throws.
 */
export async function probeCoverage(
  page: Page,
  stateTested: CoverageStateTested = 'load',
): Promise<CoverageReport | undefined> {
  try {
    const counts = (await page.evaluate(PROBE_SCRIPT)) as CoverageCount[];
    if (!Array.isArray(counts)) return undefined;
    return buildCoverage(counts, stateTested);
  } catch (err) {
    console.error(`[aether] coverage probe skipped: ${(err as Error).message}`);
    return undefined;
  }
}
