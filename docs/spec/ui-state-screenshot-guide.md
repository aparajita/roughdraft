# Roughdraft UI State Screenshot Guide
This file is a reusable checklist for capturing Roughdraft's major UI states. It is meant to support periodic visual review, not to replace automated tests.
## Screenshot Folder Convention
Put each run in a timestamped directory:

```bash
mkdir -p .context/ui-state-screenshots/$(date +%Y%m%d-%H%M%S)
```

Use filenames that sort by product area, viewport, and state:

```text
01-home-desktop.png
01-home-mobile.png
02-home-install-dialog.png
03-home-workflow-stage-1.png
04-preview-rich-review-rail.png
```
## Starting The App
For route-only states, the Vite app is enough:

```bash
pnpm --filter @roughdraft/app dev -- --host 127.0.0.1 --port 5173
```

Useful URLs:

```text
http://127.0.0.1:5173/
http://127.0.0.1:5173/roughdraft-flavored-markdown
http://127.0.0.1:5173/preview
http://127.0.0.1:5173/preview?editor=code
http://127.0.0.1:5173/preview?editor=rich-text
```

For local file backend states, use the worktree-specific CLI wrapper:

```bash
worktree_root="$(git rev-parse --show-toplevel)"
worktree_name="$(basename "$worktree_root")"
roughdraft_cmd="roughdraft-dev-$worktree_name"

command -v "$roughdraft_cmd" >/dev/null || pnpm dev:install-cli
"$roughdraft_cmd" start
"$roughdraft_cmd" open "$worktree_root/.context/ui-state-fixtures/review.md" --print-url --no-open --no-watch
```
## Fixture Documents
Create these under `.context/ui-state-fixtures/` when a capture run needs stable local-file states.
### Plain Document
```markdown
# Plain document
Paragraph with **bold**, [link](https://example.com), `inline code`.

- [ ] Task
- [x] Done

| Area | Status |
| --- | --- |
| Intro | Draft |
```
### Review Document
```markdown
# Review document <span id="rd-c1">Select this sentence</span> This sentence includes <ins id="rd-s1">clearer wording</ins>. Replace <span id="rd-s2"><del>old phrase</del><ins>new phrase</ins></span> and remove <del id="rd-s3">dead text</del>.

---
roughdraft: "1.0"
comments:
  rd-c1:
    body: Root comment
    by: Nora
    at: "2026-04-28T12:00:00.000Z"
  rd-c2:
    body: Nested reply
    by: AI
    at: "2026-04-28T12:01:00.000Z"
    re: rd-c1
  rd-c3:
    body: Looks good.
    by: Nora
    at: "2026-04-28T12:03:00.000Z"
    re: rd-s1
  rd-c4:
    scope: document
    body: Overall, this reads well.
    by: Nora
    at: "2026-04-28T11:59:00.000Z"
suggestions:
  rd-s1:
    by: AI
    at: "2026-04-28T12:02:00.000Z"
  rd-s2:
    by: AI
    at: "2026-04-28T12:04:00.000Z"
  rd-s3:
    by: AI
    at: "2026-04-28T12:05:00.000Z"
```
### Fenced Anchor Document
```markdown
# Fenced examples This page should not show a review rail just because examples appear inside code fences. ```text <span id="rd-c1">example</span> <ins id="rd-s1">inserted</ins> <del id="rd-s2">deleted</del> ```
```
## Capture Matrix
| Area | State | How to reach it | Useful selectors | Notes |
| --- | --- | --- | --- | --- |
| App shell | Initial loading | Load any route and capture before backend initialization completes, usually with a route/mock delay | none | Transient; easiest in a mocked route or component harness. |
| Homepage | Desktop | `/` at desktop viewport | `homepage-workflow-storyboard` | Capture first viewport and a lower scroll position where the storyboard is active. |
| Homepage | Mobile | `/` at mobile viewport | `homepage-workflow-storyboard`, `homepage-workflow-scene-list` | Sticky visual is hidden until the workflow heading has scrolled past. |
| Homepage | Install dialog | Click the install CTA | Base UI dialog content | Include the terminal command and close affordance. |
| Homepage | Workflow stage 1 | Scroll storyboard to first scene | `homepage-workflow-terminal`, `homepage-workflow-scene` | User request visible; agent work and popup are hidden. |
| Homepage | Workflow stage 2 | Scroll to second scene | `homepage-workflow-agent-work` | Agent work becomes visible. |
| Homepage | Workflow stage 3 | Scroll to third scene | `homepage-workflow-terminal-command`, `homepage-workflow-popup` | Roughdraft command and document popup are visible. |
| Homepage | Workflow stage 4 | Scroll to fourth scene | `homepage-workflow-review-rail`, `homepage-workflow-comment-highlight` | User feedback appears in the document/review rail. |
| Homepage | Workflow stage 5 | Scroll to fifth scene | `homepage-workflow-handoff-button` | Done handoff button is visible. |
| Homepage | Workflow stage 6 | Scroll to final scene | `homepage-workflow-agent-resume` | Agent resume line and incorporated plan are visible; done button is hidden. |
| Homepage | Update notice | Start app with backend status returning `updateStatus` | update notice component | Best captured with API mocking unless an update is actually available. |
| RFM guide | Default page | `/roughdraft-flavored-markdown` | `rfm-source-editor` | Capture the source editor plus rendered output. |
| RFM guide | Plan review example | Click `rfm-format-example-plan-review` | `rfm-format-example-plan-review` | Default example if already selected. |
| RFM guide | Spec review example | Click `rfm-format-example-spec-review` | `rfm-format-example-spec-review` | Confirms comments/suggestions render in the embedded demo. |
| RFM guide | Writing edit example | Click `rfm-format-example-writing-edit` | `rfm-format-example-writing-edit` | Useful for prose-focused review states. |
| Preview | Rich text default | `/preview?editor=rich-text` | `page-card-rich-text`, `rich-text-editor` | Uses in-memory preview backend and includes a sample anchored comment. |
| Preview | Code editor default | `/preview?editor=code` | `page-card-code`, `markdown-code-editor` | Capture line wrapping, code editor chrome, and rail behavior. |
| Document | Rich/code toggle | Use `document-editor-view-toggle` | `document-editor-view-toggle` | URL changes to `?editor=code` or `?editor=rich-text`. |
| Document | Editing mode | Open mode menu and choose Editing | `document-mode-trigger` | Normal edit behavior. |
| Document | Suggesting mode | Open mode menu and choose Suggesting | `document-mode-trigger` | Selection actions should create suggestions instead of direct edits. |
| Document | Viewing mode | Open mode menu and choose Viewing | `document-mode-trigger` | Editing controls should look non-editable; the review rail is not rendered and the document is centered at its normal measure. |
| Document | Save status: saved | Any clean document after autosave | `document-save-button`, `document-save-status` | Checkmark and `Saved` label on a disabled save button in the top-right status stack, left of the handoff control. |
| Document | Save status: saving | Type and capture during autosave | `document-save-button`, `document-save-status` | Spinner and `Saving` label; the button stays enabled so a click flushes the pending write. Transient; easiest with mocked delayed save. |
| Document | Save status: failed | Force save error | `document-save-button`, `document-save-status` | Warning icon and `Save failed` label; the button stays enabled to retry. Use backend/API mocking or a component harness. |
| Document | Save button blocked | Any disk-blocked state (changed, conflict, paused) | `document-save-button` | Icon-only disabled button; the conflict banner carries the wording, and the accessible label matches the banner title. |
| Document | Disk changed | Open local file, modify file externally while browser content is clean | `file-conflict-notice`, `file-conflict-action-reload`, `file-conflict-action-overwrite` | Banner title: `File changed on disk`. |
| Document | Save conflict | Edit in browser, then modify file externally before autosave resolves | `file-conflict-notice`, `file-conflict-action-keep-editing` | Banner title: `Save conflict`; autosave pauses. |
| Document | Autosave paused | Keep editing after conflict | `file-conflict-notice`, `file-conflict-action-overwrite` | Banner title: `Autosave paused`; no keep-editing action. |
| Document | Review handoff idle | Open a local file while a watcher is connected | `review-handoff-button` | Header text: `Agent watching`. |
| Document | Review handoff comment popover | Open a local file while a watcher is connected, then click the handoff dropdown trigger | `review-handoff-comment-trigger`, `review-handoff-comment-popover`, `review-handoff-overall-comment` | Capture the split handoff control and textarea with `Overall comment` placeholder before submission. |
| Document | Review handoff sending | Click handoff button while watcher is connected | `review-handoff-button` | Button label: `Sending`. |
| Document | Review handoff sent | Successful handoff | `review-handoff-status`, `review-handoff-robots-toy`, `review-handoff-close-window`, `review-handoff-copy-message` | Capture the random completion title, robot toy, primary close button, and fallback copy hint below it. |
| Document | Review handoff undelivered | Watcher disconnects before handoff | `review-handoff-status` | Popover title: `No agent is watching now`. |
| Document | Review handoff error | Force handoff API error | `review-handoff-status` | Popover title: `Could not notify agent`. |
| Document | Narrow-width footer | Open review fixture in rich mode with viewport width below 1100px | `review-entry-footer`, `review-entry-footer-action-previous`, `review-entry-footer-action-next` | Replaces the rail below the `rail` breakpoint; capture with a comment thread and a suggestion entry present. |
| Remote | Connected banner | Open with `?session=<id>&token=<token>` and remote capability enabled | `role=status`, `aria-label="Remote session connected"` | Requires remote backend support in `/api/status`. |
| Remote | Disconnected banner | Drop remote session connection | `role=alert`, `aria-label="Remote session disconnected"` | Best captured with backend mocking. |
| Editor | Selection menu | Select text in rich editor | `selection-menu` | Capture formatting buttons and comment/suggestion actions. |
| Editor | Selection menu on suggestion | Select existing suggestion text | `selection-menu-action-accept-suggestion`, `selection-menu-action-reject-suggestion` | Requires review fixture. |
| Editor | Comment action blocked | Select text that crosses a block boundary, partially overlaps an existing comment anchor, or starts or ends inside inline code, then hover the disabled Comment action | `selection-menu-action-comment`, `blocked-action-tooltip` | Comment button is disabled; tooltip states the blocking reason. |
| Editor | Context menu review actions blocked | Select text inside a fenced code block, then right-click inside the selection | `editor-context-menu-action-add-comment`, `editor-context-menu-action-suggest-insertion`, `editor-context-menu-action-suggest-deletion`, `editor-context-menu-action-suggest-replacement`, `blocked-action-tooltip` | All four review actions are disabled; each carries the same reason. Right-click outside the selection collapses it and changes why the actions are disabled. |
| Editor | Link popover | Click a link or choose Link from selection menu | `link-popover`, `link-url-input`, `link-action-open`, `link-action-delete` | Use the plain fixture link. |
| Editor | Context menu | Right-click in rich editor | `editor-context-menu` | Capture comment, suggestion, paste, and paste-markdown actions. |
| Review rail | Entry chips | Open review fixture in rich mode | `document-review-rail`, `review-entry-chip-rd-c1`, `review-entry-chip-rd-s1` | One chip per entry, stacked beside its anchor; comment and suggestion chips both use `review-entry-chip-{id}`. |
| Review rail | Navigation control | Open review fixture in rich mode | `review-entry-nav`, `review-entry-nav-position`, `review-entry-nav-action-previous`, `review-entry-nav-action-next` | Fixed at the top of the rail; steps `currentEntryId` through the entry sequence. |
| Review rail | Thread dialog: comment | Click `review-entry-chip-rd-c1-action-open` | `review-thread-dialog`, `review-thread-dialog-excerpt` | Shows the anchored excerpt and the comment thread. |
| Review rail | Thread dialog: suggestion | Click `review-entry-chip-rd-s1-action-open` | `review-thread-dialog`, `review-thread-dialog-excerpt`, `review-thread-dialog-action-accept`, `review-thread-dialog-action-reject` | Accept/reject actions appear alongside the thread. |
| Review rail | Resolved chip | Resolve a thread, then view its chip | `review-entry-chip-rd-c1` | Muted at reduced opacity; the entry stays in the sequence. |
| Review rail | Document-scope chip | Open review fixture in rich mode | `review-entry-chip-rd-c4` | Pinned above the anchored chips; has no excerpt because it has no anchor. |
| Review rail | Suggestion composer popover | Select text and choose a suggestion action | `suggestion-composer`, `suggestion-composer-input`, `suggestion-composer-action-cancel`, `suggestion-composer-action-apply` | Capture with typed replacement text before applying. |
| Code mode | Review rail present | Open review fixture with `?editor=code` | `page-card-code`, `markdown-code-editor` | Confirms code editor and rail can coexist. |
| Code mode | Review rail absent | Open fenced fixture with `?editor=code` | `page-card-code`, `markdown-code-editor` | Confirms fenced CriticMarkup alone does not create review rail. |
| Error/home fallback | Non-Markdown path | Open URL with `?path=/tmp/file.txt` | homepage error message | Copy: `Roughdraft now opens one .md file at a time.` |
| Error/home fallback | Missing/unloadable path | Open URL with invalid markdown path through local backend | homepage error message | Captures load-error homepage variant. |
## Playwright Capture Skeleton
```ts
import { chromium, devices } from "playwright";

const baseUrl = process.env.ROUGHDRAFT_BASE_URL ?? "http://127.0.0.1:5173";
const outDir = process.env.ROUGHDRAFT_SCREENSHOT_DIR ?? ".context/ui-state-screenshots/manual";

const browser = await chromium.launch();
const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await desktop.goto(`${baseUrl}/`);
await desktop.screenshot({ path: `${outDir}/01-home-desktop.png`, fullPage: true });

const mobile = await browser.newPage({ ...devices["iPhone 13"] });
await mobile.goto(`${baseUrl}/`);
await mobile.screenshot({ path: `${outDir}/01-home-mobile.png`, fullPage: true });

await browser.close();
```

