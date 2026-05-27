/**
 * RFQ send-log model + storage.
 *
 * Tracks every RFQ email sent (from the sourcing-result flow or the standalone
 * /rfq screen) so the UI can show what was sent, when, and the outcome.
 * File-based JSON to match the rest of Source (single append-only log file).
 */

import path from 'path';
import { randomUUID } from 'crypto';
import { safeReadJSON, safeWriteJSON } from './file-operations';

export interface RfqSend {
  id: string;
  /** Sourcing result id this RFQ belongs to, if sent from the results page. */
  resultId?: string;
  to: string;
  subject: string;
  /** Stored for audit/history; lets the UI re-open what was sent. */
  body: string;
  status: 'sent' | 'failed';
  error?: string;
  sentAt: string;
  /** "sourcing" (from a result) or "manual" (standalone /rfq screen). */
  source: 'sourcing' | 'manual';
}

const SENDS_PATH = path.join(process.cwd(), 'src', 'data', 'rfq-sends.json');

export async function listSends(resultId?: string): Promise<RfqSend[]> {
  const all = await safeReadJSON<RfqSend[]>(SENDS_PATH, []);
  const sorted = [...all].sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  return resultId ? sorted.filter((s) => s.resultId === resultId) : sorted;
}

export async function recordSends(
  records: Array<Omit<RfqSend, 'id' | 'sentAt'>>
): Promise<RfqSend[]> {
  const existing = await safeReadJSON<RfqSend[]>(SENDS_PATH, []);
  const now = new Date().toISOString();
  const created: RfqSend[] = records.map((r) => ({
    ...r,
    id: randomUUID(),
    sentAt: now,
  }));
  await safeWriteJSON(SENDS_PATH, [...existing, ...created]);
  return created;
}
