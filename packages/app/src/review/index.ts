import {
  appendYamlEndmatter,
  type CommentId,
  type CommentRecord,
  collectOrphanedRecords,
  parseCommentId,
  parseDocument,
  parseRecordId,
  parseSuggestionId,
  type RecordIdAllocator,
  type RfmDocument,
  type SuggestionId,
  type SuggestionRecord,
  serializeDocument,
} from "@roughdraft/rfm";
import { generateHTML, generateJSON, type JSONContent } from "@tiptap/core";
import type TurndownService from "turndown";
import {
  createEditorExtensions,
  type SuggestionAttrs,
  type SuggestionKind,
} from "../editor-extensions";
import {
  createTurndownService,
  EMPTY_ANCHOR_SENTINEL,
  htmlToMarkdown,
  type MarkdownOptions,
  protectRichTextRoundTripMarkdown,
  renderMarkdownToHtml,
} from "../markdown";

/**
 * A review comment as the editor and the review rail hold it: one endmatter
 * `CommentRecord` plus the id it is filed under. `content` is the record's
 * `body`, `authorType`/`authorId` are the two readings of the record's `by`,
 * and `parentCommentId` is the record's `re`.
 *
 * `status` and `resolved` are the record's own fields, set on a thread root
 * alone: `status` marks the thread addressed and `resolved` is the short
 * resolution summary.
 */
export interface ReviewComment {
  id: string;
  content: string;
  createdAt: string;
  authorType?: "user" | "ai";
  authorId?: string | null;
  parentCommentId?: string | null;
  scope?: "document";
  status?: "resolved";
  resolved?: string;
}

export interface ReviewCommentThread {
  comment: ReviewComment;
  replies: ReviewCommentThread[];
}

export type { SuggestionAttrs, SuggestionKind };

/**
 * Something {@link editorStateToReviewMarkdown} has to tell the reviewer about
 * the save it is performing.
 *
 * `review-unpaired-replacement` is a fault in the editor state: DOM no command
 * in the app can produce. It never describes document input — a file's own
 * faults are diagnosed by `parseDocument`.
 *
 * `review-orphaned-record` is not a fault. The reviewer deleted the text a
 * record was anchored to, and the record goes with it; they are told which
 * records the edit cost them.
 */
export type ReviewDiagnostic =
  | {
      code: "review-unpaired-replacement";
      message: string;
      suggestionId: string | null;
    }
  | {
      code: "review-orphaned-record";
      message: string;
      recordId: string;
    };

export type ReviewDiagnosticHandler = (diagnostic: ReviewDiagnostic) => void;

const extensions = createEditorExtensions("");

/** Attribute the suggestion mark puts on both halves of a replacement pair. */
const REPLACEMENT_ATTRIBUTE = "data-rd-replace";

/**
 * Attribute the comment anchor mark uses to carry every id but the outermost,
 * because one element cannot express several anchors covering one range.
 */
const NESTED_IDS_ATTRIBUTE = "data-rd-nested";

const AI_AUTHOR_FIELD = "AI";
const DEFAULT_AUTHOR_FIELD = "user";

function reportDiagnostic(
  handler: ReviewDiagnosticHandler | undefined,
  diagnostic: ReviewDiagnostic,
): void {
  if (handler) {
    handler(diagnostic);
    return;
  }

  console.warn(`[review] ${diagnostic.code}: ${diagnostic.message}`);
}

/** What a record id is called in a message a reviewer reads. */
function recordKindName(recordId: string): string {
  return parseCommentId(recordId) ? "Comment" : "Suggestion";
}

function stripEmptyAnchorSentinel(content: string): string {
  return content.replaceAll(EMPTY_ANCHOR_SENTINEL, "");
}

/** The endmatter `by` field for an attributed record. */
function authorField(attribution: {
  authorType?: "user" | "ai";
  authorId?: string | null;
}): string {
  return attribution.authorType === "ai"
    ? AI_AUTHOR_FIELD
    : attribution.authorId || DEFAULT_AUTHOR_FIELD;
}

/** The two app-side readings of an endmatter `by` field. */
function attribution(by: string | undefined): {
  authorType: "user" | "ai";
  authorId: string | null;
} {
  const field = by || DEFAULT_AUTHOR_FIELD;
  const isAi = field.toUpperCase() === AI_AUTHOR_FIELD;

  return { authorType: isAi ? "ai" : "user", authorId: isAi ? null : field };
}

