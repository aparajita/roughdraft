# Homepage Workflow Storyboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Expand the homepage workflow explanation into a conversion-focused six-scene storyboard, positioned above the "It's just Markdown" / Roughdraft format demo section.

**Architecture:** Keep this as static homepage UI in `packages/app/src/App.tsx`, backed by typed scene data and small presentational helper components in the same file because the storyboard is homepage-specific. Use CSS in `packages/app/src/style.css` only for the pieces Tailwind cannot express cleanly, such as the responsive horizontal connector and compact mock UI surfaces. Do not add runtime dependencies or route-level state.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, shadcn `Button`, lucide-react icons, Vitest/JSDOM for semantic homepage assertions, Playwright for browser layout and screenshot evidence.

---

## Strategy gate

The user's actual conversion problem is not "show more Markdown syntax." The page already explains the format, but visitors still need to understand when Roughdraft enters the agent workflow and why the blocking review step matters. The cleanest solution is to promote the workflow section above the format demo and make it concrete with one realistic plan-review loop.

Do not implement this as image-only screenshots. Static screenshots would be stale and hard to maintain. Build real in-page mock UI surfaces that look like chat, tool-call output, a Roughdraft plan window, comments, the Done Reviewing popover, and the resumed agent chat. This gives the page a richer product story while keeping the implementation deterministic, responsive, testable, and aligned with Roughdraft's single-file Markdown + CriticMarkup architecture.

The storyboard should be specifically about reviewing an agent's plan before implementation, not generic document review. That is the sharp conversion hook:

> Review an agent's plan before it starts coding.

This also answers the user's confusion about "Medium strategy": the testing strategy should be written down and executed from this plan, not treated as an invisible subagent output. If the user asks again where the strategy or plan lives, answer directly: yes, it is this Markdown file at `docs/plans/2026-05-07-homepage-workflow-storyboard.md`.

Do not add a new approval gate unless the user asks to revise the plan first. The user already asked to run trycycle in the current checkout, and this plan is the execution source of truth.

Handoff expectation for the executor: if the user asks where the work is being planned or reviewed, name the plan file directly instead of summarizing an unseen "Medium strategy." The user's immediate confusion was about process visibility, so the implementation handoff should keep the Markdown plan path visible.

## Relevant existing context

- `docs/adr/0001-single-local-markdown-file.md` says Roughdraft's unit of work is one Markdown file. The storyboard should show `homepage-conversion-plan.md`, not projects, vaults, or multi-file workspaces.
- `docs/adr/0002-anchors-and-endmatter-as-review-format.md` says review feedback is portable Markdown plus anchors and endmatter. The storyboard should show inline comments and suggested changes as visible document feedback, not hidden app state.
- `docs/adr/0003-markdown-roundtrip-contract.md` says Markdown round trips matter. The storyboard should reinforce that the agent resumes by reading the same edited Markdown file.
- `docs/adr/0004-cli-server-state-model.md` says the CLI opens/reuses a local server. The storyboard should say Roughdraft opens when the agent is ready, but should not introduce new server or sync claims.
- `Homepage` currently renders hero -> `sneak-peek.png` -> `RoughdraftFormatDemo` -> a small two-card workflow section. The new storyboard replaces the small section and moves above `RoughdraftFormatDemo`.
- `homepage.test.tsx` already asserts a lot of homepage copy and structure. Split the new storyboard checks into focused tests instead of making the existing CTA test larger.

## Product copy and scene content

Use this section as the source of truth for copy. Keep punctuation ASCII and avoid typographic quotes.

Section eyebrow:

```text
Workflow
```

Section heading:

```text
Review an agent's plan before it starts coding.
```

Section body:

```text
Ask for a plan, mark it up in Roughdraft, click Done Reviewing, and the agent continues from the edited Markdown file.
```

Scene data:

