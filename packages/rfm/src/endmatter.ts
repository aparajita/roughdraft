import { parse as parseYaml, Scalar, stringify as stringifyYaml } from "yaml";
import {
  type CommentId,
  parseCommentId,
  parseRecordId,
  parseSuggestionId,
  type RecordId,
  type SuggestionId,
} from "./ids.js";
import type { LiteralSpanIndex } from "./literal-spans.js";
import {
  createDiagnostic,
  createLineStarts,
  nextLineOffset,
  type RfmDiagnostic,
  type RfmDiagnosticSeverity,
} from "./scanner.js";

/**
 * Endmatter: the final YAML block holding every review record.
 *
 * A block is endmatter when, and only when, it is the last `---`-delimited
 * YAML block in the text and its parsed mapping has a top-level `roughdraft`
 * key. No other property of a block identifies it, and no heuristic stands in
 * for that key: a trailing YAML block without it is document content.
 */

export const RFM_VERSION = "1.0" as const;

const roughdraftKey = "roughdraft";
const commentsKey = "comments";
const suggestionsKey = "suggestions";

const endmatterInvalidYamlCode = "rfm-endmatter-invalid-yaml";
const endmatterInvalidIdCode = "rfm-endmatter-invalid-id";
const endmatterDuplicateIdCode = "rfm-endmatter-duplicate-id";
const endmatterMissingBodyCode = "rfm-endmatter-missing-body";
const endmatterMissingByCode = "rfm-endmatter-missing-by";
const endmatterMissingAtCode = "rfm-endmatter-missing-at";
const endmatterInvalidAtCode = "rfm-endmatter-invalid-at";
const endmatterInvalidReCode = "rfm-endmatter-invalid-re";
const endmatterSelfReplyCode = "rfm-endmatter-self-reply";
export const endmatterReplyCycleCode = "rfm-endmatter-reply-cycle";

/**
 * A comment, a reply, or a document-scope comment.
 *
 * `re` names the record this replies to; a reply has no anchor of its own.
 * `metadata` holds the record's keys that this specification does not define,
 * exactly as they were parsed, because a write must give them back unchanged.
 */
export interface CommentRecord {
  body: string;
  by: string;
  at: string;
  re?: RecordId;
  scope?: "document";
  status?: "resolved";
  resolved?: string;
  metadata: Record<string, unknown>;
}

/**
 * A suggested edit.
 *
 * The record carries attribution and state only. It has no operation field and
 * MUST NOT gain one: what the edit does — insert, delete, replace — is read
 * from its anchor element, and giving the record somewhere to say it a second
 * time is what would let the two disagree. `metadata` holds unrecognized keys
 * as parsed.
 */
export interface SuggestionRecord {
  by: string;
  at: string;
  status?: "resolved";
  resolved?: string;
  metadata: Record<string, unknown>;
}

export interface EndmatterRecords {
  comments: Map<CommentId, CommentRecord>;
  suggestions: Map<SuggestionId, SuggestionRecord>;
  /** Top-level endmatter keys this specification does not define, as parsed. */
  extraKeys: Record<string, unknown>;
}

export interface ParsedEndmatter extends EndmatterRecords {
  /**
   * The `roughdraft` key's value as written, or null when the text carries no
   * endmatter. It is the only way to tell an endmatter block whose record maps
   * are empty from a document that has no endmatter at all, and the
   * specification forbids inferring that from the maps.
   */
  version: string | null;
  /** Offset of the block within the text it was read from, or null when absent. */
  offset: number | null;
  /** The block as written, beginning with the newline that precedes `---`. */
  raw: string | null;
  diagnostics: RfmDiagnostic[];
}

const dateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The final `---`-delimited YAML block in `text`, whether or not it is
 * endmatter.
 *
 * A delimiter inside literal text is example text, exactly as an anchor there
 * is. Reading one as the real delimiter splits the document at it and drops
 * everything after — so a document merely *showing* what endmatter looks like
 * would lose the rest of itself on the first write. `literalSpans` is the one
 * authority on where literal text is, and MUST have been built from `text`
 * itself so its offsets mean the same thing.
 */
