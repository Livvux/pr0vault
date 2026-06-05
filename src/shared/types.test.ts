import { describe, it, expect } from "vitest";
import { isVaultStats } from "./types";

const validStats = {
  uploads: 1,
  comments: 2,
  filters: 3,
  collections: 4,
  messages: 5,
  storageBytes: 6,
  lastSync: null,
};

describe("isVaultStats", () => {
  it("akzeptiert vollständige VaultStats (lastSync null)", () => {
    expect(isVaultStats(validStats)).toBe(true);
  });

  it("akzeptiert lastSync als Zahl", () => {
    expect(isVaultStats({ ...validStats, lastSync: 123 })).toBe(true);
  });

  it("lehnt null und undefined ab", () => {
    expect(isVaultStats(null)).toBe(false);
    expect(isVaultStats(undefined)).toBe(false);
  });

  it("lehnt die Fehler-Hülle ab", () => {
    expect(isVaultStats({ success: false, error: "x" })).toBe(false);
  });

  it("lehnt partielle Objekte ab (storageBytes fehlt)", () => {
    const { storageBytes, ...partial } = validStats;
    expect(isVaultStats(partial)).toBe(false);
  });

  it("lehnt lastSync mit falschem Typ ab", () => {
    expect(isVaultStats({ ...validStats, lastSync: "now" })).toBe(false);
  });
});
