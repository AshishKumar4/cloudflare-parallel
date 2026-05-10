/**
 * genetic-algorithm — evolve solutions to a Travelling Salesperson
 * Problem (TSP) over a synthetic 50-city map.
 *
 * Each generation evaluates a population of candidate tours in
 * parallel. Per-candidate fitness is "compute total tour distance" —
 * cheap individually, but a population of 256 over 30 generations is
 * 7,680 fitness evaluations. Each tour evaluation includes a heavy
 * 2-opt local-search refinement (O(n²) per evaluation) so each task
 * is genuinely CPU-bound (~5-15 ms on the Workers runtime).
 *
 * Single-threaded JS would serialize all 256 evaluations behind the
 * event loop. `pool.map` runs them across N parallel V8 isolates, so
 * generation wall-clock becomes ~max(eval) instead of sum(eval).
 *
 * Try it:
 *   curl 'http://localhost:8787/?gen=20&pop=128' | jq
 */
import { Parallel, type WorkerLoader } from 'cloudflare-parallel';

export {
  CfpCoordinator,
  CfpWorkerDO,
  CfpSubCoord,
  CfpInProcessCoordinator,
} from "cloudflare-parallel/durable-objects";

interface Env {
  LOADER: WorkerLoader;
  CfpCoordinator: DurableObjectNamespace;
  CfpWorkerDO: DurableObjectNamespace;
  CfpSubCoord: DurableObjectNamespace;
}

interface City {
  id: number;
  x: number;
  y: number;
}

// Deterministic synthetic 50-city map (LCG; reproducible across runs).
function buildCities(n: number, seed = 42): City[] {
  let s = seed | 0;
  const next = (): number => {
    s = (s * 1103515245 + 12345) | 0;
    return ((s >>> 0) / 0xffffffff) * 1000;
  };
  return Array.from({ length: n }, (_, id) => ({ id, x: next(), y: next() }));
}

function randomTour(n: number, seed: number): number[] {
  let s = seed | 0;
  const next = (): number => {
    s = (s * 1103515245 + 12345) | 0;
    return s >>> 0;
  };
  const tour = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [tour[i], tour[j]] = [tour[j], tour[i]];
  }
  return tour;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== '/' && url.pathname !== '/run') {
      return Response.json({
        usage: { 'GET /?gen=&pop=&cities=': 'evolve a TSP tour for `gen` generations' },
      });
    }

    const generations = Math.min(Number(url.searchParams.get('gen') ?? 10), 50);
    const popSize = Math.min(Number(url.searchParams.get('pop') ?? 64), 512);
    const cities = Math.min(Number(url.searchParams.get('cities') ?? 50), 200);

    const pool = Parallel.pool(env);
    const map = buildCities(cities);

    let population = Array.from({ length: popSize }, (_, i) => randomTour(cities, i + 1));
    const history: { gen: number; bestDistance: number; ms: number }[] = [];

    const t0 = Date.now();

    for (let gen = 0; gen < generations; gen++) {
      const tGen = Date.now();

      // Each isolate: evaluate ONE candidate. The fn closes over no host
      // state; it gets the tour + cities and returns { tour, distance }.
      const evaluated = await pool.map(
        (input: { tour: number[]; cities: City[] }) => {
          // 2-opt local search refinement (CPU-bound).
          const { cities } = input;
          let tour = input.tour.slice();
          const dist = (a: number, b: number): number => {
            const dx = cities[a].x - cities[b].x;
            const dy = cities[a].y - cities[b].y;
            return Math.sqrt(dx * dx + dy * dy);
          };
          const tourLen = (t: number[]): number => {
            let total = 0;
            for (let i = 0; i < t.length; i++) {
              total += dist(t[i], t[(i + 1) % t.length]);
            }
            return total;
          };
          // Two passes of 2-opt — each pass is O(n²).
          for (let pass = 0; pass < 2; pass++) {
            let improved = false;
            for (let i = 1; i < tour.length - 2; i++) {
              for (let j = i + 1; j < tour.length - 1; j++) {
                const a = tour[i - 1];
                const b = tour[i];
                const c = tour[j];
                const d = tour[j + 1];
                const before = dist(a, b) + dist(c, d);
                const after = dist(a, c) + dist(b, d);
                if (after < before - 1e-9) {
                  // Reverse segment [i..j].
                  const seg = tour.slice(i, j + 1).reverse();
                  tour = tour.slice(0, i).concat(seg, tour.slice(j + 1));
                  improved = true;
                }
              }
            }
            if (!improved) break;
          }
          return { tour, distance: tourLen(tour) };
        },
        population.map((tour) => ({ tour, cities: map })),
      );

      // Sort by fitness, keep top half, breed the bottom half.
      evaluated.sort((a, b) => a.distance - b.distance);
      const elite = evaluated.slice(0, Math.max(2, Math.floor(popSize / 2)));
      const offspring: number[][] = [];

      // Order Crossover (OX1) — sequential; cheap.
      const rng = (s: number): (() => number) => {
        let st = s | 0;
        return (): number => {
          st = (st * 1103515245 + 12345) | 0;
          return st >>> 0;
        };
      };
      const r = rng(gen + 17);
      while (offspring.length < popSize - elite.length) {
        const p1 = elite[r() % elite.length].tour;
        const p2 = elite[r() % elite.length].tour;
        const len = p1.length;
        const a = r() % len;
        const b = a + (r() % (len - a));
        const child = new Array<number>(len).fill(-1);
        for (let i = a; i <= b; i++) child[i] = p1[i];
        let ci = (b + 1) % len;
        for (let i = 0; i < len; i++) {
          const g = p2[(b + 1 + i) % len];
          if (!child.includes(g)) {
            child[ci] = g;
            ci = (ci + 1) % len;
          }
        }
        // Mutation: small chance of 2-swap.
        if (r() % 100 < 8) {
          const i = r() % len;
          const j = r() % len;
          [child[i], child[j]] = [child[j], child[i]];
        }
        offspring.push(child);
      }

      population = elite.map((e) => e.tour).concat(offspring);
      history.push({
        gen,
        bestDistance: +elite[0].distance.toFixed(2),
        ms: Date.now() - tGen,
      });
    }

    const stats = await pool.stats();
    return Response.json({
      generations,
      population: popSize,
      cities,
      bestDistance: history[history.length - 1].bestDistance,
      history,
      timing: { totalMs: Date.now() - t0 },
      topology: {
        decision: stats.topology,
        treeDepth: stats.treeDepth,
        fanOutPerLevel: stats.fanOutPerLevel,
      },
    });
  },
};
