#!/usr/bin/env node
/**
 * One-button waiver-labs deploy → https://waiver-labs.john-d70.workers.dev
 *
 *   vite build → hub becomes the site root → wrangler deploy
 *
 * · No tsc gate on purpose: this ships exactly what the dev server runs.
 *   `npm run typecheck` is the separate honesty pass.
 * · dist/ is rerooted for the web: index.html (game) → play.html, and
 *   labs.html (hub) → index.html with its game links + build stamp rewritten.
 *   Safe because vite emits absolute /assets/ URLs — HTML files can move.
 * · On the phone, wrangler needs the slow-network preload from /root/.infra;
 *   on any other machine that path doesn't exist and plain wrangler is fine.
 */
import { execSync } from 'node:child_process';
import { existsSync, renameSync, readFileSync, writeFileSync } from 'node:fs';

const run = (cmd, extraEnv = {}) =>
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...extraEnv } });

run('npx vite build');

renameSync('dist/index.html', 'dist/play.html');
renameSync('dist/labs.html', 'dist/index.html');
const commit = execSync('git rev-parse --short HEAD').toString().trim();
const dirty = execSync('git status --porcelain').toString().trim() ? '+wip' : '';
const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
writeFileSync(
  'dist/index.html',
  readFileSync('dist/index.html', 'utf8')
    .replaceAll('href="/index.html"', 'href="/play.html"')
    .replace('%BUILD%', `${commit}${dirty} · ${when} UTC`),
);

const preload = '/root/.infra/wrangler-net.cjs';
const env = existsSync(preload) ? { NODE_OPTIONS: `--require ${preload}` } : {};
run('npx wrangler@4 deploy', env);
