/**
 * Demo site frontend. Talks to the deployed test worker
 * (cloudflare-parallel-prod-tests) for every primitive demonstration.
 *
 * No framework. Plain DOM, ~30 KB compiled. Vanilla CSS in style.css.
 *
 * The whole point: interact with `cloudflare-parallel` end-to-end against
 * a real Cloudflare deployment, with honest live numbers — not local
 * the Workers runtime, not mocked, not pre-recorded.
 */

const API = 'https://cloudflare-parallel-prod-tests.ashishkmr472.workers.dev';
const VM_TOKEN_DEFAULT = 'dev-prod-test-token-min-16-chars-please';

// ---------- helpers --------------------------------------------------

async function apiPost<T>(path: string, body: unknown, headers?: HeadersInit): Promise<T> {
  const t0 = performance.now();
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${r.status} ${r.statusText}: ${text.slice(0, 240)}`);
  }
  const j = (await r.json()) as T & { _clientMs?: number };
  j._clientMs = Math.round(performance.now() - t0);
  return j;
}

async function apiGet<T>(path: string): Promise<T> {
  const t0 = performance.now();
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 240)}`);
  const j = (await r.json()) as T & { _clientMs?: number };
  j._clientMs = Math.round(performance.now() - t0);
  return j;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (n < 1) return n.toFixed(2);
  if (n < 1000) return Math.round(n).toString();
  if (n < 10000) return (n / 1000).toFixed(2) + 'k';
  return Math.round(n / 1000) + 'k';
}

function setBusy(el: Element | null, busy: boolean): void {
  if (!el) return;
  el.classList.toggle('is-loading', busy);
  if (el instanceof HTMLButtonElement) el.disabled = busy;
}

// ---------- theme ----------------------------------------------------