```ts
const HOMEPAGE_WORKFLOW_SCENES = [
  {
    step: "01",
    title: "Ask for a plan",
    description:
      "Start in the same agent chat you already use. Ask for a reviewable Markdown plan before implementation begins.",
  },
  {
    step: "02",
    title: "The agent works normally",
    description:
      "It inspects files, runs tools, and drafts the plan in the background. Roughdraft does not replace your agent workflow.",
  },
  {
    step: "03",
    title: "Roughdraft opens the plan",
    description:
      "When the file is ready, the agent opens the Markdown plan in Roughdraft and waits while you review.",
  },
  {
    step: "04",
    title: "Leave comments and suggestions",
    description:
      "Ask questions, redirect priorities, and suggest exact wording inline where the agent can read it later.",
  },
  {
    step: "05",
    title: "Click Done Reviewing",
    description:
      "Roughdraft hands control back to the agent once you are finished with the blocking review step.",
  },
  {
    step: "06",
    title: "The agent resumes",
    description:
      "The next agent turn reads the same Markdown file, sees your comments, and continues with the corrected plan.",
  },
] as const;
```

Primary mock conversation and plan content:

```text
User: Let's make the homepage more persuasive. Write a plan first.
Agent: I'll inspect the current homepage, draft a Markdown plan, and open it in Roughdraft for review before I code.
Tool activity:
- rg "It's just Markdown" packages/app/src
- sed -n '1,220p' packages/app/src/App.tsx
- write .context/homepage-conversion-plan.md

Plan title: Homepage Conversion Plan
Plan bullets:
- Move the workflow story above "It's just Markdown."
- Show the agent pause, the review window, and the resume signal.
- Keep the format section as proof that the review data is portable Markdown.

Comments:
- This should go above "It's just Markdown."
- Can we make the example about homepage conversion?

Suggested change:
Review an agent's plan before it starts coding.

Done popover title:
Review complete

Done popover body:
Your agent can read the edited Markdown file now.

Resumed agent:
I read your comments. I'll move the workflow storyboard above the Markdown section and use the homepage conversion example.
```

## Task 1: Add focused failing homepage tests

**Files:**
- Modify: `packages/app/test/homepage.test.tsx`

**Step 1: Split storyboard assertions out of the existing CTA test**

Keep the existing `"opens the agent setup prompt from the CTA and copies it"` test focused on hero, CTA, setup prompt, GitHub link, format demo survival, and existing interactive sample behavior. Remove the old assertions for the small two-card workflow section:

```ts
expect(container.textContent).toContain("Review workflow");
expect(container.textContent).toContain(
  "Pass the same Markdown file back and forth with your agent.",
);
expect(container.textContent).toContain("Review an agent's draft");
expect(container.textContent).toContain(
  "tell the agent to read the file again",
);
expect(container.textContent).toContain("Ask the agent to review yours");
expect(container.textContent).toContain(
  "leave detailed comments, questions, and suggested edits",
);
```

**Step 2: Add a helper to render the homepage**

Add this helper near the existing `click` helper:

```ts
async function renderHomepage(root: Root) {
  await act(async () => {
    root.render(
      <Homepage
        message="Roughdraft is a markdown editor with commenting and suggest changes mode, making it easier to align with AI on complex ideas."
        updateStatus={null}
      />,
    );
    await Promise.resolve();
  });
}
```

Update the CTA test to call `await renderHomepage(root);`.

**Step 3: Add the failing semantic storyboard test**

Add this test inside `describe("Homepage", () => { ... })`:

