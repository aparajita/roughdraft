import { parse as parseYaml } from "yaml";
import { scanAnchors } from "./anchors.js";
import {
  parseDocument,
  type RfmDocument,
  serializeDocument,
} from "./document.js";
import {
  type CommentRecord,
  findFinalYamlEndmatter,
  isPlainObject,
  type SuggestionRecord,
} from "./endmatter.js";
import {
  type CommentId,
  parseCommentId,
  parseSuggestionId,
  RecordIdAllocator,
  type RecordId,
  type SuggestionId,
} from "./ids.js";
import { createLiteralSpanIndex, type OffsetRange } from "./literal-spans.js";
import {
  createDiagnostic,
  createLineStarts,
  type RfmDiagnostic,
  shiftDiagnostics,
} from "./scanner.js";

/**
 * The author written on a record whose CriticMarkup carried no `by`.
 */
const UNKNOWN_AUTHOR = "unknown";

/**
 * A legacy highlight ran across a block boundary, so the anchor written for it
 * covers only the part of the highlight that lies within one block.
 */
export const migrateAnchorTruncatedCode = "rfm-migrate-anchor-truncated";

/**
 * A raw CriticMarkup id such as `c1`, `s12` or `rd-c3`, from which the record
 * number is taken. An id in any other shape names no number, so the record it
 * belongs to is given a freshly allocated id instead.
 */
const RAW_ID_NUMBER_PATTERN = /^(?:rd-)?[cs]?(\d+)$/i;

/**
 * Keys a record reads by name. Everything else a legacy entry or an inline
 * attribute block carried is preserved in the record's `metadata`.
 */
const COMMENT_KEYS = [
  "body",
  "by",
  "at",
  "re",
  "scope",
  "status",
  "resolved",
] as const;
const SUGGESTION_KEYS = ["by", "at", "status", "resolved"] as const;

interface MarkerDraftBase {
  /** The raw id named by `{#c1}` or by an inline attribute block, if any. */
  rawId: string | null;
  /** Attributes read from an inline attribute block following the marker. */
  attributes: Map<string, string>;
}

type MarkerDraft =
  | (MarkerDraftBase & {
      kind: "comment";
      body: string;
      /** Highlighted text this comment anchors to; `null` for a point comment. */
      anchorText: string | null;
      /** The comment marker this one trails, when several share a highlight. */
      parentIndex: number | null;
    })
  | (MarkerDraftBase & { kind: "insert" | "delete"; text: string })
  | (MarkerDraftBase & { kind: "replace"; oldText: string; newText: string });

type BodyPart = string | { markerIndex: number };

interface ScanResult {
  parts: BodyPart[];
  markers: MarkerDraft[];
}

interface RecordSlotBase {
  /** The raw id this record was written with, if it had one. */
  rawId: string | null;
  /** The merged legacy endmatter entry and inline attributes. */
  source: Record<string, unknown>;
  /** The marker this slot came from, or `null` for an endmatter-only entry. */
  markerIndex: number | null;
}

/**
 * A record the migration will write: either a scanned CriticMarkup marker, or
 * an entry carried over from a legacy YAML endmatter block that no marker
 * names.
 */
type RecordSlot =
  | (RecordSlotBase & { kind: "comment"; id: CommentId | null })
  | (RecordSlotBase & { kind: "suggestion"; id: SuggestionId | null });

interface LegacyEndmatter {
  comments: Map<string, Record<string, unknown>>;
  suggestions: Map<string, Record<string, unknown>>;
  extraKeys: Record<string, unknown>;
}

