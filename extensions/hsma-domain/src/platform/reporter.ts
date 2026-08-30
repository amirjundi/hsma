/**
 * Drains the outbox to the platform.
 *
 * The outbox existed and nothing emptied it, so findings queued locally and never
 * left. That is the failure this closes.
 *
 * Everything here is deliberately resumable. The platform is often unreachable -- it
 * is a single server run by a small team -- so a send that fails must leave the item
 * exactly where it was, still pending, rather than dropping it or double-counting it.
 */
import type { PlatformClient } from "./client.js";

export type OutboxRow = { id: string; kind: string; payload: unknown; requestId: string };

export interface OutboxSource {
  pendingOutbox(limit?: number): OutboxRow[];
  markSent(outboxId: string): void;
  markFailed(outboxId: string, error: string): void;
}

export interface FlushResult {
  attempted: number;
  sent: number;
  failed: number;
  /** Kinds the agent queued that this build has no endpoint for. */
  unsupported: string[];
  errors: Array<{ kind: string; error: string }>;
}

/**
 * Send one queued item.
 *
 * The requestId is the idempotency key, and it is the row's own stable id rather than
 * a fresh value per attempt. A retry after a timeout must not create a second record
 * on the platform -- the first attempt may well have landed.
 */
async function send(client: PlatformClient, row: OutboxRow): Promise<void> {
  const payload = row.payload as Record<string, unknown>;
  switch (row.kind) {
    case "lexicon-gap":
    case "lexicon-gaps": {
      const gaps = Array.isArray(payload?.gaps) ? payload.gaps : [payload];
      await client.postLexiconGaps(gaps as never, row.requestId);
      return;
    }
    case "scan-log": {
      await client.postScanLog(payload as never, row.requestId);
      return;
    }
    default:
      // Not an error the agent can fix by retrying, so it is reported rather than
      // burning the row's eight attempts against an endpoint that does not exist.
      throw new UnsupportedKind(row.kind);
  }
}

export class UnsupportedKind extends Error {
  constructor(readonly kind: string) {
    super(
      `No platform endpoint for queued item of kind "${kind}". ` +
        `It stays in the outbox rather than being discarded.`,
    );
    this.name = "UnsupportedKind";
  }
}

/**
 * Flush pending items.
 *
 * Sequential on purpose. The platform scopes idempotency on (agent_id, key) and is a
 * modest server; a burst of parallel writes from one agent is how you find that out
 * the hard way.
 */
export async function flushOutbox(
  store: OutboxSource,
  client: PlatformClient,
  limit = 50,
): Promise<FlushResult> {
  const rows = store.pendingOutbox(limit);
  const result: FlushResult = {
    attempted: rows.length,
    sent: 0,
    failed: 0,
    unsupported: [],
    errors: [],
  };

  for (const row of rows) {
    try {
      await send(client, row);
      store.markSent(row.id);
      result.sent += 1;
    } catch (err) {
      if (err instanceof UnsupportedKind) {
        if (!result.unsupported.includes(err.kind)) {
          result.unsupported.push(err.kind);
        }
        // Left Pending and not counted as an attempt: the endpoint may exist later,
        // and there is no point exhausting retries against a gap in the contract.
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      store.markFailed(row.id, message);
      result.failed += 1;
      result.errors.push({ kind: row.kind, error: message });
    }
  }

  return result;
}
