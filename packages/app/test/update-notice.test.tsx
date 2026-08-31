import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UpdateNotice } from "../src/UpdateNotice";

describe("UpdateNotice", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("renders the current and latest versions with an update button", async () => {
    await act(async () => {
      root.render(
        <UpdateNotice
          updateStatus={{
            packageName: "roughdraft",
            currentVersion: "0.1.0",
            latestVersion: "0.2.0",
            updateAvailable: true,
            updateCommand: "npm i -g roughdraft@latest",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Update available");
    expect(container.textContent).toContain("0.1.0");
    expect(container.textContent).toContain("0.2.0");
    expect(
      container.querySelector('[data-testid="update-notice-button"]')
        ?.textContent,
    ).toContain("Update");
  });
});