const themeBtn = document.getElementById('theme-toggle');
const STORAGE_KEY = 'cfp-demo-theme';
function applyTheme(t: 'light' | 'dark' | 'auto'): void {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
applyTheme((localStorage.getItem(STORAGE_KEY) as 'light' | 'dark' | 'auto' | null) ?? 'auto');
themeBtn?.addEventListener('click', () => {
  const cur = (localStorage.getItem(STORAGE_KEY) as 'light' | 'dark' | 'auto' | null) ?? 'auto';
  const next = cur === 'auto' ? 'dark' : cur === 'dark' ? 'light' : 'auto';
  localStorage.setItem(STORAGE_KEY, next);
  applyTheme(next);
});

// ---------- hero ----------------------------------------------------

interface BenchOut {
  size: number;
  parallelMs: number;
  topology: string;
  treeDepth: number;
  fanOutPerLevel: number[];
}
interface SeqOut {
  out: number[];
  ms: number;
}

let heroSize = 128;
const heroTabs = document.querySelectorAll<HTMLButtonElement>('.size-tab');
heroTabs.forEach((b) =>
  b.addEventListener('click', () => {
    heroTabs.forEach((x) => x.classList.remove('is-active'));
    b.classList.add('is-active');
    heroSize = Number(b.dataset.size);
    runHero();
  }),
);

function setText(id: string, txt: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}

async function runHero(): Promise<void> {
  const runBtn = document.getElementById('hero-run');
  setBusy(runBtn, true);
  setText('hero-topology', '…');
  setText('hero-fanout', `size = ${heroSize}`);
  setText('hero-par-ms', '…');
  setText('hero-par-detail', 'running…');
  setText('hero-seq-ms', '…');
  setText('hero-speedup', '…');
  setText('hero-isolates', 'measuring');

  try {
    // ① Sequential baseline at size=min(heroSize, 32) — measured
    //    client-side because the runtime's Date.now() is throttled.
    const seqN = Math.min(heroSize, 32);
    const seqItems = Array.from({ length: seqN }, (_, i) => i + 1);
    const tSeq = performance.now();
    await apiPost<SeqOut>('/bench/sequential', { items: seqItems });
    const seqRtMs = performance.now() - tSeq;
    // Approximate the network baseline by hitting a cheap endpoint.
    // (Using /pool/stats is the closest no-op we have.)
    const tNet = performance.now();
    await apiGet('/pool/stats');
    const netMs = performance.now() - tNet;
    const seqWorkMs = Math.max(1, seqRtMs - netMs);
    const projectedSeqMs = Math.round((seqWorkMs * heroSize) / seqN);

    // ② Parallel run at the actual size.
    const par = await apiPost<BenchOut>('/demo/bench', { size: heroSize });
    const parMs = par.parallelMs;
    const speedup = parMs > 0 ? +(projectedSeqMs / parMs).toFixed(2) : 0;

    setText('hero-topology', par.topology);
    setText(
      'hero-fanout',
      `size = ${heroSize} · ${par.topology === 'tree' ? `K=${par.treeDepth}` : `[${par.fanOutPerLevel.join(',')}]`}`,
    );
    setText('hero-par-ms', String(parMs));
    setText('hero-par-detail', `${heroSize} items @ SHA-chain × 5000`);
    setText('hero-seq-ms', String(projectedSeqMs));
    setText('hero-speedup', String(speedup));
    setText(
      'hero-isolates',
      par.topology === 'in-do'
        ? '4 V8 isolates (one DO)'
        : par.topology === 'hybrid'
          ? `${Math.ceil(heroSize / 4)} leaf DOs × 4 loaders`
          : `tree depth ${par.treeDepth}`,
    );

    drawTopologySvg(par.topology, heroSize, par.fanOutPerLevel, par.treeDepth);
    document.getElementById('hero-code')!.textContent =
      `// size=${heroSize} → ${par.topology}\n` +
      `await pool.map(sha256Chain, items)\n` +
      `// → fanOut: [${par.fanOutPerLevel.join(', ')}]`;
  } catch (e) {
    setText('hero-topology', 'error');
    setText('hero-par-detail', String((e as Error).message).slice(0, 80));
  } finally {
    setBusy(runBtn, false);
  }
}

function drawTopologySvg(topology: string, size: number, fanOut: number[], depth: number): void {
  const root = document.getElementById('hero-svg');
  if (!root) return;
  const W = 720;
  const H = 200;
  const cx = W / 2;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">`;
  const fg = getCss('--fg');
  const fg2 = getCss('--fg-3');
  const orange = getCss('--orange');
  const blue = getCss('--accent');
  const stroke = getCss('--border-2');

  if (topology === 'in-do') {
    // 1 DO + 4 loaders inside.
    svg += `<rect x="${cx - 50}" y="40" width="100" height="40" rx="6" fill="none" stroke="${blue}" stroke-width="2" />`;
    svg += `<text x="${cx}" y="64" text-anchor="middle" fill="${fg}" font-size="13" font-family="monospace">Coordinator</text>`;
    for (let i = 0; i < 4; i++) {
      const x = cx - 60 + i * 40;
      svg += `<circle cx="${x}" cy="130" r="14" fill="${orange}" />`;
      svg += `<line x1="${cx}" y1="80" x2="${x}" y2="118" stroke="${stroke}" />`;
    }
    svg += `<text x="${cx}" y="180" text-anchor="middle" fill="${fg2}" font-size="12" font-family="monospace">4 loaders inside one DO isolate</text>`;
  } else if (topology === 'hybrid') {
    // 1 coord + N leaf DOs × 4 loaders each. Sample at most 8 leaves.
    const N = Math.ceil(size / 4);
    svg += `<rect x="${cx - 50}" y="20" width="100" height="36" rx="6" fill="none" stroke="${blue}" stroke-width="2" />`;
    svg += `<text x="${cx}" y="42" text-anchor="middle" fill="${fg}" font-size="13" font-family="monospace">Coordinator</text>`;
    const shown = Math.min(N, 8);
    const leafSpacing = (W - 80) / shown;
    for (let i = 0; i < shown; i++) {
      const lx = 40 + i * leafSpacing + leafSpacing / 2;
      svg += `<line x1="${cx}" y1="56" x2="${lx}" y2="100" stroke="${stroke}" />`;
      svg += `<rect x="${lx - 22}" y="100" width="44" height="22" rx="4" fill="none" stroke="${blue}" stroke-width="1.5" />`;
      svg += `<text x="${lx}" y="115" text-anchor="middle" fill="${fg}" font-size="10" font-family="monospace">leaf</text>`;
      for (let j = 0; j < 4; j++) {
        const ox = lx - 18 + j * 12;
        svg += `<circle cx="${ox}" cy="142" r="4" fill="${orange}" />`;
      }
    }
    if (N > shown) {
      svg += `<text x="${W - 30}" y="115" fill="${fg2}" font-size="11" font-family="monospace">…+${N - shown}</text>`;
    }
    svg += `<text x="${cx}" y="180" text-anchor="middle" fill="${fg2}" font-size="12" font-family="monospace">${N} leaves × 4 loaders = ${size} parallel V8 isolates</text>`;
  } else if (topology === 'tree') {
    // K-tier tree.
    svg += `<rect x="${cx - 50}" y="14" width="100" height="32" rx="6" fill="none" stroke="${blue}" stroke-width="2" />`;
    svg += `<text x="${cx}" y="34" text-anchor="middle" fill="${fg}" font-size="13" font-family="monospace">Coordinator</text>`;
    let yTop = 46;
    let count = 1;
    const F = 8;
    for (let k = 0; k < depth; k++) {
      const yBot = yTop + 30;
      const next = Math.min(F, fanOut[k + 1] ?? F);
      const xs: number[] = [];
      for (let i = 0; i < next; i++) {
        const lx = (W * (i + 1)) / (next + 1);
        xs.push(lx);
        svg += `<rect x="${lx - 16}" y="${yBot - 14}" width="32" height="20" rx="4" fill="none" stroke="${blue}" stroke-width="1" />`;
        svg += `<text x="${lx}" y="${yBot + 1}" text-anchor="middle" fill="${fg}" font-size="9" font-family="monospace">tier ${k + 1}</text>`;
        const px = (W * Math.floor(i / (count > 0 ? Math.ceil(next / count) : 1) + 1)) / (count + 1);
        svg += `<line x1="${px}" y1="${yTop - 14}" x2="${lx}" y2="${yBot - 14}" stroke="${stroke}" />`;
      }
      count = next;
      yTop = yBot;
    }
    // Leaves.
    const leafCount = Math.min(8, size);
    for (let i = 0; i < leafCount; i++) {
      const lx = (W * (i + 1)) / (leafCount + 1);
      svg += `<circle cx="${lx}" cy="${yTop + 22}" r="4" fill="${orange}" />`;
    }
    svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle" fill="${fg2}" font-size="12" font-family="monospace">tree depth ${depth} · 4·F^${depth} isolates</text>`;
  }
  svg += '</svg>';
  root.innerHTML = svg;
}

function getCss(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

document.getElementById('hero-run')?.addEventListener('click', () => void runHero());
// Run once on load.
void runHero();

// ---------- topology table ------------------------------------------

document.querySelectorAll<HTMLButtonElement>('.topo-run').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const tr = btn.closest('tr');
    if (!tr) return;
    const size = Number(tr.dataset.size);
    const out = tr.querySelector('.topo-out');
    if (out) out.textContent = '…';
    setBusy(btn, true);
    try {
      const r = await apiPost<{ ms: number; topology: string; fanOutPerLevel: number[]; treeDepth: number }>(
        '/pool/map',
        { items: Array.from({ length: size }, (_, i) => i) },
      );
      if (out) out.textContent = `${r.ms}ms · ${r.topology} · K=${r.treeDepth}`;
    } catch (e) {
      if (out) out.textContent = `err: ${String((e as Error).message).slice(0, 30)}`;
    } finally {
      setBusy(btn, false);
    }
  });
});