function reviewCommentFromRecord(
  id: string,
  record: CommentRecord,
): ReviewComment {
  return {
    id,
    content: record.body,
    createdAt: record.at,
    ...attribution(record.by),
    parentCommentId: record.re ?? null,
    scope: record.scope,
    status: record.status,
    resolved: record.resolved,
  };
}

function reviewCommentsFromDocument(
  document: RfmDocument,
): Map<string, ReviewComment> {
  const comments = new Map<string, ReviewComment>();

  for (const [id, record] of document.comments) {
    comments.set(id, reviewCommentFromRecord(id, record));
  }

  return comments;
}

function commentRecordFrom(
  comment: ReviewComment,
  existing?: CommentRecord,
): CommentRecord {
  const record: CommentRecord = {
    ...existing,
    body: comment.content,
    by: authorField(comment),
    at: comment.createdAt,
    metadata: existing?.metadata ?? {},
  };
  const parentId = comment.parentCommentId
    ? parseRecordId(comment.parentCommentId)
    : null;

  if (parentId) {
    record.re = parentId;
    delete record.scope;
  } else {
    delete record.re;
    if (comment.scope === "document") {
      record.scope = "document";
    } else {
      delete record.scope;
    }
  }

  if (comment.status === "resolved") {
    record.status = "resolved";
  } else {
    delete record.status;
  }

  if (comment.resolved) {
    record.resolved = comment.resolved;
  } else {
    delete record.resolved;
  }

  return record;
}

function suggestionRecordFrom(
  suggestion: SuggestionAttrs,
  existing?: SuggestionRecord,
): SuggestionRecord {
  return {
    ...existing,
    by: authorField(suggestion),
    at: suggestion.createdAt,
    metadata: existing?.metadata ?? {},
  };
}

/**
 * Render a document body to HTML. Anchors are inline HTML, which marked passes
 * through untouched, so the renderer needs no extension for them: the anchor
 * elements arrive in the HTML exactly as the file wrote them.
 */
function renderBodyHtml(
  document: RfmDocument,
  markdownOptions?: MarkdownOptions,
): string {
  return renderMarkdownToHtml(
    protectRichTextRoundTripMarkdown(document.body),
    markdownOptions,
  );
}

interface ParsedReviewDocument {
  document: RfmDocument;
  comments: Map<string, ReviewComment>;
  frontmatter: string | null;
  /**
   * The source file's final endmatter block as written, from its `---`
   * delimiter, or null. It is carried back into
   * {@link editorStateToReviewMarkdown} so keys the app has no field for
   * survive a save.
   */
  endmatter: string | null;
}

function readReviewDocument(markdown: string): ParsedReviewDocument {
  const document = parseDocument(markdown);

  return {
    document,
    comments: reviewCommentsFromDocument(document),
    frontmatter: document.frontmatter,
    // `endmatterBlock` begins with the newline before its delimiter; the blank
    // line between body and block is `appendYamlEndmatter`'s to write.
    endmatter: document.endmatterBlock?.replace(/^\n/, "") ?? null,
  };
}

export function createReviewComment(
  partial: Partial<ReviewComment> | undefined,
  options: { ids: RecordIdAllocator },
): ReviewComment {
  const authorType = partial?.authorType ?? "user";

  return {
    id: partial?.id ?? options.ids.allocateCommentId(),
    content: partial?.content ?? "",
    createdAt: partial?.createdAt ?? new Date().toISOString(),
    authorType,
    authorId: partial?.authorId ?? (authorType === "ai" ? null : "user"),
    parentCommentId: partial?.parentCommentId ?? null,
    scope: partial?.scope,
  };
}

export function createSuggestion(
  kind: SuggestionKind,
  partial: Partial<SuggestionAttrs> | undefined,
  options: { ids: RecordIdAllocator },
): SuggestionAttrs {
  const authorType = partial?.authorType ?? "user";

  return {
    kind,
    suggestionId: partial?.suggestionId ?? options.ids.allocateSuggestionId(),
    createdAt: partial?.createdAt ?? new Date().toISOString(),
    authorType,
    authorId: partial?.authorId ?? (authorType === "ai" ? null : "user"),
  };
}

