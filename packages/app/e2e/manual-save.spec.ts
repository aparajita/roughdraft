import { expect, test } from "@playwright/test";
import {
  appendInCodeEditor,
  codeEditor,
  createMarkdownProject,
  documentSaveButton,
  documentSaveStatus,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("manual save", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("manual-save");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("writes the document to disk when the save button is clicked @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "manual.md",
      "# Manual\n\nOriginal body.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original body.");
    await expect(documentSaveButton(page)).toBeDisabled();

    await appendInCodeEditor(page, "\nSaved by button.\n");
    await documentSaveButton(page).click();

    await expect
      .poll(() => readProjectFile(projectDir, "manual.md"))
      .toContain("Saved by button.");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await expect(documentSaveButton(page)).toBeDisabled();

    logE2eEvent("manual-save.button-writes-to-disk", {
      file: "manual.md",
    });
  });

  test("offers the save button without an agent watching", async ({ page }) => {
    const filePath = writeProjectFile(
      projectDir,
      "unwatched.md",
      "# Unwatched\n\nBody.\n",
    );

    await openMarkdownFile(page, filePath, "code");

    await expect(documentSaveButton(page)).toBeVisible();
    await expect(page.getByTestId("review-handoff-button")).toHaveCount(0);

    logE2eEvent("manual-save.button-without-watcher", {
      file: "unwatched.md",
    });
  });
});
