import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openContextMenuOnSelection,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

/**
 * These drive real keystrokes because that is the only thing that exercises the
 * editor's `handleTextInput`, `handleKeyDown` and `handlePaste` wiring. The
 * suggesting-mode algorithm itself is covered in `src/suggesting-mode.test.ts`;
 * what only a browser can show is that each handler hands it the right range.
 */
async function enterSuggestingMode(page: Page) {
  await page.getByTestId("document-mode-trigger").click();
  await page.getByTestId("document-mode-option-suggesting").click();
}

test.describe("suggesting mode", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("suggesting");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("writes a replacement pair when typing over a selection", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "typing.md",
      "# Draft\n\nThe quick brown fox jumps.\n",
    );

    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("quick brown fox");

    await enterSuggestingMode(page);
    await selectRichText(page, "brown");
    await page.keyboard.type("red");

    await expect
      .poll(() => readProjectFile(projectDir, "typing.md"))
      .toMatch(/<del>brown<\/del><ins>red<\/ins>/);

    logE2eEvent("suggesting.type-over", { file: "typing.md" });
  });

  test("marks original text deleted on Backspace", async ({ page }) => {
    const filePath = writeProjectFile(
      projectDir,
      "backspace.md",
      "# Draft\n\nAlpha beta gamma.\n",
    );

    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("Alpha beta gamma");

    await enterSuggestingMode(page);
    await selectRichText(page, "beta ");
    await page.keyboard.press("Backspace");

    await expect
      .poll(() => readProjectFile(projectDir, "backspace.md"))
      .toMatch(/Alpha <del id="rd-s1">beta <\/del>gamma\./);

    logE2eEvent("suggesting.backspace", { file: "backspace.md" });
  });

  test("marks original text deleted on Cut", async ({ page }) => {
    const filePath = writeProjectFile(
      projectDir,
      "cut.md",
      "# Draft\n\nOne two three.\n",
    );

    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("One two three");

    await enterSuggestingMode(page);
    await selectRichText(page, "two ");
    await page.keyboard.press("ControlOrMeta+x");

    await expect
      .poll(() => readProjectFile(projectDir, "cut.md"))
      .toMatch(/One <del id="rd-s1">two <\/del>three\./);

    logE2eEvent("suggesting.cut", { file: "cut.md" });
  });

  /**
   * The menu's Suggest deletion action must reach the same code the keyboard
   * removals do. Only driving the real menu proves the handler is wired to it:
   * a unit test calling `applySuggestedRemoval` passes whether or not the menu
   * does.
   */
  test("extends an existing deletion from the Suggest deletion menu action", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "menu-deletion.md",
      [
        "# Draft",
        "",
        'alpha <del id="rd-s1">bravo charlie</del> delta.',
        "",
        "---",
        'roughdraft: "1.0"',
        "suggestions:",
        "  rd-s1:",
        "    by: user",
        "    at: 2026-08-28T12:00:00.000Z",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("bravo charlie");

    await selectRichText(page, "charlie delta");
    await openContextMenuOnSelection(page);
    await page
      .getByTestId("editor-context-menu-action-suggest-deletion")
      .click();

    // One suggestion spanning the union, still rd-s1 — not rd-s1 split in two,
    // and not a fresh id that overwrote it.
    await expect
      .poll(() => readProjectFile(projectDir, "menu-deletion.md"))
      .toMatch(/alpha <del id="rd-s1">bravo charlie delta<\/del>\./);

    logE2eEvent("suggesting.menu-deletion-merge", { file: "menu-deletion.md" });
  });
});