export function findFinalYamlEndmatter(
  text: string,
  literalSpans: LiteralSpanIndex,
): { raw: string; yaml: string; offset: number } | null {
  let lastDelimiter: number | null = null;

  for (
    let offset = 0;
    offset < text.length;
    offset = nextLineOffset(text, offset)
  ) {
    if (offset === 0 || literalSpans.isLiteral(offset)) continue;

    const lineEnd = nextLineOffset(text, offset);
    const line = text.slice(offset, lineEnd);

    if (/^---[ \t]*\r?\n$/.test(line)) {
      // The offset of the newline that precedes the delimiter, which is what
      // the block's `raw` begins with.
      lastDelimiter = offset - 1;
    }
  }

  if (lastDelimiter === null) return null;

  const raw = text.slice(lastDelimiter);
  return {
    raw,
    yaml: raw.replace(/^\n---[ \t]*\r?\n/, ""),
    offset: lastDelimiter,
  };
}

/** The one test that identifies endmatter: a mapping carrying `roughdraft`. */
function isEndmatterMapping(
  parsed: unknown,
): parsed is Record<string, unknown> {
  return isPlainObject(parsed) && roughdraftKey in parsed;
}

/**
 * Whether `block` — a `---`-delimited YAML block, delimiter included — is
 * endmatter rather than document content.
 */
export function isEndmatterBlock(block: string): boolean {
  return isEndmatterMapping(parseYamlBlock(block));
}

/**
 * Whether `block` — a `---`-delimited block, delimiter included — is a YAML
 * mapping rather than a thematic break followed by prose.
 *
 * Endmatter is one kind of such block, and a trailing block that is not
 * endmatter is document content a round trip must preserve verbatim. Both
 * questions start here so that what counts as a YAML block has one definition.
 */
export function isYamlMappingBlock(block: string): boolean {
  return isPlainObject(parseYamlBlock(block));
}

function parseYamlBlock(block: string): unknown {
  const yamlText = block.replace(/^---[ \t]*(?:\r\n|\n)/, "");

  try {
    return parseYaml(yamlText);
  } catch {
    return null;
  }
}

function emptyEndmatter(): ParsedEndmatter {
  return {
    comments: new Map(),
    suggestions: new Map(),
    extraKeys: {},
    version: null,
    offset: null,
    raw: null,
    diagnostics: [],
  };
}

/**
 * The review records `text` carries.
 *
 * Returns an empty result when the text has no final YAML block with a
 * top-level `roughdraft` key. Offsets in the diagnostics are relative to
 * `text`, and `literalSpans` MUST have been built from `text`.
 */