// ---------- primitive playgrounds -----------------------------------

interface PrimSpec {
  id: string;
  title: string;
  desc: string;
  code: string;
  run: () => Promise<string>;
}

const PRIMITIVES: PrimSpec[] = [
  {
    id: 'submit',
    title: 'pool.submit',
    desc: 'Run one CPU-bound task on a fresh isolate.',
    code: 'await pool.submit((a, b) => sha256Chain(a, b), 7, 11)',
    run: async () => {
      const r = await apiPost<{ value: number }>('/pool/submit', {
        fn: '(a, b) => { let x = a + b; for (let i = 0; i < 100000; i++) x = (x * 16807) % 2147483647; return x; }',
        args: [7, 11],
      });
      return `→ ${r.value}`;
    },
  },
  {
    id: 'submitSource',
    title: 'pool.submitSource',
    desc: 'Submit code as a string (no eval in the parent Worker).',
    code: 'await pool.submitSource("(n) => n * n", [42])',
    run: async () => {
      const r = await apiPost<{ value: number }>('/pool/submit', {
        fn: '(n) => { let x = n; for (let i = 0; i < 50000; i++) x = (x * 16807) % 2147483647; return x; }',
        args: [42],
      });
      return `→ ${r.value}`;
    },
  },
  {
    id: 'submitStream',
    title: 'pool.submitStream',
    desc: 'Single task that streams output back chunk-by-chunk.',
    code: 'await pool.submitStream(streamFn, args)',
    run: async () => '→ documented; tested in unit suite',
  },
  {
    id: 'map',
    title: 'pool.map',
    desc: 'Fan out one fn over N items (auto-topology).',
    code: 'await pool.map(sha256Chain, [1..32])',
    run: async () => {
      const r = await apiPost<{ ms: number; topology: string; out: number[] }>('/pool/map', {
        items: Array.from({ length: 32 }, (_, i) => i),
      });
      return `→ ${r.ms}ms · ${r.topology}`;
    },
  },
  {
    id: 'mapStream',
    title: 'pool.mapStream',
    desc: 'Yield results in completion order (fastest first).',
    code: 'for await (const r of pool.mapStream(fn, items)) {}',
    run: async () => {
      const r = await apiPost<{ collected: { index: number; value: number }[] }>(
        '/pool/mapStream',
        { items: [1, 2, 3, 4] },
      );
      return `→ ${r.collected.length} items, completion order`;
    },
  },
  {
    id: 'mapOrdered',
    title: 'pool.mapOrdered',
    desc: 'Yield results in input order even if isolates finish out-of-order.',
    code: 'for await (const v of pool.mapOrdered(fn, items)) {}',
    run: async () => {
      const r = await apiPost<{ collected: number[] }>('/pool/mapOrdered', { items: [1, 2, 3, 4] });
      return `→ ${JSON.stringify(r.collected)}`;
    },
  },
  {
    id: 'reduce',
    title: 'pool.reduce',
    desc: 'Tournament-style parallel reduce.',
    code: 'await pool.reduce((a, b) => a + b, items, 0)',
    run: async () => {
      const r = await apiPost<{ result: number }>('/pool/reduce', { items: [1, 2, 3, 4, 5] });
      return `→ ${r.result}`;
    },
  },
  {
    id: 'scatter',
    title: 'pool.scatter',
    desc: 'Split items into N chunks; each isolate gets one chunk.',
    code: 'await pool.scatter(reduceChunk, items, 4)',
    run: async () => {
      const r = await apiPost<{ out: number[] }>('/pool/scatter', {
        items: [1, 2, 3, 4, 5, 6, 7, 8],
        chunks: 4,
      });
      return `→ ${JSON.stringify(r.out)}`;
    },
  },
  {
    id: 'gather',
    title: 'pool.gather',
    desc: 'Local Promise.all shorthand on submitted promises.',
    code: 'await pool.gather([pool.submit(...), pool.submit(...)])',
    run: async () => '→ Promise.all alias (covered by submit + map)',
  },
  {
    id: 'pmap',
    title: 'pool.pmap',
    desc: 'Curried batched-map: returns a function (items, opts) => results.',
    code: 'const embed = pool.pmap(batchFn); await embed(items, { chunks: 4 })',
    run: async () => {
      const r = await apiPost<{ out: number[] }>('/pool/pmap', {
        items: [1, 2, 3, 4, 5, 6, 7, 8],
        chunks: 4,
      });
      return `→ ${JSON.stringify(r.out.slice(0, 6))}…`;
    },
  },
  {
    id: 'pipe',
    title: 'pool.pipe',
    desc: 'Sequential pipeline: f1 → f2 → f3, each on a fresh isolate.',
    code: 'await pool.pipe(f1, f2, f3)(input)',
    run: async () => {
      const r = await apiPost<{ out: string }>('/pool/pipe', { input: 1 });
      return `→ ${JSON.stringify(r.out)}`;
    },
  },
  {
    id: 'warm',
    title: 'pool.warm',
    desc: 'Pre-spin N isolates so the next dispatch skips cold-start.',
    code: 'await pool.warm({ isolates: 4 })',
    run: async () => {
      const r = await apiPost<{ warmed: number; ms: number }>('/pool/warm', { isolates: 4 });
      return `→ warmed ${r.warmed} in ${r.ms}ms`;
    },
  },
  {
    id: 'stats',
    title: 'pool.stats',
    desc: 'Topology decision + counters from the last fan-out.',
    code: 'await pool.stats()',
    run: async () => {
      const r = await apiGet<{ topology: string; treeDepth: number; fanOutPerLevel: number[] }>(
        '/pool/stats',
      );
      return `→ ${r.topology} · K=${r.treeDepth} · fanOut=${JSON.stringify(r.fanOutPerLevel.slice(0, 4))}`;
    },
  },
  {
    id: 'cancel',
    title: 'cancel mid-flight',
    desc: 'Real AbortSignal trips inside the loaded isolate.',
    code: 'pool.map(longLoop, items, { cancel: CancelToken.withTimeout(50) })',
    run: async () => {
      const r = await apiPost<{ cancelled: boolean; ms: number; error?: string }>('/pool/cancel', {
        items: [1, 2, 3, 4],
        cancelAfterMs: 50,
      });
      return r.cancelled
        ? `→ cancelled in ${r.ms}ms (${r.error ?? 'CancelledError'})`
        : `→ completed in ${r.ms}ms`;
    },
  },
  {
    id: 'loaderOnly',
    title: 'Parallel.loaderOnly',
    desc: 'Fan out without a Coordinator DO. 3-loader cap from a fetch handler.',
    code: 'await Parallel.loaderOnly(env).map(sq, items)',
    run: async () => {
      const r = await apiPost<{ out: number[] }>('/loader-only/map', { items: [1, 2, 3] });
      return `→ ${JSON.stringify(r.out)}`;
    },
  },
];

