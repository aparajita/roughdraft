import { tables, taskListItems } from "@joplin/turndown-plugin-gfm";
import {
  createLiteralSpanIndex,
  findFinalYamlEndmatter,
  isYamlMappingBlock,
} from "@roughdraft/rfm";
import {
  Marked,
  marked,
  type Token,
  type Tokens,
  type TokensList,
} from "marked";
import TurndownService from "turndown";

export const rawMarkdownBlockAttribute = "data-markdown-raw-block";

/**
 * Word joiner placed inside a mark range that has no visible text of its own —
 * a point anchor, or a suggested empty paragraph. It gives the range a
 * character to attach to so the editor and ProseMirror keep it addressable, and
 * it is stripped again on serialization.
 */
export const EMPTY_ANCHOR_SENTINEL = "⁠";

export interface MarkdownOptions {
  resolveFileUrl?: (path: string) => string | null;
  resolveLinkUrl?: (path: string) => string | null;
}

function isExternalUrl(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//");
}

function isInPageAnchor(path: string): boolean {
  return path.startsWith("#");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function encodeRawMarkdownBlock(markdown: string): string {
  return encodeURIComponent(markdown);
}

export function decodeRawMarkdownBlock(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function createRawMarkdownBlock(markdown: string): string {
  return `<div ${rawMarkdownBlockAttribute}="${escapeHtml(
    encodeRawMarkdownBlock(markdown),
  )}"></div>\n`;
}

function protectRawHtmlBlocks(markdown: string): string {
  return markdown
    .replace(
      /^[ \t]*<details\b[\s\S]*?<\/details>[ \t]*(?:\r?\n|$)/gim,
      (raw) => createRawMarkdownBlock(raw),
    )
    .replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*(?:\r?\n|$)/gm, (raw) =>
      createRawMarkdownBlock(raw),
    );
}

function protectIndentedCodeAfterLists(markdown: string): string {
  return markdown.replace(
    /^(?:[-*+]|\d+[.)]) [^\r\n]*(?:\r?\n)[ \t]*(?:\r?\n)(?:(?: {4}|\t)[^\r\n]*(?:\r?\n|$))+/gm,
    (raw) => createRawMarkdownBlock(raw),
  );
}

function codeSpanContainsPipe(value: string): boolean {
  return /`[^`\n]*\|[^`\n]*`/.test(value);
}

function protectPipeSensitiveTables(markdown: string): string {
  const lines = markdown.match(/[^\r\n]*(?:\r?\n|$)/g) ?? [];
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";

    if (
      !line.includes("|") ||
      !/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(nextLine)
    ) {
      output.push(line);
      continue;
    }

    const tableLines = [line, nextLine];
    index += 2;

    while (index < lines.length) {
      const row = lines[index] ?? "";
      if (!row.trim() || !row.includes("|")) break;
      tableLines.push(row);
      index += 1;
    }

    const raw = tableLines.join("");
    const needsProtection = raw.includes("\\|") || codeSpanContainsPipe(raw);
    output.push(needsProtection ? createRawMarkdownBlock(raw) : raw);
    index -= 1;
  }

  return output.join("");
}

/**
 * Protect a trailing YAML block that is document content.
 *
 * This runs on a body whose endmatter has already been split off, so a final
 * `---`-delimited YAML mapping still present is content the round trip must
 * preserve. Left alone, marked reads the `---` as a thematic break and the
 * mapping as one paragraph, and a paragraph's soft line breaks do not survive
 * the round trip — the keys come back run together on a single line.
 *
 * The block is one only when its first key sits on the line directly after the
 * `---`, which is where frontmatter and endmatter both put theirs. A `---`
 * followed by a blank line is a thematic break and then a paragraph under
 * CommonMark, and that pair renders and round trips as itself, so protecting it
 * would hide a horizontal rule and a line of prose the document meant to show.
 */
