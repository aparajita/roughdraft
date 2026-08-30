import {
  type CommentId,
  parseCommentId,
  parseSuggestionId,
  type SuggestionId,
} from "./ids.js";
import type { LiteralSpanIndex, OffsetRange } from "./literal-spans.js";
import {
  createDiagnostic,
  createLineStarts,
  locationForOffset,
  type RfmDiagnostic,
  skipHtmlWhitespace,
} from "./scanner.js";

/**
 * Anchors: the elements in the body that bind a review record to a location.
 *
 * An anchor is a `<span>`, `<ins>` or `<del>` whose `id` is a record id. Every
 * anchor is inline content within one block. What an anchor means is decided
 * by its element and its id kind together, so the union below makes the
 * impossible combinations unrepresentable: a comment cannot carry an insert,
 * and a replacement cannot be missing either half of its text.
 *
 * Offsets, lines and columns are relative to the body passed to
 * {@link scanAnchors}, never to the document the body was taken from.
 */

/** Every attribute on the anchor element, in source order, including `id`. */
export type AnchorAttributes = ReadonlyMap<string, string>;

interface AnchorLocation {
  attributes: AnchorAttributes;
  offset: number;
  endOffset: number;
  line: number;
  column: number;
}

export type CommentAnchor =
  | ({
      kind: "span";
      id: CommentId;
      /** The anchored text with markup removed. */
      text: string;
      /** The anchored content as it appears in the body. */
      markdown: string;
    } & AnchorLocation)
  | ({
      kind: "point";
      id: CommentId;
    } & AnchorLocation);

export type SuggestionAnchor =
  | ({ kind: "insert"; id: SuggestionId; text: string } & AnchorLocation)
  | ({ kind: "delete"; id: SuggestionId; text: string } & AnchorLocation)
  | ({
      kind: "replace";
      id: SuggestionId;
      oldText: string;
      newText: string;
    } & AnchorLocation);

export type Anchor = CommentAnchor | SuggestionAnchor;

export const anchorDuplicateIdCode = "rfm-anchor-duplicate-id";
export const anchorPartialOverlapCode = "rfm-anchor-partial-overlap";
export const anchorUnclosedCode = "rfm-anchor-unclosed";
export const anchorMalformedReplacementCode =
  "rfm-anchor-malformed-replacement";
export const anchorCrossesBlockCode = "rfm-anchor-crosses-block";

type AnchorElementName = "span" | "ins" | "del";

const anchorElementNames = new Set<string>(["span", "ins", "del"]);

interface OpeningTag {
  name: AnchorElementName;
  attributes: Map<string, string>;
  selfClosing: boolean;
  /** The offset just past `>`, where the element's content begins. */
  end: number;
}

interface ClosingTag {
  /** The offset of `<`, where the element's content ends. */
  start: number;
  /** The offset just past `>`. */
  end: number;
}

export interface ScanAnchorsResult {
  anchors: Anchor[];
  diagnostics: RfmDiagnostic[];
}

/**
 * Every anchor in `body`, with the problems found while reading them.
 *
 * Anchors inside code blocks and inline code spans are literal text and are not
 * returned; `literals` is the one authority on where that text is. Anchors may
 * nest, so the scan continues through an anchor's content. An element whose
 * `id` is not a record id is ordinary HTML.
 *
 * `literals` must have been built from `body` itself, since every offset it
 * answers about is relative to the text it was built from.
 *
 * The diagnostics describe file input a person can produce by hand-editing a
 * document; they are not assertions about callers inside this package.
 */
export function scanAnchors(
  body: string,
  literals: LiteralSpanIndex,
): ScanAnchorsResult {
  const lineStarts = createLineStarts(body);
  const anchors: Anchor[] = [];
  const diagnostics: RfmDiagnostic[] = [];

  const addDiagnostic = (code: string, message: string, offset: number) => {
    diagnostics.push(
      createDiagnostic(lineStarts, "error", code, message, offset),
    );
  };

  let offset = 0;

  while (offset < body.length) {
    if (literals.isLiteral(offset)) {
      offset += 1;
      continue;
    }

    const tag = matchOpeningTag(body, offset);
    if (!tag) {
      offset += 1;
      continue;
    }

    const anchor = readAnchor(body, offset, tag, lineStarts, addDiagnostic);
    if (anchor) anchors.push(anchor);

    // Continue inside the element so that nested anchors are found.
    offset = tag.end;
  }

  reportBlockCrossings(anchors, literals, lineStarts, diagnostics);
  reportDuplicateIds(anchors, lineStarts, diagnostics);
  reportPartialOverlaps(anchors, lineStarts, diagnostics);
  diagnostics.sort((left, right) => left.offset - right.offset);

  return { anchors, diagnostics };
}