function buildCommentThreadsFromOrderedComments(
  orderedComments: ReviewComment[],
): ReviewCommentThread[] {
  const validCommentIds = new Set(orderedComments.map((comment) => comment.id));
  const repliesByParentId = new Map<string, ReviewComment[]>();
  const rootComments: ReviewComment[] = [];

  for (const comment of orderedComments) {
    const parentCommentId = comment.parentCommentId;

    if (!parentCommentId || !validCommentIds.has(parentCommentId)) {
      rootComments.push(comment);
      continue;
    }

    const replies = repliesByParentId.get(parentCommentId) ?? [];
    replies.push(comment);
    repliesByParentId.set(parentCommentId, replies);
  }

  const buildNode = (comment: ReviewComment): ReviewCommentThread => ({
    comment,
    replies: (repliesByParentId.get(comment.id) ?? []).map(buildNode),
  });

  return rootComments.map(buildNode);
}

export function buildCommentThreads(
  comments: Iterable<ReviewComment>,
): ReviewCommentThread[] {
  return buildCommentThreadsFromOrderedComments([...comments]);
}

export function flattenCommentThreads(
  threads: Iterable<ReviewCommentThread>,
): ReviewComment[] {
  const orderedComments: ReviewComment[] = [];

  const visit = (thread: ReviewCommentThread) => {
    orderedComments.push(thread.comment);
    for (const reply of thread.replies) {
      visit(reply);
    }
  };

  for (const thread of threads) {
    visit(thread);
  }

  return orderedComments;
}

/**
 * The ids of whole threads, given the ids an anchor carries.
 *
 * Only a thread's root is anchored, so every caller that starts from anchored
 * ids — the rail, the fallback banner, the selection — has to reach the replies
 * this way or show a root with none of its answers. A comment reached both
 * directly and as a descendant appears once.
 */
export function expandCommentThreadIds(
  anchoredIds: string[],
  comments: ReadonlyMap<string, ReviewComment>,
): string[] {
  return [
    ...new Set(
      anchoredIds.flatMap((commentId) => [
        commentId,
        ...getCommentDescendantIds(commentId, comments),
      ]),
    ),
  ];
}

/**
 * The comments an anchor carries, each root comment followed by its replies in
 * depth-first order.
 */
export function getOrderedAnchorComments(
  commentIds: string[],
  comments: ReadonlyMap<string, ReviewComment>,
): ReviewComment[] {
  const visibleComments = expandCommentThreadIds(commentIds, comments)
    .map((commentId) => comments.get(commentId))
    .filter((comment): comment is ReviewComment => Boolean(comment));

  return flattenCommentThreads(buildCommentThreads(visibleComments));
}

/**
 * Every comment below `commentId` in its thread, in depth-first order.
 *
 * The walk is bounded because the reply links cannot form a cycle: the parser
 * breaks every cycle it reads, and the only other way a comment gets a parent
 * is {@link createReviewComment}, which attaches a freshly allocated id to a
 * parent that already exists.
 */
export function getCommentDescendantIds(
  commentId: string,
  comments: ReadonlyMap<string, ReviewComment>,
): string[] {
  const childrenByParentId = new Map<string, string[]>();

  for (const comment of comments.values()) {
    if (!comment.parentCommentId) continue;

    const childIds = childrenByParentId.get(comment.parentCommentId) ?? [];
    childIds.push(comment.id);
    childrenByParentId.set(comment.parentCommentId, childIds);
  }

  const descendantIds: string[] = [];
  const stack = [...(childrenByParentId.get(commentId) ?? [])].reverse();

  while (stack.length > 0) {
    const nextCommentId = stack.pop();
    if (!nextCommentId) continue;

    descendantIds.push(nextCommentId);

    const childIds = childrenByParentId.get(nextCommentId) ?? [];
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      const childId = childIds[index];
      if (childId) {
        stack.push(childId);
      }
    }
  }

  return descendantIds;
}

/** The suggestion an editor-rendered anchor element stands for. */
interface ElementSuggestionAttrs {
  kind: SuggestionKind;
  suggestionId: string;
}

/**
 * The suggestion an anchor element stands for, read from the element alone.
 * The DOM carries the id and the operation; `by` and `at` live on the mark and
 * reach the endmatter through {@link collectSuggestionsFromDoc}.
 */
