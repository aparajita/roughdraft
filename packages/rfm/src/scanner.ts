/**
 * Low-level text scanning used by every reader in this package.
 *
 * The scanner knows nothing about the review layer. It knows where lines
 * begin, how to turn an offset into a line and column, and how to skip
 * whitespace. Where literal text lies is not its business: that is
 * `literal-spans.ts`, which every reader queries so that no two of them can
 * disagree about it.
 *
 * Every function here takes plain text and an offset into it. Offsets are
 * relative to the text passed in, never to a larger document.
 */

export interface TextLocation {
  line: number;
  column: number;
}

export type RfmDiagnosticSeverity = "error" | "warning";

/** A problem found in a document, located at an offset in the text it was read from. */
export interface RfmDiagnostic {
  severity: RfmDiagnosticSeverity;
  code: string;
  message: string;
  offset: number;
  line: number;
  column: number;
}

export function createDiagnostic(
  lineStarts: readonly number[],
  severity: RfmDiagnosticSeverity,
  code: string,
  message: string,
  offset: number,
): RfmDiagnostic {
  return {
    severity,
    code,
    message,
    offset,
    ...locationForOffset(lineStarts, offset),
  };
}

/**
 * The same diagnostics, relocated into a text that contains the one they were
 * produced from starting at `offsetDelta` / line `lineDelta + 1`. Columns are
 * unchanged, which holds because the enclosing text begins the inner text at a
 * line start.
 */
export function shiftDiagnostics(
  diagnostics: readonly RfmDiagnostic[],
  offsetDelta: number,
  lineDelta: number,
): RfmDiagnostic[] {
  if (offsetDelta === 0 && lineDelta === 0) return [...diagnostics];

  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    offset: diagnostic.offset + offsetDelta,
    line: diagnostic.line + lineDelta,
  }));
}

/** Offsets at which each line of `text` begins. Line 1 begins at offset 0. */
export function createLineStarts(text: string): number[] {
  const lineStarts = [0];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}

/** The 1-based line and column of `offset` within the text `lineStarts` describes. */
export function locationForOffset(
  lineStarts: readonly number[],
  offset: number,
): TextLocation {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const lineStart = lineStarts[middle] ?? 0;
    const nextLineStart = lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY;

    if (offset < lineStart) {
      high = middle - 1;
    } else if (offset >= nextLineStart) {
      low = middle + 1;
    } else {
      return {
        line: middle + 1,
        column: offset - lineStart + 1,
      };
    }
  }

  const lastLineStart = lineStarts[lineStarts.length - 1] ?? 0;
  return {
    line: lineStarts.length,
    column: offset - lastLineStart + 1,
  };
}

export function isLineStart(text: string, offset: number): boolean {
  return offset === 0 || text[offset - 1] === "\n";
}

/** The offset at which the line after the one containing `offset` begins. */
export function nextLineOffset(text: string, offset: number): number {
  const nextNewline = text.indexOf("\n", offset);
  return nextNewline === -1 ? text.length : nextNewline + 1;
}

function skipWhile(
  text: string,
  offset: number,
  matches: (character: string) => boolean,
): number {
  let cursor = offset;
  while (cursor < text.length && matches(text[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

/** The offset of the first character at or after `offset` that is not a space or tab. */
export function skipSpaces(text: string, offset: number): number {
  return skipWhile(
    text,
    offset,
    (character) => character === " " || character === "\t",
  );
}

const htmlWhitespace = new Set([" ", "\t", "\n", "\r", "\f"]);

/**
 * The offset of the first character at or after `offset` that HTML does not
 * treat as whitespace. Attributes on an anchor element may be separated by a
 * line break, so this is what tag scanning uses rather than `skipSpaces`.
 */
export function skipHtmlWhitespace(text: string, offset: number): number {
  return skipWhile(text, offset, (character) => htmlWhitespace.has(character));
}
