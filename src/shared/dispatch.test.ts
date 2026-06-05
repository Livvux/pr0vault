import { describe, it, expect, vi } from "vitest";
import { respondAsync, isErrorResponse } from "./dispatch";

describe("respondAsync", () => {
  it("sendet den Resolve-Wert an sendResponse", async () => {
    const sendResponse = vi.fn();
    const value = { results: [{ score: 1, item: {} }] };
    respondAsync(() => Promise.resolve(value), "QUERY_SEARCH", sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(sendResponse).toHaveBeenCalledWith(value);
  });

  it("sendet eine Fehler-Response, wenn die Route wirft", async () => {
    const sendResponse = vi.fn();
    respondAsync(
      () => Promise.reject(new Error("boom")),
      "GET_STATS",
      sendResponse
    );
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: "Error: boom",
    });
  });

  it("ruft sendResponse bei Erfolg genau einmal auf", async () => {
    const sendResponse = vi.fn();
    respondAsync(
      () => Promise.resolve({ success: true }),
      "STORE_BATCH",
      sendResponse
    );
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    // Einen Tick warten, damit ein etwaiger verspäteter Zweitaufruf sichtbar würde
    await new Promise((r) => setTimeout(r, 0));
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });

  it("ruft sendResponse nicht erneut auf, wenn der erste Aufruf wirft", async () => {
    const sendResponse = vi.fn(() => {
      throw new Error("disconnected port");
    });
    expect(() =>
      respondAsync(
        () => Promise.resolve({ success: true }),
        "STORE_BATCH",
        sendResponse
      )
    ).not.toThrow();
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    // Einen Tick warten, damit ein etwaiger verspäteter Zweitaufruf sichtbar würde
    await new Promise((r) => setTimeout(r, 0));
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });

  it("gibt synchron true zurück (Channel offen halten)", () => {
    const result = respondAsync(
      () => Promise.resolve(undefined),
      "X",
      vi.fn()
    );
    expect(result).toBe(true);
  });
});

describe("isErrorResponse", () => {
  it("erkennt die Fehler-Hülle", () => {
    expect(isErrorResponse({ success: false, error: "boom" })).toBe(true);
  });

  it("lehnt VaultStats-artige Objekte ab", () => {
    expect(
      isErrorResponse({ uploads: 0, comments: 0, storageBytes: 0 })
    ).toBe(false);
  });

  it("lehnt Erfolgs-Responses ab", () => {
    expect(isErrorResponse({ success: true, filename: "x.json" })).toBe(false);
  });

  it("lehnt null und undefined ab", () => {
    expect(isErrorResponse(null)).toBe(false);
    expect(isErrorResponse(undefined)).toBe(false);
  });
});
