import { describe, expect, it } from "vitest";
import { readFixtures } from "../test/spec-fixtures.js";
import { createLiteralSpanIndex, type OffsetRange } from "./literal-spans.js";

function readFixtureBodies(): { name: string; markdown: string }[] {
  return readFixtures().map(({ name, fixture }) => ({
    name,
    markdown: fixture.source.markdown,
  }));
}

/**
 * Every offset of `body` the index calls literal.
 *
 * The whole set is compared at once rather than one offset at a time so a
 * failure names the offsets that disagree, in both directions: a construct the
 * index missed and prose it wrongly swallowed read the same way.
 */
function literalOffsets(body: string): number[] {
  const index = createLiteralSpanIndex(body);
  const offsets: number[] = [];

  for (let offset = 0; offset < body.length; offset += 1) {
    if (index.isLiteral(offset)) offsets.push(offset);
  }

  return offsets;
}

/** The offsets `construct` occupies in `body`, delimiters included. */
function offsetsOf(body: string, construct: string): number[] {
  const start = body.indexOf(construct);
  if (start === -1) throw new Error(`Not in the body: ${construct}`);

  return Array.from({ length: construct.length }, (_, index) => start + index);
}

function blockKey(block: OffsetRange): string {
  return `${block.start}-${block.end}`;
}

function distinctBlocks(
  answers: readonly (OffsetRange | null)[],
): OffsetRange[] {
  const byKey = new Map<string, OffsetRange>();

  for (const block of answers) {
    if (block) byKey.set(blockKey(block), block);
  }

  return [...byKey.values()];
}

describe("isLiteral", () => {
  it.each([
    {
      name: "a fenced code block",
      body: "Text.\n\n```js\nconst x = 1;\n```\n\nAfter.\n",
      construct: "```js\nconst x = 1;\n```",
    },
    {
      name: "an indented code block",
      body: "Text.\n\n    const x = 1;\n\nAfter.\n",
      construct: "    const x = 1;",
    },
    {
      name: "an indented code block introduced by a tab",
      body: "Text.\n\n\tconst x = 1;\n\nAfter.\n",
      construct: "\tconst x = 1;",
    },
    {
      name: "an inline code span",
      body: "Use `code` here.\n",
      construct: "`code`",
    },
    {
      name: "an inline code span in a list item",
      body: "- Use `code` here.\n",
      construct: "`code`",
    },
    {
      name: "a fenced code block in a list item",
      body: "- Item:\n\n  ```js\n  const x = 1;\n  ```\n",
      construct: "```js\n  const x = 1;\n  ```",
    },
    {
      name: "an inline code span in a blockquote",
      body: "> Use `code` here.\n",
      construct: "`code`",
    },
    {
      name: "a fenced code block in a blockquote",
      body: "> Item:\n>\n> ```js\n> const x = 1;\n> ```\n",
      construct: "```js\n> const x = 1;\n> ```",
    },
  ])("marks $name and nothing else", ({ body, construct }) => {
    expect(literalOffsets(body)).toEqual(offsetsOf(body, construct));
  });
});

describe("blockAt", () => {
  const fixtures = readFixtureBodies();

  it("finds the specification fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)(
    "reports the containing block at every offset of $name",
    ({ markdown }) => {
      const index = createLiteralSpanIndex(markdown);
      const answers = Array.from({ length: markdown.length }, (_, offset) =>
        index.blockAt(offset),
      );
      const blocks = distinctBlocks(answers);

      expect(blocks.length).toBeGreaterThan(0);

      // Every answer contains the offset that asked for it.
      expect(
        answers.flatMap((block, offset) =>
          block && (offset < block.start || block.end <= offset)
            ? [offset]
            : [],
        ),
      ).toEqual([]);

      // Every offset a block covers answers that same block, so no two blocks
      // overlap and no offset within one falls through to nothing.
      for (const block of blocks) {
        const covered = answers
          .slice(block.start, block.end)
          .map((answer) => (answer ? blockKey(answer) : null));

        expect(covered).toEqual(
          new Array(block.end - block.start).fill(blockKey(block)),
        );
      }
    },
  );
});