/**
 * Rewrite a CriticMarkup document as Roughdraft Flavored Markdown 1.0.
 *
 * This is the only CriticMarkup reader in the package. Reading a document never
 * goes through it: it is a one-off conversion run deliberately against a file,
 * so `packages/rfm/src/index.ts` must not import this module.
 *
 * The conversion is a pure transform of the text it is given. It touches no
 * filesystem, opens no network connection, and reads no clock beyond a single
 * timestamp taken at entry, which stands in for `at` on a marker that carried
 * no date. A marker that carried no `by` is attributed to `unknown`.
 *
 * It is run only on a document whose endmatter has no `roughdraft` key: a
 * document already in 1.0 has nothing to convert, so the caller checks that
 * precondition and refuses rather than rewriting the file. The refusal lives in
 * `packages/server/src/cli.ts`. Anchors and records the document already
 * carries are kept exactly as they stand, and the ids they hold are never
 * handed to a converted marker.
 *
 * `converted` counts the records the migrated document carries in its
 * endmatter, not the delimiters consumed: `{==text==}{>>note<<}` is one record,
 * and a record carried over from a legacy endmatter block counts the same as
 * one converted from a marker. A record `serializeDocument` drops as an orphan
 * is not counted, because it is not in the file that comes back.
 *
 * CriticMarkup inside a code block or an inline code span is literal text and is
 * left exactly as it stands. Where that text is comes from the literal-span
 * index, the same authority every other reader in this package queries.
 *
 * `diagnostics` report what the conversion could not express as written: a
 * legacy highlight that ran across a block boundary becomes an anchor over the
 * part of it lying within one block, and says so. They are located against the
 * returned markdown, frontmatter included.
 */
export function migrateCriticMarkup(markdown: string): {
  markdown: string;
  converted: number;
  diagnostics: RfmDiagnostic[];
} {
  const migratedAt = new Date().toISOString();
  const { head, legacy } = splitLegacyEndmatter(markdown);
  const document = parseDocument(head);
  const { parts, markers } = scanBody(document.body);
  const slots = createRecordSlots(markers, legacy);

  assignRecordIds(slots, document);

  const idsByRawId = new Map<string, RecordId>();
  const idsByMarker = new Map<number, RecordId>();
  for (const slot of slots) {
    if (slot.id === null) continue;
    if (slot.rawId !== null) {
      idsByRawId.set(rawIdKey(slot.kind, slot.rawId), slot.id);
    }
    if (slot.markerIndex !== null) {
      idsByMarker.set(slot.markerIndex, slot.id);
    }
  }

  const replyMarkers = new Set<number>();

  for (const slot of slots) {
    if (slot.id === null) continue;

    if (slot.kind === "suggestion") {
      document.suggestions.set(
        slot.id,
        createSuggestionRecord(slot, migratedAt),
      );
      continue;
    }

    const record = createCommentRecord(
      slot,
      markers,
      idsByRawId,
      idsByMarker,
      migratedAt,
    );
    document.comments.set(slot.id, record);
    if (record.re && slot.markerIndex !== null) {
      replyMarkers.add(slot.markerIndex);
    }
  }

  const { body, diagnostics } = renderBody(
    parts,
    markers,
    idsByMarker,
    replyMarkers,
  );

  document.body = body;
  document.anchors = scanAnchors(body, createLiteralSpanIndex(body)).anchors;
  document.extraEndmatterKeys = {
    ...legacy.extraKeys,
    ...document.extraEndmatterKeys,
  };

  const migrated = serializeDocument(document);
  const written = parseDocument(migrated);
  const frontmatter = document.frontmatter ?? "";

  return {
    markdown: migrated,
    converted: written.comments.size + written.suggestions.size,
    diagnostics: shiftDiagnostics(
      diagnostics,
      frontmatter.length,
      createLineStarts(frontmatter).length - 1,
    ),
  };
}

/**
 * Separate a legacy YAML endmatter block from the document that precedes it.
 *
 * A legacy block is the final `---`-delimited YAML block that carries no
 * `roughdraft` key and whose `comments` and `suggestions` values are record
 * sets holding at least one record between them. Anything else is document
 * content: it comes back in `head` and stays in the body.
 *
 * The test is on the shape, not on the key names, because claiming a block is
 * deleting it. A document explaining a configuration file that happens to have
 * a `comments` key would otherwise lose the whole block from its body while
 * carrying nothing into the endmatter, since none of what it holds is a record.
 */
