# Aether WCAG Scanner — agent instructions

Copy this file into your project (Codex reads `AGENTS.md`; Cursor and Windsurf accept it as a
rules file) so your coding agent uses the Aether MCP tools the way Claude Code's `/wcag-scan`
skill does. The server also sends a condensed version of these rules at connect time.

## When to use the tools

For any question about the accessibility, a11y or WCAG conformance of a URL, call
`aether_scan_and_fix` first. Do not fetch the page and reason about the HTML: fetched markup
misses rendered state, colour contrast, keyboard behaviour and single-page-app routes, all of
which the browser scan measures.

- URL → `aether_scan_and_fix` (`url`). Single-page app → the `spa` block.
- Pasted HTML or a component → `aether_check_html`.
- One specific element → `aether_get_fix` with `ruleId` + `html`. Rule explanation only → omit `html`.
- Did a fix work? → the `verification` block on each fix, or `aether_verify_fix`.

## Workflow

1. **Scan.** `aether_scan_and_fix` with the URL. The default (`maxFixes: 10`) also generates
   fixes; use `maxFixes: 0` only when the user explicitly wants a scan with no fixes.
2. **Review.** Present violations grouped by severity: critical, serious, moderate, minor.
3. **Fix.** `fixHtml` is a suggestion; the tools never modify files.
   - You have the source (localhost, a repo you can edit): apply the fix in the real file, then verify.
   - Remote site you do not own: present `fixHtml` as a recommendation and say the developer
     must apply it. Do not imply anything changed.
4. **Verify.** Read the `verification` block attached to each fix, or call `aether_verify_fix`
   (URL mode re-scans a live page; snippet mode diffs original vs fixed HTML). Report
   `status`, `targetCleared`, `regressions`, `newViolations`, `resolvedViolations` and
   `complianceDelta` verbatim. `regressions` lists what a fix took away from the element (for example lost aria-expanded, no longer focusable, hidden content exposed); a fix with regressions is not `verified` even when `targetCleared` is true, so say so and don't apply it as is.
   `status` is `verified`, `not_measurable_in_snippet` (re-scan the URL to confirm), `failed` or
   `regressed`. `newViolations` block verification; `contextDependent` lists page-context rules
   (region, landmark-*, …) that mean "confirm on the live page", not a failure.
5. **Report.** The fixes are the deliverable, not the counts. Include every severity. Lead each
   fix with its `actionabilityNote`, verbatim, then show the target element, the change in one line (for example "background
   #00a2c7 → #00819f" or "add aria-label"), `source`, `confidence.tier`, and the verification
   fields or note. Group fixes that share one root cause (one colour token, one landmark) and say
   so. A fix with `occurrences` > 1 covers a repeated component: present it once with its instance
   count (`appliesTo`, `instances`) and say that applying it to the shared component fixes all
   instances (relay `appliesTo`: names and alt text need their own wording per instance). Then:
   `verificationCounts` and the `verificationSummary` line as given, WCAG criteria addressed and
   anything flagged for manual review.

## Honesty rules

- Never say a violation is "fixed" unless you changed source **and** verification shows
  `verified: true`.
- Relay tool output as-is. Do not add quality or confidence judgements of your own.
- Do say when a specific fix or finding looks wrong, with evidence: passing verification only
  means axe stopped flagging the rule. If a fix would remove keyboard focus, an ARIA state
  (e.g. `aria-expanded`), an accessible name or content, or a finding is a false positive in
  the real source, explain what you see and don't apply that fix.
- Show each fix's `source` (`rag` = cloud engine, `template` = local fallback), `fixTier`,
  `confidence.tier` (`grounded` | `best_effort` | `abstain`) and `rationale`. An `abstain`
  means no grounded fix exists; say so instead of inventing one.
- Relay any `repeat` on a fix or remaining violation prominently with its note (an earlier fix for
  that rule/target did not work or was not applied; with `sameFixAgain: true` don't re-apply it
  unchanged), and relay `coverage.note` in the report (interactive states the scan did not test).
- `actionability` is the verdict: `apply` (specific change, verified), `apply_then_confirm`
  (specific change; confirm on the live page), `review` (generic pattern or failed check: adapt,
  do not paste; a KB example is in `referencePattern`), `no_fix` (nothing to apply; investigate).
  Never present `review` or `no_fix` as a fix; `fixHtml` is empty for them.
- Relay any `note` or `caveat` on a verification (for example, contrast cannot be measured on an
  isolated snippet; snippet mode can't see what your framework renders; prefer a URL re-scan).
- Cite only the WCAG techniques and success criteria the tools returned for that element. If you
  add one yourself, label it as your own suggestion, not Aether's, and never list it alongside
  Aether's grounded citations. Before citing techniques for a violation you have not sent to
  Aether, call `aether_get_fix` for it (pass `html`).
- Automated scans find a subset of barriers. A clean scan is not WCAG conformance and is not
  legal advice.

## Setup reminder

An API key (from https://beta.allchemylabs.ai/?src=readme) enables cloud fixes
(`source: "rag"`). Set it as `ALLCHEMY_API_KEY` in the MCP server's env, the shell, or the
project `.env`; in Claude Code the plugin's `api_key` option (`/plugin configure`) takes
precedence over those. The server's stderr startup line (`[aether] … source=…`) says which
one is in use. Without a key the scanner still runs and returns template fixes. If a tool result
ends with a line starting "Notice for the user:" (missing/invalid key, rate limit, partial scan),
end your answer to the user with that line, unchanged and including its link, once per session.
The first scan downloads Chromium's headless shell once (about 200-300 MB on disk).
