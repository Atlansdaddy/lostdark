/**
 * Mesh worker — runs the pure mesher core (meshSlabs) off the main thread.
 *
 * The main thread's whole cost is copySlabsFor (~0.3ms) on dispatch and a
 * BufferGeometry wrap on arrival; the ~8-15ms face loop AND its scratch-array
 * garbage live here. This is what turns streamed-chunk meshing from a
 * per-chunk frame spike into background work.
 *
 * Protocol: { key, mats, light, bx, by, bz } in →
 *           { key, arrays? } out (arrays absent = empty chunk), buffers
 *           transferred both ways.
 */

import { meshSlabs, MeshArrays } from './VoxelMesher';

interface MeshRequest {
  key: string;
  mats: Uint8Array;
  light: Uint8Array;
  bx: number;
  by: number;
  bz: number;
}

export interface MeshResponse {
  key: string;
  arrays?: MeshArrays;
}

const post = self.postMessage.bind(self) as (msg: MeshResponse, transfer?: Transferable[]) => void;

self.onmessage = (e: MessageEvent<MeshRequest>) => {
  const { key, mats, light, bx, by, bz } = e.data;
  const a = meshSlabs(mats, light, bx, by, bz);
  if (!a) {
    post({ key });
    return;
  }
  post({ key, arrays: a }, [
    a.positions.buffer,
    a.normals.buffer,
    a.colors.buffer,
    a.alight.buffer,
    a.aao.buffer,
    a.amat.buffer,
    a.indices.buffer,
  ]);
};