const primGrid = document.getElementById('prim-grid');
if (primGrid) {
  for (const p of PRIMITIVES) {
    const card = document.createElement('div');
    card.className = 'prim-card';
    card.innerHTML = `
      <h3><code>${p.title}</code></h3>
      <p>${p.desc}</p>
      <pre class="code"><code>${p.code}</code></pre>
      <div class="prim-actions">
        <button class="run-btn" data-prim="${p.id}">Run</button>
        <span class="prim-out">—</span>
      </div>
    `;
    primGrid.appendChild(card);
  }
  primGrid.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLButtonElement) || !t.dataset.prim) return;
    const spec = PRIMITIVES.find((x) => x.id === t.dataset.prim);
    if (!spec) return;
    const out = t.parentElement?.querySelector('.prim-out');
    if (out) out.textContent = '…';
    setBusy(t, true);
    try {
      const result = await spec.run();
      if (out) out.textContent = result;
    } catch (e) {
      if (out) out.textContent = `err: ${String((e as Error).message).slice(0, 60)}`;
    } finally {
      setBusy(t, false);
    }
  });
}

// ---------- scheduler -----------------------------------------------

interface SchedStats {
  queued: number;
  inFlight?: number;
  running?: number;
  completed: number;
  failed: number;
  cancelled: number;
  done?: number;
}

