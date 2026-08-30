# Anchor Forms
Every anchor form the specification defines, in one document.

Ship <span id="rd-c1">guest checkout</span> in the beta.

The rollout date belongs here.<span id="rd-c2"></span>

Add <ins id="rd-s1">one concrete example</ins> here.

Remove <del id="rd-s2">this vague phrasing</del>.

Use <span id="rd-s3"><del>rough</del><ins>specific</ins></span> wording.

Track <span id="rd-c3" data-origin="import">the launch checklist</span> in the plan.

Review <span id="rd-c4"><span id="rd-c5">this exact range</span></span> from both sides.

Anchors inside code are literal text:

```md
Ship <span id="rd-c1">guest checkout</span> in the beta.
```

Inline code stays literal too: `<ins id="rd-s1">not a suggestion</ins>`.

---
deploy:
  target: staging
  region: us-east-1

---
roughdraft: "1.0"
comments:
  rd-c1:
    body: Confirm this excludes SSO-only workspaces.
    by: user
    at: "2026-08-28T12:00:00.000Z"
  rd-c2:
    body: A point anchor carries no text of its own.
    by: AI
    at: "2026-08-28T12:01:00.000Z"
  rd-c3:
    body: The extra attribute on this anchor must survive a write.
    by: user
    at: "2026-08-28T12:02:00.000Z"
    status: resolved
    resolved: "Checklist linked from the plan."
  rd-c4:
    body: The outer of two anchors covering one range.
    by: user
    at: "2026-08-28T12:03:00.000Z"
  rd-c5:
    body: The inner of two anchors covering one range.
    by: AI
    at: "2026-08-28T12:04:00.000Z"
  rd-c6:
    body: This reads as a specification rather than a draft.
    by: user
    at: "2026-08-28T12:05:00.000Z"
    scope: document
  rd-c7:
    body: Confirmed. SSO-only workspaces are out of the beta.
    by: AI
    at: "2026-08-28T12:06:00.000Z"
    re: rd-c1
  rd-c8:
    body: Then say so in the release note as well.
    by: user
    at: "2026-08-28T12:07:00.000Z"
    re: rd-c7
    priority: high
suggestions:
  rd-s1:
    by: AI
    at: "2026-08-28T12:08:00.000Z"
  rd-s2:
    by: user
    at: "2026-08-28T12:09:00.000Z"
  rd-s3:
    by: AI
    at: "2026-08-28T12:10:00.000Z"
reviewers:
  - user
  - AI