function readAnchor(
  body: string,
  offset: number,
  tag: OpeningTag,
  lineStarts: readonly number[],
  addDiagnostic: (code: string, message: string, offset: number) => void,
): Anchor | null {
  const rawId = readIdAttribute(tag.attributes);
  if (rawId === null) return null;

  const commentId = parseCommentId(rawId);
  const suggestionId = parseSuggestionId(rawId);
  if (!commentId && !suggestionId) return null;
  if (tag.selfClosing) return null;

  const closing = findClosingTag(body, tag.end, tag.name);
  if (!closing) {
    addDiagnostic(
      anchorUnclosedCode,
      `Anchor \`${rawId}\` has no closing \`</${tag.name}>\`.`,
      offset,
    );
    return null;
  }

  const content = body.slice(tag.end, closing.start);
  const location = {
    attributes: tag.attributes,
    offset,
    endOffset: closing.end,
    ...locationForOffset(lineStarts, offset),
  };

  if (commentId) {
    if (tag.name !== "span") return null;

    return content.length === 0
      ? { kind: "point", id: commentId, ...location }
      : {
          kind: "span",
          id: commentId,
          text: stripMarkup(content),
          markdown: content,
          ...location,
        };
  }

  if (!suggestionId) return null;

  if (tag.name === "ins") {
    return { kind: "insert", id: suggestionId, text: content, ...location };
  }

  if (tag.name === "del") {
    return { kind: "delete", id: suggestionId, text: content, ...location };
  }

  const replacement = readReplacementContent(content);
  if (!replacement) {
    addDiagnostic(
      anchorMalformedReplacementCode,
      `Replacement anchor \`${rawId}\` must contain exactly one \`<del>\` followed by one \`<ins>\`.`,
      offset,
    );
    return null;
  }

  return {
    kind: "replace",
    id: suggestionId,
    oldText: replacement.oldText,
    newText: replacement.newText,
    ...location,
  };
}

function readIdAttribute(
  attributes: ReadonlyMap<string, string>,
): string | null {
  for (const [name, value] of attributes) {
    if (name.toLowerCase() === "id") return value;
  }
  return null;
}

/** The `<del>…</del><ins>…</ins>` pair a replacement anchor wraps, or null. */
function readReplacementContent(
  content: string,
): { oldText: string; newText: string } | null {
  let cursor = skipHtmlWhitespace(content, 0);

  const deletion = readSimpleElement(content, cursor, "del");
  if (!deletion) return null;
  cursor = skipHtmlWhitespace(content, deletion.endOffset);

  const insertion = readSimpleElement(content, cursor, "ins");
  if (!insertion) return null;
  cursor = skipHtmlWhitespace(content, insertion.endOffset);

  if (cursor !== content.length) return null;

  return { oldText: deletion.content, newText: insertion.content };
}

function readSimpleElement(
  text: string,
  offset: number,
  name: AnchorElementName,
): { content: string; endOffset: number } | null {
  const tag = matchOpeningTag(text, offset);
  if (!tag || tag.name !== name || tag.selfClosing) return null;

  const closing = findClosingTag(text, tag.end, name);
  if (!closing) return null;

  return {
    content: text.slice(tag.end, closing.start),
    endOffset: closing.end,
  };
}

/**
 * The opening tag of a `<span>`, `<ins>` or `<del>` beginning at `offset`, or
 * null when no such tag begins there.
 */
function matchOpeningTag(text: string, offset: number): OpeningTag | null {
  if (text[offset] !== "<") return null;

  let cursor = offset + 1;
  const nameStart = cursor;
  while (cursor < text.length && /[A-Za-z]/.test(text[cursor] ?? "")) {
    cursor += 1;
  }

  const name = text.slice(nameStart, cursor).toLowerCase();
  if (!anchorElementNames.has(name)) return null;

  const attributes = new Map<string, string>();
  let selfClosing = false;

  while (cursor < text.length) {
    const afterWhitespace = skipHtmlWhitespace(text, cursor);
    const character = text[afterWhitespace];

    if (character === ">") {
      return {
        name: name as AnchorElementName,
        attributes,
        selfClosing,
        end: afterWhitespace + 1,
      };
    }

    if (character === "/") {
      selfClosing = true;
      cursor = afterWhitespace + 1;
      continue;
    }

    if (character === undefined) return null;
    // An attribute must be separated from what precedes it by whitespace.
    if (afterWhitespace === cursor) return null;

    const attribute = matchAttribute(text, afterWhitespace);
    if (!attribute) return null;

    attributes.set(attribute.name, attribute.value);
    cursor = attribute.endOffset;
  }

  return null;
}