function splitLegacyEndmatter(markdown: string): {
  head: string;
  legacy: LegacyEndmatter;
} {
  const empty: LegacyEndmatter = {
    comments: new Map(),
    suggestions: new Map(),
    extraKeys: {},
  };

  const block = findFinalYamlEndmatter(
    markdown,
    createLiteralSpanIndex(markdown),
  );
  if (!block) return { head: markdown, legacy: empty };

  let parsed: unknown;
  try {
    parsed = parseYaml(block.yaml);
  } catch {
    return { head: markdown, legacy: empty };
  }

  if (!isPlainObject(parsed)) return { head: markdown, legacy: empty };
  if ("roughdraft" in parsed) return { head: markdown, legacy: empty };

  const comments = readRecordSet(parsed, "comments");
  const suggestions = readRecordSet(parsed, "suggestions");
  if (!comments || !suggestions) return { head: markdown, legacy: empty };
  if (comments.size === 0 && suggestions.size === 0) {
    return { head: markdown, legacy: empty };
  }

  const extraKeys: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "comments" || key === "suggestions") continue;
    extraKeys[key] = value;
  }

  return {
    head: `${markdown.slice(0, block.offset)}\n`,
    legacy: { comments, suggestions, extraKeys },
  };
}

/**
 * The records `key` holds in `parsed`, or null when what it holds is not a
 * record set. An absent key holds no records, which is not a failure: a legacy
 * block naming only `comments` is still a legacy block.
 */
function readRecordSet(
  parsed: Record<string, unknown>,
  key: "comments" | "suggestions",
): Map<string, Record<string, unknown>> | null {
  const entries = new Map<string, Record<string, unknown>>();
  if (!(key in parsed)) return entries;

  const value = parsed[key];
  if (!isPlainObject(value)) return null;

  for (const [id, entry] of Object.entries(value)) {
    if (!isLegacyRecord(entry)) return null;
    entries.set(id, entry);
  }

  return entries;
}

/**
 * Whether `entry` is a legacy record rather than prose that happens to sit
 * under a `comments` key.
 *
 * A record is a mapping, and it carries attribution: `by`, `at`, or both. That
 * is what an endmatter entry existed to supply — the marker in the body carried
 * the comment's own text, and the entry it named said who wrote it and when —
 * so a mapping with neither was never a record. Without this test a document
 * ending in `comments:\n  foo:\n    body: sample` reads as a real comment by
 * `unknown` scoped to the document, which moves prose into the review layer.
 */
function isLegacyRecord(entry: unknown): entry is Record<string, unknown> {
  if (!isPlainObject(entry)) return false;
  return typeof entry.by === "string" || typeof entry.at === "string";
}

/**
 * Walk the body, collecting the literal text between CriticMarkup markers and a
 * draft of each marker. Code blocks and inline code spans are copied through
 * unread, from the same literal-span index the anchor scanner queries.
 *
 * A `{==…==}` highlight that no comment follows carries no record, so it is
 * unwrapped to the text it highlighted.
 */