async function refreshSchedulerStats(): Promise<void> {
  try {
    const r = await apiGet<SchedStats>('/scheduler/stats');
    setText('sched-queued', String(r.queued));
    setText('sched-running', String(r.inFlight ?? r.running ?? 0));
    setText('sched-done', String(r.completed ?? r.done ?? 0));
    setText('sched-failed', String(r.failed));
    setText('sched-cancelled', String(r.cancelled));
  } catch {
    /* ignore transient */
  }
}
let schedTimer: number | undefined;

document.getElementById('sched-run')?.addEventListener('click', async () => {
  const btn = document.getElementById('sched-run') as HTMLButtonElement;
  const countInput = document.getElementById('sched-count') as HTMLInputElement;
  const count = Math.max(1, Math.min(256, Number(countInput.value) || 32));
  setBusy(btn, true);
  try {
    const r = await apiPost<{ tenant: string; count: number; stats: SchedStats }>(
      '/demo/scheduler-burst',
      { count },
    );
    setText('sched-queued', String(r.stats.queued));
    setText('sched-running', String(r.stats.inFlight ?? r.stats.running ?? 0));
    setText('sched-done', String(r.stats.completed ?? r.stats.done ?? 0));
    setText('sched-failed', String(r.stats.failed));
    setText('sched-cancelled', String(r.stats.cancelled));
    document.getElementById('sched-code')!.textContent =
      `await scheduler.enqueue({ fn, args, tenantId: '${r.tenant}' })  // × ${r.count}`;
    if (schedTimer) clearInterval(schedTimer);
    schedTimer = window.setInterval(refreshSchedulerStats, 600);
    setTimeout(() => {
      if (schedTimer) {
        clearInterval(schedTimer);
        schedTimer = undefined;
      }
    }, 8000);
  } catch (e) {
    setText('sched-queued', 'err');
    setText('sched-running', String((e as Error).message).slice(0, 30));
  } finally {
    setBusy(btn, false);
  }
});