For interaction-heavy states, prefer selectors over coordinates. The current code has stable `data-testid` hooks for the homepage storyboard, editor view toggle, mode trigger, conflict banner/actions, review rail, rich editor, code editor, selection menu, link popover, and context menu.
## States That Need A Harness Or Mocking
These are real product states, but they are awkward to capture deterministically through only public routes:

- Initial loading
  
- Save status: saving, failed, and sometimes unsaved
  
- Disk conflict and autosave paused
  
- Review handoff undelivered/error
  
- Remote connected/disconnected banners
  
- Update notice
  

The most reliable long-term solution is a dedicated screenshot harness route or Playwright component harness that renders `DocumentWorkspace` with controlled backend, disk, remote, watcher, and save states. Keep the production-route screenshots for broad layout coverage and use the harness for rare operational states.
## Maintenance Checklist
- Add a row when a new route, dialog, popover, banner, editor mode, or empty/error state ships.
  
- Add or update a fixture when a new Markdown/Roughdraft Format feature changes rendering.
  
- Prefer `data-testid` selectors for screenshot automation; add a selector when a state matters visually.
  
- Capture desktop and mobile for page-level states.
  
- Capture both rich-text and code editor for document states that affect the editor surface or review rail.
  
- Keep screenshots in `.context/` unless the run is intentionally being committed as visual documentation.
