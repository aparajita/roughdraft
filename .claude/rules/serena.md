MANDATORY: Use `serena` `jet_brains_*` tools for all TypeScript exploration and refactoring. `rg`, `grep`, `Read` and `Glob` are the fallbacks — reach for them only when a `jet_brains_*` tool returns no results, the file is not TypeScript, or the IDE connection is unavailable.

Whenever you are about to determine the set of places a symbol is used — method, field, or class — start with `jet_brains_find_referencing_symbols`.

Use `Edit` for code changes so the user sees a diff. Do not use `replace_symbol_body`, `insert_after_symbol` or `insert_before_symbol`. To get exact text for an `Edit`, read it with `find_symbol` and `include_body=true`.

Use `replace_content` only when `Edit`'s literal `replace_all` cannot express the change: a regex match, or a long wildcard span you do not want to type out in full. For an exact-string change, even one repeated across a file, use `Edit` with `replace_all`.

Use `replace_in_files` in place of a `sed` or Python call for a bulk find-and-replace across many files, or many places in one file. Run it with `dry_run: true` first and check the diff before you apply it.

Always pass `rename_in_comments: false` to `jet_brains_rename`. A symbol named in a comment via `{@link}`, `{@code}` or backticks renames on its own; the option is a repo-wide textual sweep that damages unrelated prose.

**It does not protect Markdown.** A rename still rewrites the old name in `plans/`, `docs/` and `specs/`, which silently destroys a sentence that names both the old and the new name — a plan or decision record states what was found and decided, so rewriting the name there turns it into a tautology rather than updating it. After every rename, read the prose diff (`git status --porcelain | grep -v '\.java$'`) and restore what records history; a spec or register row naming a type that must exist today is the only kind that should keep the new name.

For name-path syntax, per-tool parameters, the constructor-body workaround, and the refactoring tool catalog: [Serena Reference](../guides/serena-reference.md).
