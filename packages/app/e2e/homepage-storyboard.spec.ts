import { expect, test } from "@playwright/test";
import { logE2eEvent } from "./helpers";

// The scene at which Roughdraft opens the plan, so the document preview inside
// the popup is what the docked visual shows from here on.
const DOCUMENT_PREVIEW_STAGE = 3;
/** Scenes in the storyboard: one per step of the plan-review workflow. */
const WORKFLOW_SCENE_COUNT = 6;
/** Traffic lights on a window chrome mock: close, minimise, zoom. */
const TRAFFIC_LIGHT_COUNT = 3;
/** Review threads Nora leaves on the plan: one comment, one suggestion. */
const REVIEW_THREAD_COUNT = 2;

// Desktop layout.
/** The document preview is shrunk to this fraction so a full page fits. */
const DESKTOP_DOCUMENT_SCALE = 0.6;
/** Decimal places the measured transform scale is compared to. */
const DOCUMENT_SCALE_PRECISION = 2;
/** A rail thread tracks its anchor: at most this far from the anchor's top. */
const MAX_RAIL_ANCHOR_DRIFT_PX = 8;
/** The comments shell leaves the rail this much of the popup's width. */
const MAX_SHELL_SHARE_OF_POPUP_WIDTH = 0.85;
/** Each scene is tall enough to hold the sticky visual beside it. */
const MIN_DESKTOP_SCENE_HEIGHT_PX = 500;

// Mobile dock: the visual pins to the bottom of the viewport as scenes scroll
// past it, so every threshold below keeps the dock and the copy from colliding.
/** A phone viewport narrow enough to put the layout in its docked mode. */
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const MIN_DOCK_BOTTOM_GAP_PX = 8;
const MAX_DOCK_BOTTOM_GAP_PX = 40;
const MIN_DOCK_HEIGHT_PX = 200;
/** Clearance between the bottom of a scene's copy and the top of the dock. */
const MIN_COPY_TO_DOCK_GAP_PX = 8;
/** Clearance between the document title and the bottom edge of the dock. */
const MIN_TITLE_TO_DOCK_BOTTOM_GAP_PX = 8;
/** The scaled document starts this close to the top of its workspace. */
const MAX_DOCUMENT_SURFACE_GAP_PX = 72;
/** Slack added below the dock when scrolling a scene to its activation line. */
const DOCK_ACTIVATION_SLACK_PX = 32;
/** The activation line sits no further than this fraction down the viewport. */
const DOCK_ACTIVATION_VIEWPORT_FRACTION = 0.35;