```ts
it("explains the plan-review workflow as a six-scene storyboard above the Markdown section", async () => {
  await renderHomepage(root);

  const text = container.textContent ?? "";
  expect(text).toContain("Review an agent's plan before it starts coding.");
  expect(text).toContain(
    "Ask for a plan, mark it up in Roughdraft, click Done Reviewing, and the agent continues from the edited Markdown file.",
  );

  const storyboard = container.querySelector("[data-homepage-workflow-storyboard]");
  expect(storyboard).not.toBeNull();
  expect(storyboard?.getAttribute("aria-labelledby")).toBe(
    "homepage-workflow-heading",
  );

  const markdownDemo = container.querySelector(".rfm-format-demo");
  expect(markdownDemo).not.toBeNull();
  expect(storyboard && markdownDemo).toBeTruthy();
  if (!storyboard || !markdownDemo) {
    throw new Error("Expected storyboard and Markdown demo to render");
  }
  expect(
    storyboard.compareDocumentPosition(markdownDemo) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  const scenes = [
    "Ask for a plan",
    "The agent works normally",
    "Roughdraft opens the plan",
    "Leave comments and suggestions",
    "Click Done Reviewing",
    "The agent resumes",
  ];

  const sceneNodes = [
    ...storyboard.querySelectorAll("[data-homepage-workflow-scene]"),
  ];
  expect(sceneNodes).toHaveLength(scenes.length);

  scenes.forEach((scene, index) => {
    expect(sceneNodes[index]?.textContent).toContain(
      String(index + 1).padStart(2, "0"),
    );
    expect(sceneNodes[index]?.textContent).toContain(scene);
  });

  expect(storyboard.textContent).toContain(
    "Let's make the homepage more persuasive. Write a plan first.",
  );
  expect(storyboard.textContent).toContain(
    "write .context/homepage-conversion-plan.md",
  );
  expect(storyboard.textContent).toContain("Homepage Conversion Plan");
  expect(storyboard.textContent).toContain(
    'Move the workflow story above "It\'s just Markdown."',
  );
  expect(storyboard.textContent).toContain(
    "This should go above \"It's just Markdown.\"",
  );
  expect(storyboard.textContent).toContain(
    "Review an agent's plan before it starts coding.",
  );
  expect(storyboard.textContent).toContain("Review complete");
  expect(storyboard.textContent).toContain(
    "Your agent can read the edited Markdown file now.",
  );
  expect(storyboard.textContent).toContain("I read your comments.");
});
```

Do not add unit assertions that parse `APP_STYLES` for storyboard implementation details. The existing CSS string assertions protect legacy format-demo regressions, but new storyboard layout should be covered by semantic DOM assertions plus Playwright render and mobile-overflow checks. This keeps the new tests behavioral instead of coupling them to a specific CSS spelling.

**Step 4: Run the focused test and verify failure**

Run:

```bash
pnpm --filter @roughdraft/app exec vitest run test/homepage.test.tsx -t "six-scene storyboard"
```

Expected: FAIL because `[data-homepage-workflow-storyboard]` does not exist and the section copy is absent.

**Step 5: Commit the failing tests**

Only commit if the test fails for the expected missing-storyboard reason.

```bash
git add packages/app/test/homepage.test.tsx
git commit -m "test: specify homepage workflow storyboard"
```

## Task 2: Replace the small workflow cards with the storyboard UI

**Files:**
- Modify: `packages/app/src/App.tsx`
- Modify: `packages/app/src/style.css`

**Step 1: Update lucide imports**

Change the import from `lucide-react` to include the storyboard icons:

```ts
import {
  ArrowLeft,
  Braces,
  Check,
  Code2,
  Copy,
  ExternalLink,
  FileText,
  MessageSquare,
  MousePointerClick,
  Sparkles,
} from "lucide-react";
```

Remove any icon imports that become unused after deleting `HOMEPAGE_WORKFLOWS`. In the current file, `PencilLine` should be removed because it is only used by the old two-card workflow data.

**Step 2: Replace `HOMEPAGE_WORKFLOWS` with storyboard data**

Delete the `HOMEPAGE_WORKFLOWS` constant and add the new `HOMEPAGE_WORKFLOW_SCENES` constant from the product copy section.

**Step 3: Add small presentational helpers below `Homepage` or above it**

Add these helpers in `App.tsx`. Keep them local to the file because they are static homepage presentation, not shared product components.