export function parseEndmatter(
  text: string,
  literalSpans: LiteralSpanIndex,
): ParsedEndmatter {
  const match = findFinalYamlEndmatter(text, literalSpans);
  if (!match) return emptyEndmatter();

  const lineStarts = createLineStarts(text);
  const addDiagnostic = (
    severity: RfmDiagnosticSeverity,
    code: string,
    message: string,
  ): RfmDiagnostic =>
    createDiagnostic(lineStarts, severity, code, message, match.offset);

  let parsed: unknown;
  try {
    parsed = parseYaml(match.yaml);
  } catch (error) {
    if (!/^[ \t]*roughdraft[ \t]*:/m.test(match.yaml)) return emptyEndmatter();

    return {
      ...emptyEndmatter(),
      raw: match.raw,
      offset: match.offset,
      diagnostics: [
        addDiagnostic(
          "error",
          endmatterInvalidYamlCode,
          `YAML endmatter could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }

  if (!isEndmatterMapping(parsed)) return emptyEndmatter();

  const diagnostics: RfmDiagnostic[] = [];
  const comments = new Map<CommentId, CommentRecord>();
  const suggestions = new Map<SuggestionId, SuggestionRecord>();

  for (const [id, entry] of readEndmatterEntries(parsed[commentsKey])) {
    const commentId = parseCommentId(id);
    if (!commentId) {
      diagnostics.push(
        addDiagnostic(
          "error",
          endmatterInvalidIdCode,
          `Comment key \`${id}\` is not a comment id.`,
        ),
      );
      continue;
    }

    if (comments.has(commentId)) {
      diagnostics.push(
        addDiagnostic(
          "error",
          endmatterDuplicateIdCode,
          `Duplicate comment record \`${id}\`.`,
        ),
      );
      continue;
    }

    comments.set(
      commentId,
      readCommentRecord(commentId, entry, addDiagnostic, diagnostics),
    );
  }

  for (const [id, entry] of readEndmatterEntries(parsed[suggestionsKey])) {
    const suggestionId = parseSuggestionId(id);
    if (!suggestionId) {
      diagnostics.push(
        addDiagnostic(
          "error",
          endmatterInvalidIdCode,
          `Suggestion key \`${id}\` is not a suggestion id.`,
        ),
      );
      continue;
    }

    if (suggestions.has(suggestionId)) {
      diagnostics.push(
        addDiagnostic(
          "error",
          endmatterDuplicateIdCode,
          `Duplicate suggestion record \`${id}\`.`,
        ),
      );
      continue;
    }

    suggestions.set(
      suggestionId,
      readSuggestionRecord(suggestionId, entry, addDiagnostic, diagnostics),
    );
  }

  breakReplyCycles(comments, addDiagnostic, diagnostics);

  const extraKeys: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      key === roughdraftKey ||
      key === commentsKey ||
      key === suggestionsKey
    ) {
      continue;
    }
    extraKeys[key] = value;
  }

  return {
    comments,
    suggestions,
    extraKeys,
    version: String(parsed[roughdraftKey]),
    offset: match.offset,
    raw: match.raw,
    diagnostics,
  };
}

type AddEndmatterDiagnostic = (
  severity: RfmDiagnosticSeverity,
  code: string,
  message: string,
) => RfmDiagnostic;

const commentRecordKeys = new Set([
  "body",
  "by",
  "at",
  "re",
  "scope",
  "status",
  "resolved",
]);
const suggestionRecordKeys = new Set(["by", "at", "status", "resolved"]);

function readCommentRecord(
  id: CommentId,
  entry: Record<string, unknown>,
  addDiagnostic: AddEndmatterDiagnostic,
  diagnostics: RfmDiagnostic[],
): CommentRecord {
  const body = readString(entry.body);
  if (body === null) {
    diagnostics.push(
      addDiagnostic(
        "error",
        endmatterMissingBodyCode,
        `Comment \`${id}\` is missing \`body\`.`,
      ),
    );
  }

  const record: CommentRecord = {
    body: body ?? "",
    ...readAttribution(id, entry, addDiagnostic, diagnostics),
    metadata: readMetadata(entry, commentRecordKeys),
  };

  const re = readString(entry.re);
  if (re !== null) {
    const parent = parseRecordId(re);
    if (!parent) {
      diagnostics.push(
        addDiagnostic(
          "error",
          endmatterInvalidReCode,
          `Comment \`${id}\` replies to \`${re}\`, which is not a record id.`,
        ),
      );
    } else if ((parent as string) === (id as string)) {
      diagnostics.push(
        addDiagnostic(
          "error",
          endmatterSelfReplyCode,
          `Comment \`${id}\` must not reply to itself.`,
        ),
      );
    } else {
      record.re = parent;
    }
  }

  if (entry.scope === "document") record.scope = "document";
  if (entry.status === "resolved") record.status = "resolved";

  const resolved = readString(entry.resolved);
  if (resolved !== null) record.resolved = resolved;

  return record;
}

/**
 * The comment `id` replies to, or undefined when it replies to nothing, to a
 * suggestion, or to a record no map holds.
 *
 * Only a comment can carry `re`, so only a comment-to-comment link can be part
 * of a cycle.
 */
function parentCommentOf(
  comments: ReadonlyMap<CommentId, CommentRecord>,
  id: CommentId,
): CommentId | undefined {
  const re = comments.get(id)?.re;
  if (re === undefined) return undefined;

  const parent = parseCommentId(re);
  return parent && comments.has(parent) ? parent : undefined;
}

