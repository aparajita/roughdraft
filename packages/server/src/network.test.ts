import { describe, expect, it } from "vitest";
import {
  hasNonLoopbackHost,
  isLoopbackHost,
  ROUGHDRAFT_BIND_HOST_ENV,
  ROUGHDRAFT_LOOPBACK_HOSTS,
  resolveBindHosts,
} from "./network";

describe("resolveBindHosts", () => {
  it("returns the default loopback list when the env var is unset", () => {
    expect(resolveBindHosts({})).toEqual(ROUGHDRAFT_LOOPBACK_HOSTS);
  });

  it("returns a single host when the env var names one host", () => {
    expect(resolveBindHosts({ [ROUGHDRAFT_BIND_HOST_ENV]: "0.0.0.0" })).toEqual(
      ["0.0.0.0"],
    );
  });

  it("returns multiple hosts from a comma-separated value", () => {
    expect(
      resolveBindHosts({ [ROUGHDRAFT_BIND_HOST_ENV]: "0.0.0.0,::" }),
    ).toEqual(["0.0.0.0", "::"]);
  });

  it("trims whitespace around comma-separated hosts", () => {
    expect(
      resolveBindHosts({
        [ROUGHDRAFT_BIND_HOST_ENV]: " 127.0.0.1 , ::1 ",
      }),
    ).toEqual(["127.0.0.1", "::1"]);
  });

  it("falls back to the loopback list when the env var is an empty string", () => {
    expect(resolveBindHosts({ [ROUGHDRAFT_BIND_HOST_ENV]: "" })).toEqual(
      ROUGHDRAFT_LOOPBACK_HOSTS,
    );
  });

  it("falls back to the loopback list when the env var is only commas and whitespace", () => {
    expect(resolveBindHosts({ [ROUGHDRAFT_BIND_HOST_ENV]: " , , " })).toEqual(
      ROUGHDRAFT_LOOPBACK_HOSTS,
    );
  });
});

describe("isLoopbackHost", () => {
  it("treats 127.0.0.1, ::1, and localhost as loopback", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
  });

  it("treats every 127.0.0.0/8 address as loopback", () => {
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("127.255.255.254")).toBe(true);
  });

  it("rejects 0.0.0.0 and routable IPs", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("100.73.51.106")).toBe(false);
    expect(isLoopbackHost("192.168.1.1")).toBe(false);
  });
});

describe("hasNonLoopbackHost", () => {
  it("returns false for the default loopback list", () => {
    expect(hasNonLoopbackHost(ROUGHDRAFT_LOOPBACK_HOSTS)).toBe(false);
  });

  it("returns true when any host is non-loopback", () => {
    expect(hasNonLoopbackHost(["127.0.0.1", "0.0.0.0"])).toBe(true);
    expect(hasNonLoopbackHost(["100.73.51.106"])).toBe(true);
  });
});
