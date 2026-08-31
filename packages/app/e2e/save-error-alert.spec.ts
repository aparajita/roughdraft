import { expect, test } from "@playwright/test";
import {
  appendInCodeEditor,
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  saveFailedAlert,
  saveFailedAlertCancelButton,
  saveFailedAlertRetryButton,
  writeProjectFile,
} from "./helpers";

test.describe("save failed alert", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("save-error-alert");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("retries and saves after clicking OK @smoke", async ({ page }) => {
    const filePath = writeProjectFile(
      projectDir,
      "retry.md",
      "# Retry\n\nOriginal body.\n",
    );

    let failNextWrite = true;
    await page.route("**/api/markdown-file*", async (route) => {
      if (route.request().method() === "PUT" && failNextWrite) {
        failNextWrite = false;
        await route.fulfill({ status: 500, body: "Simulated write failure" });
        return;
      }
      await route.continue();
    });

    await openMarkdownFile(page, filePath, "code");
    await appendInCodeEditor(page, "\nSaved after retry.\n");

    await expect(saveFailedAlert(page)).toBeVisible();
    await expect(saveFailedAlert(page)).toContainText(
      "The document failed to save. Try again?",
    );
    expect(readProjectFile(projectDir, "retry.md")).not.toContain(
      "Saved after retry.",
    );

    await saveFailedAlertRetryButton(page).click();

    await expect
      .poll(() => readProjectFile(projectDir, "retry.md"))
      .toContain("Saved after retry.");
    await expect(saveFailedAlert(page)).toBeHidden();

    logE2eEvent("save-error-alert.retry-succeeds", { file: "retry.md" });
  });

  test("Cancel dismisses the alert, and Cmd/Ctrl+S still retries", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "cancel.md",
      "# Cancel\n\nOriginal body.\n",
    );

    let failNextWrite = true;
    await page.route("**/api/markdown-file*", async (route) => {
      if (route.request().method() === "PUT" && failNextWrite) {
        failNextWrite = false;
        await route.fulfill({ status: 500, body: "Simulated write failure" });
        return;
      }
      await route.continue();
    });

    await openMarkdownFile(page, filePath, "code");
    await appendInCodeEditor(page, "\nSaved after shortcut retry.\n");

    await expect(saveFailedAlert(page)).toBeVisible();
    await saveFailedAlertCancelButton(page).click();
    await expect(saveFailedAlert(page)).toBeHidden();
    expect(readProjectFile(projectDir, "cancel.md")).not.toContain(
      "Saved after shortcut retry.",
    );

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S",
    );

    await expect
      .poll(() => readProjectFile(projectDir, "cancel.md"))
      .toContain("Saved after shortcut retry.");
    await expect(saveFailedAlert(page)).toBeHidden();

    logE2eEvent("save-error-alert.cancel-then-shortcut-retries", {
      file: "cancel.md",
    });
  });
});
