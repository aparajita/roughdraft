---
name: test-desiderata
description: Apply Kent Beck's Test Desiderata to plan, add, rewrite, or review tests. Use when Codex is designing a test strategy, adding or changing unit/integration/e2e tests, reproducing a bug with a failing test, reviewing test quality, deciding what level of test to write, or explaining test tradeoffs.
---

# Test Desiderata

Use the desiderata as design lenses, not a rigid checklist. The goal is to optimize the value of the tests by making explicit tradeoffs among valuable properties. Source: https://testdesiderata.com/

## Workflow

1. State the behavior or risk the test must protect in one sentence before choosing the test level.
2. Choose the fastest test level that remains predictive of production behavior. Escalate from pure unit tests to integration or e2e tests only when the boundary itself is the behavior under test.
3. Prefer tests that fail for user-visible behavior changes over tests that fail because a private implementation detail was refactored.
4. Make the failure diagnostic: the test name, fixture, and assertion should point to the broken behavior without requiring a long investigation.
5. Keep setup local to the test or an explicit helper that preserves isolation and determinism.
6. Run the narrow relevant command first, then the broader package or repo command when the change is broad enough to justify it.
7. In the final response, name the command run and any meaningful test tradeoff made.

## Desiderata

- Isolated: test results should not depend on execution order or shared mutable state.
- Composable: independently valuable tests should combine without hidden coupling or cascading setup requirements.
- Deterministic: unchanged code and inputs should produce the same result every run.
- Fast: tests should be quick enough that agents and humans will run them while working.
- Writable: tests should be cheap to create relative to the behavior protected.
- Readable: tests should make their motivation and expected behavior clear to the next maintainer.
- Behavioral: tests should change result when the behavior under test changes.
- Structure-insensitive: tests should survive internal refactors that preserve behavior.
- Automated: tests should run without manual intervention.
- Specific: failures should make the likely cause obvious.
- Predictive: passing tests should give justified confidence that production behavior is acceptable.
- Inspiring: the suite should increase confidence, not create noise, flakes, or avoidance.

## Repo Defaults

- For bug fixes, create the smallest failing behavioral test before implementation, following the repo's `AGENTS.md` bug-fix workflow.
- Use `slog` before or during test work when runtime behavior is uncertain and static reading is not enough.
- For Markdown and review anchor/endmatter behavior, prefer fixture or round-trip coverage that protects the file-format contract.
- For UI behavior, prefer component tests for local interaction logic and Playwright only when browser, file, server, or cross-view behavior is the product risk.
- Avoid snapshot-heavy or DOM-structure-heavy assertions unless the rendered structure itself is the public contract.

## Tradeoff Notes

When a test intentionally sacrifices one desideratum for another, make that explicit in a short comment or final summary. Common acceptable tradeoffs:

- Slower e2e coverage for a critical file-system or browser integration path.
- A slightly larger fixture when readability and production similarity matter more than minimal setup.
- Multiple focused tests instead of one broad test when specificity and determinism matter more than brevity.
