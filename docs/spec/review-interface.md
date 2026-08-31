# Roughdraft Review Interface

Status: Draft

This specification defines how Roughdraft presents the review layer of a Roughdraft Flavored Markdown document: the rail, the thread dialog, thread navigation, and the ownership rules that keep the on-screen review state and the file in agreement.

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" are to be interpreted as described in RFC 2119.

## Scope

This specification governs presentation and editing of comments and suggestions. The storage format is defined by [Roughdraft Flavored Markdown 1.0](./roughdraft-flavored-markdown.md); nothing here changes it. Capture states for visual review are listed in the [UI state screenshot guide](./ui-state-screenshot-guide.md).

## Entries

An **entry** is one navigable, one-chip unit of review:

- a **comment thread**: a root comment carrying a body anchor, plus every comment reachable from it through `re`;
- a **suggestion**: one `rd-s*` record and its anchor, plus every comment reachable from it through `re`;
- a **document comment**: a root comment with `scope: document` and no anchor, plus its replies.

Entries form one ordered sequence. Document comments come first, in `at` order. Anchored entries follow, comments and suggestions interleaved, ordered by the vertical position of their anchors in the rendered document.

The sequence MUST be produced by a pure helper in `document-comments.ts` and computed by `PageCard`. It MUST NOT be computed inside `DocumentReviewRail`, which does not mount below 1100px.

## Rail

At 1100px and above, entries are shown in a rail beside the document. The rail is `12rem` wide, declared once and read by both the document header row and the document shell.

The rail is not rendered in viewing mode. In viewing mode the document is centred at its `60rem` measure, as it is when a document has no review records.

### Navigation control

A control at the top of the rail shows the current position as `N of M` with previous and next buttons. It is present whenever the sequence is non-empty.

### Chips

One chip per entry, one line high. Each chip is positioned against its anchor and participates in the existing anchored stacking layout, which pins the current entry's chip at its anchor top and displaces its neighbours to avoid collisions. A document comment's chip is pinned above every anchored chip and does not participate in stacking.

A comment thread's chip carries the total number of comments in the thread, counting the root, and a pencil that opens the dialog. The count is not split by author.

A suggestion's chip carries the operation — Insert, Delete or Replace — the number of comments on it if any, a pencil, a green check that accepts, and a red cross that rejects.

A resolved thread's chip renders muted and keeps its count.

The chip body is the click target for making the entry current.

## Footer

Below 1100px the rail is not rendered. A fixed footer bar shows the current entry and MUST provide:

- the entry's summary, in the same terms as its chip;
- a pencil that opens the dialog;
- for a suggestion, the green check and red cross;
- previous and next buttons.

The footer sits above document content and below the editor context menu and link popover. The document's bottom inset MUST clear it.

There is no inline comment banner above the document at narrow widths, and `CommentEditorList` has no rail-versus-banner variant.

## Making an entry current

Exactly one entry is current at a time. Any of these makes an entry current: pressing a navigation button, clicking a chip, clicking the entry's anchor in the document.

When an anchored entry becomes current, its anchor is scrolled to the upper third of the viewport if it is not already fully visible, and is not scrolled otherwise. When a document comment becomes current, nothing scrolls.

## Thread dialog

The dialog is a modal `Dialog`: focus is trapped, page scroll is locked, pointer interaction outside is disabled, the backdrop is drawn, and an outside click dismisses. It is centred, `48rem` wide, and its height is the viewport less `2rem` at top and bottom.

Navigation is unavailable while the dialog is open.

### Header

The header shows the anchored text the entry is about, in a fixed-height scrollable box that shows the excerpt complete and untruncated. A document comment's dialog has no excerpt.

A suggestion's header also carries the green check and red cross. Accepting or rejecting applies the change, closes the dialog, and makes the next entry in the sequence current. Neither action prompts for confirmation.

### Thread

Every comment in the entry renders as a sibling in a flat list ordered by `at`, regardless of `re` nesting depth. There is no indentation, no tree, and no reply-parent reference line.

Each row shows:

- the author avatar — the `Bot` icon for `authorType: "ai"`, the `User` icon otherwise;
- the author label: `AI`, the author id, or `Me`;
- the time, phrased relative to now with `Intl.RelativeTimeFormat`, carrying the absolute local time from `Intl.DateTimeFormat` in its `title`;
- the body, rendered as Markdown through `renderMarkdownToHtml`;
- an overflow menu holding Edit and Delete, and on the root row Delete thread.

Editing a comment replaces its body in place and leaves `at` unchanged.

### Composer

One composer at the foot of the dialog. It is a plain textarea; `Cmd`/`Ctrl`+`Enter` submits, `Escape` closes the dialog.

A submitted reply parents to the thread root. `re` therefore records thread membership, not conversational nesting. A reply to a suggestion parents to the suggestion.

### Resolve

A resolve control sits beside the composer, on comment threads only. It writes `status: resolved` and `resolved` on the thread root.

A resolved thread remains fully editable: it accepts replies, edits and deletes, and replying does not clear the resolved status. Only the resolve control changes it.

A suggestion record's `status: resolved` is preserved on round trip and carries no meaning in this interface.

### External changes

When the document is reloaded from disk while the dialog is open, the dialog re-renders against the new state and newly arrived comments appear in place. If the current entry no longer exists, the dialog closes and reports why.

## Suggestion composer

Suggest insertion and Suggest replacement open a composer in a popover anchored to the selection, so the text under change stays visible beside it. `Cmd`/`Ctrl`+`Enter` applies. Suggest deletion applies immediately and opens nothing.

There is no draft-suggestion entry in the rail.

## Review state ownership

The review layer is owned by a ProseMirror plugin: every comment record, anchored and document-scoped, together with the document's frontmatter and its preserved endmatter block.

Every mutation of that state MUST be carried on a ProseMirror transaction, so that it participates in the editor's history. Serializing a document to Markdown MUST be a pure function of editor state.

It follows that undo and redo restore records and anchors together. An undo MUST NOT be able to produce a document whose body carries an anchor with no matching record.

## Creating records

A comment record and its anchor mark are created only when a non-empty body is saved. Clicking Comment on a selection holds the pending range in state and opens the dialog; nothing is written to the document until the body is submitted. A reply record is created the same way.

An empty comment body is therefore unrepresentable, and no exit path needs to clean one up.

## Serialization invariants

The writer drops a record whose anchor is absent from the body, and strips an anchor whose record is absent from the review state. Both are reported through the review diagnostic channel.

`COMMENT_ANCHOR_SELECTOR` is declared once, in `document-comments.ts`, and imported wherever an anchor is matched.

## Keyboard

| Keys | Action |
| --- | --- |
| `Cmd`/`Ctrl`+`Opt`/`Alt`+`M` | Comment on the selection |
| `Cmd`/`Ctrl`+`Enter` | Submit the composer |
| `Escape` | Close the dialog |
| `Cmd`/`Ctrl`+`S` | Save |

There is no reply shortcut and no keyboard thread navigation.

## Modes

| Mode | Rail | Dialog | Creating and applying |
| --- | --- | --- | --- |
| Editing | Shown | Available | Available |
| Suggesting | Shown | Available | Available |
| Viewing | Not rendered | Not available | Unavailable |
