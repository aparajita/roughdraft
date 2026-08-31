# Review Interface — Presentation Layer

Implements the presentation half of `docs/spec/review-interface.md`: entries, rail, footer, current-entry navigation, thread dialog, suggestion composer, keyboard and modes.

The spec's "Review state ownership" section — moving every review record into a ProseMirror plugin, carrying every mutation on a transaction, and making serialization a pure function of editor state — is a separate plan. Every phase here keeps the comments `Map<string, ReviewComment>` in `PageCard`'s React state and keeps `editorStateToReviewMarkdown(doc, comments, options)` taking that map as an argument. No phase adds a ProseMirror plugin.

## Status Dashboard

| Phase | Description | Status | Sub-plan |
| --- | --- | --- | --- |
| 1   | [Entry Model And Pure Helpers](#-phase-1-entry-model-and-pure-helpers) | ✅ Complete | —   |
| 2   | [Layout Tokens](#-phase-2-layout-tokens) | ✅ Complete | —   |
| 3   | [Entry Chip](#-phase-3-entry-chip) | ✅ Complete | —   |
| 4   | [Flat Thread List](#-phase-4-flat-thread-list) | ✅ Complete | —   |
| 5   | [Thread Dialog](#-phase-5-thread-dialog) | ✅ Complete | —   |
| 6   | [Rail Rewrite](#-phase-6-rail-rewrite) | ✅ Complete | —   |
| 7   | [Narrow Width Footer](#-phase-7-narrow-width-footer) | ✅ Complete | —   |
| 8   | [Suggestion Composer Popover](#-phase-8-suggestion-composer-popover) | ✅ Complete | —   |
| 9   | [PageCard Orchestration](#-phase-9-pagecard-orchestration) | ✅ Complete | —   |
| 10  | [Document Shell](#-phase-10-document-shell) | ✅ Complete | —   |
| 11  | [Tests](#-phase-11-tests) | 🔄 In Progress | —   |
| 12  | [Screenshot Guide](#-phase-12-screenshot-guide) | ✅ Complete | —   |
| 13  | [Gate](#-phase-13-gate) | ⏸️ Blocked by 9, 10, 11, 12 | —   |
| 14  | [Manual UI Verification](#-phase-14-manual-ui-verification) | ⏸️ Blocked by 13 | —   |

---

## ✅ Phase 1: Entry Model And Pure Helpers

**Status:** Complete  
**BlockedBy:** —  
**Files:** packages/app/src/document-comments.ts, packages/app/src/review/index.ts  
**Recommended model/effort:** Opus, high — this phase decides the type that every other phase renders and navigates. Getting the union and the ordering contract right is what deletes work from phases 3, 6, 7, 9 and 11.

### Context this phase must not rediscover

`packages/app/src/document-comments.ts` today holds anchor measurement, grouping, and the rail stacking algorithm (`getCommentAnchorMeasurements`, `groupCommentAnchorMeasurements`, `buildCommentThreadRailItems`, `resolveAnchoredRailLayouts`, `resolveCommentThreadRailLayouts`, `resolveCommentRailLayouts`, `COMMENT_ANCHOR_SELECTOR`).

There is no unified "review entry" concept anywhere in the app. `PageCard.tsx` tracks `selectedCommentId` and `selectedChangeId` as two independent `useState` values (`PageCard.tsx:582-587`); `selectSuggestion` clears `selectedCommentId` but `selectComment` does not clear `selectedChangeId` (`PageCard.tsx:1519-1526`), so a comment and a suggestion can both be current at once. `DocumentReviewRail.tsx` merges and orders the two lists itself (`DocumentReviewRail.tsx:312-333`).

`SuggestionRailItem` — the shape `PageCard` builds and passes around — is declared inside the view component at `DocumentReviewRail.tsx:34-43`, and `PageCard.tsx:11` imports it from there. A data shape owned by the component that draws it is why phase 6 cannot be rewritten without breaking phase 9; this phase moves it.

`ReviewComment` (`packages/app/src/review/index.ts:38-46`) has no `status` or `resolved` field. The rfm `CommentRecord` (`packages/rfm/src/endmatter.ts:58-59`) does. `commentRecordFrom` (`review/index.ts:163-191`) spreads the existing record first, so `status`/`resolved` survive a round trip today only as opaque pass-through — nothing in the app can set or clear them.

`packages/app/src/document-comments.ts:59` declares `COMMENT_ANCHOR_SELECTOR = 'span[id^="rd-c"]'`. The identical literal is declared a second time at `packages/app/src/DocumentWorkspace.tsx:175`, alongside three suggestion-anchor selectors at `DocumentWorkspace.tsx:176-178` (`ins[id^="rd-s"]`, `del[id^="rd-s"]`, `span[id^="rd-s"]`), while `PageCard.tsx:348` declares a fourth, differently-shaped one (`'ins[id^="rd-s"], del[id^="rd-s"], [data-rd-replace]'`). Four sibling declarations of the same idea that do not agree.

### Tasks

1. Move `SuggestionRailItem` out of `packages/app/src/DocumentReviewRail.tsx:34-43` into `document-comments.ts` and rename it `SuggestionAnchorItem`. It keeps its fields: `suggestionId`, `attrs`, `kind`, `oldText`, `newText`, `commentIds`, `anchorTop`, `anchorBottom`. Re-export nothing from `DocumentReviewRail.tsx`; phases 6 and 9 import it from `document-comments.ts`.
2. Add `export type SuggestionOperation = "insert" | "delete" | "replace"` and `export function suggestionOperationOf(kind: SuggestionKind): SuggestionOperation` to `document-comments.ts`. `SuggestionKind` is `"insert" | "delete" | "replace-old" | "replace-new"`, exported from `packages/app/src/editor-extensions.ts:50-54`; `"replace-old"` and `"replace-new"` both map to `"replace"`. Write the mapping as a `Record<SuggestionKind, SuggestionOperation>` so adding a `SuggestionKind` constant fails to compile until the mapping covers it. The operation is derived from the anchor markup and is never read from an endmatter record.
3. Write the contract for `ReviewEntry` before declaring it. State: exactly one entry is current at a time; an entry's `id` is unique across the whole sequence because comment ids (`rd-c*`) and suggestion ids (`rd-s*`) share one id space in the document; a suggestion's reply comments belong to that suggestion's entry and never form an entry of their own; a comment reachable through `re` from a thread root belongs to that root's entry.
4. Declare the union in `document-comments.ts`:
  
  ```ts
  export type ReviewEntry =
    | { kind: "document-comment"; id: string; commentIds: string[]; at: string }
    | { kind: "comment-thread"; id: string; commentIds: string[];
        anchorGroupKey: string; anchorTop: number; anchorBottom: number }
    | { kind: "suggestion"; id: string; operation: SuggestionOperation;
        oldText: string; newText: string; commentIds: string[];
        anchorTop: number; anchorBottom: number };
  ```
  
  `id` is the root comment id for the first two kinds and the suggestion id for the third. `commentIds` is the full ordered membership of the entry, root first for a thread. This union replaces the four-variable `selectedCommentId`/`hoveredCommentId`/`selectedChangeId`/`hoveredChangeId` state in `PageCard.tsx`, so no phase reintroduces a parallel "selected suggestion" variable.
5. Write the contract for `buildReviewEntries` before implementing it: preconditions on its inputs, the total ordering it produces, and the guarantee that every returned `id` is distinct. Then implement:
  
  ```ts
  export function buildReviewEntries(
    commentGroups: CommentGroupAnchor[],
    suggestions: SuggestionAnchorItem[],
    comments: ReadonlyMap<string, ReviewComment>,
  ): ReviewEntry[]
  ```
  
  Ordering: every `scope: "document"` root comment first, ascending by its `createdAt`; then anchored entries — comment threads and suggestions interleaved — ascending by `anchorTop`, ties broken by `anchorBottom` then by `id` so the order is total and stable. A comment listed in a suggestion's `commentIds` is claimed by that suggestion and does not also produce a comment-thread entry; `DocumentReviewRail.tsx:216-266` does this filtering today and that logic moves here. Reuse the existing `buildCommentThreadRailItems`, `expandCommentThreadIds`, `buildCommentThreads` and `flattenCommentThreads` rather than writing a second thread walk.
6. Implement `export function resolveNextCurrentEntry(previousEntries: ReviewEntry[], nextEntries: ReviewEntry[], removedEntryId: string): string | null`. The spec says accepting or rejecting a suggestion "makes the next entry in the sequence current". Contract: let `i` be `removedEntryId`'s index in `previousEntries`; return `nextEntries[i]?.id`, else the last entry's id when `i` is past the end, else `null` when `nextEntries` is empty. Phase 9 calls this after accept and after reject.
7. Implement `export function resolveAnchorScroll(anchor: { top: number; bottom: number }, viewportHeight: number): number | null`. The spec: when an anchored entry becomes current its anchor "is scrolled to the upper third of the viewport if it is not already fully visible, and is not scrolled otherwise". Return `null` when `0 <= anchor.top` and `anchor.bottom <= viewportHeight`; otherwise return the scroll delta that puts `anchor.top` at `viewportHeight / 3`. `top`/`bottom` are viewport-relative, as `getBoundingClientRect` returns them. Name `1 / 3` as a named constant — a bare `3` in a calculation is a magic number.
8. Add `export const INSERTION_ANCHOR_SELECTOR = 'ins[id^="rd-s"]'`, `export const DELETION_ANCHOR_SELECTOR = 'del[id^="rd-s"]'` and `export const REPLACEMENT_ANCHOR_SELECTOR = 'span[id^="rd-s"]'` beside the existing `COMMENT_ANCHOR_SELECTOR`. These four are the only declarations of an anchor selector in the app; phases 9 and 10 delete the copies at `DocumentWorkspace.tsx:175-178` and `PageCard.tsx:348` and import these instead.
9. Add `status?: "resolved"` and `resolved?: string` to `ReviewComment` (`packages/app/src/review/index.ts:38-46`), and make `commentRecordFrom` (`review/index.ts:163-191`) write both onto the `CommentRecord` it builds: present when set on the `ReviewComment`, deleted from the record when cleared. It currently spreads `...existing` and overwrites only `body`/`by`/`at`/`re`/`scope`, which is why a resolve control has nothing to write to today. Keep the pass-through of every other unrecognized record key intact — the round-trip contract in `docs/adr/0003-markdown-roundtrip-contract.md` requires it.
10. Make `reviewCommentsFromDocument` (`review/index.ts:151-161`) read `status` and `resolved` off each `CommentRecord` into the `ReviewComment` it builds, so a document opened from disk shows its resolved threads muted.
11. Leave `resolveAnchoredRailLayouts`, `resolveCommentRailLayouts`, `getCommentAnchorMeasurements`, `groupCommentAnchorMeasurements` and `getRootThreadIdForCommentId` as they are. Phase 6 still stacks chips with `resolveAnchoredRailLayouts`.

---

## ✅ Phase 2: Layout Tokens

**Status:** Complete  
**BlockedBy:** —  
**Files:** packages/app/src/style.css  
**Recommended model/effort:** Sonnet, low — declaring three Tailwind v4 theme tokens and rewriting one media query to read them.

### Context this phase must not rediscover

The rail width, the rail breakpoint and the document measure are each declared in several places today, and two of them disagree:

- `style.css:736` — `@media (min-width: 1100px)`.
- `style.css:740` — `--review-rail-width: 18rem` for the `.review-layout-grid` header row, collapsing to `0rem` at `style.css:749`.
- `style.css:741` — `grid-template-columns: minmax(0, 60rem) var(--review-rail-width)`.
- `PageCard.tsx:1576` and `PageCard.tsx:1727` — `min-[1100px]:grid-cols-[minmax(0,60rem)_minmax(24rem,1fr)]`, a rail column of at least **24rem**, not the header row's 18rem.
- `PageCard.tsx:1584`, `PageCard.tsx:1735`, `DocumentWorkspace.tsx:1034` — `max-w-[60rem]`.
- `PageCard.tsx:1589`, `PageCard.tsx:1595`, `PageCard.tsx:1742` — `min-[1100px]:hidden` / `hidden min-[1100px]:block`.

The spec requires the rail to be `12rem`, "declared once and read by both the document header row and the document shell".

`packages/app/src/style.css` is a Tailwind v4 entry (`@import "tailwindcss"` at line 1) and already has a `@theme inline` block at line 594. A `--breakpoint-*` token in a `@theme` block generates a responsive variant of that name usable as a Tailwind class prefix; a CSS custom property cannot be used inside a `@media` condition, so the breakpoint has to be a theme token rather than a `var()`.

### Tasks

1. Add a plain `@theme` block (not `@theme inline` — these are literal values, not references to other custom properties) to `packages/app/src/style.css`, placed immediately before the existing `@theme inline` block at line 594:
  
  ```css
  @theme {
    --breakpoint-rail: 1100px;
    --review-rail-width: 12rem;
    --document-measure: 60rem;
  }
  ```
  
  This makes `rail:` available as a Tailwind variant (`rail:grid`, `rail:hidden`, …) and makes `var(--review-rail-width)` and `var(--document-measure)` readable from both CSS and Tailwind arbitrary values.
2. Rewrite the `.review-layout-grid` rules at `style.css:725-761` to read the tokens: change the media query to `@media (min-width: theme(--breakpoint-rail))`, delete the local `--review-rail-width: 18rem` declaration at `style.css:740`, and make the grid template `minmax(0, var(--document-measure)) var(--review-rail-width)`. Keep the `.review-layout-grid--centered` rule, but have it override the column gap and set the rail track to `0rem` without redeclaring the width token's value for the non-centered case.
3. Add a `--review-footer-height` token to the same `@theme` block, set to the height the fixed narrow-width footer occupies (`3.5rem`). Phase 7 sizes the footer from it and phase 9 uses it as the document's bottom inset below the rail breakpoint, so the inset and the bar cannot drift apart.
4. Add a `.review-entry-footer` class in `style.css` that sets `position: fixed`, `inset-inline: 0`, `bottom: 0`, `height: var(--review-footer-height)` and `z-index: 30`, and hides itself at `@media (min-width: theme(--breakpoint-rail))`. 30 sits above document content and below every layer it must not cover: the shadcn Popover portal at `z-[70]` (used by the editor context menu and link popover, `components/ui/popover.tsx`), the document status stack at `z-[60]` (`DocumentWorkspace.tsx:768`), and the conflict notice at `z-50` (`DocumentWorkspace.tsx:968`).
5. Leave the `embedded-demo` layout's own `900px` breakpoint alone. It is the RFM guide page's inline demo, not the document shell, and phases 6, 9 and 10 keep it working through the existing `layout` prop.

---

## ✅ Phase 3: Entry Chip

**Status:** Complete  
**BlockedBy:** 1  
**Files:** packages/app/src/ReviewEntryChip.tsx  
**Recommended model/effort:** Sonnet, medium — one presentational component with an exhaustive switch and no state of its own.

### Context this phase must not rediscover

Today there is no chip. The rail renders a full expandable `CommentEditorList` card per entry (`DocumentReviewRail.tsx:434-477` for comments, `DocumentReviewRail.tsx:636-709` for suggestions), plus a separate draft-suggestion card at `DocumentReviewRail.tsx:480-559`.

`docs/spec/review-interface.md` requires one chip per entry, one line high, and requires the narrow-width footer to show "the entry's summary, in the same terms as its chip". This component is what both the rail (phase 6) and the footer (phase 7) render, so the two cannot drift.

Icons come from `lucide-react`, already a dependency. `Check` and `X` are the green check and red cross used at `DocumentReviewRail.tsx:602-632` today; keep those two icons.

### Tasks

1. Create `packages/app/src/ReviewEntryChip.tsx` exporting a single component:
  
  ```tsx
  interface ReviewEntryChipProps {
    entry: ReviewEntry;
    isCurrent: boolean;
    isResolved: boolean;
    onSelect: () => void;
    onOpenDialog: () => void;
    onAcceptSuggestion: (suggestionId: string) => void;
    onRejectSuggestion: (suggestionId: string) => void;
  }
  ```
  
  `ReviewEntry` and `SuggestionOperation` are imported from `packages/app/src/document-comments.ts`.
2. Render the chip body as the click target that calls `onSelect`, one line high, with `overflow: hidden` and ellipsis on its label. The pencil, check and cross are buttons layered on top of it, and each stops propagation so clicking one does not also fire `onSelect`.
3. Drive the chip's contents from a `switch (entry.kind)` whose `default` branch assigns `entry` to a `never`-typed local, so adding a `ReviewEntry` kind in `document-comments.ts` fails to compile here until this component handles it. Per kind:
  
  - `"comment-thread"` — the count of comments in the thread including the root (`entry.commentIds.length`, not split by author), and a pencil button calling `onOpenDialog`.
  - `"document-comment"` — the same as a comment thread.
  - `"suggestion"` — the operation label `Insert`, `Delete` or `Replace` from `entry.operation`; the comment count only when `entry.commentIds.length > 0`; a pencil calling `onOpenDialog`; a green check calling `onAcceptSuggestion(entry.id)`; a red cross calling `onRejectSuggestion(entry.id)`.
4. When `isResolved` is true, render the chip muted and keep the count visible. A resolved chip keeps every control it had — resolution mutes it, it does not disable it.
5. Give the chip root `data-testid={`review-entry-chip-${entry.id}`}` and each control `data-testid={`review-entry-chip-${entry.id}-action-{open,accept,reject}`}`. `scripts/check-test-selectors.mjs` requires tests to address elements by `data-testid`, so every control a test or screenshot run has to reach needs one.
6. Add no `variant` prop and no layout prop. The rail and the footer position this component; they do not restyle it.

---

## ✅ Phase 4: Flat Thread List

**Status:** Complete  
**BlockedBy:** 1  
**Files:** packages/app/src/CommentEditorList.tsx  
**Recommended model/effort:** Opus, high — this is a rewrite of an 811-line component down to a flat list, and it decides the row contract the dialog renders.

### Context this phase must not rediscover

`packages/app/src/CommentEditorList.tsx` today:

- Takes a `variant?: "banner" | "rail"` prop (`CommentEditorList.tsx:26-47`). `DocumentReviewRail.tsx:462,660` passes `"rail"`; `PageCard.tsx:1606-1628` renders it as a narrow-width banner above the document. The spec states `CommentEditorList` has no rail-versus-banner variant and there is no inline comment banner, so the prop and both call-site shapes go.
- Renders an indented tree: `buildCommentThreads` at `CommentEditorList.tsx:116` and `CommentThreadNode` recursing over `thread.replies` at `CommentEditorList.tsx:774-808`, with connector-line constants at `CommentEditorList.tsx:347-351,591-639`. The spec requires a flat list ordered by `at`, with no indentation, no tree and no reply-parent reference line.
- Renders the body as plain `whitespace-pre-wrap` text (`CommentEditorList.tsx:692-702`). The spec requires Markdown, through `renderMarkdownToHtml` (`packages/app/src/markdown.ts:395`).
- Renders no timestamp at all. The spec requires a relative time via `Intl.RelativeTimeFormat` carrying the absolute local time from `Intl.DateTimeFormat` in its `title`.
- Renders actions as a flat row of Reply/Edit/Delete buttons (`CommentEditorList.tsx:508-540`) plus a standalone Delete-thread icon button on root rows (`CommentEditorList.tsx:642-655`). The spec requires an overflow menu holding Edit and Delete, and Delete thread on the root row.
- Registers a bare `r` reply shortcut (`isReplyShortcut`, `CommentEditorList.tsx:73-91`, wired at `124-141`). The spec states there is no reply shortcut.
- Auto-opens an editor for a freshly created empty comment via `pendingFocusCommentId` (`CommentEditorList.tsx:158-175`), deletes the comment when a draft is submitted empty (`CommentEditorList.tsx:222-227`) or cancelled while still empty (`CommentEditorList.tsx:251-254`), and hides the Cancel button entirely for a new root draft via `isNewRootCommentDraft` (`CommentEditorList.tsx:474-478,541-543`). All of that exists because `PageCard.tsx:1142-1173` writes the record and its anchor before a body is typed. Phase 9 stops doing that, so this machinery has nothing left to clean up and goes.

`ReviewComment` carries `id`, `content`, `createdAt`, `authorType`, `authorId`, `parentCommentId`, `scope`, and — after phase 1 — `status` and `resolved` (`packages/app/src/review/index.ts:38-46`).

### Tasks

1. Rewrite the prop signature to exactly:
  
  ```tsx
  interface CommentEditorListProps {
    comments: ReviewComment[];
    onUpdateComment: (commentId: string, nextContent: string) => void;
    onDeleteComment: (commentId: string) => void;
    onDeleteThread: (rootCommentId: string) => void;
    testId?: string;
  }
  ```
  
  Delete `variant`, `interactive`, `className`, `selectedCommentId`, `hoveredCommentId`, `onSelectComment`, `onHoverComment`, `onFocusComment`, `onReplyComment`, `pendingFocusCommentId`, `newCommentDraftIds`, `onAutoFocusComment`, `renderCommentContent` and `getCommentActions`. Selection, hover and reply now live one level up: selection is the current entry (phase 9), and the composer is the dialog's (phase 5). `renderCommentContent` and `getCommentActions` existed so `DocumentReviewRail` could inject the suggestion operation label and accept/reject buttons into a comment list; phase 3's chip and phase 5's dialog header carry those now, so the injection points go.
2. Render `comments` as siblings in one flat list ordered ascending by `createdAt`, ties broken by `id`. Do not call `buildCommentThreads`; the caller passes the entry's membership already. Delete `CommentThreadNode`'s recursion and every connector-line constant.
3. Render each row with: the author avatar — the `Bot` icon from `lucide-react` for `authorType === "ai"`, the `User` icon otherwise; the author label `AI`, the `authorId`, or `Me`; the time; the body; and an overflow menu.
4. Write one `formatCommentTime(at: string, now: Date)` helper in this file that returns `{ relative, absolute }` — `relative` from a module-level `Intl.RelativeTimeFormat` instance, `absolute` from a module-level `Intl.DateTimeFormat` instance. Both instances are created once at module scope, not per render. Render `relative` as the row's text and `absolute` as its `title`. Name the second-per-unit thresholds as constants.
5. Render the body through `renderMarkdownToHtml` from `packages/app/src/markdown.ts`, into a container styled by the same prose classes the document body uses. A comment body is Markdown of any length and structure per `docs/spec/roughdraft-flavored-markdown.md`, so nothing here may reject or transform a body on the basis of its content.
6. Replace the button row with an overflow menu per row holding Edit and Delete, and on the root row — the row whose comment has no `parentCommentId` — additionally Delete thread calling `onDeleteThread`. Build the menu from the shadcn primitives in `packages/app/src/components/ui/`; if no menu primitive exists there yet, add one in the same shadcn style before wiring it in, per `AGENTS.md`.
7. Keep in-place editing: Edit swaps the row's body for the `Textarea` from `packages/app/src/components/ui/textarea.tsx`, `Cmd`/`Ctrl`+`Enter` saves by calling `onUpdateComment`, and `Escape` reverts the row without saving. Editing a comment replaces its body and leaves `createdAt` unchanged, so no code path here writes `createdAt`.
8. Delete the `r` reply shortcut and its `isReplyShortcut` / `isEditableShortcutTarget` helpers, the `pendingFocusCommentId` auto-open effect, the empty-draft delete branches in `submitEditingComment` and `cancelEditingComment`, and `isNewRootCommentDraft` with the action filtering it drives. Every one of these exists only to service an empty record that phase 9 stops creating; leaving any of them behind is dead code that will look load-bearing to the next reader.
9. Keep row `data-testid`s stable in shape: `comment-row-{id}`, `comment-row-{id}-menu`, `comment-row-{id}-action-edit`, `comment-row-{id}-action-delete`, `comment-row-{id}-action-delete-thread`, `comment-row-{id}-editor`, `comment-row-{id}-action-save`. Keep `data-comment-thread-root-id` on the root row — `scripts/check-test-selectors.mjs` allowlists it as a selector.

---

## ✅ Phase 5: Thread Dialog

**Status:** Complete  
**BlockedBy:** 1, 4  
**Files:** packages/app/src/ReviewThreadDialog.tsx  
**Recommended model/effort:** Opus, high — modal semantics, the excerpt box, the resolve rule and the external-reload path all interact.

### Context this phase must not rediscover

No dialog exists for review today; editing happens inline in the rail. `packages/app/src/components/ui/dialog.tsx` wraps `@base-ui/react/dialog` and exports `Dialog`, `DialogTrigger`, `DialogPortal`, `DialogClose`, `DialogOverlay`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription`. `DialogContent` always renders `DialogPortal` + `DialogOverlay` and nothing opts out of Base UI's modal defaults, so focus trapping, scroll lock, outside-pointer blocking, the backdrop and outside-click dismissal come for free — do not reimplement any of them.

`ReviewComment` has no `status`/`resolved` fields until phase 1 adds them; this phase depends on that.

### Tasks

1. Create `packages/app/src/ReviewThreadDialog.tsx` exporting one component:
  
  ```tsx
  interface ReviewThreadDialogProps {
    entry: ReviewEntry | null;
    comments: ReviewComment[];
    excerpt: string | null;
    closedReason: string | null;
    onClose: () => void;
    onSubmitReply: (body: string) => void;
    onUpdateComment: (commentId: string, nextContent: string) => void;
    onDeleteComment: (commentId: string) => void;
    onDeleteThread: (rootCommentId: string) => void;
    onToggleResolved: (rootCommentId: string, nextResolved: boolean) => void;
    onAcceptSuggestion: (suggestionId: string) => void;
    onRejectSuggestion: (suggestionId: string) => void;
  }
  ```
  
  The dialog is open when `entry` is non-null. It holds no copy of the thread: it renders `comments` on every render, so a reload from disk that changes the array shows the new comments in place with no extra wiring.
2. Size the dialog: centred, `48rem` wide, height the viewport less `2rem` at top and bottom. Express the `2rem` inset once in this file as a named constant used for both edges.
3. Render the header excerpt — `excerpt`, the anchored text the entry is about — in a fixed-height scrollable box that shows it complete and untruncated: a fixed height with `overflow-y: auto`, never a line clamp or an ellipsis. When `excerpt` is `null` (a document comment) render no excerpt box at all.
4. For a `"suggestion"` entry, put the green check and red cross in the header, calling `onAcceptSuggestion(entry.id)` / `onRejectSuggestion(entry.id)`. Neither prompts for confirmation and neither closes the dialog itself — phase 9's handler closes it and advances the current entry.
5. Render the thread by handing `comments` to `CommentEditorList` from `packages/app/src/CommentEditorList.tsx`, forwarding `onUpdateComment`, `onDeleteComment` and `onDeleteThread` unchanged. Do not re-sort or re-nest here; the flat ordering is that component's contract.
6. Render one composer at the foot of the dialog: the plain `Textarea` from `components/ui/textarea.tsx`, `Cmd`/`Ctrl`+`Enter` calling `onSubmitReply` with the trimmed body, `Escape` calling `onClose`. Submitting clears the textarea. A blank body submits nothing — the button and the shortcut are inert while the trimmed body is empty, so no empty record can be produced from here.
7. Render a resolve control beside the composer **only** when `entry.kind !== "suggestion"`. It calls `onToggleResolved(entry.id, next)`. A resolved thread stays fully editable: it accepts replies, edits and deletes, and this component must not clear resolved state from any path except that control. A suggestion's `status: resolved` carries no meaning in this interface, which is why the control is absent rather than disabled for suggestions.
8. When `closedReason` is non-null, render it in place of the thread — the entry the dialog was open on no longer exists because the document was reloaded from disk. Phase 9 supplies the string and clears `entry`.
9. Give the dialog root `data-testid="review-thread-dialog"`, and `review-thread-dialog-{excerpt,composer,action-submit,action-resolve,action-accept,action-reject,closed-reason}` to the parts a test or screenshot run must reach.
10. Do not render navigation controls here. Navigation is unavailable while the dialog is open; phase 9 is what suppresses it.

---

## ✅ Phase 6: Rail Rewrite

**Status:** Complete  
**BlockedBy:** 1, 2, 3  
**Files:** packages/app/src/DocumentReviewRail.tsx  
**Recommended model/effort:** Opus, high — the file loses most of its body and its remaining stacking behavior has to keep working against the existing layout helper.

### Context this phase must not rediscover

`packages/app/src/DocumentReviewRail.tsx` is 714 lines today and computes the entry sequence itself: it groups threads (`216-266`), builds suggestion entries (`268-278`), positions a draft-suggestion card from `editor.view.coordsAtPos` (`280-300`), merges and sorts everything and resolves an `activeKey` (`312-333`). `docs/spec/review-interface.md` requires the sequence to be produced by a pure helper in `document-comments.ts` and computed by `PageCard`, and states it MUST NOT be computed inside `DocumentReviewRail`, which does not mount below 1100px. After phase 1 the helper is `buildReviewEntries`; after phase 9 `PageCard` calls it.

The rail renders full `CommentEditorList` cards today; phase 3's `ReviewEntryChip` replaces them. The draft-suggestion card at `DocumentReviewRail.tsx:480-559` has no replacement here — phase 8 moves it to a popover anchored to the selection, because the spec states there is no draft-suggestion entry in the rail.

`resolveAnchoredRailLayouts` in `document-comments.ts:273-346` pins the active item's chip at its own `anchorTop` and displaces its neighbours outward to avoid collisions, shifting the whole set down if the first would go negative. That is the "existing anchored stacking layout" the spec keeps.

### Tasks

1. Rewrite the prop signature to exactly:
  
  ```tsx
  interface DocumentReviewRailProps {
    entries: ReviewEntry[];
    currentEntryId: string | null;
    resolvedEntryIds: ReadonlySet<string>;
    contentHeight: number;
    className?: string;
    testId?: string;
    onSelectEntry: (entryId: string) => void;
    onOpenDialog: (entryId: string) => void;
    onGoToPreviousEntry: () => void;
    onGoToNextEntry: () => void;
    onAcceptSuggestion: (suggestionId: string) => void;
    onRejectSuggestion: (suggestionId: string) => void;
  }
  ```
  
  Delete `commentGroups`, `comments`, `suggestions`, `selectedCommentId`, `hoveredCommentId`, `selectedChangeId`, `hoveredChangeId`, `layout`, `draftSuggestion`, `editor`, every `onHover*`, every `onFocus*`, every `onReply*`, `pendingFocusCommentId`, `onAutoFocusComment`, `onDraftSuggestionTextChange`, `onApplyDraftSuggestion` and `onCancelDraftSuggestion`.
2. Delete `SuggestionRailItem` from this file; phase 1 moved it to `document-comments.ts` as `SuggestionAnchorItem`. Delete `getSuggestionPreview` and `SuggestionCommentContent` — phase 3's chip carries the operation label now. Delete the `getCommentActions` accept/reject injection at `DocumentReviewRail.tsx:596-634` and the whole draft-suggestion card at `480-559`. Delete the `CommentEditorList` import; the rail no longer renders comment bodies at all.
3. Render the navigation control at the top of the rail whenever `entries` is non-empty: the current position as `N of M` — `N` being the 1-based index of `currentEntryId` in `entries`, `M` being `entries.length` — with previous and next buttons calling `onGoToPreviousEntry` / `onGoToNextEntry`. When `currentEntryId` is null or absent from `entries`, show `M` and disable both buttons. Disable previous at index 0 and next at the last index; the sequence does not wrap. Give it `data-testid="review-entry-nav"` with `review-entry-nav-{position,action-previous,action-next}`.
4. Render one `ReviewEntryChip` per entry, `isCurrent` from `currentEntryId`, `isResolved` from `resolvedEntryIds`, forwarding `onSelectEntry(entry.id)`, `onOpenDialog(entry.id)`, `onAcceptSuggestion` and `onRejectSuggestion`.
5. Position the chips in two groups. Every `kind === "document-comment"` entry is pinned above every anchored chip, in sequence order, and is not passed to the stacking algorithm at all. The remaining entries — `"comment-thread"` and `"suggestion"`, which both carry `anchorTop`/`anchorBottom` — go through `resolveAnchoredRailLayouts` from `document-comments.ts` with `activeKey = currentEntryId`. Keep the existing `ResizeObserver` height measurement that feeds it.
6. Keep the rail's own width off this component. Its `<aside>` wrapper is supplied by `PageCard` through `className`; the width lives in the `--review-rail-width` token phase 2 declares. Do not add a width class here.
7. Keep `data-testid="document-review-rail"` as the rail root's default `testId` so the existing screenshot guide row and e2e selector keep resolving.

---

## ✅ Phase 7: Narrow Width Footer

**Status:** Complete  
**BlockedBy:** 1, 2, 3  
**Files:** packages/app/src/ReviewEntryFooter.tsx  
**Recommended model/effort:** Sonnet, medium — one fixed bar reusing the chip and the nav shape the rail already defines.

### Context this phase must not rediscover

Below 1100px today, `PageCard.tsx:1605-1629` renders a `CommentEditorList` banner above the document, showing only the comments anchored at the current editor selection, with `fallbackClass = "min-[1100px]:hidden"` (`PageCard.tsx:1587-1590`). The spec replaces it: there is no inline comment banner above the document at narrow widths, and instead a fixed footer bar shows the current entry. Phase 9 deletes the banner call site; this phase supplies its replacement.

Phase 2 declares `.review-entry-footer` in `style.css` with the fixed positioning, `--review-footer-height` and `z-index: 30`, and hides it at and above `--breakpoint-rail`. Use that class rather than restating any of it here.

### Tasks

1. Create `packages/app/src/ReviewEntryFooter.tsx` exporting one component:
  
  ```tsx
  interface ReviewEntryFooterProps {
    entries: ReviewEntry[];
    currentEntryId: string | null;
    resolvedEntryIds: ReadonlySet<string>;
    onSelectEntry: (entryId: string) => void;
    onOpenDialog: (entryId: string) => void;
    onGoToPreviousEntry: () => void;
    onGoToNextEntry: () => void;
    onAcceptSuggestion: (suggestionId: string) => void;
    onRejectSuggestion: (suggestionId: string) => void;
  }
  ```
2. Render nothing when `entries` is empty.
3. Render the current entry's summary by rendering `ReviewEntryChip` from `packages/app/src/ReviewEntryChip.tsx` for the entry whose `id` matches `currentEntryId`, with `isCurrent` true. The spec requires the footer's summary to be "in the same terms as its chip", and rendering the same component is what makes that true rather than aspirational — do not restate the count, the operation label or the accept/reject controls here.
4. When `currentEntryId` is null or absent from `entries`, render the first entry in the sequence as the current one rather than an empty bar; phase 9 guarantees a non-empty sequence always has a current entry, so this is the render-order fallback only.
5. Render previous and next buttons calling `onGoToPreviousEntry` / `onGoToNextEntry`, disabled at the ends of the sequence exactly as the rail's control is.
6. Apply the `review-entry-footer` class to the root. Do not add positioning, height or z-index utility classes — every one of those is in the class phase 2 declares, and a second declaration here is what makes the document's bottom inset drift out of agreement with the bar.
7. Give the root `data-testid="review-entry-footer"` and the buttons `review-entry-footer-action-previous` / `review-entry-footer-action-next`.

---

## ✅ Phase 8: Suggestion Composer Popover

**Status:** Complete  
**BlockedBy:** —  
**Files:** packages/app/src/SuggestionComposerPopover.tsx  
**Recommended model/effort:** Sonnet, medium — one popover around a textarea, anchored to a caller-supplied rect.

### Context this phase must not rediscover

`PageCard.tsx:1283-1307` (`handleSuggestInsertion`) and `PageCard.tsx:1202-1215` (`handleSuggestReplacement`) set a `draftSuggestion` state object (`DraftSuggestionState`, declared at `PageCard.tsx:126`) carrying `{ type, from, to, sourceText, text }`. `DocumentReviewRail.tsx:480-559` renders it as a card in the rail, positioned from `editor.view.coordsAtPos`. `handleSuggestDeletion` (`PageCard.tsx:1175-1200`) applies immediately and opens nothing.

The spec keeps the immediate-apply deletion and moves insertion and replacement into "a composer in a popover anchored to the selection, so the text under change stays visible beside it", with `Cmd`/`Ctrl`+`Enter` applying, and states there is no draft-suggestion entry in the rail. Phase 6 deletes the rail card; this phase supplies the popover and phase 9 wires it.

`packages/app/src/components/ui/popover.tsx` exports `Popover`, `PopoverTrigger` and `PopoverContent`, wrapping `@base-ui/react/popover` with `side`/`align`/ `sideOffset` positioning. It is non-modal, which is what keeps the selected text visible and unobscured.

### Tasks

1. Create `packages/app/src/SuggestionComposerPopover.tsx` exporting one component:
  
  ```tsx
  interface SuggestionComposerPopoverProps {
    draft: { type: "insertion" | "replacement"; sourceText: string; text: string } | null;
    anchorRect: DOMRect | null;
    onTextChange: (text: string) => void;
    onApply: () => void;
    onCancel: () => void;
  }
  ```
  
  Open when `draft` is non-null.
2. Anchor the popover to `anchorRect` — the selection's client rect, which phase 9 supplies — using the `Popover` primitive's virtual-anchor positioning, placed to the side rather than over the selection so the text under change stays visible beside it.
3. Render `draft.sourceText` as a read-only label above the textarea for a `"replacement"`, and nothing above it for an `"insertion"` (there is no text being replaced). Render the `Textarea` from `components/ui/textarea.tsx`, wired to `draft.text` and `onTextChange`.
4. Bind `Cmd`/`Ctrl`+`Enter` to `onApply` and `Escape` to `onCancel`. `onApply` is inert while `draft.text` is empty for an insertion; a replacement with empty text is a deletion the user should express through Suggest deletion, so it is inert too.
5. Give the root `data-testid="suggestion-composer"` with `suggestion-composer-{input,action-apply,action-cancel}`.

---

## ✅ Phase 9: PageCard Orchestration

**Status:** Complete  
**BlockedBy:** 1, 2, 3, 4, 5, 6, 7, 8  
**Files:** packages/app/src/PageCard.tsx  
**Recommended model/effort:** Opus, high — this phase replaces four pieces of selection state with one, changes when a record is created, and rewires every component the earlier phases built. It is the only phase that writes this file.

### Context this phase must not rediscover

`packages/app/src/PageCard.tsx` is 2107 lines and owns the review state: `comments` (a `Map<string, ReviewComment>`), `suggestions` (`PageCard.tsx:588`), `draftSuggestion` (`PageCard.tsx:589`), and four selection variables — `selectedCommentId`, `hoveredCommentId` (`PageCard.tsx:582-585`), `selectedChangeId`, `hoveredChangeId` (`PageCard.tsx:586-587`) — mirrored into refs at `PageCard.tsx:580-581,904-905`. `selectSuggestion` clears `selectedCommentId` but `selectComment` does not clear `selectedChangeId` (`PageCard.tsx:1519-1526`), so both can be set at once. `focusComment` (`PageCard.tsx:1528-1548`) and `focusSuggestion` (`PageCard.tsx:1550-1566`) move the editor selection to the anchor and explicitly pass `{ scrollIntoView: false }` (`PageCard.tsx:1536,1547,1560`), so nothing scrolls an anchor into view today.

`handleAddComment` (`PageCard.tsx:1142-1173`) creates a `ReviewComment` with an empty body and calls `.setCommentAnchor(...)` immediately, writing the anchor into the document before the user types anything, then sets `pendingFocusCommentId` so the rail auto-opens an editor for it.

`replyToComment` (`PageCard.tsx:1323-1359`) writes `parentCommentId: commentId` verbatim, so a reply parents to whichever row was clicked. The `r` shortcut in `CommentEditorList` passed the thread root instead, so the two entry points disagreed about what `re` means. The spec settles it: a submitted reply parents to the thread root, and `re` records thread membership rather than conversational nesting.

`acceptSuggestion` (`PageCard.tsx:1393-1413`) and `rejectSuggestion` (`PageCard.tsx:1415-1435`) apply the edit, call `removeSuggestionComments` (`PageCard.tsx:1361-1391`), and clear `selectedChangeId`/`hoveredChangeId` — they do not advance to another entry.

`shouldDismissCommentThread` (`PageCard.tsx:553`, used at `PageCard.tsx:1122`) decides whether a document click dismisses the open inline rail card.

`PageCard.tsx:348` declares `'ins[id^="rd-s"], del[id^="rd-s"], [data-rd-replace]'` as a local suggestion-anchor selector; phase 1 exports the canonical selectors from `document-comments.ts`.

`PageCard.tsx:1576,1580,1584,1589,1595` (rich-text surface) and `PageCard.tsx:1727,1731,1735,1742` (code surface) hold the duplicated `1100px`, `60rem`, `24rem` layout literals phase 2 replaced with tokens.

`interactionMode` is `DocumentInteractionMode = "viewing" | "suggesting" | "editing"` (`PageCard.tsx:62`), mirrored into `interactionModeRef` (`PageCard.tsx:576,636-637`); `PageCard.tsx:908` already sets the editor non-editable in viewing mode, and `PageCard.tsx:1639-1657` already withholds the comment and suggestion actions from the context menu in viewing mode.

The `layout="embedded-demo"` variant is used by `packages/app/src/RoughdraftFormatDemo.tsx:190-193` and must keep rendering the rail at its own 900px breakpoint.

### Tasks

1. Replace `selectedCommentId`, `hoveredCommentId`, `selectedChangeId` and `hoveredChangeId` with a single `currentEntryId: string | null` and a single `hoveredEntryId: string | null`, plus their refs. Delete `selectComment`, `selectSuggestion`, `focusComment` and `focusSuggestion` (`PageCard.tsx:1519-1566`) and replace them with one `setCurrentEntry(entryId)`. Exactly one entry is current at a time, and one variable is what makes that true rather than a rule two setters have to remember.
2. Feed the existing comment-highlight and suggestion-highlight ProseMirror plugins from the single `currentEntryId`/`hoveredEntryId`. The dispatch sites are `PageCard.tsx:1000-1019`, sending `commentHighlightPluginKey` and `suggestionHighlightPluginKey` meta. An entry id starting `rd-c` addresses the comment plugin and one starting `rd-s` the suggestion plugin; derive which from the current entry's `kind`, not from the id's prefix.
3. Compute the entry sequence with `buildReviewEntries(commentGroups, suggestions, comments)` from `packages/app/src/document-comments.ts`, memoized on those three inputs, and pass the result to both `DocumentReviewRail` and `ReviewEntryFooter`. Do not compute or reorder entries anywhere else in this file.
4. Maintain the invariant that a non-empty sequence always has a current entry: when `entries` is non-empty and `currentEntryId` is null or names an entry that is no longer present, set it to `entries[0].id`. When `entries` is empty, set it to null.
5. Implement `goToPreviousEntry` and `goToNextEntry` as index moves in `entries`, clamped at both ends — the sequence does not wrap. Both are inert while the thread dialog is open; navigation is unavailable then.
6. Implement the scroll rule. When an entry with an anchor becomes current, read its anchor element's `getBoundingClientRect()`, call `resolveAnchorScroll` from `document-comments.ts`, and scroll by the delta it returns, doing nothing when it returns null. When a `"document-comment"` entry becomes current, nothing scrolls. Making an entry current happens on exactly three actions: a navigation button, a chip click, and a click on the entry's anchor in the document — route all three through `setCurrentEntry` so the scroll rule cannot be reached from one path and skipped on another. Find the anchor element with the selectors phase 1 exports from `document-comments.ts`.
7. Delete the local anchor selector at `PageCard.tsx:348` and import `INSERTION_ANCHOR_SELECTOR`, `DELETION_ANCHOR_SELECTOR`, `REPLACEMENT_ANCHOR_SELECTOR` and `COMMENT_ANCHOR_SELECTOR` from `document-comments.ts`.
8. Change record creation so nothing is written to the document until a body is submitted. Rewrite `handleAddComment` (`PageCard.tsx:1142-1173`) to hold the pending range in state — `{ from, to, excerpt }` — and open the thread dialog on it, creating neither the `ReviewComment` nor the anchor mark. On the dialog's first submit with a non-empty body, allocate the id, create the record, and call `.setCommentAnchor(...)` for the held range in one step. An empty comment body is then unrepresentable, so add no cleanup path for one.
9. Route every reply through the thread root: the dialog's composer submits a body, and this file creates the record with `parentCommentId` set to the current entry's root id — the root comment id for a comment thread or document comment, the suggestion id for a suggestion. Delete the caller-supplied parent id from `replyToComment` (`PageCard.tsx:1323-1359`) so no call site can parent a reply anywhere else.
10. Implement `toggleResolved(rootCommentId, nextResolved)`: set or clear `status` and `resolved` on the root `ReviewComment` and emit the markdown change. Replying, editing and deleting must not touch either field — only this handler writes them.
11. Make accept and reject advance the sequence. After `acceptSuggestion` (`PageCard.tsx:1393-1413`) or `rejectSuggestion` (`PageCard.tsx:1415-1435`) applies, close the dialog, rebuild the entry sequence, and set the current entry from `resolveNextCurrentEntry(previousEntries, nextEntries, suggestionId)` in `document-comments.ts`. Neither action prompts for confirmation — do not add one.
12. Render `ReviewThreadDialog` from `packages/app/src/ReviewThreadDialog.tsx`, open on a `dialogEntryId` state separate from `currentEntryId`: a chip's pencil opens the dialog on that entry and also makes it current, but making an entry current does not open the dialog. Pass `comments` as the entry's members, resolved from `entry.commentIds`, ordered by `createdAt`. Pass `excerpt` as the anchored text for an anchored entry and null for a document comment.
13. Handle a reload from disk while the dialog is open: the dialog re-renders against the new comments because it holds no copy of them, and when the current entry's id is absent from the rebuilt sequence, clear `dialogEntryId` and pass a `closedReason` string saying the entry no longer exists in the document.
14. Delete the narrow-width `CommentEditorList` banner at `PageCard.tsx:1605-1629` and the `fallbackClass` computation at `PageCard.tsx:1587-1590`, and render `ReviewEntryFooter` from `packages/app/src/ReviewEntryFooter.tsx` instead. Add the document's bottom inset below the rail breakpoint as `padding-bottom: var(--review-footer-height)`, removed at and above the breakpoint, so the footer never covers document content.
15. Replace the layout literals at `PageCard.tsx:1576,1580,1584,1589,1595` and `PageCard.tsx:1727,1731,1735,1742` with the phase 2 tokens: the `rail:` variant in place of `min-[1100px]:`, `var(--document-measure)` in place of `60rem`, and `var(--review-rail-width)` in place of both `18rem` and `minmax(24rem,1fr)`. The rail column is a fixed `var(--review-rail-width)` track, not a flexible one — the header row and the document shell must resolve to the same width. Keep the `embedded-demo` branch of each class on its own 900px breakpoint and its own widths.
16. Do not render the rail in viewing mode, and centre the document at `var(--document-measure)` — the same layout a document with no review records gets. The rail and the footer are both shown in editing and suggesting mode; the dialog and creating/applying are available in both and unavailable in viewing.
17. Replace the `draftSuggestion` rail card wiring with `SuggestionComposerPopover` from `packages/app/src/SuggestionComposerPopover.tsx`, passing the selection's client rect as `anchorRect`. Keep `handleSuggestDeletion` (`PageCard.tsx:1175-1200`) applying immediately and opening nothing. Keep `applyDraftSuggestion` (`PageCard.tsx:1217-1281`) as the apply path.
18. Delete `shouldDismissCommentThread` (`PageCard.tsx:553`) and its click handler at `PageCard.tsx:1122`. Dismissal is the modal `Dialog`'s outside-click behavior now, and a second dismissal rule reading document clicks would fight it.
19. Read the remaining `PageCard` render body once more as though it were new code: the rail, footer, dialog and popover are all rendered from one place now, and any prop still being threaded to a component that no longer takes it, or any handler left with no caller, is deleted rather than left in place.

---

## ✅ Phase 10: Document Shell

**Status:** Complete  
**BlockedBy:** 2  
**Files:** packages/app/src/DocumentWorkspace.tsx  
**Recommended model/effort:** Sonnet, low — replacing duplicated literals with imports and tokens.

### Context this phase must not rediscover

`packages/app/src/DocumentWorkspace.tsx:175-178` declares four anchor selectors — `COMMENT_ANCHOR_SELECTOR = 'span[id^="rd-c"]'`, `INSERTION_ANCHOR_SELECTOR`, `DELETION_ANCHOR_SELECTOR`, `REPLACEMENT_ANCHOR_SELECTOR`. The first is a character-for-character duplicate of the declaration at `packages/app/src/document-comments.ts:59`. `docs/spec/review-interface.md` requires `COMMENT_ANCHOR_SELECTOR` to be declared once in `document-comments.ts` and imported wherever an anchor is matched. Phase 1 exports all four from there.

`DocumentWorkspace.tsx:1029` applies `review-layout-grid` to the document header row and `DocumentWorkspace.tsx:1034` hardcodes `max-w-[60rem]` on `review-layout-main`. Phase 2 replaced the values inside `.review-layout-grid` with the `--review-rail-width` and `--document-measure` tokens.

`DocumentWorkspace.tsx:593-611` already binds `Cmd`/`Ctrl`+`S` to a manual save; the spec's Save shortcut needs no work.

### Tasks

1. Delete the four selector declarations at `DocumentWorkspace.tsx:175-178` and import `COMMENT_ANCHOR_SELECTOR`, `INSERTION_ANCHOR_SELECTOR`, `DELETION_ANCHOR_SELECTOR` and `REPLACEMENT_ANCHOR_SELECTOR` from `packages/app/src/document-comments.ts`.
2. Replace `max-w-[60rem]` at `DocumentWorkspace.tsx:1034` with the `var(--document-measure)` token, so the header row's measure and the shell's measure are one value.
3. Leave the `documentHasComments` gating of `review-layout-grid--centered` (`DocumentWorkspace.tsx:490-501,1030-1031`) as it is. A document with no review records still centres at the measure, which is the same layout viewing mode gets.

---

## 🔄 Phase 11: Tests

**Status:** In Progress — new coverage written; awaiting a decision on 13 stale tests (see below)  
**BlockedBy:** 9  
**Files:** packages/app/test/document-comments.test.ts, packages/app/test/page-card.test.tsx, packages/app/test/review.test.ts, packages/app/e2e/anchor-review.spec.ts, scripts/check-test-selectors.mjs  
**Recommended model/effort:** Opus, high — deciding what survives the rewrite and what is deleted, and writing e2e flows against a modal dialog.

### Context this phase must not rediscover

`packages/app/test/document-comments.test.ts` covers the pure layout helpers — measurement conversion, grouping, `resolveCommentRailLayouts`, `buildCommentThreadRailItems`, and `resolveAnchoredRailLayouts` including the negative-offset clamp (`document-comments.test.ts:421-467`). Those helpers survive unchanged; those tests survive unchanged.

`packages/app/test/page-card.test.tsx:9,430-447` imports and exercises `shouldDismissCommentThread`, which phase 9 deletes.

`packages/app/e2e/anchor-review.spec.ts` drives the inline rail editors: `comment-rail-{id}-action-reply` → fill `comment-rail-{id}-editor` → click `comment-rail-{id}-action-save` (`anchor-review.spec.ts:51-68`), a new root comment through `selection-menu-action-comment` (`anchor-review.spec.ts:90-102`), the blocked-action tooltips (`anchor-review.spec.ts:109-296`), and one-click accept and reject (`anchor-review.spec.ts:298-342`). Every selector that reaches an editor or a save button is gone after phase 9.

`scripts/check-test-selectors.mjs` fails the build on any test selector that is not a `data-testid` or one of the explicitly allowlisted patterns (`check-test-selectors.mjs:28-47`).

`AGENTS.md` requires tests to be judged against Kent Beck's Test Desiderata, and `~/.claude/guides/design.md` limits the suite to three kinds: real algorithms with logic worth checking, invariants spanning several calls, and behavior with a known-correct corpus.

### Proposed tests

This table is the proposal the user reviews. Do not write a test that is not on it, and do not add a case per branch of any implementation.

| Test | Kind |
| --- | --- |
| `buildReviewEntries` puts every `scope: document` comment first in `createdAt` order, then anchored comment threads and suggestions interleaved by `anchorTop` | real algorithm |
| `buildReviewEntries` returns distinct ids, and a comment replying to a suggestion appears in that suggestion's entry and produces no entry of its own | real algorithm |
| `resolveNextCurrentEntry` returns the entry now at the removed index, the last entry when the removed one was last, and null when the sequence empties | real algorithm |
| `resolveAnchorScroll` returns null for a fully visible anchor and the upper-third delta for one above, below, or taller than the viewport | real algorithm |
| A resolve, then a reply, then a save preserves `status: resolved` and `resolved` on the thread root through the markdown round trip | invariant spanning several calls |
| e2e: a chip's pencil opens the dialog, a reply submitted with `Cmd`+`Enter` persists to disk parented to the thread root | known-correct corpus |
| e2e: accepting a suggestion from the dialog header applies it with no confirmation, closes the dialog, and makes the next entry current | known-correct corpus |
| e2e at a viewport below 1100px: the rail is absent, the footer shows the current entry, and next advances it | known-correct corpus |
### Deletions

| Test | Reason |
|---|---|
| `page-card.test.tsx:430-447` — the three `shouldDismissCommentThread` cases | The helper is deleted in phase 9; outside-click dismissal is the modal `Dialog`'s, and it is the library's behavior, not ours to pin. |
| `anchor-review.spec.ts:51-68,90-102` — the inline `comment-rail-{id}-editor` reply and new-comment flows | Rewritten against the dialog by the e2e rows above; the inline rail editor no longer exists. |
| `anchor-review.spec.ts:298-342` — the chip accept and reject cases | Rewritten to also assert the dialog closes and the next entry becomes current, which is the part the spec added. |
### Tasks

1. Before writing each test, check whether it will sit beside a same-shape sibling. Where two cases differ only in their input and expected value — the four `resolveAnchorScroll` positions, the three `resolveNextCurrentEntry` cases — write them as rows of one parameterized table, not as separate `it` blocks.
2. Add the `buildReviewEntries`, `resolveNextCurrentEntry` and `resolveAnchorScroll` cases to `packages/app/test/document-comments.test.ts`, derived from the contracts phase 1 wrote, not from reading the implementations. Leave the existing layout and grouping tests in that file untouched.
3. Add the resolve round-trip case to `packages/app/test/review.test.ts`, beside the existing `describe("editor state to review markdown")` block. It must assert the whole cycle: set resolved, serialize, reparse, add a reply, serialize again, and check both `status` and `resolved` are still on the root and untouched by the reply.
4. Delete the `shouldDismissCommentThread` import at `page-card.test.tsx:9` and its three cases at `page-card.test.tsx:430-447`.
5. Rewrite `packages/app/e2e/anchor-review.spec.ts`'s comment and suggestion flows against the new selectors: `review-entry-chip-{id}`, `review-entry-chip-{id}-action-open`, `review-thread-dialog`, `review-thread-dialog-composer`, `review-thread-dialog-action-submit`, `review-thread-dialog-action-accept`, `review-entry-nav-position`, `review-entry-nav-action-next`. Keep the blocked-action tooltip cases at `anchor-review.spec.ts:109-296` as they are — they exercise the selection guard, which this plan does not change.
6. Add the narrow-viewport e2e case with an explicit `page.setViewportSize` below 1100px, asserting `document-review-rail` is absent and `review-entry-footer` is present.
7. Run `pnpm test:selectors`. If it rejects a selector these tests need, add the pattern to `allowedSelectorPatterns` in `scripts/check-test-selectors.mjs` rather than working around it in the test — but prefer a `data-testid`, which needs no allowlist entry at all.

---

## ✅ Phase 12: Screenshot Guide

**Status:** Complete  
**BlockedBy:** 9  
**Files:** docs/spec/ui-state-screenshot-guide.md  
**Recommended model/effort:** Sonnet, low — editing a table of capture states to match what ships.

### Context this phase must not rediscover

`AGENTS.md` requires this guide to be updated when a change adds, removes, or materially changes a UI state worth capturing. `docs/spec/review-interface.md`'s "Scope" section points at this guide for capture states.

The guide's Capture Matrix currently lists rows whose states no longer exist after phase 9: "Review rail | Draft suggestion" with `draft-suggestion-thread` and `draft-suggestion-editor`, and "Comment editor | Root comment editing" / "Reply editing" with `comment-rail-root-editor` / `comment-rail-child-editor`. The "Review rail | Comments" and "| Suggestions" rows name `comment-thread-root` and `suggestion-thread-s1/s2/s3`, which the chips replace.

### Tasks

1. Replace the two "Review rail" rows and the two "Comment editor" rows with rows for the states that ship: rail chips (`document-review-rail`, `review-entry-chip-{id}`), the navigation control (`review-entry-nav`), the thread dialog on a comment thread and on a suggestion (`review-thread-dialog`, `review-thread-dialog-excerpt`, `review-thread-dialog-action-accept`), a resolved thread's muted chip, a document-comment chip pinned above the anchored chips, and the suggestion composer popover (`suggestion-composer`).
2. Add a row for the narrow-width footer (`review-entry-footer`) with the viewport below 1100px as the way to reach it, and update the "Document | Viewing mode" row to state that the rail is not rendered and the document is centred at its measure.
3. Add a document-scope comment to the Review Document fixture in the guide so a capture run can reach the document-comment chip. It is a root comment with `scope: document` and no anchor.
4. Leave the rest of the guide alone. The homepage, RFM guide, save-status, conflict, handoff and remote rows are untouched by this plan.

---

## ⏳ Phase 13: Gate

**Status:** Pending  
**BlockedBy:** 9, 10, 11, 12  
**Files:** —  
**Recommended model/effort:** Sonnet, low — running the project's checks and reporting exactly what they print.

### Tasks

1. Run `pnpm check` from the repo root. It runs `pnpm lint`, `pnpm test:selectors`, `pnpm unused`, `pnpm test` (rfm, app, server) and `pnpm build` in that order. Report the result verbatim.
2. Run `pnpm test:smoke` from the repo root. `AGENTS.md` requires it after UI, routing, editor, file-backend or workflow changes, and this plan is all of the first three; it is not covered by `pnpm check`.
3. Fix any lint, type, unused-export, test, smoke or build failure this surfaces. A `pnpm unused` failure most likely names an export the rewrite orphaned — delete it rather than re-export it.
4. Report SUCCESS only when both commands pass, and report which commands ran and what each proved. A passing suite proves the pieces integrate; it is not evidence that the interface is right, and must not be reported as though it were.

---

## ⏳ Phase 14: Manual UI Verification

**Status:** Pending  
**BlockedBy:** 13  
**Files:** —  
**Recommended model/effort:** Sonnet, low — driving the app and handing the user a checklist.

### Tasks

1. Derive the worktree CLI command and open a review fixture, per `AGENTS.md`:
  
  ```bash
  worktree_root="$(git rev-parse --show-toplevel)"
  worktree_name="$(basename "$worktree_root")"
  roughdraft_cmd="roughdraft-dev-$worktree_name"
  "$roughdraft_cmd" start
  "$roughdraft_cmd" open "$worktree_root/.context/ui-state-fixtures/review.md"
  ```
  
  Create the fixture from the Review Document in `docs/spec/ui-state-screenshot-guide.md` if it is not already there, and add a `scope: document` comment to it.
2. Ask the user to confirm each of these in the running app, and report which they confirmed and which they rejected:
  
  - At 1200px the rail shows one chip per entry, `N of M` at the top, and previous and next step through the sequence with document comments first.
  - Clicking a chip makes it current and scrolls its anchor to the upper third only when the anchor was not already fully visible.
  - The pencil opens a centred modal dialog showing the anchored excerpt complete and scrollable, with the thread flat and in time order.
  - A reply submitted with `Cmd`+`Enter` appears in the thread, and `Escape` closes the dialog.
  - Resolving mutes the chip and keeps its count; the thread still accepts a reply, and replying does not clear resolved.
  - A suggestion's dialog header accepts and rejects with one click, no confirmation, and the next entry becomes current.
  - Suggest insertion and Suggest replacement open a popover beside the selection with the text under change still visible; Suggest deletion applies immediately and opens nothing; nothing draft-related appears in the rail.
  - At 900px the rail is gone, the fixed footer shows the current entry with the same summary its chip had, previous and next work, and no document content is hidden behind the bar.
  - In viewing mode the rail is gone and the document is centred at its measure.
3. Fix anything the user rejects, then rerun `pnpm test:smoke` before reporting.
