/**
 * Re-export the library's Durable Object classes (and the in-process
 * coordinator WorkerEntrypoint) for users to register in their Worker
 * entrypoint:
 *
 *     import {
 *       CfpCoordinator,
 *       CfpWorkerDO,
 *       CfpSubCoord,
 *       CfpSchedulerDO,
 *       CfpInProcessCoordinator,
 *     } from 'cloudflare-parallel/durable-objects';
 *     export {
 *       CfpCoordinator,
 *       CfpWorkerDO,
 *       CfpSubCoord,
 *       CfpSchedulerDO,
 *       CfpInProcessCoordinator,
 *     };
 *
 * `CfpInProcessCoordinator` is a `WorkerEntrypoint` (not a Durable
 * Object) — re-exporting it makes it available as a `ctx.exports` loopback
 * binding for small-N submits, dropping dispatch overhead from tens of
 * milliseconds (DO RPC) to a couple of milliseconds (in-process).
 *
 * The matching `wrangler.toml` bindings are documented in the project
 * README; run `npx cloudflare-parallel doctor` to scaffold them in an
 * existing Worker.
 */

export {
  CfpCoordinator,
  CfpWorkerDO,
  CfpSubCoord,
  CfpInProcessCoordinator,
} from './coordinator/index';
export { CfpSchedulerDO } from './scheduler/index';