function getElementSuggestionAttrs(
  element: HTMLElement,
): ElementSuggestionAttrs | null {
  const replacementId = element.getAttribute(REPLACEMENT_ATTRIBUTE);

  if (replacementId) {
    const suggestionId = parseSuggestionId(replacementId);
    if (!suggestionId) return null;

    if (element.nodeName === "DEL") {
      return { kind: "replace-old", suggestionId };
    }
    if (element.nodeName === "INS") {
      return { kind: "replace-new", suggestionId };
    }

    return null;
  }

  const suggestionId = parseSuggestionId(element.getAttribute("id") ?? "");
  if (!suggestionId) return null;

  if (element.nodeName === "INS") return { kind: "insert", suggestionId };
  if (element.nodeName === "DEL") return { kind: "delete", suggestionId };

  return null;
}

/**
 * The comment ids an anchor element carries: its own `id` first, then the ids
 * the mark could not give elements of their own.
 */
function getElementCommentIds(element: HTMLElement): string[] {
  const outermostId = parseCommentId(element.getAttribute("id") ?? "");
  if (!outermostId) return [];

  const nestedText = element.getAttribute(NESTED_IDS_ATTRIBUTE);
  if (!nestedText) return [outermostId];

  let parsed: unknown;

  try {
    parsed = JSON.parse(nestedText);
  } catch {
    return [outermostId];
  }

  if (!Array.isArray(parsed)) return [outermostId];

  const nestedIds = parsed
    .map((value) => (typeof value === "string" ? parseCommentId(value) : null))
    .filter((id): id is CommentId => Boolean(id));

  return [outermostId, ...nestedIds];
}

function isCommentAnchorElement(element: Element): boolean {
  return (
    element.nodeName === "SPAN" &&
    Boolean(parseCommentId(element.getAttribute("id") ?? ""))
  );
}

/**
 * The child that covers exactly the same range as `element`: its only child,
 * itself a comment anchor. Nesting over a narrower range is legal in the
 * format but cannot be carried by one mark, so it is left alone here.
 */
function soleNestedCommentAnchor(element: Element): Element | null {
  if (element.childNodes.length !== 1) return null;

  const child = element.firstElementChild;

  return child && isCommentAnchorElement(child) ? child : null;
}

/**
 * Collapse comment anchors that nest over one range into a single element
 * carrying the outermost id and {@link NESTED_IDS_ATTRIBUTE}, which is the
 * shape the `commentAnchor` mark parses. Serializing expands it again.
 */
function collapseNestedCommentAnchors(container: ParentNode): void {
  const collapse = (element: Element) => {
    if (isCommentAnchorElement(element)) {
      const nestedIds: string[] = [];
      let innermost = element;

      for (
        let nested = soleNestedCommentAnchor(innermost);
        nested;
        nested = soleNestedCommentAnchor(innermost)
      ) {
        nestedIds.push(nested.getAttribute("id") ?? "");
        innermost = nested;
      }

      if (nestedIds.length > 0) {
        const innerHtml = innermost.innerHTML;
        element.setAttribute(NESTED_IDS_ATTRIBUTE, JSON.stringify(nestedIds));
        element.innerHTML = innerHtml;
      }
    }

    for (const child of [...element.children]) {
      collapse(child);
    }
  };

  for (const child of [...container.children]) {
    collapse(child);
  }
}

/**
 * Split each `<span id="rd-sN"><del>old</del><ins>new</ins></span>` into the
 * two adjacent halves the `suggestion` mark parses. The mark cannot span both
 * halves as one range, so the id moves onto each half and the wrapping span
 * goes; serializing rebuilds it.
 */
function expandReplacementAnchors(container: ParentNode): void {
  for (const element of [...container.querySelectorAll("span[id]")]) {
    const suggestionId = parseSuggestionId(element.getAttribute("id") ?? "");
    if (!suggestionId) continue;

    const [oldHalf, newHalf] = element.children;

    if (
      element.children.length !== 2 ||
      oldHalf?.nodeName !== "DEL" ||
      newHalf?.nodeName !== "INS"
    ) {
      continue;
    }

    oldHalf.setAttribute(REPLACEMENT_ATTRIBUTE, suggestionId);
    newHalf.setAttribute(REPLACEMENT_ATTRIBUTE, suggestionId);
    element.replaceWith(oldHalf, newHalf);
  }
}

function isAnchorElement(element: Element): boolean {
  const id = element.getAttribute("id") ?? "";

  return Boolean(parseCommentId(id) ?? parseSuggestionId(id));
}

/**
 * Give an anchor with no text of its own the sentinel to cover. A mark needs a
 * range, and a point anchor — `<span id="rd-cN"></span>` — has none, so it
 * would be dropped on the way into the editor. Serializing strips the sentinel
 * again.
 */
