import { describe, it, expect } from "vitest";
import { readBorshString, isPumpFunCreateInstruction } from "./solanaOnchainDiscovery";

// Real discriminators from pump.fun's published IDL (github.com/pump-fun/
// pump-public-docs, idl/pump.json), the same bytes solanaOnchainDiscovery.ts
// matches against.
const CREATE_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);
const CREATE_V2_DISCRIMINATOR = Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]);

function borshString(value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}

describe("isPumpFunCreateInstruction", () => {
  it("matches the legacy create discriminator", () => {
    expect(isPumpFunCreateInstruction(Buffer.concat([CREATE_DISCRIMINATOR, Buffer.from([1, 2, 3])]))).toBe(true);
  });

  it("matches the create_v2 discriminator", () => {
    expect(isPumpFunCreateInstruction(Buffer.concat([CREATE_V2_DISCRIMINATOR, Buffer.from([1, 2, 3])]))).toBe(true);
  });

  it("rejects an unrelated instruction's discriminator (e.g. buy)", () => {
    const buyDiscriminator = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
    expect(isPumpFunCreateInstruction(Buffer.concat([buyDiscriminator, Buffer.from([1, 2, 3])]))).toBe(false);
  });

  it("rejects data shorter than a full discriminator", () => {
    expect(isPumpFunCreateInstruction(Buffer.from([24, 30, 200]))).toBe(false);
  });
});

describe("readBorshString", () => {
  it("decodes a single length-prefixed UTF-8 string", () => {
    const buf = borshString("Based Doge");
    const result = readBorshString(buf, 0);
    expect(result?.value).toBe("Based Doge");
    expect(result?.next).toBe(buf.length);
  });

  it("decodes name then symbol back-to-back, matching the create instruction's arg layout", () => {
    const buf = Buffer.concat([borshString("Based Doge"), borshString("BASEDDOGE"), borshString("https://ipfs.io/ipfs/example")]);
    const name = readBorshString(buf, 0);
    expect(name?.value).toBe("Based Doge");
    const symbol = readBorshString(buf, name!.next);
    expect(symbol?.value).toBe("BASEDDOGE");
    const uri = readBorshString(buf, symbol!.next);
    expect(uri?.value).toBe("https://ipfs.io/ipfs/example");
  });

  it("decodes an empty string", () => {
    const buf = borshString("");
    expect(readBorshString(buf, 0)?.value).toBe("");
  });

  it("returns undefined instead of throwing when the length prefix is truncated", () => {
    expect(readBorshString(Buffer.from([1, 2]), 0)).toBeUndefined();
  });

  it("returns undefined instead of throwing when the declared length overruns the buffer", () => {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(1000, 0);
    const buf = Buffer.concat([len, Buffer.from("short")]);
    expect(readBorshString(buf, 0)).toBeUndefined();
  });

  it("returns undefined when the offset is past the end of the buffer", () => {
    const buf = borshString("hi");
    expect(readBorshString(buf, buf.length + 10)).toBeUndefined();
  });
});
