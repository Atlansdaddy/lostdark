#!/usr/bin/env node
/**
 * meshy-gen — generate a game-ready GLB from a text prompt via the Meshy
 * Text-to-3D API and drop it straight into the flora asset folder.
 *
 * Usage:
 *   node scripts/meshy-gen.mjs "giant glowing toadstool" [outName] [flags]
 *
 * Flags:
 *   --preview-only        stop after the fast untextured preview (cheaper)
 *   --art-style <s>       "realistic" (default) | "sculpture"
 *   --polycount <n>       target triangle count (default 30000)
 *   --neg "<text>"        negative prompt
 *
 * The key is read from waiver/.env.local (MESHY_API_KEY=...), which is
 * gitignored. Nothing here is bundled into the web app — this is an offline
 * asset pipeline only.
 *
 * On success the GLB lands in web/public/assets/flora/<outName>.glb and the
 * script prints the manifest line to paste into web/src/world/FloraAssets.ts.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'web/public/assets/flora');
const API = 'https://api.meshy.ai/openapi/v2/text-to-3d';

// --- tiny .env.local reader (no dependency) -------------------------------
function loadKey() {
  if (process.env.MESHY_API_KEY) return process.env.MESHY_API_KEY.trim();
  try {
    const env = readFileSync(resolve(ROOT, '.env.local'), 'utf8');
    const line = env.split(/\r?\n/).find((l) => l.startsWith('MESHY_API_KEY='));
    const val = line?.slice('MESHY_API_KEY='.length).trim();
    if (val) return val;
  } catch {
    /* fall through to the error below */
  }
  console.error('✗ MESHY_API_KEY not found. Put it in waiver/.env.local as MESHY_API_KEY=...');
  process.exit(1);
}

// --- arg parsing ----------------------------------------------------------
function parseArgs(argv) {
  const positional = [];
  const opts = { artStyle: 'realistic', polycount: 30000, previewOnly: false, neg: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--preview-only') opts.previewOnly = true;
    else if (a === '--art-style') opts.artStyle = argv[++i];
    else if (a === '--polycount') opts.polycount = Number(argv[++i]);
    else if (a === '--neg') opts.neg = argv[++i];
    else positional.push(a);
  }
  opts.prompt = positional[0];
  opts.name =
    positional[1] ||
    (positional[0] || 'asset')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);
  return opts;
}

const KEY = loadKey();
const HEADERS = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createTask(body) {
  const res = await fetch(API, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`create ${body.mode} failed ${res.status}: ${text}`);
  const data = JSON.parse(text);
  const id = data.result ?? data.id;
  if (!id) throw new Error(`no task id in response: ${text}`);
  return id;
}

async function pollTask(id, label) {
  const started = Date.now();
  let lastPct = -1;
  for (;;) {
    const res = await fetch(`${API}/${id}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`poll failed ${res.status}: ${await res.text()}`);
    const t = await res.json();
    if (t.progress !== lastPct) {
      lastPct = t.progress;
      process.stdout.write(`\r  ${label}: ${t.status} ${t.progress ?? 0}%   `);
    }
    if (t.status === 'SUCCEEDED') {
      process.stdout.write('\n');
      return t;
    }
    if (t.status === 'FAILED' || t.status === 'CANCELED') {
      throw new Error(`${label} ${t.status}: ${t.task_error?.message ?? JSON.stringify(t.task_error)}`);
    }
    if (Date.now() - started > 15 * 60 * 1000) throw new Error(`${label} timed out after 15min`);
    await sleep(5000);
  }
}

async function download(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const magic = buf.subarray(0, 4).toString('ascii');
  if (magic !== 'glTF') throw new Error(`downloaded file is not a GLB (magic='${magic}')`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buf);
  return buf.length;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.prompt) {
    console.error('Usage: node scripts/meshy-gen.mjs "<prompt>" [outName] [--preview-only] [--art-style realistic|sculpture] [--polycount N] [--neg "<text>"]');
    process.exit(1);
  }
  console.log(`▶ prompt: "${opts.prompt}"  → ${opts.name}.glb  (style=${opts.artStyle}, ${opts.previewOnly ? 'preview only' : 'preview+refine'})`);

  // 1) Preview: fast, untextured base mesh.
  const previewBody = {
    mode: 'preview',
    prompt: opts.prompt,
    art_style: opts.artStyle,
    should_remesh: true,
    target_polycount: opts.polycount,
    topology: 'triangle',
  };
  if (opts.neg) previewBody.negative_prompt = opts.neg;
  console.log('① creating preview task…');
  const previewId = await createTask(previewBody);
  let task = await pollTask(previewId, 'preview');

  // 2) Refine: adds textures (the maps our loader expects). Skippable.
  let refineId = null;
  if (!opts.previewOnly) {
    console.log('② creating refine task (textures)…');
    refineId = await createTask({ mode: 'refine', preview_task_id: previewId });
    task = await pollTask(refineId, 'refine');
  }

  const glbUrl = task.model_urls?.glb;
  if (!glbUrl) throw new Error(`no GLB url in result: ${JSON.stringify(task.model_urls)}`);
  const outPath = resolve(OUT_DIR, `${opts.name}.glb`);
  console.log('③ downloading GLB…');
  const bytes = await download(glbUrl, outPath);
  console.log(`✓ saved ${outPath} (${(bytes / 1024).toFixed(1)} KB)`);

  // Persist the Meshy task ids + a backup of the original GLB so this generation
  // can be re-downloaded, remeshed, retextured, or reuploaded later (task ids are
  // the durable handle even after the download URL expires).
  try {
    const manifestPath = resolve(ROOT, 'meshy_assets/manifest.json');
    const m = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { assets: [] };
    if (!Array.isArray(m.assets)) m.assets = [];
    const relFile = `web/public/assets/flora/${opts.name}.glb`;
    const entry = {
      file: relFile,
      original: `meshy_assets/originals/${opts.name}.glb`,
      kind: 'flora',
      prompt: opts.prompt,
      refineTaskId: refineId,
      previewTaskId: previewId,
      createdAt: Date.now(),
    };
    const i = m.assets.findIndex((a) => a.file === relFile);
    if (i >= 0) m.assets[i] = entry;
    else m.assets.push(entry);
    writeFileSync(manifestPath, JSON.stringify(m, null, 2));
    mkdirSync(resolve(ROOT, 'meshy_assets/originals'), { recursive: true });
    copyFileSync(outPath, resolve(ROOT, 'meshy_assets/originals', `${opts.name}.glb`));
    console.log('✓ recorded task ids in meshy_assets/manifest.json + backed up original');
  } catch (e) {
    console.log(`  (could not record manifest: ${e.message})`);
  }

  console.log('\nAdd to web/src/world/FloraAssets.ts FLORA_MANIFEST:');
  console.log(`  ${opts.name}: '${opts.name}.glb',`);
  console.log('…and to DEFAULT_HEIGHT (units). Mushroom names auto-join the phosphorescence if they contain "mushroom"/"shroom".');
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
});