```tsx
function HomepageWorkflowScene({
  active,
  description,
  step,
  title,
}: {
  active?: boolean;
  description: string;
  step: string;
  title: string;
}) {
  return (
    <li
      className="homepage-workflow-scene min-w-0"
      data-homepage-workflow-scene=""
    >
      <div
        className={
          active
            ? "homepage-workflow-scene-marker homepage-workflow-scene-marker-active"
            : "homepage-workflow-scene-marker"
        }
      >
        {step}
      </div>
      <h3 className="mt-3 text-sm font-semibold text-slate-950 dark:text-slate-50">
        {title}
      </h3>
      <p className="mt-2 text-xs leading-5 text-slate-600 dark:text-slate-400">
        {description}
      </p>
    </li>
  );
}

function AgentChatMock() {
  return (
    <div className="homepage-workflow-panel homepage-workflow-chat">
      <div className="homepage-workflow-panel-header">
        <MessageSquare className="size-3.5" aria-hidden="true" />
        Agent chat
      </div>
      <div className="space-y-3 p-4">
        <div className="ml-auto max-w-[82%] rounded-lg bg-slate-950 px-3 py-2 text-sm leading-5 text-white dark:bg-slate-100 dark:text-slate-950">
          Let's make the homepage more persuasive. Write a plan first.
        </div>
        <div className="max-w-[86%] rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-5 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
          I'll inspect the current homepage, draft a Markdown plan, and open it
          in Roughdraft for review before I code.
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-400">
          <div className="mb-2 flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-300">
            <Code2 className="size-3.5" aria-hidden="true" />
            Tool calls
          </div>
          <div>rg "It's just Markdown" packages/app/src</div>
          <div>sed -n '1,220p' packages/app/src/App.tsx</div>
          <div>write .context/homepage-conversion-plan.md</div>
        </div>
      </div>
    </div>
  );
}

function RoughdraftPlanMock() {
  return (
    <div className="homepage-workflow-panel homepage-workflow-plan">
      <div className="homepage-workflow-panel-header">
        <FileText className="size-3.5" aria-hidden="true" />
        homepage-conversion-plan.md
      </div>
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="min-w-0 p-5">
          <p className="text-xs font-medium tracking-[0.14em] text-stone-500 uppercase">
            Roughdraft
          </p>
          <h3 className="mt-2 text-xl font-semibold text-slate-950 dark:text-slate-50">
            Homepage Conversion Plan
          </h3>
          <ul className="mt-4 space-y-2 text-sm leading-6 text-slate-700 dark:text-slate-300">
            <li>Move the workflow story above "It's just Markdown."</li>
            <li>
              Show the agent pause, the review window, and the resume signal.
            </li>
            <li>
              Keep the format section as proof that the review data is portable
              Markdown.
            </li>
          </ul>
          <div className="mt-5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-900 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-200">
            Review an agent's plan before it starts coding.
          </div>
        </div>
        <div className="border-t border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950/70 lg:border-t-0 lg:border-l">
          <div className="space-y-3">
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-100">
              This should go above "It's just Markdown."
            </div>
            <div className="rounded-md border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
              Can we make the example about homepage conversion?
            </div>
            <div className="rounded-md border border-emerald-200 bg-white p-3 text-xs leading-5 text-emerald-900 dark:border-emerald-900/70 dark:bg-slate-900 dark:text-emerald-200">
              Suggested change
              <div className="mt-1 font-medium">
                Review an agent's plan before it starts coding.
              </div>
            </div>
          </div>
          <div className="mt-5 flex justify-end">
            <div className="homepage-workflow-done-popover">
              <Button className="h-9 gap-2 px-3 text-sm" type="button">
                <MousePointerClick className="size-4" aria-hidden="true" />
                Done Reviewing
              </Button>
              <div className="homepage-workflow-popover-card">
                <div className="font-semibold text-slate-950 dark:text-slate-50">
                  Review complete
                </div>
                <div className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-400">
                  Your agent can read the edited Markdown file now.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentResumeMock() {
  return (
    <div className="homepage-workflow-panel homepage-workflow-resume">
      <div className="homepage-workflow-panel-header">
        <Sparkles className="size-3.5" aria-hidden="true" />
        Agent resumes
      </div>
      <div className="p-4">
        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-6 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
          I read your comments. I'll move the workflow storyboard above the
          Markdown section and use the homepage conversion example.
        </div>
      </div>
    </div>
  );
}
```

**Step 4: Replace the old workflow section placement**

In `Homepage`, move the workflow section so the render order becomes:

