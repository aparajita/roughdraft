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

  test("renders a comment thread and saves a reply @smoke", async ({
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
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "Needs detail",
    );

    await page
      .getByTestId("comment-rail-rd-c1-action-reply")
      .evaluate((element) => {
        (element as HTMLButtonElement).click();
      });
    await page
      .getByTestId("comment-rail-rd-c2-editor")
      .fill("Added context looks good.");
    await page
      .getByTestId("comment-rail-rd-c2-action-save")
      .evaluate((element) => {
        (element as HTMLButtonElement).click();
      });

    await expect
      .poll(() => readProjectFile(projectDir, "comment.md"))
      .toContain("Added context looks good.");
    expect(readProjectFile(projectDir, "comment.md")).toContain("re: rd-c1");

    logE2eEvent("anchors.reply-saved", {
      file: "comment.md",
    });
  });

  test("creates a new root comment and saves it to disk @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "new-comment.md",
      [
        "# New Comment",
        "",
        "This paragraph has target text to review.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await selectRichText(page, "target text");
    await page.getByTestId("selection-menu-action-comment").click();
    await page
      .getByTestId("comment-rail-rd-c1-editor")
      .fill("Clarify this phrase.");
    await page.getByTestId("comment-rail-rd-c1-action-save").click();

    await expect
      .poll(() => readProjectFile(projectDir, "new-comment.md"))
      .toContain('<span id="rd-c1">target text</span>');
    expect(readProjectFile(projectDir, "new-comment.md")).toContain(
      "body: Clarify this phrase.",
    );

    logE2eEvent("anchors.root-comment-saved", {
      file: "new-comment.md",
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

  test("accepts and rejects suggested changes on disk @smoke", async ({
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
        "---",
        'roughdraft: "1.0"',
        "suggestions:",
        "  rd-s1:",
        "    by: user",
        "    at: 2026-04-23T18:00:00.000Z",
        "  rd-s2:",
        "    by: user",
        "    at: 2026-04-23T18:01:00.000Z",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await expect(page.locator('[id="rd-s1"]')).toBeVisible();

    await page.getByTestId("comment-rail-rd-s1-action-accept").click();
    await expect
      .poll(() => readProjectFile(projectDir, "suggestions.md"))
      .toContain("Keep clear wording here.");

    await page.getByTestId("comment-rail-rd-s2-action-reject").click();
    await expect
      .poll(() => readProjectFile(projectDir, "suggestions.md"))
      .toContain("Remove drafty there.");
    expect(readProjectFile(projectDir, "suggestions.md")).not.toContain("<ins");
    expect(readProjectFile(projectDir, "suggestions.md")).not.toContain("<del");

    logE2eEvent("anchors.suggestions-applied", {
      file: "suggestions.md",
    });
  });
});
