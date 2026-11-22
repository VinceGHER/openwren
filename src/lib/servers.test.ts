import { describe, expect, it } from "vitest";
import { isOnThisComputer, isProtonAddress, protonBridge } from "./servers";

describe("isOnThisComputer", () => {
  it("accepts loopback names and addresses", () => {
    for (const host of ["localhost", "LocalHost", " 127.0.0.1 ", "127.1.2.3", "::1", "[::1]"]) expect(isOnThisComputer(host), host).toBe(true);
  });
  it("accepts every spelling of the IPv6 loopback address", () => {
    for (const host of ["0::1", "::0001", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "[0::1]"]) expect(isOnThisComputer(host), host).toBe(true);
  });
  it("refuses other IPv6 addresses, like the core", () => {
    for (const host of ["::", "::2", "1::1", "::ffff:127.0.0.1", "::127.0.0.1", "::00001", "::1%lo", ":::1"]) expect(isOnThisComputer(host), host).toBe(false);
  });
  it("refuses everything else", () => {
    for (const host of ["imap.example.com", "192.168.1.2", "127.0.0.256", "localhost.example.com", "128.0.0.1", "127.0.0.01", ""]) expect(isOnThisComputer(host), host).toBe(false);
  });
  it("covers the Bridge preset, so the core allows it unencrypted", () => {
    expect(isOnThisComputer(protonBridge.imap.host)).toBe(true);
    expect(isOnThisComputer(protonBridge.smtp.host)).toBe(true);
  });
});

describe("isProtonAddress", () => {
  it("knows Proton's domains", () => {
    for (const a of ["me@proton.me", "me@ProtonMail.com", "me@protonmail.ch", "me@pm.me"]) expect(isProtonAddress(a), a).toBe(true);
  });
  it("ignores other addresses", () => {
    for (const a of ["me@gmail.com", "me@notproton.me", "proton.me", ""]) expect(isProtonAddress(a), a).toBe(false);
  });
});
