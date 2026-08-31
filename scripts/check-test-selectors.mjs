#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const testFilePattern =
  /(?:^|\/)(?:test|e2e)\/.*\.(?:test|spec)\.tsx?$|\.e2e\/.*\.spec\.tsx?$|\.test\.tsx?$|\.spec\.tsx?$/;
const ignoredDirs = new Set(["node_modules", "dist", "coverage", ".git"]);

// Matched against whole file contents, not single lines: a call Biome wrapped
// puts its selector string on the line after the opening paren, and a
// line-at-a-time scan never sees the two together. Every `\s*` here therefore
// has to be able to cross a newline, which it does.
const forbiddenApiPatterns = [
  /\b(?:page|screen|within\([^)]*\)|rendered|container)\.get(?:All)?By(?:Text|Role|LabelText|PlaceholderText|DisplayValue|AltText|Title)\s*\(/g,
  /\b(?:page|screen|within\([^)]*\)|rendered|container)\.query(?:All)?By(?:Text|Role|LabelText|PlaceholderText|DisplayValue|AltText|Title)\s*\(/g,
  /\b(?:page|screen|within\([^)]*\)|rendered|container)\.find(?:All)?By(?:Text|Role|LabelText|PlaceholderText|DisplayValue|AltText|Title)\s*\(/g,
];

const selectorApiPatterns = [
  /\bquerySelector(?:All)?\s*\(\s*([`'"])(.*?)\1/g,
  /\bclosest\s*\(\s*([`'"])(.*?)\1/g,
  /\blocator\s*\(\s*([`'"])(.*?)\1/g,
  /\b\$\$?\s*\(\s*([`'"])(.*?)\1/g,
];

const allowedSelectorPatterns = [
  /\[data-testid=/,
  /^\[data-testid=/,
  /^title$/,
  /^meta\[/,
  /^link\[/,
  /^a\[href=/,
  /^a\[data-markdown-src=/,
  /^img\[data-markdown-src=/,
  /^input\[type="checkbox"\]$/,
  /^img\[alt=/,
  /^\.cm-(content|editor|gutters)$/,
  /^\.ProseMirror$/,
  // Review anchors are addressed by the `rd-` id the format puts on them and by
  // the class the marks render; decorations are addressed by `data-testid`.
  /^\.comment-anchor(?:\[id\^="rd-c"\])?$/,
  /^\.suggestion\[data-rd-replace\^="rd-s"\]$/,
  /^\[id\^?="rd-[cs]\d*"\]$/,
  /^\[data-comment-thread-root-id\]/,
  /^\[data-comment-thread-container="true"\]$/,
];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }

    if (testFilePattern.test(path.relative(repoRoot, fullPath))) {
      files.push(fullPath);
    }
  }

  return files;
}

function isAllowedSelector(selector) {
  return allowedSelectorPatterns.some((pattern) => pattern.test(selector));
}

/** Every match of `pattern` in `content`, as `{ match, line }` one-indexed. */
function* matchesWithLines(content, pattern) {
  pattern.lastIndex = 0;
  for (const match of content.matchAll(pattern)) {
    const line = content.slice(0, match.index).split("\n").length;
    yield { match, line };
  }
}

const violations = [];

for (const file of walk(repoRoot)) {
  const relativePath = path.relative(repoRoot, file);
  const content = fs.readFileSync(file, "utf8");
  const lines = content.split("\n");
  // A match can span lines, so the marker exempts anything the call touches.
  const isIgnored = ({ match, line }) =>
    lines
      .slice(line - 1, line - 1 + match[0].split("\n").length)
      .some((text) => text.includes("selector-check-ignore"));

  for (const pattern of forbiddenApiPatterns) {
    for (const found of matchesWithLines(content, pattern)) {
      if (isIgnored(found)) continue;

      violations.push({
        file: relativePath,
        line: found.line,
        reason:
          "Use getByTestId/query by data-testid instead of text, role, label, placeholder, alt, or title selectors.",
        source: lines[found.line - 1].trim(),
      });
    }
  }

  for (const pattern of selectorApiPatterns) {
    for (const found of matchesWithLines(content, pattern)) {
      if (isIgnored(found)) continue;

      const selector = found.match[2];
      if (isAllowedSelector(selector)) continue;

      violations.push({
        file: relativePath,
        line: found.line,
        reason: `Selector "${selector}" is not data-testid-based or explicitly allowlisted.`,
        source: lines[found.line - 1].trim(),
      });
    }
  }
}

if (violations.length > 0) {
  console.error("Test selector convention violations found:\n");
  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line}: ${violation.reason}\n  ${violation.source}`,
    );
  }
  process.exit(1);
}

console.log("Test selectors use data-testid or an explicit stable exception.");