```tsx
<div className="mx-auto mt-10 ...">
  <img ... />
</div>

<section
  aria-labelledby="homepage-workflow-heading"
  className="homepage-workflow-storyboard mx-auto mt-12 w-full max-w-6xl text-left"
  data-homepage-workflow-storyboard=""
>
  ...
</section>

<RoughdraftFormatDemo />
```

Delete the old two-card section that currently appears after `<RoughdraftFormatDemo />`.

**Step 5: Add the storyboard section JSX**

Use this JSX for the section body:

```tsx
<section
  aria-labelledby="homepage-workflow-heading"
  className="homepage-workflow-storyboard mx-auto mt-12 w-full max-w-6xl text-left"
  data-homepage-workflow-storyboard=""
>
  <div className="grid gap-8 border-b border-slate-200 bg-[#FAFAF8] p-5 dark:border-slate-700 dark:bg-slate-950/60 sm:p-6 lg:grid-cols-[0.72fr_1.28fr] lg:p-8">
    <div>
      <p className="text-xs font-medium tracking-[0.16em] text-stone-500 dark:text-stone-400 uppercase">
        Workflow
      </p>
      <h2
        className="mt-3 text-3xl leading-tight font-semibold text-balance text-slate-950 dark:text-slate-50 sm:text-4xl"
        id="homepage-workflow-heading"
      >
        Review an agent's plan before it starts coding.
      </h2>
      <p className="mt-4 text-base leading-7 text-slate-600 dark:text-slate-400">
        Ask for a plan, mark it up in Roughdraft, click Done Reviewing, and the
        agent continues from the edited Markdown file.
      </p>
    </div>

    <ol className="homepage-workflow-scene-list">
      {HOMEPAGE_WORKFLOW_SCENES.map((scene, index) => (
        <HomepageWorkflowScene
          active={index === 2 || index === 4}
          description={scene.description}
          key={scene.step}
          step={scene.step}
          title={scene.title}
        />
      ))}
    </ol>
  </div>

  <div className="grid gap-4 bg-white p-4 dark:bg-slate-900 sm:p-5 xl:grid-cols-[0.9fr_1.35fr_0.75fr]">
    <AgentChatMock />
    <RoughdraftPlanMock />
    <AgentResumeMock />
  </div>
</section>
```

**Step 6: Add CSS for the storyboard**

Append these rules inside `@layer components` in `packages/app/src/style.css`, near the existing `rfm-*` homepage rules:

