# Roughdraft Flavored Markdown 1.0

Status: Draft

Roughdraft Flavored Markdown is CommonMark with GitHub Flavored Markdown extensions, plus a review layer. The review layer is two things: **anchors**, which are ordinary HTML elements carrying an `id`, and **endmatter**, a final YAML block holding every comment, reply, and suggestion record in the document.

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" are to be interpreted as described in RFC 2119.

## Scope

This specification defines the review layer that Roughdraft reads and writes. It does not define a replacement for Markdown, a hosted document format, a sync protocol, or a project database.

A conforming document is a Markdown document that MAY contain anchors in its body and MAY carry endmatter. Implementations MUST preserve YAML frontmatter as document metadata.

## Document Structure

A document has up to three parts, in order:

1. Optional YAML frontmatter, delimited by `---` lines at the very start of the file.
2. The body: ordinary Markdown, which MAY contain anchors.
3. Optional endmatter: the review records.

## Endmatter

Endmatter is the final `---`-delimited YAML block in the file whose parsed mapping contains a top-level `roughdraft` key. A document containing no such block has no review layer.

```markdown
Ship guest checkout in the beta.

---
roughdraft: "1.0"
comments:
  rd-c1:
    body: Confirm this excludes SSO-only workspaces.
    by: AI
    at: "2026-08-28T12:00:00.000Z"
```

The `roughdraft` key holds the specification version the document conforms to. Its presence is what identifies the block, so implementations MUST NOT apply heuristics to decide whether a trailing YAML block is endmatter. A trailing block without the key is document content and MUST be preserved as written.

Endmatter MUST be the last content in the file and MUST be preceded by a blank line. Its recognized top-level keys are `roughdraft`, `comments`, and `suggestions`. Implementations MUST preserve unrecognized top-level keys and unrecognized keys within a record.

## Anchors

An anchor binds a review record to a location in the body. It is an HTML element whose `id` matches an endmatter record.

```ebnf
id = "rd-" ( "c" / "s" ) 1*DIGIT
```

| Form | Binds |
| --- | --- |
| `<span id="rd-c1">anchored text</span>` | a comment to an inline span of text |
| `<span id="rd-c1"></span>` | a comment to a point, with no text of its own |
| `<ins id="rd-s1">new text</ins>` | a suggested insertion |
| `<del id="rd-s2">old text</del>` | a suggested deletion |
| `<span id="rd-s3"><del>old</del><ins>new</ins></span>` | a suggested replacement |

The `id` always sits on the outermost element of the anchor. A replacement wraps its `<del>` and `<ins>` in a `<span>` because an `id` MUST be unique within the document.

A comment anchor is inline content, so the text it covers MUST lie within a single block. A range spanning a block boundary is not expressible in this format, and implementations MUST NOT write one.

An id MUST appear at most once as an anchor. Anchors MAY nest. Anchors MUST NOT partially overlap, since no HTML element structure can express that. A writer offered a range that partially overlaps an existing anchor MUST refuse it rather than widen either anchor.

A writer MUST NOT issue an id that is in use in the document it is about to write, or that it has issued since it last read one. Scanning the document immediately before writing satisfies this; so does counting up from the highest number seen — counting both endmatter record keys and anchors in the body, since records with no anchor, such as replies and document-scope comments, only appear in the endmatter — which additionally never reissues the id of a record that has since been removed. A writer MAY reuse a freed id but is not required to. Two writers holding the same document at the same time can still allocate the same id; reconciling that is outside this specification.

Implementations MUST preserve anchor elements and their `id` attributes across a read/write cycle, and MUST preserve any other attributes present on them.

An anchor's content is the text its record covers, so implementations MUST preserve it exactly as written, including whitespace at its edges. A Markdown serializer that lifts whitespace out of an inline element changes what the record covers; an implementation MUST NOT let it do so to an anchor.

Anchors inside inline code spans and fenced code blocks are literal text under ordinary CommonMark rules. Implementations need no special handling for them and MUST NOT treat them as review markup.

## Comments

A comment is a record under `comments`, keyed by its id.

```markdown
Ship <span id="rd-c1">guest checkout</span> in the beta.

---
roughdraft: "1.0"
comments:
  rd-c1:
    body: |
      Confirm this excludes SSO-only workspaces. The check is:

      ```ts
      if (workspace.ssoOnly) return
      ```
    by: AI
    at: "2026-08-28T12:00:00.000Z"
```

| Key | Required | Meaning |
| --- | --- | --- |
| `body` | Yes | Comment text, as Markdown. |
| `by` | Yes | Author or agent label. `AI` identifies an agent author. |
| `at` | Yes | ISO 8601 timestamp. |
| `re` | No | Id of the comment or suggestion this replies to. |
| `scope` | No | `document` for a comment about the document as a whole. |
| `status` | No | `resolved` when the item has been addressed. |
| `resolved` | No | Short resolution summary. |

