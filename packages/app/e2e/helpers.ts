import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

export function createMarkdownProject(label: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `roughdraft-${label}-`));
}

export function removeMarkdownProject(projectDir: string) {
  fs.rmSync(projectDir, { recursive: true, force: true });
}

export function writeProjectFile(
  projectDir: string,
  relativePath: string,
  content: string | Buffer,
) {
  const absolutePath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
  return absolutePath;
}

export function readProjectFile(projectDir: string, relativePath: string) {
  return fs.readFileSync(path.join(projectDir, relativePath), "utf8");
}

export async function openMarkdownFile(
  page: Page,
  absolutePath: string,
  editor?: "rich-text" | "code",
) {
  const params = new URLSearchParams({ path: absolutePath });
  if (editor) params.set("editor", editor);

  await page.goto(`/?${params.toString()}`);
}

export function codeEditor(page: Page) {
  return page.getByTestId("markdown-code-editor").locator(".cm-content");
}

export function richTextEditor(page: Page) {
  return page.getByTestId("rich-text-editor").locator(".ProseMirror");
}

export function saveFailedAlert(page: Page) {
  return page.getByTestId("save-failed-alert");
}

export function saveFailedAlertRetryButton(page: Page) {
  return page.getByTestId("save-failed-alert-retry");
}

export function saveFailedAlertCancelButton(page: Page) {
  return page.getByTestId("save-failed-alert-cancel");
}

export function fileConflictNotice(page: Page) {
  return page.getByTestId("file-conflict-notice");
}

export async function appendInCodeEditor(page: Page, text: string) {
  const editor = codeEditor(page);
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+End" : "Control+End",
  );
  await page.keyboard.type(text);
}

/**
 * Select `text` in the rich-text editor.
 *
 * The target is searched across the editor's text nodes rather than within each
 * one, because an anchor splits its paragraph into a node per element: a
 * selection that crosses an anchor boundary — the case a reviewer hits when they
 * drag over the edge of an existing comment — exists in no single node.
 */
export async function selectRichText(page: Page, text: string) {
  await richTextEditor(page).focus();
  await page.evaluate((targetText) => {
    const editor = document.querySelector(".ProseMirror");
    if (!editor) {
      throw new Error("Could not find rich-text editor");
    }

    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let documentText = "";

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      textNodes.push(node as Text);
      documentText += node.textContent ?? "";
    }

    const start = documentText.indexOf(targetText);

    if (start < 0) {
      throw new Error(`Could not find text "${targetText}"`);
    }

    /**
     * The node and offset a document-wide offset falls in. An offset sitting on
     * the boundary between two nodes resolves to the start of the later one, so
     * a range end at the very end of the document resolves to the last node.
     */
    const locate = (offset: number): { node: Text; offset: number } => {
      let consumed = 0;

      for (const node of textNodes) {
        const length = node.length;

        if (offset < consumed + length) {
          return { node, offset: offset - consumed };
        }

        consumed += length;
      }

      const last = textNodes[textNodes.length - 1];

      if (!last) throw new Error("The editor holds no text");

      return { node: last, offset: last.length };
    };

    const from = locate(start);
    const to = locate(start + targetText.length);
    const range = document.createRange();

    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
  }, text);
}

export function logE2eEvent(event: string, data: Record<string, unknown> = {}) {
  const file = process.env.THOUGHTFUL_SLOG_FILE;
  if (!file) return;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      runId: process.env.THOUGHTFUL_SLOG_RUN_ID ?? "manual",
      source: "packages/app/e2e",
      event,
      data,
    })}\n`,
  );
}

/**
 * Open the editor context menu without disturbing the selection. A right-click
 * inside a selection keeps it; one outside collapses it to the caret, which
 * changes which menu actions are available and why.
 */
export async function openContextMenuOnSelection(page: Page) {
  const box = await page.evaluate(() => {
    const range = window.getSelection()?.getRangeAt(0);
    if (!range) throw new Error("The editor holds no selection");

    const { x, y, width, height } = range.getBoundingClientRect();

    return { x, y, width, height };
  });

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
    button: "right",
  });
}