function fillEmptyAnchors(container: ParentNode): void {
  for (const element of [
    ...container.querySelectorAll("span[id], ins[id], del[id]"),
  ]) {
    if (!isAnchorElement(element) || element.childNodes.length > 0) continue;

    element.textContent = EMPTY_ANCHOR_SENTINEL;
  }
}

/**
 * Rewrite the document's anchor elements into the DOM shapes the editor marks
 * parse. Both shapes differ from the format's only where a ProseMirror mark
 * cannot carry the format's, and both are undone when the editor state is
 * serialized.
 */
function toEditorAnchorHtml(html: string): string {
  const container = window.document.createElement("template");
  container.innerHTML = html;
  fillEmptyAnchors(container.content);
  expandReplacementAnchors(container.content);
  collapseNestedCommentAnchors(container.content);

  return container.innerHTML;
}

/**
 * Expand a collapsed comment anchor back into nested `<span>` anchors,
 * outermost id first, all covering the same range.
 *
 * A comment anchor carrying a single id has no nesting to expand and is
 * serialized by the `rfmAnchorElement` rule in `createTurndownService`.
 */
function addNestedCommentAnchorRule(service: TurndownService): void {
  service.addRule("rfmNestedCommentAnchor", {
    filter: (node) =>
      node.nodeName === "SPAN" &&
      (node as HTMLElement).hasAttribute(NESTED_IDS_ATTRIBUTE),
    replacement(content, node) {
      const element = node as HTMLElement;
      const commentIds = getElementCommentIds(element);
      const text = stripEmptyAnchorSentinel(content);

      if (commentIds.length === 0) return text;

      let result = text;

      for (let index = commentIds.length - 1; index >= 0; index -= 1) {
        result = `<span id="${commentIds[index]}">${result}</span>`;
      }

      return result;
    },
  });
}

function isReplacementHalf(
  element: Element | null,
  nodeName: "DEL" | "INS",
  suggestionId: string,
): boolean {
  return (
    element instanceof HTMLElement &&
    element.nodeName === nodeName &&
    element.getAttribute(REPLACEMENT_ATTRIBUTE) === suggestionId
  );
}

/**
 * Serialize the two adjacent halves of a replacement as the single
 * `<span id="rd-sN"><del>old</del><ins>new</ins></span>` the format defines.
 * The `<del>` emits the whole element; its paired `<ins>` emits nothing.
 *
 * This rule is registered after `createTurndownService` has added its own, so
 * it is reached before `markdownStrikethrough`, which would otherwise rewrite
 * an unidentified `<del>` half as `~~old~~`.
 */
function addReplacementPairRule(
  service: TurndownService,
  onDiagnostic?: ReviewDiagnosticHandler,
): void {
  service.addRule("rfmReplacementPair", {
    filter: (node) =>
      (node.nodeName === "DEL" || node.nodeName === "INS") &&
      (node as HTMLElement).hasAttribute(REPLACEMENT_ATTRIBUTE),
    replacement(content, node) {
      const element = node as HTMLElement;
      // Not trimmed, matching the comment-anchor rule above: the format
      // requires a suggestion's text to survive exactly, whitespace at its
      // edges included, and a trailing hard break lives in that whitespace.
      const text = stripEmptyAnchorSentinel(content);
      const attrs = getElementSuggestionAttrs(element);

      if (!attrs) {
        reportDiagnostic(onDiagnostic, {
          code: "review-unpaired-replacement",
          message: `A <${element.nodeName.toLowerCase()}> replacement half carries "${element.getAttribute(
            REPLACEMENT_ATTRIBUTE,
          )}", which is not a suggestion id. Its text is kept and the suggestion is dropped.`,
          suggestionId: null,
        });
        return text;
      }

      if (attrs.kind === "replace-new") {
        if (
          isReplacementHalf(
            element.previousElementSibling,
            "DEL",
            attrs.suggestionId,
          )
        ) {
          return "";
        }

        reportDiagnostic(onDiagnostic, {
          code: "review-unpaired-replacement",
          message: `The new half of replacement ${attrs.suggestionId} has no preceding old half. Its text is kept and the suggestion is dropped.`,
          suggestionId: attrs.suggestionId,
        });
        return text;
      }

      const nextElement = element.nextElementSibling;

      if (!isReplacementHalf(nextElement, "INS", attrs.suggestionId)) {
        reportDiagnostic(onDiagnostic, {
          code: "review-unpaired-replacement",
          message: `The old half of replacement ${attrs.suggestionId} has no following new half. Its text is kept and the suggestion is dropped.`,
          suggestionId: attrs.suggestionId,
        });
        return text;
      }

      const newText = stripEmptyAnchorSentinel(
        service.turndown((nextElement as HTMLElement).innerHTML),
      );

      return `<span id="${attrs.suggestionId}"><del>${text}</del><ins>${newText}</ins></span>`;
    },
  });
}

