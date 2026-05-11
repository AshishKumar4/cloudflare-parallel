import { describe, expect, test } from 'bun:test';
import { emitObservabilityEvent } from '../../src/observability/index';
import type { AnalyticsEngineDataset, ObservabilityOptions } from '../../src/api/options';

function makeAE(): {
  ds: AnalyticsEngineDataset;
  points: Array<{ blobs?: string[]; doubles?: number[]; indexes?: string[] }>;
} {
  const points: Array<{ blobs?: string[]; doubles?: number[]; indexes?: string[] }> = [];
  return {
    points,
    ds: {
      writeDataPoint(p) {
        points.push(p);
      },
    },
  };
}

describe('emitObservabilityEvent', () => {
  test('fires hooks for every event kind', () => {
    const calls: string[] = [];
    const opts: ObservabilityOptions = {
      hooks: {
        onTaskStart: () => calls.push('taskStart'),
        onTaskEnd: () => calls.push('taskEnd'),
        onTaskError: () => calls.push('taskError'),
        onTaskOrphan: () => calls.push('taskOrphan'),
        onPoolPressure: () => calls.push('poolPressure'),
        onTopologyDecision: () => calls.push('topologyDecision'),
        onLruEviction: () => calls.push('lruEviction'),
        onSchedulerEvent: () => calls.push('scheduler'),
      },
    };
    emitObservabilityEvent(opts, {
      kind: 'taskStart',
      payload: { ts: 0, poolId: 'p', taskId: 't', topology: 'in-do', fnHash: 'h' },
    });
    emitObservabilityEvent(opts, {
      kind: 'taskEnd',
      payload: {
        ts: 0,
        poolId: 'p',
        taskId: 't',
        topology: 'in-do',
        fnHash: 'h',
        wallMs: 1,
        retryCount: 0,
      },
    });
    emitObservabilityEvent(opts, {
      kind: 'taskError',
      payload: {
        ts: 0,
        poolId: 'p',
        taskId: 't',
        topology: 'in-do',
        fnHash: 'h',
        errorClass: 'E',
        message: 'm',
        retryCount: 0,
      },
    });
    emitObservabilityEvent(opts, {
      kind: 'taskOrphan',
      payload: { ts: 0, poolId: 'p', taskId: 't' },
    });
    emitObservabilityEvent(opts, {
      kind: 'poolPressure',
      payload: { ts: 0, kind: 'lru-thrash' },
    });
    emitObservabilityEvent(opts, {
      kind: 'topologyDecision',
      payload: { ts: 0, size: 64, topology: 'tree', fanOutPerLevel: [4, 16], treeDepth: 2 },
    });
    emitObservabilityEvent(opts, {
      kind: 'lruEviction',
      payload: { ts: 0, cacheKey: 'k' },
    });
    emitObservabilityEvent(opts, {
      kind: 'scheduler',
      payload: { ts: 0, jobId: 'j', kind: 'enqueued' },
    });
    expect(calls).toEqual([
      'taskStart',
      'taskEnd',
      'taskError',
      'taskOrphan',
      'poolPressure',
      'topologyDecision',
      'lruEviction',
      'scheduler',
    ]);
  });

  test('writes AE points for taskEnd / taskError / taskOrphan / poolPressure / topologyDecision / lruEviction / scheduler', () => {
    const { ds, points } = makeAE();
    const opts: ObservabilityOptions = { metrics: ds };

    emitObservabilityEvent(opts, {
      kind: 'taskEnd',
      payload: {
        ts: 0,
        poolId: 'p',
        taskId: 't',
        topology: 'in-do',
        fnHash: 'h',
        wallMs: 1,
        retryCount: 0,
      },
    });
    emitObservabilityEvent(opts, {
      kind: 'taskError',
      payload: {
        ts: 0,
        poolId: 'p',
        taskId: 't',
        topology: 'in-do',
        fnHash: 'h',
        errorClass: 'E',
        message: 'm',
        retryCount: 0,
      },
    });
    emitObservabilityEvent(opts, {
      kind: 'taskOrphan',
      payload: { ts: 0, poolId: 'p', taskId: 't', reason: 'cancel' },
    });
    emitObservabilityEvent(opts, {
      kind: 'poolPressure',
      payload: { ts: 0, kind: 'lru-thrash', detail: 'd' },
    });
    emitObservabilityEvent(opts, {
      kind: 'topologyDecision',
      payload: { ts: 0, size: 64, topology: 'tree', fanOutPerLevel: [4, 16], treeDepth: 2 },
    });
    emitObservabilityEvent(opts, {
      kind: 'lruEviction',
      payload: { ts: 0, cacheKey: 'k' },
    });
    emitObservabilityEvent(opts, {
      kind: 'scheduler',
      payload: { ts: 0, jobId: 'j', kind: 'enqueued' },
    });

    expect(points.length).toBe(7);
    expect(points[0].blobs?.[0]).toBe('taskEnd');
    expect(points[1].blobs?.[0]).toBe('taskError');
    expect(points[2].blobs?.[0]).toBe('taskOrphan');
    expect(points[3].blobs?.[0]).toBe('poolPressure');
    expect(points[4].blobs?.[0]).toBe('topologyDecision');
    expect(points[5].blobs?.[0]).toBe('lruEviction');
    expect(points[6].blobs?.[0]).toBe('scheduler');
  });

  test('hook errors do not propagate (must not break submit path)', () => {
    const opts: ObservabilityOptions = {
      hooks: {
        onTaskStart: () => {
          throw new Error('boom');
        },
      },
    };
    expect(() =>
      emitObservabilityEvent(opts, {
        kind: 'taskStart',
        payload: { ts: 0, poolId: 'p', taskId: 't', topology: 'in-do', fnHash: 'h' },
      }),
    ).not.toThrow();
  });

  test('AE write errors do not propagate', () => {
    const opts: ObservabilityOptions = {
      metrics: {
        writeDataPoint() {
          throw new Error('AE down');
        },
      },
    };
    expect(() =>
      emitObservabilityEvent(opts, {
        kind: 'taskEnd',
        payload: {
          ts: 0,
          poolId: 'p',
          taskId: 't',
          topology: 'in-do',
          fnHash: 'h',
          wallMs: 1,
          retryCount: 0,
        },
      }),
    ).not.toThrow();
  });

  test('no hooks + no metrics is a no-op (no errors, no calls)', () => {
    expect(() =>
      emitObservabilityEvent(undefined, {
        kind: 'taskStart',
        payload: { ts: 0, poolId: 'p', taskId: 't', topology: 'in-do', fnHash: 'h' },
      }),
    ).not.toThrow();
    expect(() =>
      emitObservabilityEvent(
        {},
        {
          kind: 'taskStart',
          payload: { ts: 0, poolId: 'p', taskId: 't', topology: 'in-do', fnHash: 'h' },
        },
      ),
    ).not.toThrow();
  });
});