/**
 * Drop the `re` of every record that closes a reply cycle, and report each
 * cycle it broke.
 *
 * This is the only place a cycle can enter the system: a parent link is either
 * read from a file here or attached to a freshly allocated id, and an id
 * nothing has seen is in no chain. A cycle that survived would make walking a
 * record's ancestry unbounded, so a consumer asking for a record's replies or
 * its root never terminates. A record whose `re` is dropped is a top-level
 * comment.
 */
function breakReplyCycles(
  comments: Map<CommentId, CommentRecord>,
  addDiagnostic: AddEndmatterDiagnostic,
  diagnostics: RfmDiagnostic[],
): void {
  // Records whose whole ancestry has already been walked. Reaching one proves
  // the rest of this chain is acyclic, which is what keeps the walk linear.
  const settled = new Set<CommentId>();

  for (const start of comments.keys()) {
    const path: CommentId[] = [];
    const positionOnPath = new Map<CommentId, number>();

    for (
      let current: CommentId | undefined = start;
      current !== undefined && !settled.has(current);
      current = parentCommentOf(comments, current)
    ) {
      const revisited = positionOnPath.get(current);

      if (revisited !== undefined) {
        breakCycle(comments, path.slice(revisited), addDiagnostic, diagnostics);
        break;
      }

      positionOnPath.set(current, path.length);
      path.push(current);
    }

    for (const id of path) settled.add(id);
  }
}

/**
 * Drop the `re` of the last record in `cycle`, which is the one whose reply
 * link closes it back onto the first.
 */
function breakCycle(
  comments: Map<CommentId, CommentRecord>,
  cycle: CommentId[],
  addDiagnostic: AddEndmatterDiagnostic,
  diagnostics: RfmDiagnostic[],
): void {
  const closing = cycle.at(-1);
  const record = closing === undefined ? undefined : comments.get(closing);
  if (closing === undefined || !record) return;

  const { re: _closingLink, ...withoutRe } = record;
  comments.set(closing, withoutRe);

  const chain = [...cycle, cycle[0]].map((id) => `\`${id}\``).join(" → ");
  diagnostics.push(
    addDiagnostic(
      "error",
      endmatterReplyCycleCode,
      `Comment \`${closing}\` closes a reply cycle ${chain}; its \`re\` is dropped.`,
    ),
  );
}

function readSuggestionRecord(
  id: SuggestionId,
  entry: Record<string, unknown>,
  addDiagnostic: AddEndmatterDiagnostic,
  diagnostics: RfmDiagnostic[],
): SuggestionRecord {
  const record: SuggestionRecord = {
    ...readAttribution(id, entry, addDiagnostic, diagnostics),
    metadata: readMetadata(entry, suggestionRecordKeys),
  };

  if (entry.status === "resolved") record.status = "resolved";

  const resolved = readString(entry.resolved);
  if (resolved !== null) record.resolved = resolved;

  return record;
}

/**
 * The `by` and `at` every record requires, with a diagnostic for each one
 * missing or malformed. This is the check the plan calls
 * `validateEndmatterEntry`, folded into reading so that a record and its
 * diagnostics cannot be produced by two different readings of the same entry.
 *
 * Both keys carry a `minLength` of 1 in the schema, so an empty one is as
 * unusable as an absent one and is reported the same way. Every other string
 * key admits the empty string.
 */
function readAttribution(
  id: RecordId,
  entry: Record<string, unknown>,
  addDiagnostic: AddEndmatterDiagnostic,
  diagnostics: RfmDiagnostic[],
): { by: string; at: string } {
  const by = readString(entry.by);
  if (by === null || by.length === 0) {
    diagnostics.push(
      addDiagnostic(
        "error",
        endmatterMissingByCode,
        `Record \`${id}\` is missing \`by\`.`,
      ),
    );
  }

  const at = readString(entry.at);
  if (at === null || at.length === 0) {
    diagnostics.push(
      addDiagnostic(
        "error",
        endmatterMissingAtCode,
        `Record \`${id}\` is missing \`at\`.`,
      ),
    );
  } else if (!isValidDateTime(at)) {
    diagnostics.push(
      addDiagnostic(
        "error",
        endmatterInvalidAtCode,
        `Record \`${id}\` has an \`at\` that is not an ISO 8601 date-time.`,
      ),
    );
  }

  return { by: by ?? "", at: at ?? "" };
}

