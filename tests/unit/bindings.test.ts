import { describe, expect, test } from 'bun:test';
import { bindingAllowList, pickBindings } from '../../src/api/bindings';
import { LoaderOnlyPoolImpl } from '../../src/api/loader-only-pool';
import { Pool } from '../../src/api/pool';
import { Scheduler } from '../../src/api/scheduler';
import { submitCodeHandler } from '../../src/api/submit-code-handler';
import { BindingError } from '../../src/errors/index';
import type { PoolEnv } from '../../src/api/options';
import type {
  CoordinatorFanOutRequest,
  CoordinatorRunRequest,
  RunOneResult,
} from '../../src/coordinator/protocol';
import type { SchedulerEnqueueRequest } from '../../src/scheduler/scheduler-do';
import type { WorkerCode, WorkerLoader } from '../../src/types';

function fakeLoader(): WorkerLoader {
  return {
    get: (() => {
      throw new Error('LOADER.get unused in these tests');
    }) as unknown as WorkerLoader['get'],
  } as unknown as WorkerLoader;
}

function capturingLoader(codes: WorkerCode[]): WorkerLoader {
  return {
    get: ((_id, getCodeCallback) =>
      ({
        getEntrypoint: () => ({
          fetch: async () => new Response(),
          execute: async () => {
            codes.push(await getCodeCallback());
            return 1;
          },
        }),
      }) as never) as WorkerLoader['get'],
  };
}

function fakePoolNamespace(captures: {
  runOne?: CoordinatorRunRequest;
  runMany?: CoordinatorFanOutRequest;
}): DurableObjectNamespace {
  const stub = {
    runOne(req: CoordinatorRunRequest): Promise<RunOneResult> {
      captures.runOne = req;
      return Promise.resolve({ ok: true, value: 'ok' });
    },
    runMany(req: CoordinatorFanOutRequest) {
      captures.runMany = req;
      return Promise.resolve({
        results: req.argsList.map(() => ({ ok: true as const, value: 'ok' })),
        topology: 'hybrid' as const,
        fanOutPerLevel: [req.argsList.length],
        treeDepth: 1,
      });
    },
    async noop() {
      return;
    },
  };
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    newUniqueId: () => 'fake' as unknown as DurableObjectId,
    idFromString: (s: string) => s as unknown as DurableObjectId,
    get: () => stub as unknown as DurableObjectStub,
    jurisdiction: () => {
      throw new Error('not implemented');
    },
  } as unknown as DurableObjectNamespace;
}

function fakeSchedulerNamespace(captures: {
  configure: unknown[];
  enqueue?: SchedulerEnqueueRequest;
}): DurableObjectNamespace {
  const stub = {
    async configure(c: unknown) {
      captures.configure.push(c);
      return { effective: c };
    },
    async enqueue(req: SchedulerEnqueueRequest) {
      captures.enqueue = req;
      return { id: req.id };
    },
    async status() {
      return 'queued';
    },
    async result() {
      return { status: 'done', value: undefined };
    },
    async cancel() {
      return true;
    },
    async cancelByTenant() {
      return 0;
    },
    async stats() {
      return { queued: 0, leased: 0, done: 0, failed: 0, cancelled: 0, oldestQueuedAgeMs: 0 };
    },
  };
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    newUniqueId: () => 'fake' as unknown as DurableObjectId,
    idFromString: (s: string) => s as unknown as DurableObjectId,
    get: () => stub as unknown as DurableObjectStub,
    jurisdiction: () => {
      throw new Error('not implemented');
    },
  } as unknown as DurableObjectNamespace;
}

describe('pickBindings', () => {
  test('narrows env to named keys', () => {
    const env = { AI: 'ai-stub', KV: 'kv-stub', SECRET: 'shh', R2: 'r2-stub' };
    const picked = pickBindings(env, ['AI', 'KV']);
    expect(picked).toEqual({ AI: 'ai-stub', KV: 'kv-stub' });
    expect('SECRET' in picked).toBe(false);
    expect('R2' in picked).toBe(false);
  });

  test('drops keys that are absent', () => {
    const env = { AI: 'ai' };
    const picked = pickBindings(env as { AI: string; MISSING?: string }, ['AI', 'MISSING']);
    expect(picked).toEqual({ AI: 'ai' });
    expect('MISSING' in picked).toBe(false);
  });

  test('handles empty / non-object env', () => {
    expect(pickBindings({} as Record<string, unknown>, ['x' as never])).toEqual({});
    expect(pickBindings(null as unknown as Record<string, unknown>, ['x' as never])).toEqual({});
    expect(pickBindings(undefined as unknown as Record<string, unknown>, ['x' as never])).toEqual(
      {},
    );
  });

  test('preserves type-level Pick', () => {
    interface Env {
      AI: { run: () => unknown };
      KV: { get: () => unknown };
      SECRET: string;
    }
    const env: Env = {
      AI: { run: () => null },
      KV: { get: () => null },
      SECRET: 'shh',
    };
    const picked: Pick<Env, 'AI' | 'KV'> = pickBindings(env, ['AI', 'KV']);
    expect(typeof picked.AI.run).toBe('function');
    expect(typeof picked.KV.get).toBe('function');
    // SECRET intentionally not in scope; type-level test.
  });
});