function protectTrailingYamlBlock(markdown: string): string {
  const match = findFinalYamlEndmatter(
    markdown,
    createLiteralSpanIndex(markdown),
  );
  if (!match) return markdown;

  // `yaml` is everything after the delimiter line, so a blank line between the
  // `---` and what follows it is a leading blank line here.
  if (/^[ \t]*\r?\n/.test(match.yaml)) return markdown;

  const block = match.raw.replace(/^\r?\n/, "");
  if (!isYamlMappingBlock(block)) return markdown;

  return `${markdown.slice(0, match.offset)}\n${createRawMarkdownBlock(block)}`;
}

export function protectRichTextRoundTripMarkdown(markdown: string): string {
  return protectPipeSensitiveTables(
    protectIndentedCodeAfterLists(
      protectTrailingYamlBlock(protectRawHtmlBlocks(markdown)),
    ),
  );
}

function normalizeMarkdownPath(path: string): string {
  if (path.startsWith("./") || path.startsWith("../")) return path;
  return `./${path.replace(/^\/+/, "")}`;
}

function tableHasUnsupportedMarkdownContent(table: HTMLTableElement): boolean {
  return Boolean(
    table.querySelector(
      "blockquote, h1, h2, h3, h4, h5, h6, hr, ol, pre, table, ul",
    ),
  );
}

function getFirstTableRow(table: HTMLTableElement): HTMLTableRowElement | null {
  return table.rows.length > 0 ? table.rows[0] : null;
}

function isHeaderTableRow(row: HTMLTableRowElement | null): boolean {
  if (!row || row.cells.length === 0) return false;

  return Array.from(row.cells).every((cell) => cell.tagName === "TH");
}

function isMarkdownTableDivider(line: string | undefined): boolean {
  return Boolean(line && /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line));
}

function markdownTableDividerForCell(cell: HTMLTableCellElement): string {
  const alignment = (
    cell.getAttribute("align") ||
    cell.style.textAlign ||
    ""
  ).toLowerCase();

  if (alignment === "left") return ":---";
  if (alignment === "right") return "---:";
  if (alignment === "center") return ":---:";

  return "---";
}

function markdownTableDividerForRow(row: HTMLTableRowElement): string {
  const dividers = Array.from(row.cells).map(markdownTableDividerForCell);
  return `| ${dividers.join(" | ")} |`;
}

function resolveRenderedUrl(
  path: string,
  resolveFileUrl?: MarkdownOptions["resolveFileUrl"],
) {
  if (isExternalUrl(path) || isInPageAnchor(path)) return path;
  return resolveFileUrl?.(path) ?? path;
}

const RFM_ANCHOR_ID_PATTERN = /^rd-[cs][0-9]+$/;
const RFM_SUGGESTION_ID_PATTERN = /^rd-s[0-9]+$/;
const RFM_ANCHOR_TAG_NAMES = new Set(["SPAN", "INS", "DEL"]);

function isRfmAnchorElement(node: HTMLElement): boolean {
  return (
    RFM_ANCHOR_TAG_NAMES.has(node.nodeName) &&
    RFM_ANCHOR_ID_PATTERN.test(node.getAttribute("id") ?? "")
  );
}

/**
 * A suggested replacement is `<span id="rd-sN"><del>old</del><ins>new</ins></span>`.
 * The inner elements carry no id of their own, yet the operation is read from
 * them, so they serialize as tags rather than as `~~` strikethrough.
 */
function isRfmReplacementPart(node: HTMLElement): boolean {
  if (node.nodeName !== "DEL" && node.nodeName !== "INS") return false;

  const parent = node.parentElement;
  return Boolean(
    parent &&
      parent.nodeName === "SPAN" &&
      RFM_SUGGESTION_ID_PATTERN.test(parent.getAttribute("id") ?? ""),
  );
}

/**
 * Private-use character standing at an anchor edge whose whitespace has to
 * survive serialization.
 *
 * Turndown lifts a node's edge whitespace out of the element it belongs to, and
 * drops it outright when the neighbouring text already ends in whitespace. That
 * is right for emphasis, where `**bold **` is not valid Markdown, and wrong for
 * an anchor, whose extent is the extent of the review record bound to it: an
 * anchor that gives up its trailing space now proposes deleting a different
 * string than the one the reviewer selected. The guard sits between the edge and
 * the whitespace so Turndown finds no edge whitespace to take.
 *
 * It exists only between {@link guardAnchorEdgeWhitespace} and
 * {@link htmlToMarkdown}, which spends it, and never reaches a file.
 */
