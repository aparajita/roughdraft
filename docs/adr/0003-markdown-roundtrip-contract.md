# 0003: Markdown Round-Trip Contract

## Context

Roughdraft renders Markdown through rich text and code editing surfaces. Accidental rewrites make reviews noisy and can damage documents.

## Decision

Roughdraft should preserve user-authored Markdown unless an edit requires a minimal, understandable serialization change. Frontmatter, local links, image paths, tables, task lists, code fences, inline code, and raw supported HTML blocks need explicit tests.

The review layer is part of the same contract. A read/write cycle that makes no review change preserves anchor elements, their ids, and their other attributes; endmatter keys and record keys, including ones the implementation does not recognize; anchors appearing inside code spans and fenced code blocks, as literal text; and a trailing YAML block that is not endmatter, as document content.

## Consequences

Round-trip tests are part of the product contract. New Markdown support should add fixture coverage before broad parser refactors.

The rich text surface serializes through Turndown, which drops elements it has no rule for and rewrites `<del>` as strikethrough. Every anchor element needs an explicit serialization rule, and a document carrying each anchor form belongs in the round-trip fixtures.

## What This Explicitly Does Not Mean

Roughdraft does not promise to preserve every byte of unsupported Markdown syntax, and it should not normalize documents just to make implementation easier.
