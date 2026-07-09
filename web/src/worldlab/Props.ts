/**
 * WORLDLAB stage-3 props — per-region instanced, architected instanced-first.
 *
 * Props NEVER exist as individual scene meshes. Decoration emits (type,
 * transform, bakedLight) records per column; this class buckets columns into
 * REGIONS (4×4 columns) and draws each region's props as one InstancedMesh
 * per type. Draw cost = regions × types present, not prop count — measured
 * headroom (35 draws, 0.5ms submit at R=6) is what buys this cullable,
 * per-region design over one global pool.
 *
 * Lighting: each instance carries the baked flood-light level sampled at its
 * position when its column meshed (iLight attribute), so props sit in grove
 * light pools correctly in DARK mode; emissive parts (shroom caps) glow on
 * their own via a per-vertex `aem` flag.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const enum PropType {
  Glowshroom = 0,
  Rock = 1,
  Grass = 2,
  /** Drifting emissive spore-mote — the Reek's "glowing air". */
  Mote = 3,
}

export interface PropRecord {
  t: PropType;
  x: number;
  y: number;
  z: number;
  /** Uniform scale. */
  s: number;
  /** Yaw, radians. */
  r: number;
  /** Baked flood light 0..1 at the prop's position (filled at mesh time). */
  light: number;
}

const REGION = 4; // columns per region side

/** Stamp albedo + emissive-strength (+ drift-bob flag) onto a primitive. */
function paint(geo: THREE.BufferGeometry, color: [number, number, number], em: number, bob = 0): THREE.BufferGeometry {
  const n = geo.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  const aem = new Float32Array(n);
  const abob = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    colors.set(color, i * 3);
    aem[i] = em;
    abob[i] = bob;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aem', new THREE.BufferAttribute(aem, 1));
  geo.setAttribute('abob', new THREE.BufferAttribute(abob, 1));
  return geo;
}

function buildTypeGeometries(): THREE.BufferGeometry[] {
  // Glowshroom: pale stalk + emissive teal cap.
  const stalk = paint(new THREE.CylinderGeometry(0.1, 0.17, 0.9, 5), [0.72, 0.68, 0.55], 0).translate(0, 0.45, 0);
  const cap = paint(new THREE.SphereGeometry(0.42, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2), [0.3, 0.95, 0.7], 1)
    .scale(1, 0.62, 1)
    .translate(0, 0.88, 0);
  const shroom = mergeGeometries([stalk, cap], false);

  // Rock: squashed icosahedron.
  const rock = paint(new THREE.IcosahedronGeometry(0.45, 0), [0.4, 0.41, 0.46], 0).scale(1, 0.72, 1).translate(0, 0.3, 0);

  // Grass tuft: two crossed quads (material renders DoubleSide).
  const g1 = paint(new THREE.PlaneGeometry(0.7, 0.55), [0.24, 0.48, 0.28], 0).translate(0, 0.27, 0);
  const g2 = g1.clone().rotateY(Math.PI / 2);
  const grass = mergeGeometries([g1, g2], false);

  // Spore-mote: tiny emissive octahedron, drift-bobbed in the vertex shader.
  const mote = paint(new THREE.OctahedronGeometry(0.1, 0), [0.55, 1.0, 0.8], 1, 1);

  return [shroom, rock, grass, mote];
}

/** Shares the lab's uniform OBJECTS (uDark/uOrbPos/fog/sun) so day/night/fog
 *  stay in sync with the terrain shader automatically. */
