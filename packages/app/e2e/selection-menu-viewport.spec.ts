import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  openMarkdownFile,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

/**
 * The selection menu renders above the selection (`-translate-y-full`) with no
 * viewport clamping, so a selection on the document's first line — which sits
 * right under the toolbar, close to the top of the viewport — pushes the
 * popup partially or fully above `y = 0`, where it is unreachable.
 */
test.describe("selection menu viewport clamping", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("selection-menu-viewport");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("stays within the viewport when selecting the first line", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "top-of-document.md",
      "First line near the top.\n\nSecond paragraph.\n",
    );

    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("First line near the top");

    await selectRichText(page, "First line near the top");

    const menu = page.getByTestId("selection-menu");
    await expect(menu).toBeVisible();

    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.y).toBeGreaterThanOrEqual(0);
  });
});