const attributeNameCharacters = /[^\s"'>/=]/;

function matchAttribute(
  text: string,
  offset: number,
): { name: string; value: string; endOffset: number } | null {
  let cursor = offset;
  while (
    cursor < text.length &&
    attributeNameCharacters.test(text[cursor] ?? "")
  ) {
    cursor += 1;
  }

  const name = text.slice(offset, cursor);
  if (!name) return null;

  const afterName = skipHtmlWhitespace(text, cursor);
  if (text[afterName] !== "=") {
    return { name, value: "", endOffset: cursor };
  }

  const valueStart = skipHtmlWhitespace(text, afterName + 1);
  const quote = text[valueStart];

  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, valueStart + 1);
    if (close === -1) return null;
    return {
      name,
      value: text.slice(valueStart + 1, close),
      endOffset: close + 1,
    };
  }

  let valueEnd = valueStart;
  while (
    valueEnd < text.length &&
    attributeNameCharacters.test(text[valueEnd] ?? "")
  ) {
    valueEnd += 1;
  }
  if (valueEnd === valueStart) return null;

  return {
    name,
    value: text.slice(valueStart, valueEnd),
    endOffset: valueEnd,
  };
}

/** The closing tag matching an element of `name` whose content begins at `offset`. */
function findClosingTag(
  text: string,
  offset: number,
  name: AnchorElementName,
): ClosingTag | null {
  const openPattern = new RegExp(`<${name}(?=[\\s/>])`, "gi");
  const closePattern = new RegExp(`</${name}[^>]*>`, "gi");
  let depth = 0;
  let cursor = offset;

  while (cursor < text.length) {
    openPattern.lastIndex = cursor;
    closePattern.lastIndex = cursor;
    const open = openPattern.exec(text);
    const close = closePattern.exec(text);

    if (!close) return null;

    if (open && open.index < close.index) {
      // A self-closing tag of the same name opens no level, so it must not
      // consume the closing tag that ends this element.
      const opening = matchOpeningTag(text, open.index);
      if (!opening?.selfClosing) depth += 1;
      cursor = opening ? opening.end : open.index + open[0].length;
      continue;
    }

    if (depth === 0) {
      return { start: close.index, end: close.index + close[0].length };
    }

    depth -= 1;
    cursor = close.index + close[0].length;
  }

  return null;
}

function stripMarkup(content: string): string {
  return content.replace(/<[^>]*>/g, "");
}

function sameBlock(
  left: OffsetRange | null,
  right: OffsetRange | null,
): boolean {
  if (!left || !right) return left === right;
  return left.start === right.start && left.end === right.end;
}

/**
 * An anchor is inline content, so the text it covers lies within one block. A
 * document that already holds one spanning two blocks is still read — the
 * anchor is returned beside the diagnostic, so the record it binds keeps its
 * anchor and is not dropped for a defect the file arrived with.
 */
function reportBlockCrossings(
  anchors: readonly Anchor[],
  literals: LiteralSpanIndex,
  lineStarts: readonly number[],
  diagnostics: RfmDiagnostic[],
): void {
  for (const anchor of anchors) {
    // `endOffset` is just past the closing tag, which may be past the block
    // itself; the last character the anchor covers is the one inside it.
    const last = literals.blockAt(anchor.endOffset - 1);

    if (sameBlock(literals.blockAt(anchor.offset), last)) continue;

    diagnostics.push(
      createDiagnostic(
        lineStarts,
        "error",
        anchorCrossesBlockCode,
        `Anchor \`${anchor.id}\` spans a block boundary.`,
        anchor.offset,
      ),
    );
  }
}

function reportDuplicateIds(
  anchors: readonly Anchor[],
  lineStarts: readonly number[],
  diagnostics: RfmDiagnostic[],
): void {
  const seen = new Set<string>();

  for (const anchor of anchors) {
    if (seen.has(anchor.id)) {
      diagnostics.push(
        createDiagnostic(
          lineStarts,
          "error",
          anchorDuplicateIdCode,
          `Id \`${anchor.id}\` appears more than once as an anchor.`,
          anchor.offset,
        ),
      );
      continue;
    }

    seen.add(anchor.id);
  }
}

function reportPartialOverlaps(
  anchors: readonly Anchor[],
  lineStarts: readonly number[],
  diagnostics: RfmDiagnostic[],
): void {
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    if (!anchor) continue;

    for (let other = index + 1; other < anchors.length; other += 1) {
      const candidate = anchors[other];
      if (!candidate) continue;
      if (candidate.offset >= anchor.endOffset) continue;
      if (candidate.endOffset <= anchor.endOffset) continue;

      diagnostics.push(
        createDiagnostic(
          lineStarts,
          "error",
          anchorPartialOverlapCode,
          `Anchor \`${candidate.id}\` partially overlaps anchor \`${anchor.id}\`.`,
          candidate.offset,
        ),
      );
    }
  }
}
