/**
 * Test-only entrypoint. Provides in-process fakes for `Pool`,
 * `LoaderOnlyPool`, `ActorHandle`, `Scheduler`, and `VM` that match the
 * production return types (`IPool` / `IActorHandle` / `IScheduler`)
 * without spinning up Worker Loaders or Durable Objects.
 *
 * Use:
 *   import { poolFake, actorFake, schedulerFake } from 'cloudflare-parallel/testing';
 *   const fake = poolFake({ bindings: { KV: kvStub } });
 *   await fake.map((n: number) => n + 1, [1, 2, 3]);
 *
 * The fakes are deliberately kept out of `cloudflare-parallel`'s main
 * entrypoint so production bundles tree-shake them — they ship ~2 KB of
 * extra logic per fake which is wasted in a deployed Worker.
 */
export { poolFake, loaderOnlyFake, actorFake, schedulerFake, vmFake } from './api/testing';