const ANCHOR_EDGE_GUARD = "";

/**
 * Stand a guard at each anchor edge that opens or closes with whitespace.
 *
 * An empty anchor gets none: it is a point anchor, and Turndown routes a node it
 * considers blank through `blankReplacement`, which a guard would divert.
 */
function guardAnchorEdgeWhitespace(root: HTMLElement): void {
  const ownerDocument = root.ownerDocument;

  for (const element of root.querySelectorAll("span, ins, del")) {
    const anchor = element as HTMLElement;

    if (!isRfmAnchorElement(anchor) && !isRfmReplacementPart(anchor)) continue;

    const text = anchor.textContent ?? "";

    if (/^\s/.test(text)) {
      anchor.insertBefore(
        ownerDocument.createTextNode(ANCHOR_EDGE_GUARD),
        anchor.firstChild,
      );
    }

    if (/\s$/.test(text)) {
      anchor.appendChild(ownerDocument.createTextNode(ANCHOR_EDGE_GUARD));
    }
  }
}

/**
 * Parse `html` the way Turndown parses a string it is handed, so that guarding
 * the anchors costs nothing else: the custom wrapper is what keeps the elements
 * in one place rather than split across `<head>` and `<body>`.
 */
function parseGuardedRoot(html: string): HTMLElement {
  const parsed = new DOMParser().parseFromString(
    `<x-turndown id="turndown-root">${html}</x-turndown>`,
    "text/html",
  );
  const root = parsed.getElementById("turndown-root");

  if (!root) throw new Error("could not parse HTML for Markdown conversion");

  guardAnchorEdgeWhitespace(root);

  return root;
}

/**
 * Convert editor HTML to the Markdown that goes to disk.
 *
 * Callers pass their own service because the review serializer registers rules
 * of its own on top of {@link createTurndownService}.
 */
export function htmlToMarkdown(service: TurndownService, html: string): string {
  const markdown = service.turndown(parseGuardedRoot(html)).trimEnd();

  return normalizeBlockSpacing(`${markdown}\n`).replaceAll(
    ANCHOR_EDGE_GUARD,
    "",
  );
}

function serializeAnchorElement(content: string, node: HTMLElement): string {
  const tagName = node.nodeName.toLowerCase();
  const { attributes } = node;
  let attributeMarkup = "";

  for (let index = 0; index < attributes.length; index += 1) {
    const attribute = attributes.item(index);
    if (!attribute) continue;
    // `class` on an anchor is presentation the editor's marks add when they
    // render, never anything the document carried in: the marks hold ids, so a
    // class read from a source anchor cannot reach this point. Writing it back
    // would put `class="comment-anchor"` into the file on every save.
    if (attribute.name === "class") continue;
    attributeMarkup += ` ${attribute.name}="${escapeHtml(attribute.value)}"`;
  }

  const text = content.replaceAll(EMPTY_ANCHOR_SENTINEL, "");
  return `<${tagName}${attributeMarkup}>${text}</${tagName}>`;
}

/**
 * Attributes recording the blank lines a heading had around it in the source.
 *
 * Markdown distinguishes `## H\n\ntext` from `## H\ntext`; HTML does not, so
 * without carrying the distinction here a round trip has to guess, and every
 * document is rewritten to whichever form the guess picks. The editor's Heading
 * node keeps both attributes, and the Turndown heading rule spends them.
 */
export const HEADING_BLANK_BEFORE_ATTRIBUTE = "data-md-blank-before";
export const HEADING_BLANK_AFTER_ATTRIBUTE = "data-md-blank-after";

/**
 * Private-use characters the heading rule leaves on a side that carried no
 * blank line, for {@link normalizeBlockSpacing} to act on and remove. They
 * exist only between those two functions.
 */
const TIGHT_BEFORE_MARKER = "";
const TIGHT_AFTER_MARKER = "";

/**
 * Record each heading's surrounding blank lines onto its token.
 *
 * A blank line after a heading is inside the heading token's own `raw`, which
 * ends with two newlines. A blank line before one is a preceding `space` token.
 * Neither fact is recoverable once the tokens become HTML.
 */
