# Roughdraft Agent Setup

You are setting yourself up to use Roughdraft, a local Markdown review tool.

Roughdraft lets you open one Markdown file from disk in a local browser editor so the user can read, edit, comment, and suggest changes. It is currently a single-file Markdown viewer/editor.

## Check Installation

Check whether Roughdraft is available:

```bash
roughdraft help
```

If Roughdraft is missing and the user has asked you to install it, install it with:

```bash
npm i -g roughdraft
```

If the user did not explicitly ask you to install software, ask before installing a global npm package.

## Update Your Persistent Instructions

Add Roughdraft guidance to the persistent instruction file this agent will actually load. Prefer global or user-level instructions, because Roughdraft is a cross-project workflow.

First inspect the user's existing setup. Do not create a new instruction file when an appropriate one already exists.

Common current locations:

```text
OpenAI Codex:        ${CODEX_HOME:-$HOME/.codex}/AGENTS.md
Claude Code:         $HOME/.claude/CLAUDE.md
Gemini CLI:          $HOME/.gemini/GEMINI.md
opencode:            ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/AGENTS.md
Cursor:              Cursor Settings > Rules for global user rules; project AGENTS.md or .cursor/rules/*
VS Code Copilot:     GitHub/VS Code settings for personal instructions; project .github/copilot-instructions.md, .github/instructions/*.instructions.md, or AGENTS.md
```

Check for existing files before editing:

```bash
find \
  "${CODEX_HOME:-$HOME/.codex}" \
  "$HOME/.claude" \
  "$HOME/.gemini" \
  "${XDG_CONFIG_HOME:-$HOME/.config}/opencode" \
  "$PWD" \
  -maxdepth 3 \
  \( -name "AGENTS.md" -o -name "CLAUDE.md" -o -name "GEMINI.md" -o -name "copilot-instructions.md" -o -name "*.instructions.md" \) \
  2>/dev/null
```

If one or more files exist, choose the one for the current agent and merge in any missing Roughdraft guidance. If the current agent cannot determine which file it loads, use its built-in memory or settings command when available, such as Claude Code's `/memory`.

If no persistent instruction file exists and the user has not specified a tool, create a portable canonical file at `${XDG_CONFIG_HOME:-$HOME/.config}/agents/AGENTS.md`, then connect vendor-specific global files to it. Do not overwrite existing files.

```bash
canonical_agents_file="${XDG_CONFIG_HOME:-$HOME/.config}/agents/AGENTS.md"
mkdir -p "$(dirname "$canonical_agents_file")"
touch "$canonical_agents_file"

mkdir -p "${CODEX_HOME:-$HOME/.codex}"
[ -e "${CODEX_HOME:-$HOME/.codex}/AGENTS.md" ] || [ -L "${CODEX_HOME:-$HOME/.codex}/AGENTS.md" ] || ln -s "$canonical_agents_file" "${CODEX_HOME:-$HOME/.codex}/AGENTS.md"

mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
[ -e "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/AGENTS.md" ] || [ -L "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/AGENTS.md" ] || ln -s "$canonical_agents_file" "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/AGENTS.md"

mkdir -p "$HOME/.gemini"
[ -e "$HOME/.gemini/GEMINI.md" ] || [ -L "$HOME/.gemini/GEMINI.md" ] || ln -s "$canonical_agents_file" "$HOME/.gemini/GEMINI.md"

mkdir -p "$HOME/.claude"
[ -e "$HOME/.claude/CLAUDE.md" ] || [ -L "$HOME/.claude/CLAUDE.md" ] || printf "@%s\n" "$canonical_agents_file" > "$HOME/.claude/CLAUDE.md"
```

Use imports or symlinks only when the target agent supports normal Markdown files at that path. For UI-only settings such as Cursor User Rules or GitHub Copilot personal instructions, tell the user what text to add rather than editing an unknown file.

The canonical Roughdraft instruction block is hosted at https://roughdraft.md/prompt.md. After you identify or create the right instruction file, prefer appending or merging that exact block:

```bash
agent_instructions_file="/absolute/path/to/AGENTS.md"
printf "\n\n" >> "$agent_instructions_file"
curl -fsSL https://roughdraft.md/prompt.md >> "$agent_instructions_file"
```

If the instruction file already has Roughdraft guidance, merge in any missing guidance from https://roughdraft.md/prompt.md instead of duplicating the section.

If you cannot use `curl`, add guidance like this:

````markdown
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
````

After updating your instructions, briefly tell the user which file you changed.

## Roughdraft Flavored Markdown Reference

Roughdraft uses inline HTML anchors and a final YAML endmatter block for comments and suggested changes, keeping all review state in the Markdown file.

For exact syntax, metadata, and round-trip behavior, read the official Roughdraft Flavored Markdown spec at https://roughdraft.md/spec/roughdraft-flavored-markdown.md. The review-index JSON Schema is available at https://roughdraft.md/spec/roughdraft-flavored-markdown.schema.json.

Anchor forms:

```text
Comment on a span: <span id="rd-c1">anchored text</span>
Comment on a point: <span id="rd-c1"></span>
Suggested insertion: <ins id="rd-s1">new text</ins>
Suggested deletion:  <del id="rd-s2">old text</del>
Suggested replacement: <span id="rd-s3"><del>old</del><ins>new</ins></span>
```

The anchor says what the edit does; the record it binds to carries who made it and when.

Example:

```markdown
<span id="rd-c1">selected text</span>

Add <ins id="rd-s1">new text</ins> here, remove <del id="rd-s2">this</del>, and
replace <span id="rd-s3"><del>old text</del><ins>new text</ins></span>.

---
roughdraft: "1.0"
comments:
  rd-c1:
    body: Please tighten this.
    by: user
    at: "2026-04-28T12:00:00.000Z"
  rd-c2:
    body: I can make that edit.
    by: AI
    at: "2026-04-28T12:05:00.000Z"
    re: rd-c1
  rd-c3:
    body: Use the customer example here.
    by: user
    at: "2026-04-28T12:13:00.000Z"
    re: rd-s1
suggestions:
  rd-s1:
    by: AI
    at: "2026-04-28T12:10:00.000Z"
  rd-s2:
    by: user
    at: "2026-04-28T12:11:00.000Z"
  rd-s3:
    by: AI
    at: "2026-04-28T12:12:00.000Z"
```

Endmatter is the final YAML block, identified by its `roughdraft` key. Each record carries:

```text
by  Author or agent label
at  ISO timestamp
re  Parent comment or suggestion id for replies
```

A comment record also carries `body`. A suggestion record does not: the anchor already says what the edit does.

An anchor inside a fenced code block or an inline code span is literal example text. Do not treat it as review feedback.

CriticMarkup spans such as `{==text==}` carry no meaning in this format. A document written that way has no review layer; convert it once with `roughdraft migrate <file>`.

Use `roughdraft help format` for local syntax examples.