/**
 * True when the document carries anything the review rail renders: an anchor
 * in the body, or a comment or suggestion record in the endmatter.
 */
export function reviewMarkdownHasReviewRail(markdown: string): boolean {
  const document = parseDocument(markdown);

  return (
    document.anchors.length > 0 ||
    document.comments.size > 0 ||
    document.suggestions.size > 0
  );
}

export function reviewMarkdownToRenderedHtml(
  markdown: string,
  options?: MarkdownOptions,
): {
  html: string;
  comments: Map<string, ReviewComment>;
  frontmatter: string | null;
  endmatter: string | null;
} {
  const { document, comments, frontmatter, endmatter } =
    readReviewDocument(markdown);

  return {
    html: renderBodyHtml(document, options),
    comments,
    frontmatter,
    endmatter,
  };
}

export function reviewMarkdownToEditorState(
  markdown: string,
  options?: MarkdownOptions,
): {
  doc: JSONContent;
  comments: Map<string, ReviewComment>;
  frontmatter: string | null;
  endmatter: string | null;
  /**
   * The parsed source, which a caller holding an editor needs to seed or
   * reserve the ids its own allocations must not collide with.
   */
  document: RfmDocument;
} {
  const { document, comments, frontmatter, endmatter } =
    readReviewDocument(markdown);
  const html = renderBodyHtml(document, options);
  const doc = generateJSON(
    toEditorAnchorHtml(html),
    extensions,
  ) as JSONContent & {
    yamlFrontmatter?: string;
    yamlEndmatter?: string;
  };

  applySuggestionAttribution(doc, document.suggestions);

  if (frontmatter) {
    doc.yamlFrontmatter = frontmatter;
  }
  if (endmatter) {
    doc.yamlEndmatter = endmatter;
  }

  return { doc, comments, frontmatter, endmatter, document };
}

/**
 * Copy each suggestion record's `by` and `at` onto its marks.
 *
 * The anchor element carries only the operation and the id, so attribution
 * reaches the editor by this route alone. It has to happen on the way in:
 * `collectSuggestionsFromDoc` reads the marks and nothing else, so a mark left
 * without `createdAt` yields no record and the suggestion is dropped from the
 * endmatter the next time the document is written.
 */
function applySuggestionAttribution(
  doc: JSONContent,
  records: ReadonlyMap<string, SuggestionRecord>,
): void {
  const visit = (node: JSONContent) => {
    for (const mark of node.marks ?? []) {
      if (mark.type !== "suggestion") continue;

      const attrs = mark.attrs as Partial<SuggestionAttrs> | undefined;
      const record = attrs?.suggestionId
        ? records.get(attrs.suggestionId)
        : undefined;

      if (!attrs || !record) continue;

      attrs.createdAt = record.at;
      Object.assign(attrs, attribution(record.by));
    }

    for (const child of node.content ?? []) visit(child);
  };

  visit(doc);
}

/**
 * Every suggestion the editor state holds, keyed by id. The anchor elements
 * carry the operation; the mark is the only carrier of `by` and `at`, so the
 * endmatter records are built from here rather than from the serialized body.
 * Both halves of a replacement carry the same id and attribution, so a
 * replacement yields one record.
 */
function collectSuggestionsFromDoc(
  doc: JSONContent,
): Map<string, SuggestionAttrs> {
  const suggestions = new Map<string, SuggestionAttrs>();
  const visit = (node: JSONContent) => {
    for (const mark of node.marks ?? []) {
      if (mark.type !== "suggestion") continue;

      const attrs = mark.attrs as Partial<SuggestionAttrs> | undefined;
      if (attrs?.suggestionId && attrs.kind && attrs.createdAt) {
        suggestions.set(attrs.suggestionId, {
          kind: attrs.kind,
          suggestionId: attrs.suggestionId,
          createdAt: attrs.createdAt,
          authorType: attrs.authorType ?? "user",
          authorId: attrs.authorId ?? null,
        });
      }
    }

    for (const child of node.content ?? []) {
      visit(child);
    }
  };

  visit(doc);
  return suggestions;
}

