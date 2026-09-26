import { describe, expect, it } from "vitest";
import { isNotFoundError } from "../src/util.js";

describe("isNotFoundError", () => {
  it("matches the AWS exception name and not-found phrasing", () => {
    expect(isNotFoundError({ name: "ResourceNotFoundException", message: "x" })).toBe(true);
    expect(isNotFoundError(new Error("microvm m-1 not found"))).toBe(true);
    expect(isNotFoundError(new Error("NotFoundException: no such image"))).toBe(true);
  });

  it("rejects DNS/lookup failures — infra errors are not 'the VM is gone'", () => {
    const dns = Object.assign(new Error("getaddrinfo ENOTFOUND e.lambda-microvms.x.on.aws"), {
      code: "ENOTFOUND",
    });
    expect(isNotFoundError(dns)).toBe(false);
    // Even without a .code property the ENOTFOUND text must not match.
    expect(isNotFoundError(new Error("getaddrinfo ENOTFOUND e.lambda-microvms.x.on.aws"))).toBe(
      false,
    );
    expect(isNotFoundError(Object.assign(new Error("x"), { code: "EAI_AGAIN" }))).toBe(false);
  });

  it("rejects unrelated errors", () => {
    expect(isNotFoundError(new Error("conflict"))).toBe(false);
    expect(isNotFoundError(new Error("not permitted"))).toBe(false);
  });
});
