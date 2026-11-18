# Aether WCAG Scanner

An MCP server for Claude Code, Cursor, Codex and other coding agents that finds
**WCAG 2.1 AA accessibility violations** and returns **ready-to-apply fixes** —
not just a list of problems.

It drives a real browser (Playwright + axe-core) across desktop, tablet, and
mobile viewports, then pairs each violation with a concrete fix: corrected
HTML, the relevant WCAG success criteria, and technique code examples.

**It works free without a key. For higher quality, contextual fixes, get a beta
key at [beta.allchemylabs.ai](https://beta.allchemylabs.ai/?src=github)** (sign in with GitHub).

---

## Why it's different

An AI coding agent working from markup alone has to infer what a page does. Aether runs
the page in a real browser, measures it with axe-core, and grounds every suggested fix in
the WCAG spec, so the agent is working from measurements rather than inference.

| | Coding agent alone | Aether, offline | Aether, with API key |
|---|---|---|---|
| **How it looks at the page** | Reads the HTML it is given | Renders the page in Chromium at desktop, tablet and mobile widths and runs axe-core | Same |
| **What it can measure** | Structure visible in the markup | What axe measures on the rendered page: contrast, accessible names, ARIA usage, focusable regions, landmarks | Same |
| **Fix suggestions** | From the model's general knowledge | Deterministic templates for the common rules | Templates first, then WCAG-corpus examples, then a model; every cited technique passes a grounding check |
| **How fixes are checked** | Not checked unless you set that up | axe re-run on the fixed element; reports what cleared and what regressed | Same |
| **What each fix cites** | Whatever the model recalls | The axe rule and its severity | The WCAG success criteria and techniques, with rejected candidates shown |
| **Network** | Depends on the agent | None; runs entirely on your machine | Fix requests go to the hosted engine; falls back to offline templates when it is unreachable |

## Install

```
/plugin marketplace add https://github.com/allchemylabs/claude-plugins.git
/plugin install aether-wcag-scanner@allchemylabs
```

Once the official Claude Code marketplace listing is live, you can also install
it directly from there.

Installing with `/plugin install` inside Claude Code prompts for your
**Allchemy Labs API key**; paste the key you got from
[beta.allchemylabs.ai](https://beta.allchemylabs.ai/?src=readme). Installing from the
terminal (`claude plugin install …`), or letting Claude run the install for
you, does not prompt, so set the key afterwards with the command below (or use
one of the [other places](#where-to-put-the-key)). Run the same command to change
the key later:

```
/plugin configure aether-wcag-scanner@allchemylabs
```

The first start installs the plugin's dependencies (about a minute) and
downloads Chromium's headless shell for Playwright in the background (about
100-125 MB, about 200-300 MB on disk); a scan started before that finishes waits for it. If
`/mcp` shows the server as not connected right after install, wait a moment and
run `/reload-plugins`.

### Where to put the key

The cloud fixes need a key; get one at
[beta.allchemylabs.ai](https://beta.allchemylabs.ai/?src=github) (sign in with GitHub).
Set it in any one of these places:

1. **The plugin option** — the install prompt, or
   `/plugin configure aether-wcag-scanner@allchemylabs`.
2. **Your shell** — `export ALLCHEMY_API_KEY=<key>` before starting `claude`.
3. **Claude Code settings** — `"env": { "ALLCHEMY_API_KEY": "<key>" }` in
   `~/.claude/settings.json` (or a project's `.claude/settings.json`).
4. **A project `.env`** — `ALLCHEMY_API_KEY=<key>` in the `.env` of the project you
   are scanning.

If more than one is set, the first in this list wins: the plugin option beats
`ALLCHEMY_API_KEY` from the shell or settings.json, which beats `.env`. If you use
2, 3 or 4, leave the plugin option empty; an empty option is not an error and
does not hide the key from the other places.

To check which key the plugin is using, start Claude Code with
`claude --debug-file /tmp/claude-debug.log` and search the log for the server's
startup line:

```
[aether] insights endpoint=https://… apiKey=[REDACTED] source=plugin option
```

`source` is `plugin option`, `environment (shell or settings.json env)`, the path of
the `.env` file, or `not set`. The server prints only the first 8 characters of the
key, and Claude Code's debug log hides even those.

### Running without a key

The scanner itself runs locally and still works without a key (for example via
`npx`): you get local template fixes for every violation, and tool results end
with a notice saying where to get a key. A beta key adds higher quality,
contextual fixes from the hosted insights engine.

---

## Use it outside Claude Code (any MCP client)

The same server is published to npm and the MCP Registry as
`@allchemylabs/aether-wcag-scanner`. Any MCP client that speaks stdio can run it:

```json
{
  "mcpServers": {
    "aether-wcag-scanner": {
      "command": "npx",
      "args": ["-y", "@allchemylabs/aether-wcag-scanner"],
      "env": { "ALLCHEMY_API_KEY": "<your beta key>" }
    }
  }
}
```

The first scan downloads Playwright's Chromium headless shell once (about
100-125 MB to download, about 200-300 MB on disk; an existing Playwright Chromium install is
reused). Without `ALLCHEMY_API_KEY`
the scanner still runs fully offline and returns template fixes.

Claude Code gets the `/wcag-scan` skill, which drives the scan → review → fix → verify
loop. Other agents only see the tool descriptions and the instructions the server sends at
connect time, so for the same behaviour copy [`AGENTS.md`](./AGENTS.md) into your project
(Codex reads it natively; Cursor and Windsurf accept it as a rules file). Without it an agent
may fetch the page HTML and guess instead of running the browser scan.

## The 5 tools

| Tool | What it does |
|---|---|
| `aether_scan_and_fix` | **Recommended.** Scan a URL — or a single-page app across routes via the `spa` block — and return violations *with* fixes, each verified on the real browser, in one call. Set `maxFixes: 0` for a fast scan-only pass. |
| `aether_get_fix` | Get a fix for one specific violation (verified on the real browser). Omit `html` to instead get a rule-level explanation — WCAG success criteria and technique examples. |
| `aether_verify_fix` | Deterministically verify a fix with real Playwright + axe — re-scan a URL or diff original vs fixed HTML. Reports whether the target cleared, any new regressions, and the net compliance delta. |
| `aether_check_html` | Analyze an HTML snippet for issues — no live URL or browser needed. |
| `aether_submit_feedback` | Rate a fix (useful / not useful) so the guidance engine keeps improving; your correction helps seed better fixes. |

Just ask Claude naturally, e.g. *"check localhost:3000 for accessibility
issues and fix them"* — it will pick the right tool.

## The `/wcag-scan` skill

Run `/wcag-scan <url>` for a guided workflow: scan → review violations → apply
fixes → re-scan to verify → summarize. The skill orchestrates the tools above
and edits your files in place.

## Hooks

The plugin adds two hooks to Claude Code:

- **Session start:** checks that the plugin's dependencies and Chromium are
  installed (a fraction of a second). If something is missing it installs it
  in the background, so the session is never held up; progress goes to
  `aether-deps-install.log` in the plugin's data directory.
- **After each edit:** when Claude edits an HTML, JSX, TSX, Vue or Svelte file, a
  quick heuristic check (no browser) reports possible accessibility issues to
  Claude. It never blocks an edit, and its findings can be false positives.

To turn the post-edit check off in every project, run
`/plugin configure aether-wcag-scanner@allchemylabs` and set **Post-edit
accessibility check** to false. To turn it off (or back on) for one project, add
this to that project's `.claude/settings.local.json`:

```json
{ "env": { "AETHER_POSTEDIT_HOOK": "0" } }
```

Use `"1"` to turn it back on for that project. Restart Claude Code after either
change.

---

## Scanning single-page apps

Pass a `spa` block to `aether_scan_and_fix` instead of `url`:

```json
{ "spa": { "entryUrl": "http://localhost:4200", "framework": "angular", "maxRoutes": 10 } }
```

- `entryUrl` — where the app boots. Routes are discovered by crawling client-side links
  unless you list them in `routes: [{ "path": "/settings", "name": "Settings" }]`.
- `framework` — `angular`, `react`, `vue`, or omit to auto-detect.
- `maxRoutes` — cap on discovered routes.

Navigation is client-side (the browser context and app state are kept between routes),
and readiness is decided by a layered stability cascade — DOM quiet, framework hooks such
as Angular testability, pending-request drain — never by Playwright's `networkidle`,
which deadlocks on apps with long-polling or websockets. A config that sets
`networkIdle` is rejected for that reason.

## Requirements

- Node.js >= 20
- Chromium headless shell (installed automatically on first run, about 200-300 MB on disk)

## Disclaimer

Aether is an accessibility analysis and guidance tool. Using the platform does not, by
itself, make your website, application, or digital service conformant with WCAG, the ADA
(including Title II), the European Accessibility Act, Section 508, EN 301 549, or any other
accessibility law or standard.

Automated scans detect only a subset of accessibility barriers. A "zero issues" result means
the scanner did not flag anything in its detection range — not that the property is legally
compliant.

You remain responsible for:

- reviewing findings with qualified people
- fixing issues in the underlying code and content
- conducting or commissioning manual testing and audits as needed
- maintaining accessibility as the product changes
- obtaining legal advice for your specific obligations

Aether does not provide legal advice and does not replace an accessibility audit or a
VPAT/ACR prepared by a qualified auditor.

## License

MIT for the client (this plugin). The hosted insights engine and related
Allchemy Labs services are proprietary — see `LICENSE` and `NOTICE`.
