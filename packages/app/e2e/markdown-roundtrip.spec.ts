import fs from "node:fs";
import { expect, test } from "@playwright/test";
import {
  appendInCodeEditor,
  codeEditor,
  createMarkdownProject,
  documentSaveStatus,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

test.describe("markdown round-trips", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("roundtrip");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("toggles rich text and code mode without rewriting literal anchors @smoke", async ({
    page,
  }) => {
    const original = [
      "---",
      "title: Literal anchors",
      "---",
      "",
      "# Round Trip",
      "",
      'Inline code stays literal: `<span id="rd-c1">not a comment</span>`.',
      "",
      "```md",
      '<span id="rd-c2">not review feedback</span>',
      '<ins id="rd-s1">not a suggestion</ins>',
      "```",
      "",
    ].join("\n");
    const filePath = writeProjectFile(projectDir, "roundtrip.md", original);

    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("rich-text-editor")).toContainText(
      "Round Trip",
    );

    await page.getByTestId("document-editor-view-toggle").click();
    await expect(codeEditor(page)).toContainText(
      '<span id="rd-c2">not review feedback</span>',
    );

    await page.getByTestId("document-editor-view-toggle").click();
    await expect(page.getByTestId("rich-text-editor")).toContainText(
      "Round Trip",
    );
    expect(readProjectFile(projectDir, "roundtrip.md")).toBe(original);

    logE2eEvent("markdown-roundtrip.toggle-preserved", {
      file: "roundtrip.md",
    });
  });

  test("saves code-mode edits to disk while preserving fenced anchor examples @smoke", async ({
    page,
  }) => {
    const initial = [
      "# Code Save",
      "",
      "```md",
      '<span id="rd-c1">literal</span>',
      "```",
      "",
    ].join("\n");
    const filePath = writeProjectFile(projectDir, "code-save.md", initial);

    await openMarkdownFile(page, filePath, "code");
    await appendInCodeEditor(page, "\nSaved from Playwright.\n");

    await expect
      .poll(() => readProjectFile(projectDir, "code-save.md"))
      .toContain("Saved from Playwright.");
    expect(readProjectFile(projectDir, "code-save.md")).toContain(
      '<span id="rd-c1">literal</span>',
    );

    logE2eEvent("markdown-roundtrip.code-save", {
      size: fs.statSync(filePath).size,
    });
  });

  test("initial open shows persistent saved status", async ({ page }) => {
    const filePath = writeProjectFile(
      projectDir,
      "initial-saved.md",
      "# Initial Saved\n\nBody.\n",
    );

    await openMarkdownFile(page, filePath);

    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );

    logE2eEvent("markdown-roundtrip.initial-saved", {
      file: "initial-saved.md",
    });
  });

  test("manual save shortcut flushes code-mode edits to disk @smoke", async ({
    page,
  }) => {
    const initial = ["# Manual Save", "", "Initial body.", ""].join("\n");
    const filePath = writeProjectFile(projectDir, "manual-save.md", initial);

    await openMarkdownFile(page, filePath, "code");
    await appendInCodeEditor(page, "\nSaved by shortcut.\n");

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S",
    );

    await expect
      .poll(() => readProjectFile(projectDir, "manual-save.md"))
      .toContain("Saved by shortcut.");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );

    logE2eEvent("markdown-roundtrip.manual-save-shortcut", {
      file: "manual-save.md",
      size: fs.statSync(filePath).size,
    });
  });

  test("manual save shortcut flushes rich-text edits to disk", async ({
    page,
  }) => {
    const initial = ["# Rich Save", "", "Initial body.", ""].join("\n");
    const filePath = writeProjectFile(projectDir, "rich-save.md", initial);

    await openMarkdownFile(page, filePath, "rich-text");
    const editor = richTextEditor(page);
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+End" : "Control+End",
    );
    await page.keyboard.type(" Saved by shortcut.");
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S",
    );

    await expect
      .poll(() => readProjectFile(projectDir, "rich-save.md"))
      .toContain("Saved by shortcut.");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );

    logE2eEvent("markdown-roundtrip.rich-manual-save", {
      file: "rich-save.md",
      size: fs.statSync(filePath).size,
    });
  });

  test("save shortcut prevents browser default in rich-text and code modes", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "prevent-default.md",
      "# Prevent Default\n\nBody.\n",
    );

    for (const editorMode of ["rich-text", "code"] as const) {
      await openMarkdownFile(page, filePath, editorMode);

      if (editorMode === "code") {
        await codeEditor(page).click();
      } else {
        await richTextEditor(page).click();
      }

      const events = await page.evaluate(() =>
        [
          { metaKey: true, ctrlKey: false },
          { metaKey: false, ctrlKey: true },
        ].map((init) => {
          const event = new KeyboardEvent("keydown", {
            key: "s",
            ...init,
            bubbles: true,
            cancelable: true,
          });
          window.dispatchEvent(event);
          return {
            defaultPrevented: event.defaultPrevented,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
          };
        }),
      );

      expect(events).toEqual([
        { defaultPrevented: true, metaKey: true, ctrlKey: false },
        { defaultPrevented: true, metaKey: false, ctrlKey: true },
      ]);
      await expect(documentSaveStatus(page)).toHaveAttribute(
        "aria-label",
        "Saved",
      );
    }

    logE2eEvent("markdown-roundtrip.save-default-prevented", {
      file: "prevent-default.md",
    });
  });
});
