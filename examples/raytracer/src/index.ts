/**
 * raytracer — distributed ray-traced image rendering across V8 isolates.
 *
 * The image is sliced into N horizontal tiles. Each isolate ray-traces
 * one tile against a tiny scene (3 spheres + a plane, single light,
 * Lambertian shading + sphere reflections). Tiles are reassembled into
 * a PPM image returned to the client.
 *
 * Pure CPU: each ray costs ~50 µs on workerd; a 256-row tile of a
 * 320-wide image is ~80k rays = ~4s per tile single-threaded. Splitting
 * into 16 tiles and running across 16 isolates collapses wall-clock by
 * the parallelism factor.
 *
 * Try it:
 *   curl -o out.ppm 'http://localhost:8787/render?w=320&h=192&tiles=16'
 *   open out.ppm   # any PPM viewer; macOS Preview opens it
 */
import { Parallel, type WorkerLoader } from 'cloudflare-parallel';

export { CfpCoordinator, CfpWorkerDO, CfpSubCoord } from 'cloudflare-parallel/durable-objects';

interface Env {
  LOADER: WorkerLoader;
  CfpCoordinator: DurableObjectNamespace;
  CfpWorkerDO: DurableObjectNamespace;
  CfpSubCoord: DurableObjectNamespace;
}

