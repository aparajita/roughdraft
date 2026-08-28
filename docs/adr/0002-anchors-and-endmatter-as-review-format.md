# 0002: HTML Anchors And YAML Endmatter As Review Format

## Context

Review feedback must remain portable in the Markdown file and readable outside the app.

## Decision

Roughdraft stores review feedback as Roughdraft Flavored Markdown, specified in `docs/spec/roughdraft-flavored-markdown.md`. A review record is anchored to the body by an HTML element carrying an `id` — `<span>`, `<div>`, `<ins>`, or `<del>` — and every comment, reply, and suggestion record lives in a final YAML endmatter block identified by its `roughdraft` key. Suggested text stays visible inline, so the raw file reads as a redline without consulting the endmatter. The app may render richer controls, but the saved representation is Markdown plus anchors plus endmatter.

Roughdraft neither reads nor writes CriticMarkup. A document that encodes review feedback as CriticMarkup is converted by a one-off migration run against the file, so the parser carries no second syntax and the app has no legacy write path.

## Consequences

Agents can leave review feedback without depending on Roughdraft-specific sidecar files. Anchors are ordinary HTML, so any CommonMark parser reads them, and an anchor inside an inline code span or fenced code block is literal text under ordinary Markdown rules rather than by a carve-out the parser has to implement.

Parser and editor changes must preserve anchor elements, their ids, and their other attributes, and must preserve endmatter keys the implementation does not recognize. Comment bodies are YAML block scalars, so a body carries fenced code, blank lines, and any delimiter sequence without escaping and must never be rejected or transformed on the basis of its content.

## What This Explicitly Does Not Mean

The endmatter is not a hidden product database, chat transcript format, or replacement for normal Markdown content. Anchors are not a general-purpose HTML extension point: the format defines `id` on four elements, and nothing else in a document acquires meaning by being HTML.
