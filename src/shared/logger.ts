// pr0Vault — Shared Logger
// Centralized logging for Content Script, Service Worker, and Popup.
// Logs are stored in chrome.storage.local (max 200 entries).

import {browser} from "./browser";

const LOG_KEY = "pr0vault_logs";
const MAX_LOGS = 200;

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogEntry {
  ts: number;
  src: "CS" | "SW" | "Popup";
  lvl: LogLevel;
  msg: string;
}

async function readLogs(): Promise<LogEntry[]> {
  const data = await browser.storage.local.get(LOG_KEY);
  return (data[LOG_KEY] as LogEntry[]) || [];
}

async function writeLogs(logs: LogEntry[]): Promise<void> {
  await browser.storage.local.set({ [LOG_KEY]: logs.slice(-MAX_LOGS) });
}

export async function log(
  src: LogEntry["src"],
  lvl: LogLevel,
  msg: string
): Promise<void> {
  const entry: LogEntry = { ts: Date.now(), src, lvl, msg };
  try {
    const logs = await readLogs();
    logs.push(entry);
    await writeLogs(logs);
  } catch {
    // Logging failed — must not crash caller
  }
}

export function logSync(src: LogEntry["src"], msg: string) {
  return log(src, "info", msg);
}

export function logErr(src: LogEntry["src"], msg: string) {
  return log(src, "error", msg);
}

export async function getLogs(): Promise<LogEntry[]> {
  return readLogs();
}

export async function clearLogs(): Promise<void> {
  await browser.storage.local.remove(LOG_KEY);
}