function scanBody(body: string): ScanResult {
  const literals = createLiteralSpanIndex(body);
  const parts: BodyPart[] = [];
  const markers: MarkerDraft[] = [];
  let literalStart = 0;
  let offset = 0;

  const flushLiteral = (end: number): void => {
    if (end > literalStart) {
      parts.push(body.slice(literalStart, end));
    }
    literalStart = end;
  };

  const pushMarker = (marker: MarkerDraft): number => {
    const index = markers.length;
    markers.push(marker);
    parts.push({ markerIndex: index });
    return index;
  };

  while (offset < body.length) {
    if (literals.isLiteral(offset)) {
      offset += 1;
      continue;
    }

    if (body.startsWith("{==", offset)) {
      const close = body.indexOf("==}", offset + 3);
      if (close === -1) {
        offset += 1;
        continue;
      }

      const anchorText = body.slice(offset + 3, close);
      flushLiteral(offset);

      let cursor = close + 3;
      let ownerIndex: number | null = null;

      while (body.startsWith("{>>", cursor)) {
        const comment = parseCommentMarker(body, cursor);
        if (!comment) break;

        if (ownerIndex === null) {
          ownerIndex = pushMarker(
            createCommentDraft(comment, anchorText, null),
          );
        } else {
          pushMarker(createCommentDraft(comment, null, ownerIndex));
        }
        cursor = comment.endOffset;
      }

      if (ownerIndex === null) {
        parts.push(anchorText);
      }

      literalStart = cursor;
      offset = cursor;
      continue;
    }

    if (body.startsWith("{>>", offset)) {
      const comment = parseCommentMarker(body, offset);
      if (comment) {
        flushLiteral(offset);
        pushMarker(createCommentDraft(comment, null, null));
        literalStart = comment.endOffset;
        offset = comment.endOffset;
        continue;
      }
    }

    const suggestion = parseSuggestionMarker(body, offset);
    if (suggestion) {
      flushLiteral(offset);
      pushMarker(suggestion.draft);
      literalStart = suggestion.endOffset;
      offset = suggestion.endOffset;
      continue;
    }

    offset += 1;
  }

  flushLiteral(body.length);
  return { parts, markers };
}

interface ParsedCommentMarker {
  body: string;
  metadata: MarkerMetadata | null;
  endOffset: number;
}

function parseCommentMarker(
  body: string,
  offset: number,
): ParsedCommentMarker | null {
  const close = body.indexOf("<<}", offset + 3);
  if (close === -1) return null;

  const metadata = parseMarkerMetadata(body, close + 3);
  return {
    body: body.slice(offset + 3, close),
    metadata,
    endOffset: metadata?.endOffset ?? close + 3,
  };
}

function createCommentDraft(
  comment: ParsedCommentMarker,
  anchorText: string | null,
  parentIndex: number | null,
): MarkerDraft {
  return {
    kind: "comment",
    rawId: comment.metadata?.attributes.get("id") ?? null,
    attributes: comment.metadata?.attributes ?? new Map(),
    body: comment.body,
    anchorText,
    parentIndex,
  };
}

function parseSuggestionMarker(
  body: string,
  offset: number,
): { draft: MarkerDraft; endOffset: number } | null {
  const insertion = matchWrappedMarker(body, offset, "{++", "++}");
  if (insertion) {
    const metadata = parseMarkerMetadata(body, insertion.endOffset);
    return {
      draft: { kind: "insert", text: insertion.text, ...identity(metadata) },
      endOffset: metadata?.endOffset ?? insertion.endOffset,
    };
  }

  const deletion = matchWrappedMarker(body, offset, "{--", "--}");
  if (deletion) {
    const metadata = parseMarkerMetadata(body, deletion.endOffset);
    return {
      draft: { kind: "delete", text: deletion.text, ...identity(metadata) },
      endOffset: metadata?.endOffset ?? deletion.endOffset,
    };
  }

  const replacement = matchReplacementMarker(body, offset);
  if (replacement) {
    const metadata = parseMarkerMetadata(body, replacement.endOffset);
    return {
      draft: {
        kind: "replace",
        oldText: replacement.oldText,
        newText: replacement.newText,
        ...identity(metadata),
      },
      endOffset: metadata?.endOffset ?? replacement.endOffset,
    };
  }

  return null;
}

function identity(metadata: MarkerMetadata | null): MarkerDraftBase {
  return {
    rawId: metadata?.attributes.get("id") ?? null,
    attributes: metadata?.attributes ?? new Map(),
  };
}

function matchWrappedMarker(
  body: string,
  offset: number,
  open: string,
  close: string,
): { text: string; endOffset: number } | null {
  if (!body.startsWith(open, offset)) return null;

  const closeOffset = body.indexOf(close, offset + open.length);
  if (closeOffset === -1) return null;

  return {
    text: body.slice(offset + open.length, closeOffset),
    endOffset: closeOffset + close.length,
  };
}