/**
 * Write the editor state back as Roughdraft Flavored Markdown. Every save in
 * the app goes through this function.
 *
 * Preserved:
 * - Every anchor element the editor holds, with its id, and the replacement
 *   pair rebuilt as one `<span id="rd-sN"><del>…</del><ins>…</ins></span>`.
 * - Comment anchors nesting over one range, re-expanded to nested `<span>`s
 *   with the outermost id first.
 * - The frontmatter block, byte for byte.
 * - Endmatter keys this module has no field for: unrecognized top-level keys,
 *   and unrecognized keys inside a comment or suggestion record, including a
 *   suggestion's `status` and `resolved`. They survive because
 *   `options.endmatter` is reparsed and each record is rewritten onto the one
 *   already there. A comment's `status` and `resolved` are fields of
 *   {@link ReviewComment} and are written from it.
 * - A trailing YAML block with no `roughdraft` key, which is document content
 *   and stays in the body.
 *
 * Dropped:
 * - The records `collectOrphanedRecords` finds orphaned by the edit being
 *   saved: a record with no anchor in the body that is neither
 *   `scope: document` nor a reply to a record that is kept. This is the only
 *   place in the app a record is removed, and every id it removes is reported
 *   through `onDiagnostic`, because the edit that orphaned a record is the
 *   reviewer's own and they are the one who needs to know.
 * - Attributes other than `id` on an anchor element. The marks carry only ids,
 *   so an attribute a hand-written file put on an anchor does not survive a
 *   pass through the rich text editor.
 * - A replacement half whose partner is missing. Its text is kept, the
 *   suggestion is not, and the loss is reported through `onDiagnostic`.
 */
export function editorStateToReviewMarkdown(
  doc: JSONContent,
  comments: Map<string, ReviewComment>,
  options?: {
    frontmatter?: string | null;
    endmatter?: string | null;
    onDiagnostic?: ReviewDiagnosticHandler;
  },
): string {
  const html = generateHTML(doc, extensions);
  const service = createTurndownService();
  addNestedCommentAnchorRule(service);
  addReplacementPairRule(service, options?.onDiagnostic);

  const frontmatter =
    options?.frontmatter ??
    (doc as JSONContent & { yamlFrontmatter?: string }).yamlFrontmatter ??
    null;
  const sourceEndmatter =
    options?.endmatter ??
    (doc as JSONContent & { yamlEndmatter?: string }).yamlEndmatter ??
    null;

  const body = htmlToMarkdown(service, html);
  const document = parseDocument(appendYamlEndmatter(body, sourceEndmatter));
  const suggestions = collectSuggestionsFromDoc(doc);

  const commentRecords = new Map<CommentId, CommentRecord>();
  for (const comment of comments.values()) {
    const id = parseCommentId(comment.id);
    if (!id) continue;

    commentRecords.set(
      id,
      commentRecordFrom(comment, document.comments.get(id)),
    );
  }

  // The suggestion mark cannot carry `by` and `at`: neither is on the anchor
  // element, so a suggestion read from a file arrives with neither. The
  // endmatter is the source for those, and the marks speak only for the
  // suggestions this session created.
  const suggestionRecords = new Map<SuggestionId, SuggestionRecord>(
    document.suggestions,
  );
  for (const suggestion of suggestions.values()) {
    const id = parseSuggestionId(suggestion.suggestionId);
    if (!id) continue;

    suggestionRecords.set(
      id,
      suggestionRecordFrom(suggestion, document.suggestions.get(id)),
    );
  }

  // The document was parsed from the body this save writes, so its anchors
  // describe that body, which is what the retention rule asks about.
  const { document: collected, dropped } = collectOrphanedRecords({
    ...document,
    frontmatter,
    comments: commentRecords,
    suggestions: suggestionRecords,
  });

  for (const recordId of dropped) {
    reportDiagnostic(options?.onDiagnostic, {
      code: "review-orphaned-record",
      message: `${recordKindName(recordId)} ${recordId} was dropped: the text it was anchored to is no longer in the document.`,
      recordId,
    });
  }

  return serializeDocument(collected);
}
