import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractRoughdraftReviewIndex } from "@roughdraft/rfm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTool } from "./mcp";

describe("mcp", () => {
  let tempDir: string;
  let stateFile: string;
  let projectDir: string;
  let documentPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-mcp-"));
    projectDir = path.join(tempDir, "project");
    stateFile = path.join(tempDir, "state", "server.json");
    documentPath = path.join(projectDir, "draft.md");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ url: "http://localhost:7373", port: 7373 }),
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("omits timeoutSeconds from review watch calls unless the tool caller provides one", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ events: [], timedOut: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );
    await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir, timeoutSeconds: 5 },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(requestBodies[0]).toMatchObject({
      projectPath: projectDir,
      path: "draft.md",
      batchWindowSeconds: 0.25,
      fromNow: true,
    });
    expect(requestBodies[0]).not.toHaveProperty("timeoutSeconds");
    expect(requestBodies[1]).toMatchObject({
      timeoutSeconds: 5,
    });
  });

  it("returns overall comments from review watch events unchanged", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          events: [
            {
              documentPath,
              type: "review.completed",
              overallComment: "Please prioritize the CLI contract.",
            },
          ],
          timedOut: false,
          nextSequence: 2,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );

    const result = await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(result).toMatchObject({
      events: [
        {
          overallComment: "Please prioritize the CLI contract.",
        },
      ],
    });
  });

  it("stores a reply body containing YAML-sensitive characters without corrupting the document", async () => {
    const original = [
      "# Draft",
      "",
      '<span id="rd-c1">Needs proof</span>',
      "",
      "---",
      'roughdraft: "1.0"',
      "comments:",
      "  rd-c1:",
      "    body: Needs proof",
      "    by: user",
      '    at: "2026-04-28T12:00:00.000Z"',
      "",
    ].join("\n");
    fs.writeFileSync(documentPath, original);

    const message =
      'This closes early <<} and has: a colon, "quotes", and\na newline.';

    await callTool(
      "roughdraft_reply_to_comment",
      { documentPath, parentId: "rd-c1", message },
      { ROUGHDRAFT_STATE_FILE: stateFile },
    );

    const updated = fs.readFileSync(documentPath, "utf8");
    const index = extractRoughdraftReviewIndex(updated);
    const reply = index.comments.find((comment) => comment.re === "rd-c1");

    expect(reply?.body).toBe(message);
  });

  // An endmatter record nothing in the body anchors cannot survive a write:
  // serializing the document drops it. A writer that reported success would
  // therefore delete the record it claimed to act on, so both writers refuse.
  const unanchoredRecordDocument = [
    "# Draft",
    "",
    "The body carries no rd-c1 anchor.",
    "",
    "---",
    'roughdraft: "1.0"',
    "comments:",
    "  rd-c1:",
    "    body: Needs proof",
    "    by: user",
    '    at: "2026-04-28T12:00:00.000Z"',
    "",
  ].join("\n");

  it("refuses to reply to a comment whose record has no anchor in the body and leaves the record in place", async () => {
    fs.writeFileSync(documentPath, unanchoredRecordDocument);

    const result = (await callTool(
      "roughdraft_reply_to_comment",
      { documentPath, parentId: "rd-c1", message: "Here is the source." },
      { ROUGHDRAFT_STATE_FILE: stateFile },
    )) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("rd-c1");
    expect(fs.readFileSync(documentPath, "utf8")).toBe(
      unanchoredRecordDocument,
    );
  });

  it("marks an anchored comment resolved and records the summary", async () => {
    fs.writeFileSync(
      documentPath,
      [
        "# Draft",
        "",
        '<span id="rd-c1">Needs proof</span>',
        "",
        "---",
        'roughdraft: "1.0"',
        "comments:",
        "  rd-c1:",
        "    body: Add a source",
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "",
      ].join("\n"),
    );

    const result = (await callTool(
      "roughdraft_mark_resolved",
      { documentPath, targetId: "rd-c1", summary: "Cited the RFC." },
      { ROUGHDRAFT_STATE_FILE: stateFile },
    )) as { ok: boolean };

    expect(result.ok).toBe(true);

    const index = extractRoughdraftReviewIndex(
      fs.readFileSync(documentPath, "utf8"),
    );
    expect(index.comments).toMatchObject([
      { id: "rd-c1", status: "resolved", resolved: "Cited the RFC." },
    ]);
  });

  it("refuses to resolve a comment whose record has no anchor in the body and leaves the record in place", async () => {
    fs.writeFileSync(documentPath, unanchoredRecordDocument);

    const result = (await callTool(
      "roughdraft_mark_resolved",
      { documentPath, targetId: "rd-c1", summary: "Cited the RFC." },
      { ROUGHDRAFT_STATE_FILE: stateFile },
    )) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("rd-c1");
    expect(fs.readFileSync(documentPath, "utf8")).toBe(
      unanchoredRecordDocument,
    );
  });

  it("returns comments and suggestions as separate arrays from roughdraft_get_review_index", async () => {
    fs.writeFileSync(
      documentPath,
      [
        '<span id="rd-c1">Needs proof</span>',
        "",
        '<ins id="rd-s1">a citation</ins>',
        "",
        "---",
        'roughdraft: "1.0"',
        "comments:",
        "  rd-c1:",
        "    body: Add a source",
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "suggestions:",
        "  rd-s1:",
        "    by: AI",
        '    at: "2026-04-28T12:01:00.000Z"',
        "",
      ].join("\n"),
    );

    const result = (await callTool(
      "roughdraft_get_review_index",
      { documentPath },
      { ROUGHDRAFT_STATE_FILE: stateFile },
    )) as { comments: unknown[]; suggestions: unknown[] };

    expect(result).not.toHaveProperty("items");
    expect(result.comments).toHaveLength(1);
    expect(result.suggestions).toHaveLength(1);
  });

  it("returns only unresolved comments and suggestions as separate arrays from roughdraft_get_pending_feedback", async () => {
    fs.writeFileSync(
      documentPath,
      [
        '<span id="rd-c1">Needs proof</span>',
        "",
        '<span id="rd-c2">Resolved point</span>',
        "",
        "---",
        'roughdraft: "1.0"',
        "comments:",
        "  rd-c1:",
        "    body: Add a source",
        "    by: user",
        '    at: "2026-04-28T12:00:00.000Z"',
        "  rd-c2:",
        "    body: Already handled",
        "    by: user",
        '    at: "2026-04-28T12:01:00.000Z"',
        "    status: resolved",
        "",
      ].join("\n"),
    );

    const result = (await callTool(
      "roughdraft_get_pending_feedback",
      { documentPath },
      { ROUGHDRAFT_STATE_FILE: stateFile },
    )) as { comments: Array<{ id: string }>; suggestions: unknown[] };

    expect(result).not.toHaveProperty("items");
    expect(result.comments.map((comment) => comment.id)).toEqual(["rd-c1"]);
    expect(result.suggestions).toEqual([]);
  });
});
