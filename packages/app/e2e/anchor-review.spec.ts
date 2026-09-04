import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openContextMenuOnSelection,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  selectRichText,
  writeProjectFile,
} from "./helpers";

test.describe("Anchor review flows", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("anchors");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("opens a thread from its chip and saves a reply sent with Cmd+Enter @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "comment.md",
      [
        "# Comment Review",
        "",
        'This paragraph has <span id="rd-c1">target text</span>.',
        "",
        "---",
        'roughdraft: "1.0"',
        "comments:",
        "  rd-c1:",
        "    body: Needs detail",
        "    by: user",
        "    at: 2026-04-23T18:00:00.000Z",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    // The rail stays permanently hidden (`--breakpoint-rail` is unreachable);
    // the footer is the only place the chip renders.
    await page
      .getByTestId("review-entry-footer")
      .getByTestId("review-entry-chip-rd-c1")
      .click();

    const dialog = page.getByTestId("review-thread-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Needs detail");

    const composer = page.getByTestId("review-thread-dialog-composer");
    await expect(composer).toBeFocused();
    await composer.fill("Added context looks good.");
    await composer.press("ControlOrMeta+Enter");

    await expect
      .poll(() => readProjectFile(projectDir, "comment.md"))
      .toContain("Added context looks good.");
    expect(readProjectFile(projectDir, "comment.md")).toContain("re: rd-c1");

    logE2eEvent("anchors.reply-saved", {
      file: "comment.md",
    });
  });

  test("refuses to comment a selection that partially overlaps an anchor", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "overlap.md",
      [
        "# Overlap",
        "",
        'This paragraph has <span id="rd-c1">target text</span> to review.',
        "",
        "---",
        'roughdraft: "1.0"',
        "comments:",
        "  rd-c1:",
        "    body: Needs detail",
        "    by: user",
        "    at: 2026-04-23T18:00:00.000Z",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await selectRichText(page, "text to review");

    await expect(
      page.getByTestId("selection-menu-action-comment"),
    ).toBeDisabled();
    expect(readProjectFile(projectDir, "overlap.md")).toContain(
      '<span id="rd-c1">target text</span>',
    );
  });

  /**
   * A browser dispatches no mouse events over a disabled control, so the reason
   * only reaches the reviewer if something else takes the hover. jsdom does
   * dispatch them, so a component test would pass whether or not it does — this
   * has to run in a real browser to mean anything.
   */
  test("explains why a selection crossing a block boundary cannot be commented @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "cross-block.md",
      [
        "# Cross Block",
        "",
        "First paragraph ends here.",
        "",
        "Second paragraph starts here.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await selectRichText(page, "ends here.Second paragraph");

    await expect(
      page.getByTestId("selection-menu-action-comment"),
    ).toBeDisabled();
    await expect(page.getByTestId("blocked-action-tooltip")).toHaveCount(0);

    await page.getByTestId("selection-menu-action-comment").hover();

    await expect(page.getByTestId("blocked-action-tooltip")).toBeVisible();
  });

  test("explains why a selection inside inline code cannot be commented @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "inline-code.md",
      ["# Inline Code", "", "Press the `escape key` to dismiss.", ""].join(
        "\n",
      ),
    );

    await openMarkdownFile(page, filePath);
    await selectRichText(page, "escape");

    await expect(
      page.getByTestId("selection-menu-action-comment"),
    ).toBeDisabled();

    await page.getByTestId("selection-menu-action-comment").hover();

    await expect(page.getByTestId("blocked-action-tooltip")).toContainText(
      "inside inline code",
    );
  });

  test("refuses every review action inside a code block", async ({ page }) => {
    const filePath = writeProjectFile(
      projectDir,
      "code-block.md",
      ["# Code Block", "", "```js", "const answer = 42;", "```", ""].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await selectRichText(page, "const answer = 42;");

    await expect(
      page.getByTestId("selection-menu-action-comment"),
    ).toBeDisabled();

    await openContextMenuOnSelection(page);

    for (const action of [
      "add-comment",
      "suggest-insertion",
      "suggest-deletion",
      "suggest-replacement",
    ]) {
      await expect(
        page.getByTestId(`editor-context-menu-action-${action}`),
      ).toBeDisabled();
    }
  });

  test("refuses every review action across an inline code boundary", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "inline-code-actions.md",
      ["# Inline Code Actions", "", "Press the `escape key` now.", ""].join(
        "\n",
      ),
    );

    await openMarkdownFile(page, filePath);
    // The rendered text carries no backticks, so this runs from the prose into
    // the code span and stops partway through it.
    await selectRichText(page, "the escape");

    await openContextMenuOnSelection(page);

    for (const action of [
      "add-comment",
      "suggest-insertion",
      "suggest-deletion",
      "suggest-replacement",
    ]) {
      await expect(
        page.getByTestId(`editor-context-menu-action-${action}`),
      ).toBeDisabled();
    }
  });

  test("shows tooltips for selection menu formatting actions", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "selection-tooltips.md",
      [
        "# Selection Tooltips",
        "",
        "This paragraph has target text to review.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await selectRichText(page, "target text");

    await page.getByTestId("selection-menu-action-bold").hover();
    await expect(page.getByTestId("selection-menu-action-tooltip")).toHaveText(
      "Bold",
    );

    await expect(
      page.getByTestId("selection-menu-action-suggest-insertion"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("selection-menu-action-suggest-deletion"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("selection-menu-action-suggest-replacement"),
    ).toHaveCount(0);

    await page.getByTestId("selection-menu-action-comment").hover();
    await expect(page.getByTestId("selection-menu-action-tooltip")).toHaveCount(
      0,
    );
  });

  test("accepts a suggestion from the dialog and makes the next entry current @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "suggestions.md",
      [
        "# Suggestion Review",
        "",
        'Keep <ins id="rd-s1">clear wording</ins> here.',
        "",
        'Remove <del id="rd-s2">drafty </del>there.',
        "",
        'Add <ins id="rd-s3">a closing line</ins> below.',
        "",
        "---",
        'roughdraft: "1.0"',
        "suggestions:",
        "  rd-s1:",
        "    by: user",
        "    at: 2026-04-23T18:00:00.000Z",
        "  rd-s2:",
        "    by: user",
        "    at: 2026-04-23T18:01:00.000Z",
        "  rd-s3:",
        "    by: user",
        "    at: 2026-04-23T18:02:00.000Z",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await expect(page.locator('[id="rd-s2"]')).toBeVisible();

    // The rail stays permanently hidden (`--breakpoint-rail` is unreachable);
    // the footer only ever renders the current entry's chip, so advance to
    // the middle suggestion first, distinguishing it from falling back to the
    // first one.
    const footer = page.getByTestId("review-entry-footer");
    await footer.getByTestId("review-entry-footer-action-next").click();
    await expect(footer.getByTestId("review-entry-chip-rd-s2")).toBeVisible();

    await footer.getByTestId("review-entry-chip-rd-s2").click();
    await expect(page.getByTestId("review-thread-dialog")).toBeVisible();

    await page.getByTestId("review-thread-dialog-action-accept").click();

    await expect(page.getByTestId("review-thread-dialog")).toBeHidden();
    await expect
      .poll(() => readProjectFile(projectDir, "suggestions.md"))
      .toContain("Remove there.");
    await expect(footer.getByTestId("review-entry-chip-rd-s3")).toBeVisible();

    logE2eEvent("anchors.suggestions-applied", {
      file: "suggestions.md",
    });
  });

  test("navigates entries from the footer below the rail breakpoint", async ({
    page,
  }) => {
    // Below `--breakpoint-rail`, where the rail is replaced by the fixed footer.
    await page.setViewportSize({ width: 900, height: 800 });

    const filePath = writeProjectFile(
      projectDir,
      "narrow.md",
      [
        "# Narrow Review",
        "",
        'First paragraph has <span id="rd-c1">target text</span>.',
        "",
        'Second paragraph has <span id="rd-c2">other text</span>.',
        "",
        "---",
        'roughdraft: "1.0"',
        "comments:",
        "  rd-c1:",
        "    body: Needs detail",
        "    by: user",
        "    at: 2026-04-23T18:00:00.000Z",
        "  rd-c2:",
        "    body: Needs a source",
        "    by: user",
        "    at: 2026-04-23T18:01:00.000Z",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);

    const footer = page.getByTestId("review-entry-footer");
    await expect(footer).toBeVisible();
    await expect(page.getByTestId("document-review-rail")).toBeHidden();

    await footer.getByTestId("review-entry-chip-rd-c1").click();
    await expect(footer.getByTestId("review-entry-chip-rd-c1")).toBeVisible();

    await page.getByTestId("review-entry-footer-action-next").click();

    await expect(footer.getByTestId("review-entry-chip-rd-c2")).toBeVisible();
    await expect(footer.getByTestId("review-entry-chip-rd-c1")).toHaveCount(0);
  });
});
