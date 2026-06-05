// Minimaler chrome-Stub für die Node-Test-Umgebung.
// Nur das, was der Logger (shared/logger.ts) zur Laufzeit nutzt:
// chrome.storage.local.get/set. Verhindert, dass Tests, die logErr auslösen,
// nur durch einen im logger verschluckten ReferenceError grün werden.
globalThis.chrome = {
  storage: { local: { get: async () => ({}), set: async () => {} } },
} as unknown as typeof chrome;
