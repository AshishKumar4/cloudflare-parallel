import { DeadlineExceededError, DeadlineTooShortError, SerializationError } from '../errors/index.js';
import type { RpcEnvelope } from '../types.js';
import type { CancelToken } from '../api/cancel.js';

const MIN_DEADLINE_BUDGET_MS = 1000;

/**
 * Build the wire envelope for an outbound RPC. Converts user-facing
 * `deadline` (absolute) / `deadlineMs` (relative) into a single absolute
 * `deadlineEpochMs` field, and records whether the cancel was already
 * tripped at submit time.
 *
 * Live cancel after submit is delivered separately, via the `cancelStream`
 * channel installed on the loader's `env` (see `cancel-stream.ts`). The
 * envelope's `signal` snapshot is only consulted for the cancel-fast path
 * (already-aborted before submit reached the loaded isolate).
 */
export function buildEnvelope(opts: {
  cancel?: CancelToken;
  deadline?: number;
  deadlineMs?: number;
  mode: RpcEnvelope['mode'];
  treeDepth?: number;
}): RpcEnvelope & { signal: { cancelled: boolean; reason?: string } } {
  if (opts.deadline !== undefined && opts.deadlineMs !== undefined) {
    throw new SerializationError('Specify either `deadline` or `deadlineMs`, not both');
  }
  let deadlineEpochMs = 0;
  if (opts.deadline !== undefined) {
    deadlineEpochMs = opts.deadline;
  } else if (opts.deadlineMs !== undefined) {
    deadlineEpochMs = Date.now() + opts.deadlineMs;
  }

  if (deadlineEpochMs > 0) {
    const minBudget = computeMinBudget(opts.treeDepth ?? 0);
    if (deadlineEpochMs - Date.now() < minBudget) {
      throw new DeadlineTooShortError(deadlineEpochMs - Date.now(), minBudget);
    }
  }

  // Snapshot the cancel state at envelope-build time. Live updates after
  // this point ride on the `cancelStream` channel — see cancel-stream.ts.
  const sigState = opts.cancel?.poll() ?? { cancelled: false };

  return {
    deadlineEpochMs,
    cancelTokenId: opts.cancel?.id,
    mode: opts.mode,
    signal: { cancelled: sigState.cancelled, reason: sigState.reason },
  };
}

/**
 * Minimum effective deadline budget given tree depth (per-hop ~50ms typical
 * skew × 2 for budget). At K=4 with F=8 the 5-hop chain wants ~500ms+ floor.
 */
export function computeMinBudget(treeDepth: number): number {
  if (treeDepth <= 1) return MIN_DEADLINE_BUDGET_MS;
  return Math.max(MIN_DEADLINE_BUDGET_MS, 200 * treeDepth);
}

export function envelopeRemainingMs(envelope: RpcEnvelope): number | null {
  if (!envelope.deadlineEpochMs) return null;
  return envelope.deadlineEpochMs - Date.now();
}

export function checkDeadline(envelope: RpcEnvelope): void {
  if (!envelope.deadlineEpochMs) return;
  if (Date.now() >= envelope.deadlineEpochMs) {
    throw new DeadlineExceededError(envelope.deadlineEpochMs);
  }
}