function annotateHeadingSpacing(tokens: Token[] | TokensList): void {
  tokens.forEach((token, index) => {
    if (token.type === "heading") {
      const heading = token as Tokens.Heading & HeadingSpacing;
      heading.blankBefore = tokens[index - 1]?.type === "space";
      heading.blankAfter = /\n\s*\n$/.test(token.raw);
    }

    const nested = token as { tokens?: Token[]; items?: Token[] };
    if (nested.tokens) annotateHeadingSpacing(nested.tokens);
    if (nested.items) annotateHeadingSpacing(nested.items);
  });
}

interface HeadingSpacing {
  blankBefore?: boolean;
  blankAfter?: boolean;
}

/**
 * Render Markdown to HTML.
 *
 * Lexing is a separate step from parsing because the heading spacing has to be
 * read off the tokens before they become HTML. Both render paths go through
 * here so that neither can render without it.
 */
export function renderMarkdownToHtml(
  markdown: string,
  options?: MarkdownOptions,
): string {
  const parser = new Marked({
    async: false,
    gfm: true,
    renderer: createMarkedRenderer(options),
  });
  const tokens = parser.lexer(markdown);

  annotateHeadingSpacing(tokens);

  return parser.parser(tokens);
}

function createMarkedRenderer(options?: MarkdownOptions) {
  const renderer = new marked.Renderer();
  const baseRenderer = new marked.Renderer();
  const resolveFileUrl = options?.resolveFileUrl;
  const resolveLinkUrl = options?.resolveLinkUrl;

  renderer.heading = function (token) {
    const { blankBefore, blankAfter } = token as Tokens.Heading &
      HeadingSpacing;
    const before = blankBefore
      ? ` ${HEADING_BLANK_BEFORE_ATTRIBUTE}="true"`
      : "";
    const after = blankAfter ? ` ${HEADING_BLANK_AFTER_ATTRIBUTE}="true"` : "";

    return `<h${token.depth}${before}${after}>${this.parser.parseInline(
      token.tokens,
    )}</h${token.depth}>\n`;
  };

  renderer.code = ({ text, lang, escaped }) => {
    const language = (lang || "").match(/\S+/)?.[0];
    const content = escaped ? text : escapeHtml(text);
    const classAttr = language
      ? ` class="language-${escapeHtml(language)}"`
      : "";

    return `<pre><code${classAttr}>${content}</code></pre>\n`;
  };

  renderer.link = function ({ href, title, tokens, raw }) {
    const rawHref = href || "";
    const renderedHref = resolveRenderedUrl(
      rawHref,
      (path) => resolveLinkUrl?.(path) ?? resolveFileUrl?.(path) ?? null,
    );
    const text = this.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const markdownSrcAttr = ` data-markdown-src="${escapeHtml(rawHref)}"`;
    const autolinkAttr =
      !title && raw?.startsWith("<") && raw.endsWith(">")
        ? ' data-markdown-autolink="true"'
        : "";
    const externalAttr =
      isExternalUrl(rawHref) && !rawHref.startsWith("mailto:")
        ? ' target="_blank" rel="noreferrer noopener"'
        : "";

    return `<a href="${escapeHtml(renderedHref)}"${titleAttr}${markdownSrcAttr}${autolinkAttr}${externalAttr}>${text}</a>`;
  };

  renderer.image = ({ href, title, text }) => {
    const rawHref = href || "";
    const renderedHref = resolveRenderedUrl(rawHref, resolveFileUrl);
    const alt = text || "";
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const markdownSrcAttr = ` data-markdown-src="${escapeHtml(rawHref)}"`;

    return `<img src="${escapeHtml(renderedHref)}" alt="${escapeHtml(alt)}"${titleAttr}${markdownSrcAttr}>`;
  };

  renderer.list = function (token) {
    const hasTaskItems = token.items.some((item) => item.task);
    if (!hasTaskItems) {
      return baseRenderer.list.call(this, token);
    }

    const items = token.items
      .map((item) => {
        const checked = item.checked ? "true" : "false";
        const inner = this.parser.parse(item.tokens, false);
        return `<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox"${
          item.checked ? ' checked="checked"' : ""
        }><span></span></label><div>${inner}</div></li>`;
      })
      .join("");

    return `<ul data-type="taskList">${items}</ul>`;
  };

  return renderer;
}