```css
.homepage-workflow-storyboard {
  overflow: hidden;
  border: 1px solid rgb(226 232 240);
  border-radius: 0.5rem;
  background-color: #fff;
  box-shadow: 0 24px 70px rgb(15 23 42 / 10%);
}

.dark .homepage-workflow-storyboard {
  border-color: rgb(51 65 85);
  background-color: rgb(15 23 42);
  box-shadow: 0 24px 70px rgb(0 0 0 / 35%);
}

.homepage-workflow-scene-list {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.75rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.homepage-workflow-scene {
  position: relative;
  border: 1px solid rgb(226 232 240);
  border-radius: 0.5rem;
  background-color: rgb(255 255 255 / 82%);
  padding: 0.875rem;
}

.dark .homepage-workflow-scene {
  border-color: rgb(51 65 85);
  background-color: rgb(15 23 42 / 72%);
}

.homepage-workflow-scene-marker {
  display: inline-flex;
  height: 1.75rem;
  min-width: 1.75rem;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: 1px solid rgb(203 213 225);
  color: rgb(100 116 139);
  font-size: 0.6875rem;
  font-weight: 700;
  line-height: 1;
}

.homepage-workflow-scene-marker-active {
  border-color: rgb(15 23 42);
  background-color: rgb(15 23 42);
  color: white;
}

.dark .homepage-workflow-scene-marker {
  border-color: rgb(71 85 105);
  color: rgb(148 163 184);
}

.dark .homepage-workflow-scene-marker-active {
  border-color: rgb(241 245 249);
  background-color: rgb(241 245 249);
  color: rgb(15 23 42);
}

.homepage-workflow-panel {
  min-width: 0;
  overflow: hidden;
  border: 1px solid rgb(226 232 240);
  border-radius: 0.5rem;
  background-color: rgb(248 250 252);
}

.dark .homepage-workflow-panel {
  border-color: rgb(51 65 85);
  background-color: rgb(2 6 23);
}

.homepage-workflow-panel-header {
  display: flex;
  height: 2.5rem;
  align-items: center;
  gap: 0.375rem;
  border-bottom: 1px solid rgb(226 232 240);
  padding: 0 1rem;
  color: rgb(100 116 139);
  font-size: 0.75rem;
  font-weight: 700;
}

.dark .homepage-workflow-panel-header {
  border-color: rgb(51 65 85);
  color: rgb(148 163 184);
}

.homepage-workflow-done-popover {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.5rem;
}

.homepage-workflow-popover-card {
  width: min(13rem, calc(100vw - 3rem));
  border: 1px solid rgb(226 232 240);
  border-radius: 0.5rem;
  background-color: white;
  padding: 0.75rem;
  box-shadow: 0 14px 34px rgb(15 23 42 / 14%);
}

.dark .homepage-workflow-popover-card {
  border-color: rgb(51 65 85);
  background-color: rgb(15 23 42);
  box-shadow: 0 14px 34px rgb(0 0 0 / 36%);
}

@media (min-width: 720px) {
  .homepage-workflow-scene-list {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (min-width: 1100px) {
  .homepage-workflow-scene-list {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }

  .homepage-workflow-scene:not(:last-child)::after {
    position: absolute;
    top: 1.75rem;
    right: -0.75rem;
    z-index: 1;
    width: 0.75rem;
    height: 1px;
    background-color: rgb(203 213 225);
    content: "";
  }

  .dark .homepage-workflow-scene:not(:last-child)::after {
    background-color: rgb(71 85 105);
  }
}
```

**Step 7: Run focused unit test**

Run:

```bash
pnpm --filter @roughdraft/app exec vitest run test/homepage.test.tsx -t "six-scene storyboard"
```

Expected: PASS.

**Step 8: Run full homepage unit test file**

Run:

```bash
pnpm --filter @roughdraft/app exec vitest run test/homepage.test.tsx
```

Expected: PASS.

**Step 9: Commit implementation**

```bash
git add packages/app/src/App.tsx packages/app/src/style.css packages/app/test/homepage.test.tsx
git commit -m "feat: add homepage workflow storyboard"
```

## Task 3: Add browser coverage for placement and mobile overflow

**Files:**
- Create: `packages/app/e2e/homepage-storyboard.spec.ts`

**Step 1: Write the failing Playwright spec**

Create `packages/app/e2e/homepage-storyboard.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { logE2eEvent } from "./helpers";

test.describe("homepage workflow storyboard", () => {
  test("renders the plan-review storyboard above the Markdown section @smoke", async ({
    page,
  }, testInfo) => {
    await page.goto("/");

    const storyboard = page.locator("[data-homepage-workflow-storyboard]");
    await expect(storyboard).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Review an agent's plan before it starts coding.",
      }),
    ).toBeVisible();

    await expect(storyboard.getByText("Ask for a plan")).toBeVisible();
    await expect(storyboard.getByText("The agent works normally")).toBeVisible();
    await expect(storyboard.getByText("Roughdraft opens the plan")).toBeVisible();
    await expect(
      storyboard.getByText("Leave comments and suggestions"),
    ).toBeVisible();
    await expect(storyboard.getByText("Click Done Reviewing")).toBeVisible();
    await expect(storyboard.getByText("The agent resumes")).toBeVisible();
    await expect(
      storyboard.getByText(
        "Let's make the homepage more persuasive. Write a plan first.",
      ),
    ).toBeVisible();
    await expect(storyboard.getByText("Homepage Conversion Plan")).toBeVisible();
    await expect(storyboard.getByText("Review complete")).toBeVisible();

    const storyboardTop = await storyboard.evaluate(
      (element) => element.getBoundingClientRect().top + window.scrollY,
    );
    const markdownTop = await page.locator(".rfm-format-demo").evaluate(
      (element) => element.getBoundingClientRect().top + window.scrollY,
    );
    expect(storyboardTop).toBeLessThan(markdownTop);

    await testInfo.attach("homepage-workflow-storyboard-desktop", {
      body: await storyboard.screenshot(),
      contentType: "image/png",
    });

    logE2eEvent("homepage.workflow-storyboard.desktop", {
      storyboardTop,
      markdownTop,
    });
  });

  test("does not create horizontal overflow on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    const storyboard = page.locator("[data-homepage-workflow-storyboard]");
    await expect(storyboard).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      bodyScrollWidth: document.body.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));

    expect(dimensions.bodyScrollWidth).toBeLessThanOrEqual(
      dimensions.viewportWidth,
    );
    expect(dimensions.documentScrollWidth).toBeLessThanOrEqual(
      dimensions.viewportWidth,
    );

    logE2eEvent("homepage.workflow-storyboard.mobile-overflow", dimensions);
  });
});
```

