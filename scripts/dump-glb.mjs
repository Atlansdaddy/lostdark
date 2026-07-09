#!/usr/bin/env node
/**
 * dump-glb.mjs — print a GLB's node tree, skin joints and animation clips.
 * No dependencies: reads the JSON chunk straight out of the GLB container.
 *
 *   node scripts/dump-glb.mjs web/public/assets/folk/bluecap.glb
 */
import { readFileSync } from 'node:fs';

for (const file of process.argv.slice(2)) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) {
    console.error(`${file}: not a GLB`);
    continue;
  }
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));

  console.log(`\n=== ${file} ===`);
  const nodes = json.nodes ?? [];

  // Node tree from the scene roots.
  const children = (i) => nodes[i].children ?? [];
  const name = (i) => nodes[i].name ?? `#${i}`;
  const skinJoints = new Set((json.skins ?? []).flatMap((s) => s.joints));
  const tree = (i, depth) => {
    const tag = [
      skinJoints.has(i) ? 'bone' : null,
      nodes[i].mesh !== undefined ? 'mesh' : null,
      nodes[i].skin !== undefined ? 'skinned' : null,
    ]
      .filter(Boolean)
      .join(',');
    console.log(`${'  '.repeat(depth)}${name(i)}${tag ? `  [${tag}]` : ''}`);
    for (const c of children(i)) tree(c, depth + 1);
  };
  for (const scene of json.scenes ?? []) for (const root of scene.nodes ?? []) tree(root, 0);

  for (const [si, skin] of (json.skins ?? []).entries()) {
    console.log(`skin[${si}]: ${skin.joints.length} joints`);
  }
  for (const anim of json.animations ?? []) {
    // Duration = max input accessor bound.
    let dur = 0;
    for (const s of anim.samplers ?? []) {
      const acc = json.accessors[s.input];
      if (acc?.max?.[0] > dur) dur = acc.max[0];
    }
    console.log(`animation "${anim.name}": ${anim.channels.length} channels, ${dur.toFixed(2)}s`);
  }
}