`body` is Markdown of any length and structure. A YAML block scalar carries fenced code, blank lines, lists, and every delimiter sequence without escaping, so implementations MUST NOT reject or transform a comment body on the basis of its content.

A comment with `scope: document` has no anchor.

## Threads

A reply carries `re` naming its parent, and has no anchor of its own.

```markdown
Ship <span id="rd-c1">guest checkout</span> in the beta.

---
roughdraft: "1.0"
comments:
  rd-c1:
    body: Confirm this excludes SSO-only workspaces.
    by: user
    at: "2026-08-28T12:00:00.000Z"
  rd-c2:
    body: Confirmed. SSO-only workspaces are out of the beta.
    by: AI
    at: "2026-08-28T12:05:00.000Z"
    re: rd-c1
```

`re` MAY name a suggestion, which attaches discussion to that suggested edit. A record MUST NOT be its own parent. A reply whose `re` names a record that is not present is treated as a top-level comment.

## Suggestions

A suggestion is a pending edit. Its text is inline, so a reader of the raw file sees what the edit proposes without consulting endmatter. Its record under `suggestions` carries only attribution and state.

```markdown
Add <ins id="rd-s1">one concrete example</ins> here.

Remove <del id="rd-s2">this vague phrasing</del>.

Use <span id="rd-s3"><del>rough</del><ins>specific</ins></span> wording.

---
roughdraft: "1.0"
suggestions:
  rd-s1:
    by: AI
    at: "2026-08-28T12:05:00.000Z"
  rd-s2:
    by: user
    at: "2026-08-28T12:06:00.000Z"
  rd-s3:
    by: AI
    at: "2026-08-28T12:07:00.000Z"
```

| Key | Required | Meaning |
| --- | --- | --- |
| `by` | Yes | Author or agent label. |
| `at` | Yes | ISO 8601 timestamp. |
| `status` | No | `resolved` when the suggestion has been accepted or rejected. |
| `resolved` | No | Short resolution summary. |

The operation is read from the anchor, not from the record: `<ins>` inserts, `<del>` deletes, and a `<span>` wrapping both replaces. Implementations MUST NOT record the operation in endmatter, so that the markup remains the single source of truth for what the edit does.

Accepting a suggestion replaces the anchor with the text the edit produces and removes its record. Rejecting one replaces the anchor with the text the document had before and removes its record. Implementations MUST NOT collapse a suggestion into prose by any other route.

## Orphans

A record is retained on write when any of the following holds:

- An anchor with its id is present in the body.
- It has `scope: document`.
- Its `re` names a retained record.

Retention is resolved transitively, so dropping a record drops its replies. Implementations MUST drop records that are not retained. A comment whose anchored text is deleted in a plain text editor therefore leaves nothing behind.

## CriticMarkup

CriticMarkup spans — `{==anchor==}`, `{>>comment<<}`, `{++insertion++}`, `{--deletion--}`, `{~~old~>new~~}` — carry no meaning in this format. Implementations MUST NOT parse them as review markup and MUST NOT write them. A document whose review layer is written as CriticMarkup has no review layer under this specification, and its spans are ordinary text.

Converting such a document is a one-off migration, run deliberately against a file. It is not part of reading, so no implementation carries a second parser to do it.

## Round Trips

A read/write cycle that makes no review change MUST preserve:

- YAML frontmatter delimiters and content.
- Endmatter keys, including unrecognized ones, and record keys, including unrecognized ones.
- Anchor elements, their ids, and their other attributes.
- Anchor content exactly as written, including whitespace at its edges.
- Local links and image paths.
- Tables and task lists.
- Inline code and fenced code blocks, including anchors appearing inside them.
- A trailing YAML block that is not endmatter.

## Review Interchange JSON

The Markdown file is the normative storage format. For APIs, tests, and integrations, implementations MAY expose a review index following [`roughdraft-flavored-markdown.schema.json`](./roughdraft-flavored-markdown.schema.json). The index annotates review records with the resolved location of their anchors; it does not replace a Markdown AST.

```json
{
  "format": "roughdraft-flavored-markdown",
  "version": "1.0",
  "comments": [
    {
      "id": "rd-c1",
      "body": "Confirm this excludes SSO-only workspaces.",
      "by": "AI",
      "at": "2026-08-28T12:00:00.000Z",
      "anchor": { "kind": "span", "text": "guest checkout" }
    }
  ],
  "suggestions": []
}
```

Conformance fixtures live in [`fixtures/`](./fixtures/). A parser claiming Roughdraft Flavored Markdown 1.0 support SHOULD pass them or document its intentional differences.
