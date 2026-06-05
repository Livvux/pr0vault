import PolyfillBrowser from "webextension-polyfill";

/**
 * Pr0Vault Browser API Abstraction
 * Uses webextension-polyfill to provide a unified Promise-based API
 * that works in both Chrome and Firefox.
 */
export const browser = PolyfillBrowser;

export const isFirefox = typeof (globalThis as any).browser !== "undefined" && !!(globalThis as any).browser.runtime?.getBrowserInfo;
export const isChrome = !isFirefox;