/**
 * Builds the HTML → Markdown serializer for the rich text surface.
 *
 * Contract: an element carrying an `id` of the form `rd-cN` or `rd-sN` survives
 * serialization with its tag name, its `id` and every other attribute intact,
 * in source order. Every save of a reviewed document rests on that promise, and
 * no type can enforce it — Turndown silently drops an element it has no rule
 * for, so a missing or shadowed rule destroys review anchors with no error
 * anywhere. A rule added here must leave `rfmAnchorElement` reachable for those
 * elements: `addRule` prepends, so the last rule registered wins.
 */
export function createTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    // `<hr>` carries no record of the markers the author wrote, so serialization
    // has to pick one form. `---` is the form this format already spells its
    // frontmatter and endmatter delimiters with, so it is the one a document
    // written here is written back with; Turndown's own `* * *` would rewrite
    // every thematic break on the first save.
    hr: "---",
    blankReplacement(_content, node) {
      if (node.hasAttribute(rawMarkdownBlockAttribute)) {
        return `\n\n${decodeRawMarkdownBlock(
          node.getAttribute(rawMarkdownBlockAttribute) ?? "",
        ).trimEnd()}\n\n`;
      }

      // Turndown short-circuits every rule for a node it considers blank, so an
      // anchor holding no text at all is serialized here rather than dropped.
      if (isRfmAnchorElement(node)) return serializeAnchorElement("", node);

      return (node as HTMLElement & { isBlock?: boolean }).isBlock
        ? "\n\n"
        : "";
    },
  });

  service.use(tables as Parameters<TurndownService["use"]>[0]);
  service.use(taskListItems as Parameters<TurndownService["use"]>[0]);

  service.addRule("spacedHeading", {
    filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
    replacement(content, node) {
      const element = node as HTMLElement;
      const depth = Number(element.nodeName.charAt(1));
      const before = element.hasAttribute(HEADING_BLANK_BEFORE_ATTRIBUTE)
        ? ""
        : TIGHT_BEFORE_MARKER;
      const after = element.hasAttribute(HEADING_BLANK_AFTER_ATTRIBUTE)
        ? ""
        : TIGHT_AFTER_MARKER;

      return `\n\n${before}${"#".repeat(depth)} ${content}${after}\n\n`;
    },
  });

  service.addRule("compactListItem", {
    filter: "li",
    replacement(content, node, options) {
      // Trailing newlines come off before the indent, not after: indenting one
      // turns it into a whitespace-only line between items, which reads as a
      // loose list and adds trailing spaces the author never wrote.
      const trimmed = content
        .replace(/^\n+/, "")
        .replace(/\n+$/, "")
        .replace(/\n/gm, "\n  ");

      let prefix = `${options.bulletListMarker} `;
      const parent = node.parentNode;
      if (parent && parent.nodeName === "OL") {
        const start = (parent as HTMLOListElement).getAttribute("start");
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start ? Number(start) + index : index + 1}. `;
      }

      return prefix + trimmed + (node.nextSibling ? "\n" : "");
    },
  });

  service.addRule("tiptapHeaderTable", {
    filter(node) {
      if (node.tagName !== "TABLE") return false;

      const table = node as HTMLTableElement;
      return (
        !tableHasUnsupportedMarkdownContent(table) &&
        isHeaderTableRow(getFirstTableRow(table))
      );
    },
    replacement(content, node) {
      const table = node as HTMLTableElement;
      const headerRow = getFirstTableRow(table);
      if (!headerRow) return content;

      const lines = content.replace(/\n+/g, "\n").trim().split("\n");
      if (lines.length === 0) return content;

      if (!isMarkdownTableDivider(lines[1])) {
        lines.splice(1, 0, markdownTableDividerForRow(headerRow));
      }

      const captionContent = table.caption?.textContent || "";
      const caption = captionContent ? `${captionContent}\n\n` : "";

      return `\n\n${caption}${lines.join("\n")}\n\n`;
    },
  });

  // We own the markdown parser and want stable round-trips without doubled escapes.
  service.escape = (value: string) => value;

  service.addRule("markdownAwareLinks", {
    filter: "a",
    replacement(content, node) {
      const element = node as HTMLAnchorElement;
      const href =
        element.getAttribute("data-markdown-src") ||
        element.getAttribute("href") ||
        "";
      const normalizedHref =
        isExternalUrl(href) || isInPageAnchor(href)
          ? href
          : normalizeMarkdownPath(href);
      const title = element.getAttribute("title");
      const titleMarkdown = title
        ? ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
        : "";

      if (
        element.getAttribute("data-markdown-autolink") === "true" &&
        !titleMarkdown
      ) {
        return href.startsWith("mailto:")
          ? `<${href.slice("mailto:".length)}>`
          : `<${normalizedHref}>`;
      }

      return `[${content}](${normalizedHref}${titleMarkdown})`;
    },
  });

  service.addRule("markdownAwareImages", {
    filter: "img",
    replacement(_content, node) {
      const element = node as HTMLImageElement;
      const src =
        element.getAttribute("data-markdown-src") ||
        element.getAttribute("src") ||
        "";
      const normalizedSrc = isExternalUrl(src)
        ? src
        : normalizeMarkdownPath(src);
      const alt = element.getAttribute("alt") || "";
      const title = element.getAttribute("title");
      const titleMarkdown = title
        ? ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
        : "";
      return `![${alt}](${normalizedSrc}${titleMarkdown})`;
    },
  });

  service.addRule("markdownStrikethrough", {
    filter: (node) =>
      (node.nodeName === "DEL" ||
        node.nodeName === "S" ||
        node.nodeName === "STRIKE") &&
      !isRfmAnchorElement(node) &&
      !isRfmReplacementPart(node),
    replacement(content) {
      return `~~${content}~~`;
    },
  });

  service.addRule("rawMarkdownBlock", {
    filter: (node) =>
      node.nodeType === 1 &&
      (node as HTMLElement).hasAttribute(rawMarkdownBlockAttribute),
    replacement(_content, node) {
      const encoded =
        (node as HTMLElement).getAttribute(rawMarkdownBlockAttribute) ?? "";
      return `\n\n${decodeRawMarkdownBlock(encoded).trimEnd()}\n\n`;
    },
  });

  // Registered last so it takes precedence over every rule above it: `addRule`
  // prepends, and without this rule Turndown has no handling for `<ins>` at all
  // and would rewrite an anchored `<del>` as `~~`.
  service.addRule("rfmAnchorElement", {
    filter: (node) => isRfmAnchorElement(node) || isRfmReplacementPart(node),
    replacement(content, node) {
      return serializeAnchorElement(content, node);
    },
  });

  return service;
}

const turndown = createTurndownService();

/**
 * Collapse runs of 3+ newlines to 2, then close the blank lines Turndown put
 * around headings that had none in the source.
 *
 * Turndown decides block separation by taking the longer of the two adjacent
 * blocks' newline runs, so a heading rule cannot ask for a single newline on
 * its own — the neighbouring block overrides it. The rule therefore marks the
 * sides that were tight and this pass, which sees both sides at once, spends
 * the markers. They never reach a file: whatever survives is stripped below.
 */
function normalizeBlockSpacing(md: string): string {
  return md
    .replace(/\n{3,}/g, "\n\n")
    .replace(new RegExp(`\n\n${TIGHT_BEFORE_MARKER}`, "g"), "\n")
    .replace(new RegExp(`${TIGHT_AFTER_MARKER}\n\n`, "g"), "\n")
    .replace(
      new RegExp(`[${TIGHT_BEFORE_MARKER}${TIGHT_AFTER_MARKER}]`, "g"),
      "",
    );
}

export function toMarkdown(html: string): string {
  return htmlToMarkdown(turndown, html);
}

export function toHtml(markdown: string, options?: MarkdownOptions): string {
  return renderMarkdownToHtml(markdown, options);
}
