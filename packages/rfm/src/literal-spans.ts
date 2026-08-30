import { fromMarkdown } from "mdast-util-from-markdown";

/**
 * The one definition of "where is literal text, and where does a block begin
 * and end" for a body of Markdown.
 *
 * Every reader in this package that must not mistake code for markup, and
 * every reader that must agree with another about where a block starts, asks
 * this index instead of scanning the text itself. Two readers that each carry
 * their own copy of the rule can disagree; two readers that query one index
 * cannot.
 *
 * Offsets are relative to the body the index was built from, never to a larger
 * document that contains it. This is the convention every offset in this
 * package follows.
 *
 * The index is computed once per body and is immutable. Editing the body means
 * building a new index; there is no update path.
 *
 * An offset outside the body is a caller defect, not a supported query. The
 * index reports nothing about such an offset and does not detect it.
 */

/** A half-open offset range: `start` is included, `end` is not. */
export interface OffsetRange {
  start: number;
  end: number;
}

/**
 * Answers exactly two questions about one body of Markdown, and carries
 * nothing else.
 *
 * Do not add a third question. A consumer that needs one is deciding something
 * this index should own — in which case the answer belongs behind one of these
 * two — or is asking something that is not about literal text at all, in which
 * case it belongs to that consumer's own domain.
 */
export interface LiteralSpanIndex {
  /**
   * Whether the character at `offset` is literal text: inside a fenced code
   * block, an indented code block, or an inline code span. Markup at such an
   * offset is text under CommonMark, so a reader walking the body skips it.
   *
   * The delimiters themselves — the fence lines, the backticks of a span — are
   * literal too: an offset anywhere within the construct answers true.
   */
  isLiteral(offset: number): boolean;

  /**
   * The block containing `offset`, or null when the offset lies between blocks
   * — in a blank line, or in the whitespace and markers a container block
   * contributes around its content.
   *
   * The range is the innermost block at the offset: the paragraph, not the
   * list item that holds it; the heading, not the document.
   */
  blockAt(offset: number): OffsetRange | null;
}

/**
 * The mdast this module consumes, narrowed to what it reads. Every node
 * `mdast-util-from-markdown` produces carries `position.start.offset` and
 * `position.end.offset`, and every parent carries `children`.
 */
interface MdastNode {
  type: string;
  children?: MdastNode[];
  position?: {
    start: { offset?: number | undefined };
    end: { offset?: number | undefined };
  };
}

/** The mdast node types whose content is literal text. */
const literalNodeTypes = new Set(["code", "inlineCode"]);

/**
 * The characters a container block may contribute to the start of a line
 * before its content: blockquote markers, list markers, and the indentation
 * either one brings. The set is fixed by CommonMark — a container block is a
 * blockquote or a list item and nothing else — so unlike a list of node types
 * it does not go stale when the parser gains a node.
 *
 * A leaf block's own marker is deliberately absent. `#`, `=`, a fence, a table
 * pipe: each means the content after it belongs to the leaf block that owns
 * the marker, so a node starting after one is that block's inline content.
 */
const containerPrefix = /^(?:[ \t>]|[-+*]|\d+[.)])*$/;

function rangeOf(node: MdastNode): OffsetRange | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? null : { start, end };
}

/**
 * Whether `range` occupies whole lines of `body`: nothing but container prefix
 * before it on its first line, nothing but whitespace after it on its last.
 *
 * This is what separates a block from inline content without naming either.
 * Block content begins where its containers stop writing and runs to the end
 * of a line; inline content sits inside a line beside its siblings.
 */
function isLineAligned(body: string, range: OffsetRange): boolean {
  const lineStart = body.lastIndexOf("\n", range.start - 1) + 1;
  if (!containerPrefix.test(body.slice(lineStart, range.start))) return false;

  const lineEnd = body.indexOf("\n", range.end);
  const trailing = body.slice(
    range.end,
    lineEnd === -1 ? body.length : lineEnd,
  );
  return trailing.trim() === "";
}

function collectLiterals(node: MdastNode, literals: OffsetRange[]): void {
  if (literalNodeTypes.has(node.type)) {
    const range = rangeOf(node);
    if (range) literals.push(range);
    return;
  }

  for (const child of node.children ?? []) {
    collectLiterals(child, literals);
  }
}

/**
 * Record the innermost block at every offset `node` covers.
 *
 * A node's children are block content when every one of them is line-aligned:
 * inline siblings share a line, and the text between two inline nodes on
 * different lines is itself an inline node that starts mid-line, so a set of
 * children that are all line-aligned is a set of blocks. The root's children
 * are block content by definition, and the root itself is not a block.
 */
function collectBlocks(
  node: MdastNode,
  body: string,
  blocks: OffsetRange[],
  isRoot: boolean,
): void {
  const children = node.children ?? [];
  const aligned = children.filter((child) => {
    const range = rangeOf(child);
    return range !== null && isLineAligned(body, range);
  });
  const descend = isRoot
    ? aligned.length > 0
    : children.length > 0 && aligned.length === children.length;

  if (!descend) {
    const range = isRoot ? null : rangeOf(node);
    if (range) blocks.push(range);
    return;
  }

  for (const child of aligned) {
    collectBlocks(child, body, blocks, false);
  }
}

/** The range in `ranges` containing `offset`, given ranges in ascending order. */
function rangeContaining(
  ranges: readonly OffsetRange[],
  offset: number,
): OffsetRange | null {
  let low = 0;
  let high = ranges.length - 1;
  let candidate: OffsetRange | null = null;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = ranges[middle];
    if (!range) break;

    if (range.start <= offset) {
      candidate = range;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return candidate && offset < candidate.end ? candidate : null;
}

/** Build the index for one body of Markdown. */
export function createLiteralSpanIndex(body: string): LiteralSpanIndex {
  const tree = fromMarkdown(body) as MdastNode;
  const literals: OffsetRange[] = [];
  const blocks: OffsetRange[] = [];

  collectLiterals(tree, literals);
  collectBlocks(tree, body, blocks, true);

  return {
    isLiteral(offset) {
      return rangeContaining(literals, offset) !== null;
    },
    blockAt(offset) {
      const block = rangeContaining(blocks, offset);
      return block && { start: block.start, end: block.end };
    },
  };
}