test.describe("homepage workflow storyboard", () => {
  test("renders the plan-review storyboard above the Markdown section @smoke", async ({
    page,
  }, testInfo) => {
    await page.goto("/");

    const storyboard = page.getByTestId("homepage-workflow-storyboard");
    await expect(storyboard).toBeVisible();
    await expect(page.getByTestId("homepage-workflow-heading")).toHaveText(
      "How it works",
    );

    const scenes = storyboard.getByTestId("homepage-workflow-scene");
    await expect(scenes).toHaveCount(WORKFLOW_SCENE_COUNT);
    const sceneTexts = await scenes.allTextContents();
    expect(sceneTexts).toHaveLength(WORKFLOW_SCENE_COUNT);
    expect(sceneTexts[0]).toContain("Ask for a plan");
    expect(sceneTexts[1]).toContain("The agent works normally");
    expect(sceneTexts[2]).toContain("Roughdraft opens the plan");
    expect(sceneTexts[3]).toContain("Leave comments and suggestions");
    expect(sceneTexts[4]).toContain("Click I'm done");
    expect(sceneTexts[5]).toContain("The agent resumes");
    await expect(storyboard).toContainText(
      "Let's make the homepage more persuasive. Write a plan first.",
    );

    const agentWorkTranscript = storyboard.getByTestId(
      "homepage-workflow-agent-work",
    );
    await expect(agentWorkTranscript).toHaveAttribute(
      "data-agent-work-visible",
      "false",
    );
    const hiddenTranscriptState = await agentWorkTranscript.evaluate(
      (element) => ({
        maxHeight: window.getComputedStyle(element).maxHeight,
        opacity: window.getComputedStyle(element).opacity,
      }),
    );
    expect(hiddenTranscriptState).toEqual({
      maxHeight: "0px",
      opacity: "0",
    });

    const roughdraftPopup = storyboard.getByTestId("homepage-workflow-popup");
    await expect(roughdraftPopup).toHaveAttribute(
      "data-popup-visible",
      "false",
    );
    await expect(roughdraftPopup).toHaveAttribute("aria-hidden", "true");

    const hiddenPopupState = await roughdraftPopup.evaluate((element) => ({
      opacity: window.getComputedStyle(element).opacity,
      pointerEvents: window.getComputedStyle(element).pointerEvents,
    }));
    expect(hiddenPopupState).toEqual({
      opacity: "0",
      pointerEvents: "none",
    });

    const getDesktopActivationOffset = async () =>
      storyboard
        .getByTestId("homepage-workflow-terminal")
        .evaluate((element) => element.getBoundingClientRect().top);

    await scenes.nth(1).evaluate((element) => {
      window.scrollTo({
        top: element.getBoundingClientRect().top + window.scrollY,
      });
    });
    await page.evaluate(
      (activationOffset) => {
        window.scrollBy(0, -activationOffset - 1);
      },
      await getDesktopActivationOffset(),
    );
    await expect(agentWorkTranscript).toHaveAttribute(
      "data-agent-work-visible",
      "false",
    );

    await scenes.nth(1).evaluate((element) => {
      window.scrollTo({
        top: element.getBoundingClientRect().top + window.scrollY,
      });
    });
    await page.evaluate(
      (activationOffset) => {
        window.scrollBy(0, -activationOffset);
      },
      await getDesktopActivationOffset(),
    );
    await expect(agentWorkTranscript).toHaveAttribute(
      "data-agent-work-visible",
      "true",
    );
    await expect(storyboard).toContainText(
      "I'll inspect the current homepage, draft a Markdown plan, and open it in Roughdraft for review before I code.",
    );
    await expect(
      storyboard.getByTestId("homepage-workflow-terminal-tools"),
    ).toContainText("Explored");
    await expect(
      storyboard.getByTestId("homepage-workflow-terminal-tools"),
    ).toContainText('Search rg "It\'s just Markdown" packages/app/src');
    await expect(roughdraftPopup).toHaveAttribute(
      "data-popup-visible",
      "false",
    );

    await scenes.nth(2).evaluate((element) => {
      window.scrollTo({
        top: element.getBoundingClientRect().top + window.scrollY,
      });
    });
    await expect(roughdraftPopup).toHaveAttribute("data-popup-visible", "true");
    await expect(roughdraftPopup).not.toHaveAttribute("aria-hidden", "true");
    await expect(
      roughdraftPopup.getByTestId("homepage-workflow-popup-traffic-lights"),
    ).toHaveCount(1);
    await expect(
      roughdraftPopup
        .getByTestId("homepage-workflow-popup-traffic-lights")
        .getByTestId("homepage-workflow-popup-traffic-light"),
    ).toHaveCount(TRAFFIC_LIGHT_COUNT);
    await expect(
      roughdraftPopup.getByTestId("homepage-workflow-popup-header"),
    ).toHaveCSS("background-color", "oklch(0.129 0.042 264.695)");
    await expect(
      storyboard.getByTestId("homepage-workflow-document-title"),
    ).toBeVisible();
    await expect(
      roughdraftPopup.getByTestId(
        "homepage-workflow-document-shell-no-comments",
      ),
    ).toBeVisible();
    const previewLayout = await storyboard.evaluate((element) => {
      const terminal = element.querySelector(
        '[data-testid="homepage-workflow-terminal"]',
      );
      const popup = element.querySelector(
        '[data-testid="homepage-workflow-popup"]',
      );
      const scaledDocument = element.querySelector(
        '[data-testid="homepage-workflow-document-scale"]',
      );
      if (!terminal || !popup || !scaledDocument) {
        throw new Error("Expected terminal, popup, and scaled document");
      }

      const transform = window.getComputedStyle(scaledDocument).transform;
      const matrix =
        transform === "none"
          ? new DOMMatrixReadOnly()
          : new DOMMatrixReadOnly(transform);

      return {
        documentScale: matrix.a,
        popupWidth: popup.getBoundingClientRect().width,
        terminalWidth: terminal.getBoundingClientRect().width,
      };
    });
    expect(previewLayout.popupWidth).toBeGreaterThan(
      previewLayout.terminalWidth,
    );
    expect(previewLayout.documentScale).toBeCloseTo(
      DESKTOP_DOCUMENT_SCALE,
      DOCUMENT_SCALE_PRECISION,
    );
    await expect(
      roughdraftPopup.getByTestId("homepage-workflow-review-comment"),
    ).toHaveCount(0);
    await expect(
      storyboard.getByTestId("homepage-workflow-handoff-button"),
    ).toHaveCount(0);
    await expect(storyboard).not.toContainText("Review complete");

    await scenes.nth(3).evaluate((element) => {
      window.scrollTo({
        top: element.getBoundingClientRect().top + window.scrollY,
      });
    });
    await expect(
      roughdraftPopup.getByTestId(
        "homepage-workflow-document-shell-with-comments",
      ),
    ).toBeVisible();
    await expect(
      roughdraftPopup.getByTestId("homepage-workflow-review-comment"),
    ).toBeVisible();
    await expect(
      roughdraftPopup.getByTestId("homepage-workflow-review-rail"),
    ).toContainText("Nora");
    await expect(
      roughdraftPopup.getByTestId("homepage-workflow-review-rail"),
    ).not.toContainText("AI");
    await expect(
      roughdraftPopup.getByTestId("homepage-workflow-review-rail"),
    ).toContainText('Replace: "agent\'s plan" with "homepage plan"');
    await expect
      .poll(async () =>
        storyboard.evaluate((element, threadCount) => {
          const highlight = element.querySelector(
            '[data-testid="homepage-workflow-comment-highlight"]',
          );
          const suggestion = element.querySelector(
            '[data-testid="homepage-workflow-suggestion-old"]',
          );
          const threads = element.querySelectorAll(
            '[data-testid="homepage-workflow-review-thread"]',
          );

          if (!highlight || !suggestion || threads.length < threadCount) {
            throw new Error("Expected review anchors and Nora review threads");
          }

          return Math.max(
            Math.abs(
              threads[0].getBoundingClientRect().top -
                highlight.getBoundingClientRect().top,
            ),
            Math.abs(
              threads[1].getBoundingClientRect().top -
                suggestion.getBoundingClientRect().top,
            ),
          );
        }, REVIEW_THREAD_COUNT),
      )
      .toBeLessThanOrEqual(MAX_RAIL_ANCHOR_DRIFT_PX);
    await expect(
      storyboard.getByTestId("homepage-workflow-agent-resume"),
    ).toHaveAttribute("data-terminal-line-visible", "false");
    const commentsLayout = await storyboard.evaluate((element) => {
      const popup = element.querySelector(
        '[data-testid="homepage-workflow-popup"]',
      );
      const shell = element.querySelector(
        '[data-testid="homepage-workflow-document-shell-with-comments"]',
      );
      if (!popup || !shell) {
        throw new Error("Expected popup and comments shell");
      }

      return {
        bodyScrollWidth: document.body.scrollWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        popupWidth: popup.getBoundingClientRect().width,
        shellWidth: shell.getBoundingClientRect().width,
        viewportWidth: window.innerWidth,
      };
    });
    expect(commentsLayout.bodyScrollWidth).toBeLessThanOrEqual(
      commentsLayout.viewportWidth,
    );
    expect(commentsLayout.documentScrollWidth).toBeLessThanOrEqual(
      commentsLayout.viewportWidth,
    );
    expect(commentsLayout.shellWidth).toBeLessThan(
      commentsLayout.popupWidth * MAX_SHELL_SHARE_OF_POPUP_WIDTH,
    );

    await scenes.nth(4).evaluate((element) => {
      window.scrollTo({
        top: element.getBoundingClientRect().top + window.scrollY,
      });
    });
    await expect(
      storyboard.getByTestId("homepage-workflow-handoff-button"),
    ).toBeVisible();
    await expect(storyboard).not.toContainText("Review complete");

    const stickyLayout = await storyboard.evaluate((element) => {
      const sticky = element.querySelector(
        '[data-testid="homepage-workflow-sticky-visual"]',
      );
      const sceneList = element.querySelector(
        '[data-testid="homepage-workflow-scene-list"]',
      );
      if (!sticky || !sceneList) {
        throw new Error("Expected sticky visual and scene list");
      }

      const stickyRect = sticky.getBoundingClientRect();
      const sceneListRect = sceneList.getBoundingClientRect();
      return {
        position: window.getComputedStyle(sticky).position,
        sceneListRight: sceneListRect.right,
        stickyLeft: stickyRect.left,
        stickyTop: stickyRect.top,
      };
    });
    expect(stickyLayout.position).toBe("sticky");
    expect(stickyLayout.stickyLeft).toBeGreaterThan(
      stickyLayout.sceneListRight,
    );

    await scenes.nth(5).evaluate((element) => {
      window.scrollTo({
        top: element.getBoundingClientRect().top + window.scrollY,
      });
    });
    await expect(
      storyboard.getByTestId("homepage-workflow-handoff-button"),
    ).toHaveCount(0);
    await expect(
      storyboard.getByTestId("homepage-workflow-agent-resume"),
    ).toHaveAttribute("data-terminal-line-visible", "true");
    await expect(storyboard).toContainText(
      "I accepted your wording suggestion and moved the workflow story above the Markdown section.",
    );
    await expect(storyboard).toContainText(
      "Review a homepage plan before it starts coding.",
    );
    await expect(
      roughdraftPopup.getByTestId("homepage-workflow-review-comment"),
    ).toBeVisible();
    await expect(
      roughdraftPopup.getByTestId("homepage-workflow-review-rail"),
    ).toContainText('This should go above "It\'s just Markdown."');
    await expect(
      roughdraftPopup.getByTestId("homepage-workflow-review-rail"),
    ).toContainText("Sounds good. I'll move it above that section.");

    const sceneLayout = await scenes.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          height: rect.height,
          top: rect.top + window.scrollY,
        };
      }),
    );
    expect(sceneLayout).toHaveLength(WORKFLOW_SCENE_COUNT);
    for (let index = 1; index < sceneLayout.length; index += 1) {
      expect(sceneLayout[index].top).toBeGreaterThan(
        sceneLayout[index - 1].top,
      );
    }
    for (const scene of sceneLayout) {
      expect(scene.height).toBeGreaterThan(MIN_DESKTOP_SCENE_HEIGHT_PX);
    }

    const storyboardTop = await storyboard.evaluate(
      (element) => element.getBoundingClientRect().top + window.scrollY,
    );
    const markdownTop = await page
      .getByTestId("rfm-format-demo")
      .evaluate(
        (element) => element.getBoundingClientRect().top + window.scrollY,
      );
    expect(storyboardTop).toBeLessThan(markdownTop);

    await testInfo.attach("homepage-workflow-storyboard-desktop", {
      body: await storyboard.screenshot(),
      contentType: "image/png",
    });

    logE2eEvent("homepage.workflow-storyboard.desktop", {
      commentsLayout,
      previewLayout,
      sceneLayout,
      stickyLayout,
      storyboardTop,
      markdownTop,
    });
  });

  test("docks the storyboard visual without mobile overlap", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/");

    const storyboard = page.getByTestId("homepage-workflow-storyboard");
    await expect(storyboard).toBeVisible();
    await expect(page.getByTestId("homepage-workflow-heading")).toHaveText(
      "How it works",
    );

    const mobileSceneTexts = await storyboard
      .getByTestId("homepage-workflow-scene")
      .allTextContents();
    expect(mobileSceneTexts).toHaveLength(WORKFLOW_SCENE_COUNT);
    expect(mobileSceneTexts[0]).toContain("Ask for a plan");
    expect(mobileSceneTexts[1]).toContain("The agent works normally");
    expect(mobileSceneTexts[2]).toContain("Roughdraft opens the plan");
    expect(mobileSceneTexts[3]).toContain("Leave comments and suggestions");
    expect(mobileSceneTexts[4]).toContain("Click I'm done");
    expect(mobileSceneTexts[5]).toContain("The agent resumes");

    const stickyVisual = storyboard.getByTestId(
      "homepage-workflow-sticky-visual",
    );
    await expect(stickyVisual).toBeVisible();
    const scenes = storyboard.getByTestId("homepage-workflow-scene");

    await storyboard.evaluate((element) => {
      window.scrollTo({
        top: element.getBoundingClientRect().top + window.scrollY,
      });
    });

    const layoutAtStart = await storyboard.evaluate((element) => {
      const sticky = element.querySelector(
        '[data-testid="homepage-workflow-sticky-visual"]',
      );
      const sceneList = element.querySelector(
        '[data-testid="homepage-workflow-scene-list"]',
      );
      const popup = element.querySelector(
        '[data-testid="homepage-workflow-popup"]',
      );
      if (!sticky || !sceneList || !popup) {
        throw new Error("Expected sticky visual, scene list, and popup");
      }

      const stickyRect = sticky.getBoundingClientRect();
      const popupRect = popup.getBoundingClientRect();
      const stickyStyles = window.getComputedStyle(sticky);
      const sceneListStyles = window.getComputedStyle(sceneList);
      const popupStyles = window.getComputedStyle(popup);

      return {
        bodyScrollWidth: document.body.scrollWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        popupLeft: popupRect.left,
        popupRight: popupRect.right,
        popupOverhang: popupStyles.getPropertyValue(
          "--homepage-workflow-popup-overhang",
        ),
        position: stickyStyles.position,
        sceneListPaddingBottom: Number.parseFloat(
          sceneListStyles.paddingBottom,
        ),
        stickyMobileVisible: sticky.getAttribute(
          "data-mobile-workflow-visible",
        ),
        stickyOpacity: stickyStyles.opacity,
        stickyPointerEvents: stickyStyles.pointerEvents,
        stickyBottomGap: window.innerHeight - stickyRect.bottom,
        stickyHeight: stickyRect.height,
        stickyTop: stickyRect.top,
        storyboardClientWidth: element.clientWidth,
        storyboardScrollWidth: element.scrollWidth,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
      };
    });

    expect(layoutAtStart.position).toBe("sticky");
    expect(layoutAtStart.stickyMobileVisible).toBe("false");
    expect(layoutAtStart.stickyOpacity).toBe("0");
    expect(layoutAtStart.stickyPointerEvents).toBe("none");
    expect(layoutAtStart.stickyBottomGap).toBeGreaterThanOrEqual(
      MIN_DOCK_BOTTOM_GAP_PX,
    );
    expect(layoutAtStart.stickyBottomGap).toBeLessThan(MAX_DOCK_BOTTOM_GAP_PX);
    expect(layoutAtStart.stickyHeight).toBeGreaterThan(MIN_DOCK_HEIGHT_PX);
    expect(layoutAtStart.sceneListPaddingBottom).toBeGreaterThan(
      layoutAtStart.stickyHeight,
    );
    expect(layoutAtStart.popupOverhang.trim()).toBe("0rem");
    expect(layoutAtStart.popupLeft).toBeGreaterThanOrEqual(0);
    expect(layoutAtStart.popupRight).toBeLessThanOrEqual(
      layoutAtStart.viewportWidth,
    );

    const stageLayouts: Array<{
      copyBottom: number;
      copyTop: number;
      documentSurfaceGap: number | null;
      documentTitleBottom: number | null;
      documentTitleTop: number | null;
      popupHeaderIsPaintedAboveDock: boolean | null;
      popupHeaderTop: number | null;
      stage: number;
      stickyBottom: number;
      stickyTop: number;
      viewportHeight: number;
    }> = [];
    for (const index of [1, 2, 3, 4, 5]) {
      const targetStage = String(index + 1);
      await scenes.nth(index).evaluate(
        (element, { slackPx, viewportFraction }) => {
          const sticky = document.querySelector(
            '[data-testid="homepage-workflow-sticky-visual"]',
          );
          if (!sticky) {
            throw new Error("Expected sticky visual");
          }

          const stickyRect = sticky.getBoundingClientRect();
          const activationLine = Math.max(
            0,
            Math.ceil(
              stickyRect.top -
                Math.min(
                  stickyRect.height + slackPx,
                  window.innerHeight * viewportFraction,
                ),
            ),
          );
          window.scrollTo({
            top:
              element.getBoundingClientRect().top +
              window.scrollY -
              activationLine,
          });
        },
        {
          slackPx: DOCK_ACTIVATION_SLACK_PX,
          viewportFraction: DOCK_ACTIVATION_VIEWPORT_FRACTION,
        },
      );

      await expect(
        storyboard.getByTestId("homepage-workflow-terminal"),
      ).toHaveAttribute("data-homepage-workflow-terminal-stage", targetStage);
      await expect(stickyVisual).toHaveAttribute(
        "data-mobile-workflow-visible",
        "true",
      );

      stageLayouts.push(
        await scenes.nth(index).evaluate(
          (element, { documentPreviewStage, stage }) => {
            const sticky = document.querySelector(
              '[data-testid="homepage-workflow-sticky-visual"]',
            );
            const sceneCopy = element.querySelector(
              '[data-testid="homepage-workflow-scene-copy"]',
            );
            const documentTitle = document.querySelector(
              '[data-testid="homepage-workflow-document-title"]',
            );
            const documentScale = document.querySelector(
              '[data-testid="homepage-workflow-document-scale"]',
            );
            const documentWorkspace = document.querySelector(
              '[data-testid="homepage-workflow-document-workspace"]',
            );
            const popupHeader = document.querySelector(
              '[data-testid="homepage-workflow-popup-header"]',
            );
            if (
              !sticky ||
              !sceneCopy ||
              !documentTitle ||
              !documentScale ||
              !documentWorkspace ||
              !popupHeader
            ) {
              throw new Error(
                "Expected sticky visual, scene copy, document preview, and popup header",
              );
            }

            const stickyRect = sticky.getBoundingClientRect();
            const copyRect = sceneCopy.getBoundingClientRect();
            const scaleRect = documentScale.getBoundingClientRect();
            const titleRect = documentTitle.getBoundingClientRect();
            const workspaceRect = documentWorkspace.getBoundingClientRect();
            const popupHeaderRect = popupHeader.getBoundingClientRect();
            const headerHitTarget = document.elementFromPoint(
              popupHeaderRect.left + popupHeaderRect.width / 2,
              popupHeaderRect.top + popupHeaderRect.height / 2,
            );
            // Nothing is painted over the header: what the viewer would click at
            // its centre is the header itself, not the dock behind it.
            const headerIsTopmost =
              headerHitTarget !== null &&
              headerHitTarget.closest(
                '[data-testid="homepage-workflow-popup-header"]',
              ) !== null;
            const showsDocument = stage >= documentPreviewStage;
            return {
              copyBottom: copyRect.bottom,
              copyTop: copyRect.top,
              documentSurfaceGap: showsDocument
                ? scaleRect.top - workspaceRect.top
                : null,
              documentTitleBottom: showsDocument ? titleRect.bottom : null,
              documentTitleTop: showsDocument ? titleRect.top : null,
              popupHeaderIsPaintedAboveDock: showsDocument
                ? popupHeaderRect.top < stickyRect.top && headerIsTopmost
                : null,
              popupHeaderTop: showsDocument ? popupHeaderRect.top : null,
              stage,
              stickyBottom: stickyRect.bottom,
              stickyTop: stickyRect.top,
              viewportHeight: window.innerHeight,
            };
          },
          { documentPreviewStage: DOCUMENT_PREVIEW_STAGE, stage: index + 1 },
        ),
      );
    }

    for (const stageLayout of stageLayouts) {
      expect(stageLayout.copyTop).toBeGreaterThanOrEqual(0);
      expect(stageLayout.copyBottom).toBeLessThanOrEqual(
        stageLayout.stickyTop - MIN_COPY_TO_DOCK_GAP_PX,
      );
      expect(stageLayout.stickyBottom).toBeLessThanOrEqual(
        stageLayout.viewportHeight,
      );
      if (stageLayout.stage < DOCUMENT_PREVIEW_STAGE) continue;

      const { documentSurfaceGap, documentTitleBottom, popupHeaderTop } =
        stageLayout;
      // A missing measurement is a failure, not a reason to skip the checks
      // below: the document preview is on screen from this stage onward.
      if (
        documentSurfaceGap === null ||
        documentTitleBottom === null ||
        popupHeaderTop === null
      ) {
        throw new Error(
          `Stage ${stageLayout.stage} reported no document preview layout`,
        );
      }

      expect(documentTitleBottom).toBeLessThanOrEqual(
        stageLayout.stickyBottom - MIN_TITLE_TO_DOCK_BOTTOM_GAP_PX,
      );
      expect(documentSurfaceGap).toBeLessThanOrEqual(
        MAX_DOCUMENT_SURFACE_GAP_PX,
      );
      expect(popupHeaderTop).toBeLessThan(stageLayout.stickyTop);
      expect(stageLayout.popupHeaderIsPaintedAboveDock).toBe(true);
    }

    const dimensions = await page.evaluate(() => ({
      bodyScrollWidth: document.body.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      storyboardClientWidth:
        document.querySelector('[data-testid="homepage-workflow-storyboard"]')
          ?.clientWidth ?? 0,
      storyboardScrollWidth:
        document.querySelector('[data-testid="homepage-workflow-storyboard"]')
          ?.scrollWidth ?? 0,
      viewportWidth: window.innerWidth,
    }));

    expect(dimensions.bodyScrollWidth).toBeLessThanOrEqual(
      dimensions.viewportWidth,
    );
    expect(dimensions.documentScrollWidth).toBeLessThanOrEqual(
      dimensions.viewportWidth,
    );
    expect(dimensions.storyboardScrollWidth).toBeLessThanOrEqual(
      dimensions.storyboardClientWidth,
    );

    await testInfo.attach("homepage-workflow-storyboard-mobile", {
      body: await storyboard.screenshot(),
      contentType: "image/png",
    });

    logE2eEvent("homepage.workflow-storyboard.mobile-sticky", {
      dimensions,
      layoutAtStart,
      stageLayouts,
    });
  });
});