**Step 2: Run the focused browser spec**

Run:

```bash
pnpm exec playwright test --config packages/app/playwright.config.ts packages/app/e2e/homepage-storyboard.spec.ts --project chromium
```

Expected: PASS after Task 2. If run before implementation, it should fail because the storyboard selector is missing.

**Step 3: Commit browser coverage**

```bash
git add packages/app/e2e/homepage-storyboard.spec.ts
git commit -m "test: cover homepage storyboard in browser"
```

## Task 4: Polish copy, responsiveness, and accessibility

**Files:**
- Modify: `packages/app/src/App.tsx`
- Modify: `packages/app/src/style.css`
- Modify if needed: `packages/app/test/homepage.test.tsx`
- Modify if needed: `packages/app/e2e/homepage-storyboard.spec.ts`

**Step 1: Start the app for manual inspection**

Run:

```bash
pnpm --filter @roughdraft/app dev --host 127.0.0.1 --port 4318
```

Leave this process running while inspecting. If port `4318` is occupied, use:

```bash
PLAYWRIGHT_APP_PORT=4328 pnpm --filter @roughdraft/app dev --host 127.0.0.1 --port 4328
```

**Step 2: Inspect in browser at desktop and mobile sizes**

Open:

```text
http://127.0.0.1:4318/
```

Check:

- The storyboard appears immediately after the screenshot hero and before the format demo.
- The story reads left-to-right on wide desktop and top-to-bottom on mobile.
- No text overlaps inside scene cards, chat bubbles, the plan mock, or the Done Reviewing popover.
- The section does not look like a nested-card stack. The outer storyboard is one framed tool surface; the repeated scene cards and mock panels are legitimate framed items inside it.
- The color palette remains neutral and product-like, not dominated by purple, beige, dark blue, or brown.
- The `Done Reviewing` button is visibly a shadcn button and the pointer icon communicates the click step.

**Step 3: Refine styles only where the browser shows issues**

Use these targeted fixes if needed:

- If desktop scene labels wrap awkwardly, reduce scene body text to `text-[0.7rem] leading-4` in the JSX or set `.homepage-workflow-scene { padding: 0.75rem; }`.
- If the plan mock is too wide on laptop widths, change the `xl:grid-cols-[0.9fr_1.35fr_0.75fr]` container to `2xl:grid-cols-[0.9fr_1.35fr_0.75fr]` so the three-panel layout only appears on wider screens.
- If mobile overflows, add `min-width: 0;` to the direct children of the bottom grid and check that long text remains wrapped.
- If visual hierarchy is too heavy, reduce the outer shadow to `0 18px 44px rgb(15 23 42 / 8%)`.

**Step 4: Run verification**

Run:

```bash
pnpm --filter @roughdraft/app exec vitest run test/homepage.test.tsx
pnpm exec playwright test --config packages/app/playwright.config.ts packages/app/e2e/homepage-storyboard.spec.ts --project chromium
pnpm --filter @roughdraft/app build
```

Expected: all pass.

**Step 5: Commit polish**

Only commit if there are additional polish edits:

```bash
git add packages/app/src/App.tsx packages/app/src/style.css packages/app/test/homepage.test.tsx packages/app/e2e/homepage-storyboard.spec.ts
git commit -m "style: polish homepage workflow storyboard"
```