function matchReplacementMarker(
  body: string,
  offset: number,
): { oldText: string; newText: string; endOffset: number } | null {
  if (!body.startsWith("{~~", offset)) return null;

  const separator = body.indexOf("~>", offset + 3);
  if (separator === -1) return null;

  const close = body.indexOf("~~}", separator + 2);
  if (close === -1) return null;

  return {
    oldText: body.slice(offset + 3, separator),
    newText: body.slice(separator + 2, close),
    endOffset: close + 3,
  };
}

interface MarkerMetadata {
  attributes: Map<string, string>;
  endOffset: number;
}

/**
 * Read the metadata a CriticMarkup marker carries: either a compact reference
 * such as `{#c1}` naming an endmatter entry, or an inline attribute block such
 * as `{id="c1" by="AI" at="…"}`.
 */
function parseMarkerMetadata(
  body: string,
  offset: number,
): MarkerMetadata | null {
  if (body[offset] !== "{") return null;

  const reference = body.slice(offset).match(/^\{#([A-Za-z][A-Za-z0-9_-]*)\}/);
  if (reference) {
    return {
      attributes: new Map([["id", reference[1] ?? ""]]),
      endOffset: offset + reference[0].length,
    };
  }

  return parseAttributeBlock(body, offset);
}

function parseAttributeBlock(
  body: string,
  offset: number,
): MarkerMetadata | null {
  const attributes = new Map<string, string>();
  let cursor = offset + 1;

  while (cursor < body.length) {
    while (body[cursor] === " " || body[cursor] === "\t") {
      cursor += 1;
    }

    if (body[cursor] === "}") {
      if (attributes.size === 0) return null;
      return { attributes, endOffset: cursor + 1 };
    }

    const nameStart = cursor;
    while (cursor < body.length && /[A-Za-z0-9_-]/.test(body[cursor] ?? "")) {
      cursor += 1;
    }

    const name = body.slice(nameStart, cursor);
    if (!name || body[cursor] !== "=" || body[cursor + 1] !== '"') return null;
    cursor += 2;

    const value = readAttributeValue(body, cursor);
    if (!value) return null;

    attributes.set(name, value.value);
    cursor = value.endOffset;
  }

  return null;
}

function readAttributeValue(
  body: string,
  offset: number,
): { value: string; endOffset: number } | null {
  let cursor = offset;
  let value = "";

  while (cursor < body.length) {
    const character = body[cursor];

    if (character === "\\") {
      const next = body[cursor + 1];
      if (next === undefined) return null;
      value += next;
      cursor += 2;
      continue;
    }

    if (character === '"') {
      return { value, endOffset: cursor + 1 };
    }

    if (character === "\n" || character === "\r") return null;
    value += character;
    cursor += 1;
  }

  return null;
}

/**
 * Build one record slot per marker, in body order, followed by one per legacy
 * endmatter entry no marker names. A marker naming an entry is merged with it,
 * so a document part-way through the old endmatter migration keeps both its
 * inline attributes and its endmatter fields; the inline attributes win where
 * both name the same key.
 */
function createRecordSlots(
  markers: readonly MarkerDraft[],
  legacy: LegacyEndmatter,
): RecordSlot[] {
  const slots: RecordSlot[] = [];
  const consumed = new Set<string>();

  markers.forEach((marker, markerIndex) => {
    const kind = marker.kind === "comment" ? "comment" : "suggestion";
    const entries = kind === "comment" ? legacy.comments : legacy.suggestions;
    const entry = marker.rawId === null ? undefined : entries.get(marker.rawId);

    if (marker.rawId !== null && entry) {
      consumed.add(rawIdKey(kind, marker.rawId));
    }

    slots.push({
      kind,
      rawId: marker.rawId,
      source: { ...(entry ?? {}), ...Object.fromEntries(marker.attributes) },
      markerIndex,
      id: null,
    });
  });

  for (const [kind, entries] of [
    ["comment", legacy.comments],
    ["suggestion", legacy.suggestions],
  ] as const) {
    for (const [rawId, entry] of entries) {
      if (consumed.has(rawIdKey(kind, rawId))) continue;

      slots.push({
        kind,
        rawId,
        source: { ...entry },
        markerIndex: null,
        id: null,
      });
    }
  }

  return slots;
}

function rawIdKey(kind: "comment" | "suggestion", rawId: string): string {
  return `${kind}:${rawId}`;
}

/**
 * Give every slot an id: the canonical form of the id it already carries, where
 * that id is free, and a freshly allocated one otherwise.
 *
 * The allocator is seeded once every mapped id is in the document, so a
 * document already containing `rd-c1` from a mapped `{#c1}` cannot have
 * `rd-c1` allocated on top of it. Each slot's placeholder record goes into the
 * document as its id is taken, because the document must hold a record for
 * every slot the migration is about to fill in.
 */
function assignRecordIds(slots: RecordSlot[], document: RfmDocument): void {
  const taken = new Set<string>();
  for (const anchor of document.anchors) {
    taken.add(anchor.id);
  }
  for (const id of document.comments.keys()) {
    taken.add(id);
  }
  for (const id of document.suggestions.keys()) {
    taken.add(id);
  }

  for (const slot of slots) {
    const number = rawIdNumber(slot.rawId);
    if (number === null) continue;

    if (slot.kind === "comment") {
      const id = parseCommentId(`rd-c${number}`);
      if (!id || taken.has(id)) continue;
      slot.id = id;
      taken.add(id);
      document.comments.set(id, placeholderComment());
    } else {
      const id = parseSuggestionId(`rd-s${number}`);
      if (!id || taken.has(id)) continue;
      slot.id = id;
      taken.add(id);
      document.suggestions.set(id, placeholderSuggestion());
    }
  }

  const ids = new RecordIdAllocator(document);

  for (const slot of slots) {
    if (slot.id !== null) continue;

    if (slot.kind === "comment") {
      const id = ids.allocateCommentId();
      slot.id = id;
      document.comments.set(id, placeholderComment());
    } else {
      const id = ids.allocateSuggestionId();
      slot.id = id;
      document.suggestions.set(id, placeholderSuggestion());
    }
  }
}

/**
 * The number in a raw CriticMarkup id. The record's kind decides the letter, so
 * a suggestion written as `{#c4}` still becomes `rd-s4`.
 */
function rawIdNumber(rawId: string | null): string | null {
  if (rawId === null) return null;

  const match = rawId.match(RAW_ID_NUMBER_PATTERN);
  return match?.[1] ?? null;
}

/**
 * A record that holds an id in the document being built so no later allocation
 * reuses it. The record itself is written once every id is known.
 */
function placeholderComment(): CommentRecord {
  return { body: "", by: UNKNOWN_AUTHOR, at: "", metadata: {} };
}

function placeholderSuggestion(): SuggestionRecord {
  return { by: UNKNOWN_AUTHOR, at: "", metadata: {} };
}

function createCommentRecord(
  slot: RecordSlot & { kind: "comment" },
  markers: readonly MarkerDraft[],
  idsByRawId: ReadonlyMap<string, RecordId>,
  idsByMarker: ReadonlyMap<number, RecordId>,
  migratedAt: string,
): CommentRecord {
  const { source } = slot;
  const marker =
    slot.markerIndex === null ? null : (markers[slot.markerIndex] ?? null);
  const metadata = unrecognizedKeys(source, COMMENT_KEYS);
  const markerBody =
    marker && marker.kind === "comment" ? marker.body.trim() : "";

  const record: CommentRecord = {
    body: markerBody || (readString(source.body) ?? ""),
    by: readString(source.by) ?? UNKNOWN_AUTHOR,
    at: readString(source.at) ?? migratedAt,
    metadata,
  };

  const re = resolveReply(slot, marker, idsByRawId, idsByMarker);
  if (re) {
    record.re = re;
  } else if (readString(source.scope) === "document" || marker === null) {
    // A record with no anchor and no parent is retained only as a document
    // comment, which is what an endmatter-only entry always was.
    record.scope = "document";
  }

  applyResolution(record, source, metadata);
  return record;
}

function createSuggestionRecord(
  slot: RecordSlot & { kind: "suggestion" },
  migratedAt: string,
): SuggestionRecord {
  const { source } = slot;
  const metadata = unrecognizedKeys(source, SUGGESTION_KEYS);
  const record: SuggestionRecord = {
    by: readString(source.by) ?? UNKNOWN_AUTHOR,
    at: readString(source.at) ?? migratedAt,
    metadata,
  };

  applyResolution(record, source, metadata);
  return record;
}

function applyResolution(
  record: { status?: "resolved"; resolved?: string },
  source: Record<string, unknown>,
  metadata: Record<string, unknown>,
): void {
  const status = readString(source.status);
  if (status === "resolved") {
    record.status = "resolved";
  } else if (status !== undefined) {
    metadata.status = status;
  }

  const resolved = readString(source.resolved);
  if (resolved !== undefined) {
    record.resolved = resolved;
  }
}

/**
 * Resolve the record a comment replies to: the id its `re` names, mapped
 * through the same id mapping the records themselves went through, or the
 * comment it trails when several comments follow one `{==…==}` highlight.
 *
 * An `re` naming a record the document does not contain is dropped, leaving a
 * top-level comment, because a reply pointing at nothing is not expressible.
 */
function resolveReply(
  slot: RecordSlot,
  marker: MarkerDraft | null,
  idsByRawId: ReadonlyMap<string, RecordId>,
  idsByMarker: ReadonlyMap<number, RecordId>,
): RecordId | undefined {
  const raw = readString(slot.source.re);
  if (raw !== undefined) {
    return (
      idsByRawId.get(rawIdKey("comment", raw)) ??
      idsByRawId.get(rawIdKey("suggestion", raw))
    );
  }

  if (!marker || marker.kind !== "comment" || marker.parentIndex === null) {
    return undefined;
  }

  return idsByMarker.get(marker.parentIndex);
}

function unrecognizedKeys(
  source: Record<string, unknown>,
  recognized: readonly string[],
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === "id" || recognized.includes(key)) continue;
    metadata[key] = value;
  }

  return metadata;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** One anchored highlight in a rendered body, and where its text sits in it. */
interface AnchoredHighlight {
  markerIndex: number;
  id: RecordId;
  /** Offset of the anchor element itself, where a diagnostic points. */
  offset: number;
  /** The highlighted text the anchor wraps, as offsets into the rendered body. */
  content: OffsetRange;
}

interface RenderedBody {
  body: string;
  highlights: AnchoredHighlight[];
}

/**
 * Assemble the migrated body from the literal text between markers and the
 * anchor each marker becomes.
 *
 * An anchor is inline content within one block, so a legacy highlight that ran
 * across a block boundary is not expressible as one anchor. The body is
 * rendered once with every highlight anchored whole, the blocks of that text
 * are read from the index that owns where a block begins and ends, and any
 * highlight that overran the block its text starts in is rendered again with
 * the anchor closed at the block's end. The rest of the highlight stays in the
 * body as ordinary Markdown: no text moves or is duplicated, and the comment
 * stays attached to text the reviewer selected.
 */
function renderBody(
  parts: readonly BodyPart[],
  markers: readonly MarkerDraft[],
  idsByMarker: ReadonlyMap<number, RecordId>,
  replyMarkers: ReadonlySet<number>,
): { body: string; diagnostics: RfmDiagnostic[] } {
  const whole = renderParts(parts, markers, idsByMarker, replyMarkers, null);
  const anchoredLengths = anchorableLengths(whole);
  if (anchoredLengths.size === 0) {
    return { body: whole.body, diagnostics: [] };
  }

  const truncated = renderParts(
    parts,
    markers,
    idsByMarker,
    replyMarkers,
    anchoredLengths,
  );
  const lineStarts = createLineStarts(truncated.body);

  return {
    body: truncated.body,
    diagnostics: truncated.highlights
      .filter((highlight) => anchoredLengths.has(highlight.markerIndex))
      .map((highlight) =>
        createDiagnostic(
          lineStarts,
          "warning",
          migrateAnchorTruncatedCode,
          `Comment \`${highlight.id}\` highlighted text running across a block boundary, which no anchor can span; it is anchored to the part within the first block and the rest stays in the body.`,
          highlight.offset,
        ),
      ),
  };
}

/**
 * How much of each highlight its anchor may cover, for the highlights that
 * cannot be covered whole. A highlight absent from the result is anchored as it
 * stands.
 */
function anchorableLengths(rendered: RenderedBody): Map<number, number> {
  const literals = createLiteralSpanIndex(rendered.body);
  const lengths = new Map<number, number>();

  for (const highlight of rendered.highlights) {
    const block = literals.blockAt(highlight.content.start);
    if (!block || block.end >= highlight.content.end) continue;

    lengths.set(highlight.markerIndex, block.end - highlight.content.start);
  }

  return lengths;
}

function renderParts(
  parts: readonly BodyPart[],
  markers: readonly MarkerDraft[],
  idsByMarker: ReadonlyMap<number, RecordId>,
  replyMarkers: ReadonlySet<number>,
  anchoredLengths: ReadonlyMap<number, number> | null,
): RenderedBody {
  let body = "";
  const highlights: AnchoredHighlight[] = [];

  for (const part of parts) {
    if (typeof part === "string") {
      body += part;
      continue;
    }

    const marker = markers[part.markerIndex];
    const id = idsByMarker.get(part.markerIndex);
    if (!marker || id === undefined) continue;

    const rendered = renderMarker(
      marker,
      id,
      replyMarkers.has(part.markerIndex),
      anchoredLengths?.get(part.markerIndex) ?? null,
    );

    if (rendered.content) {
      highlights.push({
        markerIndex: part.markerIndex,
        id,
        offset: body.length,
        content: {
          start: body.length + rendered.content.start,
          end: body.length + rendered.content.end,
        },
      });
    }

    body += rendered.text;
  }

  return { body, highlights };
}

/**
 * The text one marker becomes, and where within it the anchored highlight sits.
 *
 * `content` is null for every marker that anchors no highlighted text, so only
 * an anchored comment is subject to the block-boundary rule. `anchoredLength`
 * closes the anchor early, leaving the rest of the highlight after it.
 */
interface RenderedMarker {
  text: string;
  content: OffsetRange | null;
}

function renderMarker(
  marker: MarkerDraft,
  id: RecordId,
  isReply: boolean,
  anchoredLength: number | null,
): RenderedMarker {
  switch (marker.kind) {
    case "comment": {
      // A reply carries no anchor of its own; text it highlighted stays in the
      // body as ordinary Markdown.
      if (isReply) return { text: marker.anchorText ?? "", content: null };
      if (marker.anchorText === null) {
        return { text: `<span id="${id}"></span>`, content: null };
      }

      const open = `<span id="${id}">`;
      const anchored =
        anchoredLength === null
          ? marker.anchorText
          : marker.anchorText.slice(0, anchoredLength);

      return {
        text: `${open}${anchored}</span>${marker.anchorText.slice(anchored.length)}`,
        content: { start: open.length, end: open.length + anchored.length },
      };
    }
    case "insert":
      return { text: `<ins id="${id}">${marker.text}</ins>`, content: null };
    case "delete":
      return { text: `<del id="${id}">${marker.text}</del>`, content: null };
    case "replace":
      return {
        text: `<span id="${id}"><del>${marker.oldText}</del><ins>${marker.newText}</ins></span>`,
        content: null,
      };
    default: {
      const unreachable: never = marker;
      return unreachable;
    }
  }
}