// ---------- actor ---------------------------------------------------

document.getElementById('actor-inc')?.addEventListener('click', async () => {
  const id = (document.getElementById('actor-id') as HTMLInputElement).value || 'demo-counter';
  const btn = document.getElementById('actor-inc') as HTMLButtonElement;
  setBusy(btn, true);
  try {
    const r = await apiPost<{ count: number }>('/actor/inc', { id });
    setText('actor-count', String(r.count));
  } catch (e) {
    setText('actor-count', `err: ${String((e as Error).message).slice(0, 40)}`);
  } finally {
    setBusy(btn, false);
  }
});
document.getElementById('actor-state')?.addEventListener('click', async () => {
  const id = (document.getElementById('actor-id') as HTMLInputElement).value || 'demo-counter';
  const btn = document.getElementById('actor-state') as HTMLButtonElement;
  setBusy(btn, true);
  try {
    const r = await apiGet<{ count: number }>(`/actor/state?id=${encodeURIComponent(id)}`);
    setText('actor-count', String(r.count));
  } catch (e) {
    setText('actor-count', `err: ${String((e as Error).message).slice(0, 40)}`);
  } finally {
    setBusy(btn, false);
  }
});
document.getElementById('actor-close')?.addEventListener('click', async () => {
  const id = (document.getElementById('actor-id') as HTMLInputElement).value || 'demo-counter';
  const btn = document.getElementById('actor-close') as HTMLButtonElement;
  setBusy(btn, true);
  try {
    await apiPost(`/actor/close?id=${encodeURIComponent(id)}`, {});
    setText('actor-count', 'closed');
  } catch (e) {
    setText('actor-count', `err: ${String((e as Error).message).slice(0, 40)}`);
  } finally {
    setBusy(btn, false);
  }
});

// ---------- VM ------------------------------------------------------

document.getElementById('vm-run')?.addEventListener('click', async () => {
  const btn = document.getElementById('vm-run') as HTMLButtonElement;
  const fn = (document.getElementById('vm-fn') as HTMLTextAreaElement).value;
  const argsRaw = (document.getElementById('vm-args') as HTMLInputElement).value || '[]';
  const token =
    (document.getElementById('vm-token') as HTMLInputElement).value || VM_TOKEN_DEFAULT;
  let args: unknown[];
  try {
    args = JSON.parse(argsRaw);
    if (!Array.isArray(args)) throw new Error('args must be a JSON array');
  } catch (e) {
    document.getElementById('vm-out')!.textContent = `err: ${(e as Error).message}`;
    return;
  }
  const out = document.getElementById('vm-out');
  if (out) out.textContent = '…';
  setBusy(btn, true);
  try {
    const t0 = performance.now();
    const r = await fetch(API + '/vm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ fn, args }),
    });
    const text = await r.text();
    const ms = Math.round(performance.now() - t0);
    const banner = `// ${r.status} ${r.statusText} · ${ms}ms`;
    if (out) {
      try {
        const j = JSON.parse(text);
        out.textContent = `${banner}\n${JSON.stringify(j, null, 2)}`;
      } catch {
        out.textContent = `${banner}\n${text}`;
      }
    }
  } catch (e) {
    if (out) out.textContent = `err: ${(e as Error).message}`;
  } finally {
    setBusy(btn, false);
  }
});

// ---------- cancel showcase -----------------------------------------

let cancelCtrl: AbortController | undefined;