export function createPropMaterial(uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexColors: true,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute float aem;
      attribute float abob;
      attribute float iLight;
      varying vec3 vColor;
      varying float vAem;
      varying float vLight;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying float vDist;
      void main() {
        vColor = color;
        vAem = aem;
        vLight = iLight;
        vNormal = normalize(mat3(instanceMatrix) * normal);
        vec4 w = instanceMatrix * vec4(position, 1.0);
        // Spore-drift: emitters wander gently; phase from world position so
        // every mote moves differently with zero per-instance data.
        w.y   += abob * sin(uTime * 0.9 + w.x * 0.7 + w.z * 1.3) * 0.5;
        w.x   += abob * sin(uTime * 0.6 + w.z * 0.9) * 0.35;
        vWorld = w.xyz;
        vec4 mv = viewMatrix * w;
        vDist = length(mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 fogColor;
      uniform float fogDensity;
      uniform vec3 sunDir;
      uniform float uDark;
      uniform vec3 uOrbPos;
      varying vec3 vColor;
      varying float vAem;
      varying float vLight;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying float vDist;
      void main() {
        vec3 n = normalize(vNormal);
        float sun = clamp(abs(dot(n, sunDir)), 0.0, 1.0); // abs: thin quads lit both sides
        float sky = 0.5 + 0.5 * n.y;
        vec3 day = vColor * (0.4 + 0.45 * sun + 0.3 * sky);
        float bubble = clamp(1.0 - length(vWorld - uOrbPos) / 14.0, 0.0, 1.0);
        vec3 night = vColor * (vLight * sqrt(vLight) * 1.5 + bubble * bubble * 1.1 + 0.015);
        night += vColor * vAem * 0.85; // emissive caps glow on their own
        vec3 col = mix(day + vColor * vAem * 0.35, night, uDark);
        float f = 1.0 - exp(-fogDensity * fogDensity * vDist * vDist);
        gl_FragColor = vec4(mix(col, fogColor, clamp(f, 0.0, 1.0)), 1.0);
      }
    `,
  });
}

interface Region {
  /** Live prop records per column key. */
  columns: Map<string, PropRecord[]>;
  meshes: THREE.InstancedMesh[];
  dirty: boolean;
}

export class InstancedProps {
  readonly group = new THREE.Group();
  private readonly geos = buildTypeGeometries();
  private readonly regions = new Map<string, Region>();
  private readonly colToRegion = new Map<string, string>();
  instances = 0;
  pools = 0;

  constructor(private readonly material: THREE.ShaderMaterial) {}

  /** Column meshed → its props become visible. */
  setColumn(cx: number, cz: number, recs: PropRecord[]): void {
    const rKey = `${Math.floor(cx / REGION)},${Math.floor(cz / REGION)}`;
    const cKey = `${cx},${cz}`;
    let region = this.regions.get(rKey);
    if (!region) {
      region = { columns: new Map(), meshes: [], dirty: false };
      this.regions.set(rKey, region);
    }
    region.columns.set(cKey, recs);
    region.dirty = true;
    this.colToRegion.set(cKey, rKey);
  }

  /** Column trimmed/unloaded → its props go with it. */
  clearColumn(cx: number, cz: number): void {
    const cKey = `${cx},${cz}`;
    const rKey = this.colToRegion.get(cKey);
    if (!rKey) return;
    this.colToRegion.delete(cKey);
    const region = this.regions.get(rKey);
    if (!region) return;
    region.columns.delete(cKey);
    region.dirty = true;
  }

  /** Rebuild dirty regions. Cheap (typed-array fills), called once per frame. */
  update(): void {
    for (const [rKey, region] of this.regions) {
      if (!region.dirty) continue;
      region.dirty = false;
      for (const m of region.meshes) {
        this.group.remove(m);
        m.dispose(); // InstancedMesh.dispose frees the instance buffers
      }
      region.meshes.length = 0;
      if (region.columns.size === 0) {
        this.regions.delete(rKey);
        continue;
      }
      // Bucket records by type, then one InstancedMesh per type present.
      const byType: PropRecord[][] = [[], [], [], []];
      for (const recs of region.columns.values()) for (const r of recs) byType[r.t].push(r);
      const mat4 = new THREE.Matrix4();
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      const UP = new THREE.Vector3(0, 1, 0);
      for (let t = 0; t < byType.length; t++) {
        const recs = byType[t];
        if (!recs.length) continue;
        const mesh = new THREE.InstancedMesh(this.geos[t], this.material, recs.length);
        const iLight = new Float32Array(recs.length);
        for (let i = 0; i < recs.length; i++) {
          const r = recs[i];
          pos.set(r.x, r.y, r.z);
          quat.setFromAxisAngle(UP, r.r);
          scl.setScalar(r.s);
          mesh.setMatrixAt(i, mat4.compose(pos, quat, scl));
          iLight[i] = r.light;
        }
        mesh.instanceMatrix.needsUpdate = true;
        // Per-instance light lives on the geometry in three, and the base
        // geometry is shared across regions — so wrap it in a shallow copy
        // that shares every base attribute and adds this region's iLight.
        const geo = new THREE.BufferGeometry();
        geo.setIndex(this.geos[t].getIndex());
        for (const [name, attr] of Object.entries(this.geos[t].attributes)) geo.setAttribute(name, attr);
        geo.setAttribute('iLight', new THREE.InstancedBufferAttribute(iLight, 1));
        mesh.geometry = geo;
        // Instances are placed in world space; region bounds ≠ geometry
        // bounds, so skip frustum culling (draw headroom covers it).
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
        region.meshes.push(mesh);
      }
    }
    let count = 0;
    let pools = 0;
    for (const region of this.regions.values()) {
      pools += region.meshes.length;
      for (const m of region.meshes) count += m.count;
    }
    this.instances = count;
    this.pools = pools;
  }
}
