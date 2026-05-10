/**
 * Observability surfaces. All hooks are synchronous; do not await user code
 * inside them. Errors thrown by hooks are swallowed so observability bugs
 * cannot break the submit path.
 */

import type {
  AnalyticsEngineDataset,
  ObservabilityOptions,
  PoolPressureEvent,
  TaskEndEvent,
  TaskErrorEvent,
  TaskOrphanEvent,
  TaskStartEvent,
  TopologyDecisionEvent,
  LruEvictionEvent,
  SchedulerEvent,
} from '../api/options.js';

export type ObservabilityEvent =
  | { kind: 'taskStart'; payload: TaskStartEvent }
  | { kind: 'taskEnd'; payload: TaskEndEvent }
  | { kind: 'taskError'; payload: TaskErrorEvent }
  | { kind: 'taskOrphan'; payload: TaskOrphanEvent }
  | { kind: 'poolPressure'; payload: PoolPressureEvent }
  | { kind: 'topologyDecision'; payload: TopologyDecisionEvent }
  | { kind: 'lruEviction'; payload: LruEvictionEvent }
  | { kind: 'scheduler'; payload: SchedulerEvent };

export function emitObservabilityEvent(
  opts: ObservabilityOptions | undefined,
  ev: ObservabilityEvent,
): void {
  if (!opts) return;
  const hooks = opts.hooks;
  if (hooks) {
    try {
      switch (ev.kind) {
        case 'taskStart':
          hooks.onTaskStart?.(ev.payload);
          break;
        case 'taskEnd':
          hooks.onTaskEnd?.(ev.payload);
          break;
        case 'taskError':
          hooks.onTaskError?.(ev.payload);
          break;
        case 'taskOrphan':
          hooks.onTaskOrphan?.(ev.payload);
          break;
        case 'poolPressure':
          hooks.onPoolPressure?.(ev.payload);
          break;
        case 'topologyDecision':
          hooks.onTopologyDecision?.(ev.payload);
          break;
        case 'lruEviction':
          hooks.onLruEviction?.(ev.payload);
          break;
        case 'scheduler':
          hooks.onSchedulerEvent?.(ev.payload);
          break;
      }
    } catch {
      /* observability hook errors must not break the submit path */
    }
  }
  if (opts.metrics && opts.metrics !== 'off') {
    try {
      writeAnalyticsEngine(opts.metrics, ev);
    } catch {
      /* same — never break submits */
    }
  }
}

function writeAnalyticsEngine(ds: AnalyticsEngineDataset, ev: ObservabilityEvent): void {
  // AE schema (per event kind): blobs[0] = poolId/source, blobs[1] = kind
  // discriminator, blobs[2..] = kind-specific. doubles vary; indexes always
  // poolId for cheap GROUP-BY queries.
  switch (ev.kind) {
    case 'taskEnd':
      ds.writeDataPoint({
        blobs: ['taskEnd', ev.payload.poolId, ev.payload.topology, 'ok', ev.payload.fnHash],
        doubles: [ev.payload.wallMs, ev.payload.retryCount],
        indexes: [ev.payload.poolId],
      });
      break;
    case 'taskError':
      ds.writeDataPoint({
        blobs: [
          'taskError',
          ev.payload.poolId,
          ev.payload.topology,
          ev.payload.errorClass,
          ev.payload.fnHash,
        ],
        doubles: [0, ev.payload.retryCount],
        indexes: [ev.payload.poolId],
      });
      break;
    case 'taskOrphan':
      ds.writeDataPoint({
        blobs: ['taskOrphan', ev.payload.poolId, ev.payload.taskId, ev.payload.reason ?? ''],
        doubles: [0],
        indexes: [ev.payload.poolId],
      });
      break;
    case 'poolPressure':
      ds.writeDataPoint({
        blobs: ['poolPressure', ev.payload.kind, ev.payload.detail ?? ''],
        doubles: [1],
        indexes: [ev.payload.kind],
      });
      break;
    case 'topologyDecision':
      ds.writeDataPoint({
        blobs: ['topologyDecision', ev.payload.topology],
        doubles: [ev.payload.size, ev.payload.treeDepth, ...ev.payload.fanOutPerLevel],
        indexes: [ev.payload.topology],
      });
      break;
    case 'lruEviction':
      ds.writeDataPoint({
        blobs: ['lruEviction', ev.payload.cacheKey],
        doubles: [1],
        indexes: ['lruEviction'],
      });
      break;
    case 'scheduler':
      ds.writeDataPoint({
        blobs: ['scheduler', ev.payload.kind, ev.payload.jobId, ev.payload.detail ?? ''],
        doubles: [1],
        indexes: [ev.payload.kind],
      });
      break;
    case 'taskStart':
      // taskStart is high-frequency; not emitted to AE by default. Hooks
      // still fire for in-process consumers that want it.
      break;
  }
}