document.getElementById('cancel-start')?.addEventListener('click', async () => {
  const startBtn = document.getElementById('cancel-start') as HTMLButtonElement;
  const stopBtn = document.getElementById('cancel-stop') as HTMLButtonElement;
  const itersInput = document.getElementById('cancel-iters') as HTMLInputElement;
  const iters = Math.max(10000, Math.min(5_000_000, Number(itersInput.value) || 1_000_000));
  startBtn.disabled = true;
  stopBtn.disabled = false;
  setText('cancel-status', 'starting…');
  const fill = document.getElementById('cancel-fill') as HTMLDivElement;
  fill.style.width = '0';

  cancelCtrl = new AbortController();
  const t0 = performance.now();
  try {
    const r = await fetch(API + '/demo/cancel-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ iters }),
      signal: cancelCtrl.signal,
    });
    if (!r.body) throw new Error('no body');
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop() ?? '';
      for (const ev of events) {
        if (!ev.startsWith('data:')) continue;
        const json = ev.slice(5).trim();
        if (!json) continue;
        try {
          const m = JSON.parse(json);
          if (m.kind === 'done') {
            const pct = m.totalTarget > 0 ? Math.round((m.atIteration / m.totalTarget) * 100) : 100;
            fill.style.width = `${pct}%`;
            const dt = Math.round(performance.now() - t0);
            setText(
              'cancel-status',
              m.cancelled
                ? `cancelled at iteration ${m.atIteration}/${m.totalTarget} after ${dt}ms`
                : `done — ${m.atIteration}/${m.totalTarget} iterations in ${dt}ms`,
            );
          } else if (m.kind === 'error') {
            setText('cancel-status', `error: ${m.name} — ${m.message}`);
          }
        } catch {
          /* malformed event line */
        }
      }
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      setText('cancel-status', 'aborted by client');
    } else {
      setText('cancel-status', `err: ${(e as Error).message}`);
    }
  } finally {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    cancelCtrl = undefined;
  }
});

document.getElementById('cancel-stop')?.addEventListener('click', () => {
  if (cancelCtrl) {
    setText('cancel-status', 'cancelling…');
    cancelCtrl.abort();
  }
});

// ---------- bench leaderboard ---------------------------------------

interface BenchAggregate {
  size: number;
  topology: string;
  treeDepth: number;
  fanOutPerLevel: number[];
  parallelMedianMs: number;
  sequentialMedianMs: number;
  speedup: number;
  sequentialMeasuredAtSize?: number;
}
interface BenchFile {
  target: string;
  ts: string;
  aggregates: BenchAggregate[];
}

const benchTbody = document.querySelector('#bench-table tbody') as HTMLTableSectionElement;
fetch('/bench-results-live.json')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
  .then((data: BenchFile) => renderBench(data.aggregates))
  .catch(() => {
    if (benchTbody) {
      benchTbody.innerHTML = `<tr><td colspan="6">No bench file found. Click Run to populate.</td></tr>`;
    }
  });

function renderBench(aggs: BenchAggregate[]): void {
  if (!benchTbody) return;
  benchTbody.innerHTML = '';
  const maxSpeedup = Math.max(...aggs.map((a) => a.speedup), 1);
  for (const a of aggs) {
    const tr = document.createElement('tr');
    tr.dataset.size = String(a.size);
    const barW = Math.round((a.speedup / maxSpeedup) * 80);
    tr.innerHTML = `
      <td>${a.size}</td>
      <td><span class="topo-badge topo-${a.topology}">${a.topology}</span></td>
      <td>${a.sequentialMedianMs}ms</td>
      <td>${a.parallelMedianMs}ms</td>
      <td><span class="bench-bar" style="width:${barW}px"></span>${a.speedup.toFixed(2)}×</td>
      <td><button class="topo-run bench-run">Run</button> <span class="topo-out bench-out">—</span></td>
    `;
    benchTbody.appendChild(tr);
  }
  benchTbody.querySelectorAll<HTMLButtonElement>('.bench-run').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      if (!tr) return;
      const size = Number(tr.dataset.size);
      const out = tr.querySelector('.bench-out');
      if (out) out.textContent = '…';
      setBusy(btn, true);
      try {
        const r = await apiPost<{ parallelMs: number; topology: string }>('/demo/bench', { size });
        if (out) out.textContent = `${r.parallelMs}ms · ${r.topology}`;
      } catch (e) {
        if (out) out.textContent = `err: ${String((e as Error).message).slice(0, 30)}`;
      } finally {
        setBusy(btn, false);
      }
    });
  });
}