function readMetadata(
  entry: Record<string, unknown>,
  recognized: ReadonlySet<string>,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(entry)) {
    if (recognized.has(key)) continue;
    metadata[key] = value;
  }

  return metadata;
}

/**
 * The string `value` is, or null when it is not a string.
 *
 * An empty string is a value, not an absence. Folding the two together made
 * `body: ""` read as a missing `body` and write back as `body: ""`, so the
 * package emitted documents its own validator rejected. A key whose emptiness
 * is itself invalid — `by`, `at` — says so where it is read.
 */
function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readEndmatterEntries(
  value: unknown,
): Map<string, Record<string, unknown>> {
  const entries = new Map<string, Record<string, unknown>>();
  if (!isPlainObject(value)) return entries;

  for (const [id, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) continue;
    entries.set(id, entry);
  }

  return entries;
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidDateTime(value: string): boolean {
  return dateTimePattern.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * The endmatter block for `records`, beginning with `---` and ending with a
 * newline, or null when there is nothing to write.
 *
 * `roughdraft` is written first so a reader sees what identifies the block
 * before anything else.
 */
export function renderEndmatter(records: EndmatterRecords): string | null {
  const hasRecords = records.comments.size > 0 || records.suggestions.size > 0;
  const hasExtraKeys = Object.keys(records.extraKeys).length > 0;
  if (!hasRecords && !hasExtraKeys) return null;

  const data: Record<string, unknown> = { [roughdraftKey]: RFM_VERSION };

  if (records.comments.size > 0) {
    data[commentsKey] = Object.fromEntries(
      [...records.comments].map(([id, record]) => [
        id,
        renderCommentRecord(record),
      ]),
    );
  }

  if (records.suggestions.size > 0) {
    data[suggestionsKey] = Object.fromEntries(
      [...records.suggestions].map(([id, record]) => [
        id,
        renderSuggestionRecord(record),
      ]),
    );
  }

  for (const [key, value] of Object.entries(records.extraKeys)) {
    data[key] = value;
  }

  return `---\n${stringifyYaml(data, { lineWidth: 0 })}`;
}

/**
 * A string YAML must emit quoted.
 *
 * An unquoted `2026-01-01T00:00:00.000Z` is a string to a YAML 1.2 reader and a
 * timestamp to a YAML 1.1 one — js-yaml's default, PyYAML, Ruby — so the same
 * endmatter yields a string in one language and a date object in another. The
 * schema declares the field a string and every example in the specification
 * quotes it, so the writer forces the quotes rather than leaving the type to
 * the reader. Setting the scalar's type makes the YAML serializer emit them;
 * rewriting its output afterwards would be a second, weaker parser.
 */
function quoted(value: string): Scalar<string> {
  const scalar = new Scalar(value);
  scalar.type = Scalar.QUOTE_DOUBLE;
  return scalar;
}

function renderCommentRecord(record: CommentRecord): Record<string, unknown> {
  return {
    body: record.body,
    by: record.by,
    at: quoted(record.at),
    ...(record.re !== undefined ? { re: record.re } : {}),
    ...(record.scope !== undefined ? { scope: record.scope } : {}),
    ...(record.status !== undefined ? { status: record.status } : {}),
    ...(record.resolved !== undefined
      ? { resolved: quoted(record.resolved) }
      : {}),
    ...record.metadata,
  };
}

function renderSuggestionRecord(
  record: SuggestionRecord,
): Record<string, unknown> {
  return {
    by: record.by,
    at: quoted(record.at),
    ...(record.status !== undefined ? { status: record.status } : {}),
    ...(record.resolved !== undefined
      ? { resolved: quoted(record.resolved) }
      : {}),
    ...record.metadata,
  };
}
