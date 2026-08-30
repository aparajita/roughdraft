## Roughdraft

Use Roughdraft when the user wants to review or comment on a Markdown file.

The user may refer to Roughdraft as `rd` in natural language. Treat `rd` as shorthand for Roughdraft in user requests, but do not create or modify any shell alias, executable, symlink, or command named `rd`.

When the user asks for a plan, write the plan as a Markdown file on disk before asking them to review it.

When you write or modify a Markdown file and want the user to review or comment on it, open it with:

```bash
roughdraft open "/absolute/path/to/file.md"
```

Roughdraft is currently a single-file Markdown viewer/editor. Open one `.md` file at a time.

If Roughdraft is not running, `roughdraft open` will start it automatically.

After `roughdraft open` opens the document, leave the command running. Do not interrupt, kill, background, detach, or treat the waiting process as cleanup. The wait is intentional: Roughdraft will exit the command after the user clicks Done Reviewing, and that exit is your signal to resume.

After the user finishes reviewing in Roughdraft, read the Markdown file from disk and respond to any comments or suggested changes.

Use Roughdraft Flavored Markdown's anchors and endmatter when reading or writing inline review feedback in Markdown. An anchor is an HTML element carrying an `id` in the body; the record it binds to lives in a final YAML endmatter block.

- Comment on a span: `<span id="rd-c1">anchored text</span>`
- Comment on a point, with no text of its own: `<span id="rd-c1"></span>`
- Suggested insertion: `<ins id="rd-s1">new text</ins>`
- Suggested deletion: `<del id="rd-s2">old text</del>`
- Suggested replacement: `<span id="rd-s3"><del>old</del><ins>new</ins></span>`

A comment anchor is inline content within a single block; a range crossing a block boundary is not expressible in this format.

To allocate an id, take the highest number carried by any id of the same kind — counting both body anchors and endmatter keys — and add one. Set `by` to your agent or author label, set `at` to the current ISO timestamp, and set `re` when replying to an existing comment or suggestion.

CriticMarkup spans such as `{==text==}` carry no meaning in this format. A document written that way has no review layer; convert it once with `roughdraft migrate <file>` rather than parsing it.

Example:

```markdown
<span id="rd-c1">selected text</span>

Add <ins id="rd-s1">new text</ins> here.

---
roughdraft: "1.0"
comments:
  rd-c1:
    body: Comment text
    by: AI
    at: "2026-04-28T12:00:00.000Z"
  rd-c2:
    body: I can make that edit.
    by: AI
    at: "2026-04-28T12:05:00.000Z"
    re: rd-c1
suggestions:
  rd-s1:
    by: AI
    at: "2026-04-28T12:10:00.000Z"
```

Use `roughdraft help` and `roughdraft help format` for local command and syntax details.