## Task 5: Final full check and handoff

**Files:**
- No new files unless verification reveals a necessary fix.

**Step 1: Run the repo check**

Run:

```bash
pnpm check
```

Expected: PASS.

If `pnpm check` fails outside the touched files, capture the failure in the final handoff and still run the focused app checks from Task 4. Do not hide unrelated failures.

**Step 2: Confirm intended changes**

Run:

```bash
git status --short
git diff origin/main... -- packages/app/src/App.tsx packages/app/src/style.css packages/app/test/homepage.test.tsx packages/app/e2e/homepage-storyboard.spec.ts
```

Expected changed files:

```text
packages/app/src/App.tsx
packages/app/src/style.css
packages/app/test/homepage.test.tsx
packages/app/e2e/homepage-storyboard.spec.ts
```

There should be no `dist/` changes unless the repository convention for this branch explicitly requires built assets.

**Step 3: Final implementation summary**

Report:

- The storyboard was added above the Markdown format section.
- It uses six scenes matching the user's requested workflow.
- It uses real in-page mock UI rather than static screenshots.
- Tests run, including exact commands and outcomes.
- Any residual risk, especially visual judgment that depends on browser inspection.

**Step 4: Final commit if needed**

If previous tasks were committed separately, no final commit is required. If there are uncommitted verification fixes, commit them:

```bash
git add packages/app/src/App.tsx packages/app/src/style.css packages/app/test/homepage.test.tsx packages/app/e2e/homepage-storyboard.spec.ts
git commit -m "fix: finalize homepage workflow storyboard"
```

## Testing strategy

Use a medium strategy:

- Unit coverage proves semantic content, section ordering, all six scenes, and CTA/format regressions.
- Browser coverage proves the storyboard renders in a real browser, appears above the Markdown demo, captures screenshot evidence, and does not overflow on mobile.
- Build coverage catches TypeScript and production bundling issues.

This is stronger than text-only testing because the change is conversion-oriented and layout-sensitive. It avoids heavyweight committed visual baselines because the section is static marketing UI and screenshot baselines would create maintenance churn disproportionate to the risk.

## Risks and mitigations

- **Risk: the storyboard becomes too busy.** Mitigation: keep the top row as concise scene cards and the bottom row as three mock surfaces, not six full screenshots.
- **Risk: mobile overflow from chat/tool text.** Mitigation: use `min-w-0`, wrapping text, and the Playwright mobile overflow test.
- **Risk: the page deemphasizes Markdown portability.** Mitigation: keep `RoughdraftFormatDemo` directly after the storyboard and include copy saying the agent continues from the edited Markdown file.
- **Risk: the mock UI promises behavior not yet true.** Mitigation: show only existing workflow concepts: agent writes a Markdown file, opens Roughdraft, user comments, user clicks Done Reviewing, agent reads the edited file.
- **Risk: style drift from shadcn/Tailwind conventions.** Mitigation: use the existing `Button`, lucide icons, 0.5rem radius, restrained neutral palette, and CSS only for reusable storyboard layout primitives.

## Definition of done

- Homepage render order is hero, screenshot, workflow storyboard, Roughdraft format demo, remaining homepage content.
- The old two-card "Review workflow" section is gone.
- The new storyboard has six explicit scenes:
  1. Ask for a plan
  2. The agent works normally
  3. Roughdraft opens the plan
  4. Leave comments and suggestions
  5. Click Done Reviewing
  6. The agent resumes
- The storyboard uses the homepage conversion example requested by the user.
- The storyboard shows comments, questions, a suggested change, a Done Reviewing popover, and the resumed agent chat.
- `pnpm --filter @roughdraft/app exec vitest run test/homepage.test.tsx` passes.
- `pnpm exec playwright test --config packages/app/playwright.config.ts packages/app/e2e/homepage-storyboard.spec.ts --project chromium` passes.
- `pnpm --filter @roughdraft/app build` passes.
- `pnpm check` passes or any unrelated failure is explicitly reported with focused checks passing.