describe('binding allow-list propagation', () => {
  test('bindingAllowList preserves undefined as forward-all and empty object as forward-none', () => {
    expect(bindingAllowList(undefined)).toBeUndefined();
    expect(bindingAllowList({})).toEqual([]);
    expect(bindingAllowList({ AI: 'ai', KV: 'kv' })).toEqual(['AI', 'KV']);
  });

  test('submitCodeHandler forwards allowBindings and sandboxes outbound by default', async () => {
    const captures: { runOne?: CoordinatorRunRequest } = {};
    const env: PoolEnv = {
      LOADER: fakeLoader(),
      CfpCoordinator: fakePoolNamespace(captures),
    };
    const pool = new Pool(env, {
      bindings: { KV: 'declared-kv', SECRET: 'declared-secret' },
    });
    const handler = submitCodeHandler({
      pool: pool as never,
      policy: { kind: 'auth', auth: () => true, allowBindings: ['KV'] },
    });

    const res = await handler(
      new Request('https://example.test/run', {
        method: 'POST',
        body: JSON.stringify({ fn: '() => 1', args: [] }),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(res.status).toBe(200);
    expect(captures.runOne?.allowList).toEqual(['KV']);
    expect(captures.runOne?.workerOptions?.globalOutbound).toBe('sandboxed');
  });

  test('Pool fan-out forwards the declared binding allow-list', async () => {
    const captures: { runMany?: CoordinatorFanOutRequest } = {};
    const env: PoolEnv = {
      LOADER: fakeLoader(),
      CfpCoordinator: fakePoolNamespace(captures),
    };
    const pool = new Pool(env, { bindings: { AI: 'declared-ai' } });

    await pool.map((x: number) => x * 2, [1, 2]);

    expect(captures.runMany?.allowList).toEqual(['AI']);
  });

  test('Scheduler enqueue applies constructor config, worker options, and binding allow-list', async () => {
    const captures: { configure: unknown[]; enqueue?: SchedulerEnqueueRequest } = {
      configure: [],
    };
    const env: PoolEnv = {
      LOADER: fakeLoader(),
      CfpSchedulerDO: fakeSchedulerNamespace(captures),
    };
    const scheduler = new Scheduler(env, {
      id: 's1',
      bindings: { AI: 'declared-ai' },
      globalOutbound: null,
      limits: { cpuMs: 10 },
      workerOptions: { compatibilityDate: '2026-01-20', compatibilityFlags: ['nodejs_compat'] },
      observability: { tail: { bindingName: 'TAIL' } },
      inFlightLimit: 7,
      maxQueueDepth: 9,
      fairCapacityPerTenant: 2,
      resultRetention: { ttlMs: 1234 },
    });

    await scheduler.enqueue({ fn: () => 1, args: [] });

    expect(captures.configure).toEqual([
      { inFlightLimit: 7, maxQueueDepth: 9, fairCapacityPerTenant: 2, resultTtlMs: 1234 },
    ]);
    expect(captures.enqueue?.allowList).toEqual(['AI']);
    expect(captures.enqueue?.workerOptions).toEqual({
      compatibilityDate: '2026-01-20',
      compatibilityFlags: ['nodejs_compat'],
      globalOutbound: 'sandboxed',
      limits: { cpuMs: 10 },
      tailBindingName: 'TAIL',
    });
  });

  test('Scheduler rejects advertised-but-unsupported constructor options instead of ignoring them', () => {
    const env: PoolEnv = {
      LOADER: fakeLoader(),
      CfpSchedulerDO: fakeSchedulerNamespace({ configure: [] }),
    };

    expect(() => new Scheduler(env, { id: 's-store', store: 'd1' })).toThrow(BindingError);
    expect(
      () =>
        new Scheduler(env, {
          id: 's-fairness',
          fairness: { keyFrom: () => 'tenant', capacityPerKey: 1 },
        }),
    ).toThrow(BindingError);
    expect(
      () => new Scheduler(env, { id: 's-alarm', alarmCadence: { activeMs: 1, idleMs: 10 } }),
    ).toThrow(BindingError);
  });

  test('LoaderOnly keeps default sandboxing but honors explicit workerOptions inherit', async () => {
    const defaultCodes: WorkerCode[] = [];
    const defaultPool = new LoaderOnlyPoolImpl({ LOADER: capturingLoader(defaultCodes) }, {});
    await defaultPool.submit(() => 1);
    expect(defaultCodes[0].globalOutbound).toBeNull();

    const inheritCodes: WorkerCode[] = [];
    const inheritPool = new LoaderOnlyPoolImpl(
      { LOADER: capturingLoader(inheritCodes) },
      { workerOptions: { globalOutbound: undefined } },
    );
    await inheritPool.submit(() => 1);
    expect('globalOutbound' in inheritCodes[0]).toBe(false);
  });
});