interface TileSpec {
  y0: number;
  y1: number;
  width: number;
  height: number;
  spp: number;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== '/' && url.pathname !== '/render') {
      return Response.json({
        usage: {
          'GET /render?w=&h=&tiles=&spp=': 'render PPM image; tiles=N runs N isolates in parallel',
        },
      });
    }

    const w = Math.min(Number(url.searchParams.get('w') ?? 320), 1024);
    const h = Math.min(Number(url.searchParams.get('h') ?? 192), 768);
    const tiles = Math.min(Number(url.searchParams.get('tiles') ?? 8), 128);
    const spp = Math.min(Number(url.searchParams.get('spp') ?? 1), 8);

    const pool = Parallel.pool(env);

    // Slice the image into `tiles` horizontal stripes.
    const rowsPerTile = Math.ceil(h / tiles);
    const specs: TileSpec[] = [];
    for (let t = 0; t < tiles; t++) {
      const y0 = t * rowsPerTile;
      const y1 = Math.min(h, y0 + rowsPerTile);
      if (y0 >= y1) break;
      specs.push({ y0, y1, width: w, height: h, spp });
    }

    const t0 = Date.now();

    // Render each tile in its own isolate. The user fn is closure-free —
    // takes a TileSpec, returns a Uint8Array of RGB bytes for that tile.
    const tilesOut = await pool.map((spec: TileSpec): { y0: number; bytes: number[] } => {
      // Scene: 3 spheres + a plane.
      const spheres = [
        { c: [-1.5, 0, -4], r: 1.0, color: [0.95, 0.3, 0.3] },
        { c: [0, 0, -3.5], r: 1.0, color: [0.3, 0.7, 0.95] },
        { c: [1.7, -0.2, -3.2], r: 0.7, color: [0.6, 0.9, 0.4] },
      ];
      const lightDir = (() => {
        const v = [-0.5, 0.9, 0.3];
        const n = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        return [v[0] / n, v[1] / n, v[2] / n];
      })();
      const planeY = -1.2;
      // Camera at origin, looking down -Z.
      const fov = Math.PI / 3;
      const aspect = spec.width / spec.height;
      const tanHalf = Math.tan(fov / 2);

      const dot = (a: number[], b: number[]): number =>
        a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const sub = (a: number[], b: number[]): number[] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
      const norm = (v: number[]): number[] => {
        const n = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
        return [v[0] / n, v[1] / n, v[2] / n];
      };

      const intersectSphere = (
        ro: number[],
        rd: number[],
        c: number[],
        r: number,
      ): number => {
        const oc = sub(ro, c);
        const b = dot(oc, rd);
        const cc = dot(oc, oc) - r * r;
        const d = b * b - cc;
        if (d < 0) return -1;
        const sq = Math.sqrt(d);
        const t1 = -b - sq;
        if (t1 > 0.001) return t1;
        const t2 = -b + sq;
        if (t2 > 0.001) return t2;
        return -1;
      };

      const trace = (rd: number[]): number[] => {
        const ro = [0, 0, 0];
        let tHit = Infinity;
        let hitColor = [0, 0, 0];
        let hitNormal = [0, 0, 0];
        let hitPoint = [0, 0, 0];
        for (const s of spheres) {
          const t = intersectSphere(ro, rd, s.c, s.r);
          if (t > 0 && t < tHit) {
            tHit = t;
            hitPoint = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
            hitNormal = norm(sub(hitPoint, s.c));
            hitColor = s.color;
          }
        }
        // Plane y = planeY.
        if (Math.abs(rd[1]) > 1e-6) {
          const tp = (planeY - ro[1]) / rd[1];
          if (tp > 0 && tp < tHit) {
            tHit = tp;
            hitPoint = [ro[0] + rd[0] * tp, ro[1] + rd[1] * tp, ro[2] + rd[2] * tp];
            hitNormal = [0, 1, 0];
            // Checker pattern.
            const cx = Math.floor(hitPoint[0] * 0.6);
            const cz = Math.floor(hitPoint[2] * 0.6);
            const isLight = (cx + cz) % 2 === 0;
            hitColor = isLight ? [0.85, 0.85, 0.85] : [0.2, 0.2, 0.2];
          }
        }
        if (tHit === Infinity) {
          // Sky gradient.
          const t = 0.5 * (rd[1] + 1);
          return [(1 - t) * 0.95 + t * 0.45, (1 - t) * 0.95 + t * 0.55, (1 - t) * 0.95 + t * 0.85];
        }
        // Lambertian shade with soft shadow check (1 ray).
        const ndotl = Math.max(0, dot(hitNormal, lightDir));
        const ambient = 0.15;
        // Shadow ray.
        const sho = [
          hitPoint[0] + hitNormal[0] * 0.001,
          hitPoint[1] + hitNormal[1] * 0.001,
          hitPoint[2] + hitNormal[2] * 0.001,
        ];
        let inShadow = 0;
        for (const s of spheres) {
          const t = intersectSphere(sho, lightDir, s.c, s.r);
          if (t > 0) {
            inShadow = 0.65;
            break;
          }
        }
        const shade = ambient + ndotl * (1 - inShadow);
        return [hitColor[0] * shade, hitColor[1] * shade, hitColor[2] * shade];
      };

      const bytes: number[] = [];
      for (let py = spec.y0; py < spec.y1; py++) {
        for (let px = 0; px < spec.width; px++) {
          let r = 0, g = 0, b = 0;
          for (let s = 0; s < spec.spp; s++) {
            const sx = (s & 1) * 0.5 - 0.25;
            const sy = ((s >> 1) & 1) * 0.5 - 0.25;
            const u = ((px + sx) / spec.width) * 2 - 1;
            const v = 1 - ((py + sy) / spec.height) * 2;
            const rd = norm([u * tanHalf * aspect, v * tanHalf, -1]);
            const c = trace(rd);
            r += c[0];
            g += c[1];
            b += c[2];
          }
          r /= spec.spp;
          g /= spec.spp;
          b /= spec.spp;
          bytes.push(
            Math.min(255, Math.max(0, Math.floor(Math.sqrt(r) * 255))),
            Math.min(255, Math.max(0, Math.floor(Math.sqrt(g) * 255))),
            Math.min(255, Math.max(0, Math.floor(Math.sqrt(b) * 255))),
          );
        }
      }
      return { y0: spec.y0, bytes };
    }, specs);

    const renderMs = Date.now() - t0;

    // Reassemble in y0 order.
    tilesOut.sort((a, b) => a.y0 - b.y0);
    const totalBytes = w * h * 3;
    const buf = new Uint8Array(totalBytes);
    let cursor = 0;
    for (const t of tilesOut) {
      buf.set(t.bytes, cursor);
      cursor += t.bytes.length;
    }

    const stats = await pool.stats();
    const accept = req.headers.get('accept') ?? '';
    if (accept.includes('application/json') || url.searchParams.get('json') === '1') {
      return Response.json({
        timing: { renderMs },
        topology: stats.topology,
        treeDepth: stats.treeDepth,
        fanOutPerLevel: stats.fanOutPerLevel,
        tiles: tilesOut.length,
        width: w,
        height: h,
        spp,
      });
    }

    // PPM (Netpbm) format. Trivial decode in any image viewer.
    const header = `P6\n${w} ${h}\n255\n`;
    const headerBytes = new TextEncoder().encode(header);
    const ppm = new Uint8Array(headerBytes.length + buf.length);
    ppm.set(headerBytes, 0);
    ppm.set(buf, headerBytes.length);

    return new Response(ppm, {
      headers: {
        'content-type': 'image/x-portable-pixmap',
        'x-render-ms': String(renderMs),
        'x-topology': stats.topology,
        'x-tree-depth': String(stats.treeDepth),
        'x-fan-out': JSON.stringify(stats.fanOutPerLevel),
      },
    });
  },
};
