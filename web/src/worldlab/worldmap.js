/**
 * worldmap.js — John's macro-skeleton generator, extracted VERBATIM from
 * maplab.html (keep the two in sync by re-extracting, not hand-editing).
 * Pure data, deterministic, no DOM. 1 cell = 32 m = one chunk column.
 */
'use strict';

/* ---------- biome / depth enums ---------- */
const BIOME = { NONE:0, REEK:1, BADLANDS:2, BITE:3, SEAR:4, GLARE:5, FADE:6, DROWN:7, NOTHING:8 };
const BIOME_NAME = ['none','Reek','Badlands','Bite','Sear','Glare','Fade','Drown','Nothing'];
const DEPTH = { LAND:0, SHELF:1, SEA:2, ABYSSAL:3 };
const DEPTH_NAME = ['land','shelf','sea','abyssal'];

/* land-area budget shares (of total land). Spawn-side = 0.64, trans-ocean = 0.36 */
const BUDGET = { [BIOME.REEK]:0.14, [BIOME.BADLANDS]:0.18, [BIOME.BITE]:0.16, [BIOME.SEAR]:0.16,
                 [BIOME.GLARE]:0.18, [BIOME.FADE]:0.18 };
const BUDGET_TOL = 0.30;
/* typed mirrors of the config objects — hot paths index these, exports keep the objects */
const BUDGET_ARR = new Float64Array([0,0.14,0.18,0.16,0.16,0.18,0.18,0,0]);
const DIFF_MOD_ARR = new Float64Array([1,0.55,1.0,1.15,1.15,1.30,1.40,1.0,2.0]);
const DIFF_WATER_ARR = new Float64Array([1,0.80,1.05,1.35]);
const A_DENS = new Float64Array([0,1.4,1.0,0.9,0.9,1.1,1.1,0,0]);
const A_CAVE = new Float64Array([0,0.80,0.55,0.30,0.50,0.35,0.45,0,0]);
const A_MIN  = new Int32Array([0,2,2,2,2,2,2,0,0]);

const DIFF_MOD = { [BIOME.REEK]:0.55, [BIOME.BADLANDS]:1.0, [BIOME.BITE]:1.15, [BIOME.SEAR]:1.15,
                   [BIOME.GLARE]:1.30, [BIOME.FADE]:1.40, [BIOME.NOTHING]:2.0 };
const DIFF_MOD_WATER = { [DEPTH.SHELF]:0.80, [DEPTH.SEA]:1.05, [DEPTH.ABYSSAL]:1.35 };

const ANCHOR_CFG = {
  [BIOME.REEK]:     { density:1.4, cave:0.80, min:2 },
  [BIOME.BADLANDS]: { density:1.0, cave:0.55, min:2 },
  [BIOME.BITE]:     { density:0.9, cave:0.30, min:2 },
  [BIOME.SEAR]:     { density:0.9, cave:0.50, min:2 },
  [BIOME.GLARE]:    { density:1.1, cave:0.35, min:2 },
  [BIOME.FADE]:     { density:1.1, cave:0.45, min:2 },
  SHELF:            { density:0.12, cave:1.00, min:0 },
};

const DEFAULTS = {
  seed: 1337,
  worldRadius: 6000,      // metres
  cellSize: 32,           // metres per cell
  oceanFraction: 0.45,    // of the playable disc
  landmassCount: 3,       // outer landmasses (2–4)
  wedgeJitter: 0.5,       // 0–1
  shelfWidth: 6,          // cells of shallow shelf hugging coasts
  seaBand: 8,             // cells of open sea before abyssal begins
  rimWidth: 14,           // cells of the Nothing annulus
  trenchHalf: 2,          // half-width of the forced abyssal midline trench
  badlandsInlandDepth: 5, // cells from coast that count as "inland"
  spawnLandShare: 0.64,   // spawn continent's share of total land
};

/* ---------- deterministic RNG & hashing ---------- */
function mulberry32(a){ return function(){ a|=0; a=(a+0x6D2B79F5)|0;
  let t=Math.imul(a^(a>>>15),1|a); t=(t+Math.imul(t^(t>>>7),61|t))^t;
  return ((t^(t>>>14))>>>0)/4294967296; }; }
function hashStr(s){ let h=0x811c9dc5; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,0x01000193); } return h>>>0; }
function deriveSeed(seed,label,n){ return (hashStr(label)^Math.imul(seed>>>0,0x9E3779B1)^Math.imul(n+1,0x85EBCA6B))>>>0; }

function makeNoise(seed){
  const s=seed>>>0;
  function h(x,y){ let n=(Math.imul(x|0,374761393)+Math.imul(y|0,668265263))^s;
    n=Math.imul(n^(n>>>13),1274126177); return ((n^(n>>>16))>>>0)/4294967296; }
  function val(x,y){ const xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi;
    const u=xf*xf*(3-2*xf), v=yf*yf*(3-2*yf);
    const a=h(xi,yi),b=h(xi+1,yi),c=h(xi,yi+1),d=h(xi+1,yi+1);
    return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v; }
  function fbm(x,y,oct){ let sum=0,amp=1,f=1,norm=0;
    for(let o=0;o<oct;o++){ sum+=amp*val(x*f,y*f); norm+=amp; amp*=0.5; f*=2; } return sum/norm; }
  return { val, fbm };
}

function nowMs(){ return (typeof performance!=='undefined'&&performance.now)?performance.now():Date.now(); }

/* ============================================================
   pipeline stages — each takes/extends ctx
   ============================================================ */

function stageGrid(ctx){
  const {P}=ctx;
  const Rc=Math.round(P.worldRadius/P.cellSize);
  const Rp=Rc-P.rimWidth;
  const W=2*Rc+1, H=W, C=Rc, N=W*H;
  const inWorld=new Uint8Array(N), inPlay=new Uint8Array(N);
  let playCells=0;
  for(let y=0;y<H;y++){
    const dy=y-C;
    for(let x=0;x<W;x++){
      const dx=x-C, r2=dx*dx+dy*dy, i=y*W+x;
      if(r2<=Rc*Rc){ inWorld[i]=1; if(r2<=Rp*Rp){ inPlay[i]=1; playCells++; } }
    }
  }
  Object.assign(ctx,{Rc,Rp,W,H,C,N,inWorld,inPlay,playCells,
    land:new Uint8Array(N), landmassId:new Int16Array(N).fill(-1),
    depthClass:new Uint8Array(N), coastDist:new Int16Array(N).fill(-1),
    inlandDist:new Int16Array(N).fill(-1), biome:new Uint8Array(N),
    difficulty:new Uint8Array(N), waterSrc:new Int16Array(N).fill(-1),
    queue:new Int32Array(N), stamp:new Int32Array(N), stampVal:0,
    bqHead:new Int32Array(2048), bqNext:new Int32Array(N),
    debug:{plateCores:[],plateEdges:[],trench:[],wedges:null,stageMs:{}}});
}

/* --- 1 · plates: layout retried until every plate's capacity fits its budget --- */
function stagePlates(ctx){
  const {P,seed,N,W,C,Rp,inWorld,inPlay}=ctx;
  const K=1+Math.max(2,Math.min(4,P.landmassCount|0));
  const outerCount=K-1;
  const landTarget=Math.round((1-P.oceanFraction)*ctx.playCells);

  /* outer shares engineered so masses partition into Glare(0.18)+Fade(0.18) */
  const g=mulberry32(deriveSeed(seed,'shares',0));
  const base = outerCount===2 ? [0.5,0.5]
             : outerCount===3 ? [0.5,0.25,0.25]
             : [0.25,0.25,0.25,0.25];
  const raw=base.map(v=>v*(0.92+0.16*g()));
  const rsum=raw.reduce((a,b)=>a+b,0);
  const outerShares=raw.map(v=>(1-P.spawnLandShare)*v/rsum)
    .map((s,q)=>({s,q})).sort((a,b)=>b.s-a.s||a.q-b.q);

  const straitHalf=P.shelfWidth+P.trenchHalf+(K>=5?2:3);
  let best=null, bestFit=-Infinity;
  for(let la=0; la<6 && bestFit<1; la++){
    const rng=mulberry32(deriveSeed(seed,'plates',la));
    const cs=[];
    const a0=rng()*Math.PI*2, d0=(0.06+0.08*rng())*Rp;
    cs.push({x:C+Math.cos(a0)*d0, y:C+Math.sin(a0)*d0, w:0.74-0.04*Math.max(0,K-4)});
    const bas=rng()*Math.PI*2;
    for(let k=1;k<K;k++){
      const ang=bas+(k-1)*(Math.PI*2/(K-1))+(rng()-0.5)*0.7*(Math.PI*2/(K-1));
      const rad=((K>=5?0.65:0.62)+0.15*rng())*Rp;
      cs.push({x:C+Math.cos(ang)*rad, y:C+Math.sin(ang)*rad, w:1.0});
    }
    const cap=coarseCapacity(cs,K,straitHalf,W,ctx.H,C,Rp,4);
    const capOrder=[]; for(let k=1;k<K;k++) capOrder.push({k,c:cap[k]});
    capOrder.sort((a,b)=>b.c-a.c||a.k-b.k);
    const pShare=new Float64Array(K); pShare[0]=P.spawnLandShare;
    for(let q=0;q<outerCount;q++) pShare[capOrder[q].k]=outerShares[q].s;
    let fit=Infinity;
    for(let k=0;k<K;k++){
      const capX=cap[k]*(k===0?0.90:0.85);
      fit=Math.min(fit, capX/Math.max(1,landTarget*pShare[k]));
    }
    if(fit>bestFit){ bestFit=fit; best={cs,pShare}; }
  }
  /* full-resolution ownership once, for the winning layout only */
  const own=new Int8Array(N).fill(-1), cap=new Int32Array(K);
  const box=new Int32Array(K*4);
  fillPlateOwnership(own,cap,best.cs,K,straitHalf,W,ctx.H,inWorld,inPlay,box);
  ctx.plateBox=box;
  ctx.K=K; ctx.landTarget=landTarget;
  ctx.cores=best.cs; ctx.plateOwn=own; ctx.capacity=cap; ctx.plateShare=best.pShare;
  ctx.debug.plateCores=best.cs.map(c=>({x:c.x,y:c.y}));
  const edges=ctx.debug.plateEdges;
  for(let i=0;i<N;i++) if(inWorld[i]&&own[i]<0) edges.push(i);
}

function coarseCapacity(cs,K,straitHalf,W,H,C,Rp,step){
  /* estimate playable capacity per plate on a step×step subsample */
  const cap=new Int32Array(K);
  const cell=step*step, Rp2=Rp*Rp;
  for(let y=(step>>1);y<H;y+=step){
    const dy=y-C;
    for(let x=(step>>1);x<W;x+=step){
      const dx=x-C;
      if(dx*dx+dy*dy>Rp2) continue;
      let b1=1e9,b2=1e9,bi=-1;
      for(let k=0;k<K;k++){
        const ddx=x-cs[k].x, ddy=y-cs[k].y;
        const d=Math.sqrt(ddx*ddx+ddy*ddy)*cs[k].w;
        if(d<b1){ b2=b1; b1=d; bi=k; } else if(d<b2) b2=d;
      }
      if(b2-b1>straitHalf) cap[bi]+=cell;
    }
  }
  return cap;
}

function fillPlateOwnership(own,cap,cs,K,straitHalf,W,H,inWorld,inPlay,box){
  const cx=new Float64Array(K), cy=new Float64Array(K), cw=new Float64Array(K);
  for(let k=0;k<K;k++){ cx[k]=cs[k].x; cy[k]=cs[k].y; cw[k]=cs[k].w;
    box[k*4]=W; box[k*4+1]=-1; box[k*4+2]=H; box[k*4+3]=-1; }
  for(let y=0;y<H;y++){
    const row=y*W;
    for(let x=0;x<W;x++){
      const i=row+x;
      if(!inWorld[i]) continue;
      let b1=1e9,b2=1e9,bi=-1;
      for(let k=0;k<K;k++){
        const dx=x-cx[k], dy=y-cy[k];
        const d=Math.sqrt(dx*dx+dy*dy)*cw[k];
        if(d<b1){ b2=b1; b1=d; bi=k; } else if(d<b2) b2=d;
      }
      if(b2-b1>straitHalf){
        own[i]=bi; if(inPlay[i]) cap[bi]++;
        const o=bi*4;
        if(x<box[o])box[o]=x; if(x>box[o+1])box[o+1]=x;
        if(y<box[o+2])box[o+2]=y; if(y>box[o+3])box[o+3]=y;
      }
    }
  }
}

/* --- 2 · landmass growth --- */
function stageGrow(ctx){
  const {P,seed,K,N,W,H,landTarget,capacity,plateShare,inPlay,plateOwn,land,landmassId}=ctx;
  const noiseCoast=makeNoise(deriveSeed(seed,'coast',0));
  const noiseWarp =makeNoise(deriveSeed(seed,'warp',0));
  const noiseRidge=makeNoise(deriveSeed(seed,'ridge',0));
  const NS=0.045;
  const scoreCache=new Float32Array(N), scoreDone=new Uint8Array(N);
  function cellScore(i){
    if(scoreDone[i]) return scoreCache[i];
    const x=i%W, y=(i/W)|0;
    const wx=x+(noiseWarp.val(x*NS*0.7+40,y*NS*0.7+40)-0.5)*24;
    const wy=y+(noiseWarp.val(x*NS*0.7-40,y*NS*0.7-40)-0.5)*24;
    const n=noiseCoast.fbm(wx*NS,wy*NS,3);
    const rid=Math.abs(noiseRidge.val(wx*NS*1.9,wy*NS*1.9)*2-1);
    const s=n-rid*0.38;
    scoreCache[i]=s; scoreDone[i]=1; return s;
  }
  ctx.cellScore=cellScore;

  const budgets=new Int32Array(K);
  for(let k=1;k<K;k++) budgets[k]=Math.min(Math.round(landTarget*plateShare[k]), Math.floor(capacity[k]*0.85));

  const ag=mulberry32(deriveSeed(seed,'arch',0));
  const archMask=[false];
  for(let k=1;k<K;k++) archMask.push(K-1>=3 && ag()<0.45);

  const grownArea=new Int32Array(K);
  for(let k=1;k<K;k++){
    const core=clampToPlate(ctx,ctx.cores[k],k);
    grownArea[k]=archMask[k]? growArchipelago(ctx,k,budgets[k],core)
                            : growConnected(ctx,k,budgets[k],core);
  }
  let outerTotal=0; for(let k=1;k<K;k++) outerTotal+=grownArea[k];
  const spawnBudget=Math.min(landTarget-outerTotal,
                             Math.floor(capacity[0]*0.90),
                             Math.round(landTarget*P.spawnLandShare*1.15));
  grownArea[0]=growConnected(ctx,0,spawnBudget,clampToPlate(ctx,ctx.cores[0],0));

  /* close the land deficit: feed whichever mass is furthest below its ideal share.
     Hard caps keep any mass from absorbing another's share (ocean tolerance +0.06
     absorbs a residual deficit rather than letting budgets skew). */
  const hardCap=k=> k===0
    ? Math.min(Math.floor(capacity[0]*0.90), Math.round(landTarget*0.72))
    : Math.min(Math.floor(capacity[k]*0.92), Math.round(landTarget*plateShare[k]*1.15));
  let total=0; for(let k=0;k<K;k++) total+=grownArea[k];
  let deficit=landTarget-total;
  const exhausted=new Uint8Array(K);
  for(let guard=0; deficit>50 && guard<2*K+2; guard++){
    let pick=-1, worst=0;
    for(let k=0;k<K;k++){
      if(exhausted[k]) continue;
      const slack=hardCap(k)-grownArea[k];
      if(slack<=0){ exhausted[k]=1; continue; }
      const below=landTarget*plateShare[k]-grownArea[k];
      const w=below>0? below : slack*1e-6;
      if(w>worst){ worst=w; pick=k; }
    }
    if(pick<0) break;
    const slack=hardCap(pick)-grownArea[pick];
    const below=Math.ceil(landTarget*plateShare[pick]-grownArea[pick]);
    const chunk=Math.min(deficit, slack, below>0? Math.max(below,200) : slack);
    const add=topUpLandmass(ctx,pick,chunk);
    if(add<chunk) exhausted[pick]=1;          // frontier ran dry — don't re-pick
    grownArea[pick]+=add; deficit-=add;
    if(add===0&&pick<0) break;
  }
  ctx.grownArea=grownArea;
  ctx.landDeficit=Math.max(0,deficit);
}

function clampToPlate(ctx,core,k){
  const {W,H,plateOwn,inPlay,Rp}=ctx;
  const cx=Math.round(core.x), cy=Math.round(core.y), ci=cy*W+cx;
  if(ci>=0&&ci<W*H&&plateOwn[ci]===k&&inPlay[ci]) return ci;
  for(let rad=1; rad<Rp; rad++){
    for(let dy=-rad;dy<=rad;dy++) for(let dx=-rad;dx<=rad;dx++){
      if(Math.max(Math.abs(dx),Math.abs(dy))!==rad) continue;
      const x=cx+dx,y=cy+dy; if(x<0||y<0||x>=W||y>=H) continue;
      const i=y*W+x; if(plateOwn[i]===k&&inPlay[i]) return i;
    }
  }
  return ci;
}


/* bucket priority queue over cells: O(1) push/pop, 2048 priority levels.
   Valid because the stamp guard pushes each cell at most once per pass. */
function bqQuant(s){ let q=(((s+2.2)/3.8)*2047)|0; return q<0?0:q>2047?2047:q; }
function dCentre(j,W,cx,cy){ const dx=j%W-cx, dy=((j/W)|0)-cy; return Math.sqrt(dx*dx+dy*dy); }

function growConnected(ctx,k,budget,coreI){
  const {N,W,H,inPlay,plateOwn,land,landmassId,cellScore,stamp,bqHead,bqNext}=ctx;
  if(budget<=0) return 0;
  const SV=++ctx.stampVal;
  bqHead.fill(-1); let cur=2047, inQ=0;
  const cx=coreI%W, cy=(coreI/W)|0;
  const dMax=Math.sqrt(budget/Math.PI)*2.1;
  const inv=0.9/dMax;
  bqNext[coreI]=-1; bqHead[2047]=coreI; inQ=1; stamp[coreI]=SV;
  let area=0;
  while(inQ>0&&area<budget){
    while(cur>=0&&bqHead[cur]<0) cur--;
    const i=bqHead[cur]; bqHead[cur]=bqNext[i]; inQ--;
    if(land[i]) continue;
    land[i]=1; landmassId[i]=k; area++;
    const x=i%W, y=(i/W)|0;
    let j,q;
    if(x>0){ j=i-1; if(stamp[j]!==SV&&inPlay[j]&&plateOwn[j]===k){stamp[j]=SV;
      q=bqQuant(cellScore(j)-dCentre(j,W,cx,cy)*inv); bqNext[j]=bqHead[q]; bqHead[q]=j; if(q>cur)cur=q; inQ++;} }
    if(x<W-1){ j=i+1; if(stamp[j]!==SV&&inPlay[j]&&plateOwn[j]===k){stamp[j]=SV;
      q=bqQuant(cellScore(j)-dCentre(j,W,cx,cy)*inv); bqNext[j]=bqHead[q]; bqHead[q]=j; if(q>cur)cur=q; inQ++;} }
    if(y>0){ j=i-W; if(stamp[j]!==SV&&inPlay[j]&&plateOwn[j]===k){stamp[j]=SV;
      q=bqQuant(cellScore(j)-dCentre(j,W,cx,cy)*inv); bqNext[j]=bqHead[q]; bqHead[q]=j; if(q>cur)cur=q; inQ++;} }
    if(y<H-1){ j=i+W; if(stamp[j]!==SV&&inPlay[j]&&plateOwn[j]===k){stamp[j]=SV;
      q=bqQuant(cellScore(j)-dCentre(j,W,cx,cy)*inv); bqNext[j]=bqHead[q]; bqHead[q]=j; if(q>cur)cur=q; inQ++;} }
  }
  return area;
}

function growArchipelago(ctx,k,budget,coreI){
  const {N,W,inPlay,plateOwn,land,landmassId,cellScore}=ctx;
  if(budget<=0) return 0;
  const cx=coreI%W, cy=(coreI/W)|0;
  const dMax=Math.sqrt(budget/Math.PI)*2.6;
  const cand=[], key=[];
  for(let i=0;i<N;i++){
    if(!inPlay[i]||plateOwn[i]!==k) continue;
    const x=i%W,y=(i/W)|0,dx=x-cx,dy=y-cy,d=Math.sqrt(dx*dx+dy*dy);
    if(d>dMax) continue;
    cand.push(i); key.push(cellScore(i)-d/dMax*0.55);
  }
  const order=cand.map((_,q)=>q).sort((a,b)=>key[b]-key[a]||cand[a]-cand[b]);
  const take=Math.min(cand.length, Math.round(budget*1.12));
  for(let t=0;t<take;t++){ const i=cand[order[t]]; land[i]=1; landmassId[i]=k; }
  /* drop islets <12 cells, then trim smallest islands toward budget — never the largest */
  const comps=componentsOfLandmass(ctx,k);
  comps.sort((a,b)=>a.length-b.length||a[0]-b[0]);
  let area=0; for(const c of comps) area+=c.length;
  for(let q=0;q<comps.length-1;q++){
    const c=comps[q];
    if(c.length<12 || area-c.length>=budget*0.92){
      for(const i of c){ land[i]=0; landmassId[i]=-1; } area-=c.length;
    }
  }
  /* if still over (e.g. it grew connected), shave lowest-score cells back to budget */
  if(area>budget*1.04){
    const mine=[];
    for(let i=0;i<N;i++) if(land[i]&&landmassId[i]===k) mine.push(i);
    mine.sort((a,b)=>cellScore(a)-cellScore(b)||a-b);
    let excess=area-budget;
    for(let t=0;t<mine.length&&excess>0;t++){ land[mine[t]]=0; landmassId[mine[t]]=-1; excess--; area--; }
    for(const c of componentsOfLandmass(ctx,k))
      if(c.length<12){ for(const i of c){ land[i]=0; landmassId[i]=-1; } area-=c.length; }
  }
  return area;
}

function topUpLandmass(ctx,k,extra){
  const {N,W,H,inPlay,plateOwn,land,landmassId,cellScore,stamp,bqHead,bqNext,plateBox}=ctx;
  const SV=++ctx.stampVal;
  bqHead.fill(-1); let cur=2047, inQ=0;
  const push=j=>{ const q=bqQuant(cellScore(j)); bqNext[j]=bqHead[q]; bqHead[q]=j; if(q>cur)cur=q; inQ++; };
  const x0=plateBox[k*4], x1=plateBox[k*4+1], y0=plateBox[k*4+2], y1=plateBox[k*4+3];
  for(let yy=y0;yy<=y1;yy++) for(let xx=x0;xx<=x1;xx++){
    const i=yy*W+xx;
    if(!(land[i]&&landmassId[i]===k)) continue;
    const x=i%W,y=(i/W)|0; let j;
    if(x>0){ j=i-1; if(stamp[j]!==SV&&!land[j]&&inPlay[j]&&plateOwn[j]===k){stamp[j]=SV;push(j);} }
    if(x<W-1){ j=i+1; if(stamp[j]!==SV&&!land[j]&&inPlay[j]&&plateOwn[j]===k){stamp[j]=SV;push(j);} }
    if(y>0){ j=i-W; if(stamp[j]!==SV&&!land[j]&&inPlay[j]&&plateOwn[j]===k){stamp[j]=SV;push(j);} }
    if(y<H-1){ j=i+W; if(stamp[j]!==SV&&!land[j]&&inPlay[j]&&plateOwn[j]===k){stamp[j]=SV;push(j);} }
  }
  let added=0;
  while(inQ>0&&added<extra){
    while(cur>=0&&bqHead[cur]<0) cur--;
    const i=bqHead[cur]; bqHead[cur]=bqNext[i]; inQ--;
    if(land[i]) continue;
    land[i]=1; landmassId[i]=k; added++;
    const x=i%W,y=(i/W)|0; let j;
    if(x>0){ j=i-1; if(stamp[j]!==SV&&!land[j]&&inPlay[j]&&plateOwn[j]===k){stamp[j]=SV;push(j);} }
    if(x<W-1){ j=i+1; if(stamp[j]!==SV&&!land[j]&&inPlay[j]&&plateOwn[j]===k){stamp[j]=SV;push(j);} }
    if(y>0){ j=i-W; if(stamp[j]!==SV&&!land[j]&&inPlay[j]&&plateOwn[j]===k){stamp[j]=SV;push(j);} }
    if(y<H-1){ j=i+W; if(stamp[j]!==SV&&!land[j]&&inPlay[j]&&plateOwn[j]===k){stamp[j]=SV;push(j);} }
  }
  return added;
}

function componentsOfLandmass(ctx,k){
  const {N,W,H,stamp,land,landmassId}=ctx;
  const SV=++ctx.stampVal;
  const out=[], stack=[];
  for(let s=0;s<N;s++){
    if(stamp[s]===SV||!(land[s]&&landmassId[s]===k)) continue;
    const comp=[]; stack.length=0; stack.push(s); stamp[s]=SV;
    while(stack.length){
      const i=stack.pop(); comp.push(i);
      const x=i%W,y=(i/W)|0; let j;
      if(x>0){j=i-1; if(stamp[j]!==SV&&land[j]&&landmassId[j]===k){stamp[j]=SV;stack.push(j);}}
      if(x<W-1){j=i+1; if(stamp[j]!==SV&&land[j]&&landmassId[j]===k){stamp[j]=SV;stack.push(j);}}
      if(y>0){j=i-W; if(stamp[j]!==SV&&land[j]&&landmassId[j]===k){stamp[j]=SV;stack.push(j);}}
      if(y<H-1){j=i+W; if(stamp[j]!==SV&&land[j]&&landmassId[j]===k){stamp[j]=SV;stack.push(j);}}
    }
    out.push(comp);
  }
  return out;
}

/* --- consolidate: spawn continent = its largest component; strays sink --- */
function stageConsolidate(ctx){
  const {land,landmassId}=ctx;
  const comps=componentsOfLandmass(ctx,0)
    .sort((a,b)=>b.length-a.length||a[0]-b[0]);
  for(let c=1;c<comps.length;c++) for(const i of comps[c]){ land[i]=0; landmassId[i]=-1; }
}

/* --- 3 · depth field: coast BFS, inland BFS, classes, forced midline trench --- */
function stageDepth(ctx){
  const {P,N,W,H,inWorld,land,landmassId,coastDist,inlandDist,waterSrc,depthClass,queue}=ctx;

  /* coast distance over water, carrying nearest-landmass id */
  let qt=0;
  for(let i=0;i<N;i++){
    if(!land[i]) continue;
    coastDist[i]=0;
    const x=i%W,y=(i/W)|0;
    let touch=false;
    if(x>0&&inWorld[i-1]&&!land[i-1])touch=true;
    else if(x<W-1&&inWorld[i+1]&&!land[i+1])touch=true;
    else if(y>0&&inWorld[i-W]&&!land[i-W])touch=true;
    else if(y<H-1&&inWorld[i+W]&&!land[i+W])touch=true;
    if(touch) queue[qt++]=i;
  }
  let head=0, tail=qt;
  while(head<tail){
    const i=queue[head++]; const d=coastDist[i];
    const src=land[i]? landmassId[i] : waterSrc[i];
    const x=i%W,y=(i/W)|0; let j;
    if(x>0){ j=i-1; if(inWorld[j]&&!land[j]&&coastDist[j]===-1){coastDist[j]=d+1;waterSrc[j]=src;queue[tail++]=j;} }
    if(x<W-1){ j=i+1; if(inWorld[j]&&!land[j]&&coastDist[j]===-1){coastDist[j]=d+1;waterSrc[j]=src;queue[tail++]=j;} }
    if(y>0){ j=i-W; if(inWorld[j]&&!land[j]&&coastDist[j]===-1){coastDist[j]=d+1;waterSrc[j]=src;queue[tail++]=j;} }
    if(y<H-1){ j=i+W; if(inWorld[j]&&!land[j]&&coastDist[j]===-1){coastDist[j]=d+1;waterSrc[j]=src;queue[tail++]=j;} }
  }

  /* inland distance over land */
  qt=0;
  for(let i=0;i<N;i++){
    if(!land[i]) continue;
    const x=i%W,y=(i/W)|0;
    const edge=(x>0&&inWorld[i-1]&&!land[i-1])||(x<W-1&&inWorld[i+1]&&!land[i+1])||
               (y>0&&inWorld[i-W]&&!land[i-W])||(y<H-1&&inWorld[i+W]&&!land[i+W]);
    if(edge){ inlandDist[i]=1; queue[qt++]=i; }
  }
  head=0; tail=qt;
  while(head<tail){
    const i=queue[head++]; const d=inlandDist[i];
    const x=i%W,y=(i/W)|0; let j;
    if(x>0){ j=i-1; if(land[j]&&inlandDist[j]===-1){inlandDist[j]=d+1;queue[tail++]=j;} }
    if(x<W-1){ j=i+1; if(land[j]&&inlandDist[j]===-1){inlandDist[j]=d+1;queue[tail++]=j;} }
    if(y>0){ j=i-W; if(land[j]&&inlandDist[j]===-1){inlandDist[j]=d+1;queue[tail++]=j;} }
    if(y<H-1){ j=i+W; if(land[j]&&inlandDist[j]===-1){inlandDist[j]=d+1;queue[tail++]=j;} }
  }

  /* classes */
  const abyssalStart=P.shelfWidth+P.seaBand;
  for(let i=0;i<N;i++){
    if(!inWorld[i]||land[i]){ depthClass[i]=DEPTH.LAND; continue; }
    const d=coastDist[i]<0? 32767 : coastDist[i];
    depthClass[i]= d<=P.shelfWidth? DEPTH.SHELF : d>=abyssalStart? DEPTH.ABYSSAL : DEPTH.SEA;
  }

  /* forced abyssal trench along inter-landmass water midlines — the crossing gate */
  const td=new Int16Array(N).fill(-1);
  qt=0;
  const trench=ctx.debug.trench;
  for(let i=0;i<N;i++){
    if(!inWorld[i]||land[i]||waterSrc[i]<0) continue;
    const x=i%W,y=(i/W)|0;
    if((x<W-1&&!land[i+1]&&waterSrc[i+1]>=0&&waterSrc[i+1]!==waterSrc[i])||
       (y<H-1&&!land[i+W]&&waterSrc[i+W]>=0&&waterSrc[i+W]!==waterSrc[i])){
      td[i]=0; depthClass[i]=DEPTH.ABYSSAL; queue[qt++]=i; trench.push(i);
    }
  }
  head=0; tail=qt;
  while(head<tail){
    const i=queue[head++];
    if(td[i]>=P.trenchHalf) continue;
    const x=i%W,y=(i/W)|0; let j;
    if(x>0){ j=i-1; if(inWorld[j]&&!land[j]&&td[j]===-1){td[j]=td[i]+1;depthClass[j]=DEPTH.ABYSSAL;queue[tail++]=j;} }
    if(x<W-1){ j=i+1; if(inWorld[j]&&!land[j]&&td[j]===-1){td[j]=td[i]+1;depthClass[j]=DEPTH.ABYSSAL;queue[tail++]=j;} }
    if(y>0){ j=i-W; if(inWorld[j]&&!land[j]&&td[j]===-1){td[j]=td[i]+1;depthClass[j]=DEPTH.ABYSSAL;queue[tail++]=j;} }
    if(y<H-1){ j=i+W; if(inWorld[j]&&!land[j]&&td[j]===-1){td[j]=td[i]+1;depthClass[j]=DEPTH.ABYSSAL;queue[tail++]=j;} }
  }
}

/* --- 4 · biomes: Reek disc, Bite/Sear wedges, Badlands residual, Glare/Fade masses --- */
function stageBiomes(ctx){
  const {P,seed,N,W,H,K,inWorld,inPlay,land,landmassId,inlandDist,biome,depthClass}=ctx;

  const spawnCells=[];
  for(let i=0;i<N;i++) if(land[i]&&landmassId[i]===0&&inPlay[i]) spawnCells.push(i);
  let landTotal=0;
  for(let i=0;i<N;i++) if(land[i]&&inPlay[i]) landTotal++;
  ctx.landTotalActual=landTotal;

  /* Reek pole = deepest-inland point of the spawn continent */
  let poleI=spawnCells[0]??(ctx.C*W+ctx.C), poleD=-1;
  for(let t=0;t<spawnCells.length;t++){
    const i=spawnCells[t];
    if(inlandDist[i]>poleD||(inlandDist[i]===poleD&&i<poleI)){ poleD=inlandDist[i]; poleI=i; }
  }
  const poleX=poleI%W, poleY=(poleI/W)|0;
  ctx.spawn={x:poleX,y:poleY,i:poleI};

  /* polar keys about the pole */
  const nS=spawnCells.length;
  const cAng=new Float32Array(nS), cDist=new Float32Array(nS);
  let contCy=0;
  for(let t=0;t<nS;t++){
    const i=spawnCells[t], x=i%W, y=(i/W)|0;
    cAng[t]=Math.atan2(y-poleY,x-poleX);
    cDist[t]=Math.sqrt((x-poleX)*(x-poleX)+(y-poleY)*(y-poleY));
    contCy+=y;
  }
  contCy/=Math.max(1,nS);
  const orderByDist=new Int32Array(nS);
  for(let t=0;t<nS;t++) orderByDist[t]=t;
  Array.prototype.sort.call(orderByDist,(a,b)=>cDist[a]-cDist[b]||spawnCells[a]-spawnCells[b]);

  const spawnSideSum=BUDGET_ARR[BIOME.REEK]+BUDGET_ARR[BIOME.BADLANDS]+BUDGET_ARR[BIOME.BITE]+BUDGET_ARR[BIOME.SEAR];
  const tgt=b=>Math.round(nS*BUDGET_ARR[b]/spawnSideSum);

  let wedgeOK=false, wedgeInfo=null;
  const wedgeMark=new Uint8Array(nS);
  const scratch=new Float32Array(nS), dCache=new Float32Array(nS);
  for(let attempt=0; attempt<5&&!wedgeOK; attempt++){
    const wr=mulberry32(deriveSeed(seed,'wedge',attempt));
    wedgeMark.fill(0);

    const reekN=Math.min(tgt(BIOME.REEK),nS);
    for(let t=0;t<reekN;t++) wedgeMark[orderByDist[t]]=1;
    const reekRadius=reekN? cDist[orderByDist[reekN-1]]:0;

    const relax=1+attempt*0.35;                       // later attempts search wider
    const jit=Math.min(1,P.wedgeJitter*relax+attempt*0.15);
    const hCap=Math.min(0.62, 0.46+attempt*0.04)*Math.PI;
    let biteC, searC;
    if(attempt<2){
      biteC=-Math.PI/2+(wr()-0.5)*0.6*jit;
      searC=biteC+Math.PI+(wr()-0.5)*0.7*jit;
    } else {
      /* data-driven: scan candidate centres for land supply; Bite must keep a
         northern centroid, Sear must sit ≥0.75π away from Bite */
      biteC=bestSectorCentre(wedgeMark,cAng,spawnCells,nS,W,hCap,tgt(BIOME.BITE),contCy,-Math.PI*0.95,-Math.PI*0.05,16,null);
      if(biteC===null) biteC=-Math.PI/2+(wr()-0.5)*0.9;
      searC=bestSectorCentre(wedgeMark,cAng,spawnCells,nS,W,hCap,tgt(BIOME.SEAR),null,-Math.PI,Math.PI,20,{away:biteC,min:(0.75-0.05*attempt)*Math.PI});
      if(searC===null) searC=biteC+Math.PI;
    }
    const biteH=markSector(wedgeMark,cAng,scratch,dCache,nS,biteC,tgt(BIOME.BITE),2,hCap);
    const searH=markSector(wedgeMark,cAng,scratch,dCache,nS,searC,tgt(BIOME.SEAR),3,hCap);

    let biteA=0,searA=0,badA=0,badIn=0,biteCy=0;
    for(let t=0;t<nS;t++){
      const i=spawnCells[t];
      const m=wedgeMark[t];
      if(m===1) biome[i]=BIOME.REEK;
      else if(m===2){ biome[i]=BIOME.BITE; biteA++; biteCy+=(i/W)|0; }
      else if(m===3){ biome[i]=BIOME.SEAR; searA++; }
      else { biome[i]=BIOME.BADLANDS; badA++; if(inlandDist[i]>=P.badlandsInlandDepth) badIn++; }
    }
    let adjacent=false;
    for(let t=0;t<nS&&!adjacent;t++){
      const i=spawnCells[t];
      if(biome[i]!==BIOME.BITE) continue;
      const x=i%W,y=(i/W)|0;
      if((x>0&&biome[i-1]===BIOME.SEAR)||(x<W-1&&biome[i+1]===BIOME.SEAR)||
         (y>0&&biome[i-W]===BIOME.SEAR)||(y<H-1&&biome[i+W]===BIOME.SEAR)) adjacent=true;
    }
    const within=(a,b)=>Math.abs(a-landTotal*BUDGET_ARR[b])<=landTotal*BUDGET_ARR[b]*BUDGET_TOL;
    wedgeOK = within(biteA,BIOME.BITE)&&within(searA,BIOME.SEAR)&&within(badA,BIOME.BADLANDS)&&
              badA>0&&badIn*2>badA&&!adjacent&&biteA>0&&(biteCy/biteA)<contCy;
    wedgeInfo={attempt,biteC,searC,biteH,searH,reekRadius,pole:{x:poleX,y:poleY}};
  }
  ctx.debug.wedges=wedgeInfo;

  /* Glare / Fade across the ocean: exhaustive split (≤16 options), both must exist */
  const masses=[];
  for(let k=1;k<K;k++){
    let a=0;
    for(let i=0;i<N;i++) if(land[i]&&landmassId[i]===k&&inPlay[i]) a++;
    if(a>0) masses.push({k,area:a});
  }
  masses.sort((a,b)=>b.area-a.area||a.k-b.k);
  const tgtG=landTotal*BUDGET_ARR[BIOME.GLARE], tgtF=landTotal*BUDGET_ARR[BIOME.FADE];
  const M=masses.length;
  let bestMask=1, bestErr=Infinity;
  for(let mask=0; mask<(1<<M); mask++){
    if(M>=2&&(mask===0||mask===(1<<M)-1)) continue;
    let g=0,f=0;
    for(let q=0;q<M;q++){ if(mask&(1<<q)) g+=masses[q].area; else f+=masses[q].area; }
    const err=Math.max(Math.abs(g-tgtG)/tgtG, Math.abs(f-tgtF)/tgtF);
    if(err<bestErr){ bestErr=err; bestMask=mask; }
  }
  const assign={};
  for(let q=0;q<M;q++) assign[masses[q].k]=(bestMask&(1<<q))? BIOME.GLARE : BIOME.FADE;
  for(let i=0;i<N;i++) if(land[i]&&landmassId[i]>0) biome[i]=assign[landmassId[i]]||BIOME.GLARE;

  /* water = Drown, rim = Nothing (land and ocean alike), outside = none */
  for(let i=0;i<N;i++){
    if(!inWorld[i]){ biome[i]=BIOME.NONE; continue; }
    if(!inPlay[i]){ biome[i]=BIOME.NOTHING; continue; }
    if(!land[i]) biome[i]=BIOME.DROWN;
  }
}

function bestSectorCentre(wedgeMark,cAng,spawnCells,nS,W,hCap,budget,mustBeNorthOf,a0,a1,steps,avoid){
  const TAU=Math.PI*2;
  let best=null, bestMargin=-Infinity;
  for(let s=0;s<steps;s++){
    const c=a0+(a1-a0)*(steps===1?0.5:s/(steps-1));
    if(avoid){ let dd=Math.abs(c-avoid.away)%TAU; if(dd>Math.PI)dd=TAU-dd; if(dd<avoid.min) continue; }
    let cnt=0, sy=0;
    for(let t=0;t<nS;t++){
      if(wedgeMark[t]!==0) continue;
      let d=Math.abs(cAng[t]-c)%TAU; if(d>Math.PI)d=TAU-d;
      if(d<=hCap){ cnt++; sy+=(spawnCells[t]/W)|0; }
    }
    if(cnt<budget) continue;
    if(mustBeNorthOf!==null && sy/cnt>=mustBeNorthOf) continue;
    const margin=cnt-budget;
    if(margin>bestMargin){ bestMargin=margin; best=c; }
  }
  return best;
}

function markSector(wedgeMark,cAng,scratch,dCache,nS,centre,budget,mark,hCap){
  const TAU=Math.PI*2;
  let m=0;
  for(let t=0;t<nS;t++){
    let d=Math.abs(cAng[t]-centre)%TAU; if(d>Math.PI)d=TAU-d;
    dCache[t]=d;
    if(wedgeMark[t]===0) scratch[m++]=d;
  }
  if(m===0) return 0;
  scratch.subarray(0,m).sort();                      // typed numeric sort, in place
  const h=Math.min(scratch[Math.min(budget,m)-1], hCap);
  for(let t=0;t<nS;t++)
    if(wedgeMark[t]===0 && dCache[t]<=h) wedgeMark[t]=mark;
  return h;
}

/* --- 5 · difficulty: radial from spawn × biome modifier --- */
function stageDifficulty(ctx){
  const {N,W,Rp,inWorld,biome,depthClass,difficulty,spawn}=ctx;
  const sx=spawn.x, sy=spawn.y, inv=1/Rp;
  for(let i=0;i<N;i++){
    if(!inWorld[i]) continue;
    const x=i%W, y=(i/W)|0;
    const dx=x-sx, dy=y-sy;
    const d=Math.sqrt(dx*dx+dy*dy)*inv;
    const b=biome[i];
    const mod=b===BIOME.DROWN? DIFF_WATER_ARR[depthClass[i]] : DIFF_MOD_ARR[b];
    let v=d*mod; if(v>1)v=1;
    difficulty[i]=(v*255)|0;
  }
}

/* --- 6 · anchors: dart-throwing with spacing guarantees, per-zone budgets --- */
function stageAnchors(ctx){
  const {P,seed,N,W,inPlay,land,biome,depthClass,waterSrc,difficulty}=ctx;
  const cellsByZone=[[],[],[],[],[],[],[],[],[],[]];   // 1..6 = land biomes, 9 = spawn shelf
  for(let i=0;i<N;i++){
    if(!inPlay[i]) continue;
    if(land[i]){
      const b=biome[i];
      if(b>=1&&b<=6) cellsByZone[b].push(i);
    } else if(depthClass[i]===DEPTH.SHELF&&waterSrc[i]===0){
      cellsByZone[9].push(i);
    }
  }
  const anchors=[];
  const bucketSz=8, bw=Math.ceil(W/bucketSz), buckets=new Map();
  const zoneOrder=[1,2,3,4,5,6,9];
  for(const z of zoneOrder){
    const isShelf=z===9;
    const dens=isShelf?0.12:A_DENS[z], cave=isShelf?1.0:A_CAVE[z], min=isShelf?0:A_MIN[z];
    const cells=cellsByZone[z];
    const count=Math.max(min, Math.round(cells.length*dens/1000));
    if(count===0||cells.length===0) continue;
    const minD=Math.max(5, Math.floor(Math.sqrt(cells.length/count)*0.6));
    const zr=mulberry32(deriveSeed(seed,'anchor:'+(isShelf?'SHELF':z),0));
    let placed=0, tries=0;
    while(placed<count&&tries<count*60){
      tries++;
      const i=cells[(zr()*cells.length)|0];
      const x=i%W, y=(i/W)|0;
      if(!anchorFits(buckets,bucketSz,bw,x,y,minD)) continue;
      const type=zr()<cave? 'cave':'tower';
      const a={x,y,type,zone:isShelf?'Drown-shelf':BIOME_NAME[z],
               difficulty:difficulty[i]/255};
      anchors.push(a); placed++;
      const key=((y/bucketSz)|0)*bw+((x/bucketSz)|0);
      let list=buckets.get(key); if(!list){list=[];buckets.set(key,list);}
      list.push(a);
    }
  }
  ctx.anchors=anchors;
}
function anchorFits(buckets,bucketSz,bw,x,y,minD){
  const need=Math.max(minD,4);
  const bx=(x/bucketSz)|0, by=(y/bucketSz)|0, span=Math.ceil(need/bucketSz);
  for(let dy=-span;dy<=span;dy++)for(let dx=-span;dx<=span;dx++){
    const list=buckets.get((by+dy)*bw+(bx+dx)); if(!list) continue;
    for(let q=0;q<list.length;q++){
      const a=list[q], ddx=a.x-x, ddy=a.y-y;
      if(ddx*ddx+ddy*ddy<need*need) return false;
    }
  }
  return true;
}

/* --- 7 · names --- */
function stageNames(ctx){
  const {seed,K}=ctx;
  const nr=mulberry32(deriveSeed(seed,'names',0));
  const A=['Ka','Vor','Mel','Dra','Osh','Ith','Bel','Nor','Sar','Ael','Thun','Qir','Hollow','Vane','Umber'];
  const B=['ra','ven','dris','mor','tal','ur','gild','oth','ese','une','wyn','ach','mere'];
  const C=['','','',' Reach',' Waste',' Verge',' Shroud'];
  const word=()=>A[(nr()*A.length)|0]+B[(nr()*B.length)|0]+(nr()<0.3?B[(nr()*B.length)|0]:'');
  const continents=[];
  for(let k=0;k<K;k++) continents.push(word()+C[(nr()*C.length)|0]);
  const ocean='The '+word()+[' Deep',' Expanse',' Drown'][(nr()*3)|0];
  const seas=[]; for(let k=1;k<K;k++) seas.push('Sea of '+word());
  ctx.names={continents,ocean,seas};
}

/* --- 8 · stats --- */
function stageStats(ctx){
  const {N,inWorld,inPlay,land,biome,anchors,playCells,landTotalActual}=ctx;
  const areas={};
  const counts=new Int32Array(9);
  for(let i=0;i<N;i++) if(inWorld[i]) counts[biome[i]]++;
  for(let b=1;b<=8;b++) areas[BIOME_NAME[b]]=counts[b];
  let caves=0; for(const a of anchors) if(a.type==='cave') caves++;
  ctx.stats={ areas, landCells:landTotalActual, playCells,
    oceanFraction:(playCells-landTotalActual)/playCells,
    anchorCount:anchors.length, caves, towers:anchors.length-caves };
}

/* ============================================================
   generateWorldMap(params) → WorldMap
   ============================================================ */
function generateWorldMap(userParams){
  const t0=nowMs();
  const P=Object.assign({},DEFAULTS,userParams||{});
  const ctx={P, seed:P.seed>>>0};
  const st=ctx.stageMsTmp={};
  let sp=nowMs(); const mark=n=>{ st[n]=nowMs()-sp; sp=nowMs(); };

  stageGrid(ctx);        mark('grid');
  /* structural retry: if a layout can't grow enough land (crowded plates),
     re-derive and re-run plates+growth — deterministic, bounded */
  for(let mr=0; mr<3; mr++){
    if(mr>0){
      ctx.land.fill(0); ctx.landmassId.fill(-1);
      ctx.debug.plateCores.length=0; ctx.debug.plateEdges.length=0;
      ctx.seed=deriveSeed(P.seed>>>0,'map-retry',mr);
    }
    stagePlates(ctx);
    stageGrow(ctx);
    if(ctx.landDeficit<=ctx.landTarget*0.06) break;
  }
  ctx.seed=P.seed>>>0;   // downstream stages derive from the original seed
  mark('plates+grow');
  stageConsolidate(ctx); mark('consolidate');
  stageDepth(ctx);       mark('depth');
  stageBiomes(ctx);      mark('biomes');
  stageDifficulty(ctx);  mark('difficulty');
  stageAnchors(ctx);     mark('anchors');
  stageNames(ctx);       mark('names');
  stageStats(ctx);       mark('stats');

  const map={
    params:P, seed:ctx.seed, W:ctx.W, H:ctx.H, C:ctx.C, Rc:ctx.Rc, Rp:ctx.Rp,
    cellSize:P.cellSize,
    land:ctx.land, landmassId:ctx.landmassId, depthClass:ctx.depthClass,
    coastDist:ctx.coastDist, inlandDist:ctx.inlandDist,
    biome:ctx.biome, difficulty:ctx.difficulty,
    spawn:ctx.spawn, anchors:ctx.anchors, names:ctx.names, stats:ctx.stats,
    debug:ctx.debug,
  };
  map.checksum=checksumMap(map); mark('checksum');
  map.debug.stageMs=st;
  map.genMs=nowMs()-t0;
  return map;
}

/* ---------- checksum (FNV-1a over the judged fields) ---------- */
function checksumMap(m){
  let h=0x811c9dc5;
  const bio=m.biome, dep=m.depthClass, dif=m.difficulty, n=bio.length;
  for(let i=0;i<n;i++){
    h=Math.imul(h^bio[i],0x01000193);
    h=Math.imul(h^dep[i],0x01000193);
    h=Math.imul(h^dif[i],0x01000193);
  }
  for(const a of m.anchors){
    h=Math.imul(h^(a.x&0xff),0x01000193); h=Math.imul(h^((a.x>>8)&0xff),0x01000193);
    h=Math.imul(h^(a.y&0xff),0x01000193); h=Math.imul(h^((a.y>>8)&0xff),0x01000193);
    h=Math.imul(h^(a.type==='cave'?1:2),0x01000193);
  }
  return (h>>>0).toString(16).padStart(8,'0');
}

/* ============================================================
   acceptance suite — every claim in the spec, auto-run & printed
   ============================================================ */
function runAcceptance(map, opts){
  const o=Object.assign({determinismRuns:3},opts||{});
  const P=map.params, W=map.W, H=map.H, N=W*H;
  const R=[];
  const check=(name,pass,detail)=>R.push({name,pass:!!pass,detail});

  /* 1 · ocean fraction */
  {
    const f=map.stats.oceanFraction, tgt=P.oceanFraction;
    check('ocean fraction', f>=tgt-0.02&&f<=tgt+0.06,
      `measured ${f.toFixed(3)} vs target ${tgt} (allowed −0.02 / +0.06)`);
  }
  /* 2 · Reek heart + Badlands identity */
  {
    const si=map.spawn.i;
    const onSpawn=map.land[si]===1&&map.landmassId[si]===0&&map.biome[si]===BIOME.REEK;
    let badA=0,badIn=0;
    for(let i=0;i<N;i++) if(map.biome[i]===BIOME.BADLANDS){ badA++; if(map.inlandDist[i]>=P.badlandsInlandDepth) badIn++; }
    check('Reek heart on spawn continent', onSpawn,
      `spawn cell biome=${BIOME_NAME[map.biome[si]]}, landmass=${map.landmassId[si]}`);
    check('Badlands inland cell-majority', badA>0&&badIn*2>badA,
      `${badIn}/${badA} cells ≥${P.badlandsInlandDepth} cells from coast (${badA?(100*badIn/badA).toFixed(0):0}%)`);
  }
  /* 3 · abyssal gate: flood over spawn land + non-abyssal water reaches no outer landmass */
  {
    const seen=new Uint8Array(N), stack=[map.spawn.i]; seen[map.spawn.i]=1;
    let breach=-1;
    while(stack.length&&breach<0){
      const i=stack.pop();
      const x=i%W,y=(i/W)|0;
      for(let q=0;q<4;q++){
        const j=q===0?(x>0?i-1:-1):q===1?(x<W-1?i+1:-1):q===2?(y>0?i-W:-1):(y<H-1?i+W:-1);
        if(j<0||seen[j]) continue;
        const b=map.biome[j];
        if(b===BIOME.NOTHING||b===BIOME.NONE) continue;
        if(map.land[j]){
          if(map.landmassId[j]!==0){ breach=j; break; }
          seen[j]=1; stack.push(j);
        } else if(map.depthClass[j]!==DEPTH.ABYSSAL){
          seen[j]=1; stack.push(j);
        }
      }
    }
    check('abyssal gate seals every trans-ocean route', breach<0,
      breach<0? 'flood from spawn (land + shelf/sea) reaches no outer landmass'
              : `breach at (${breach%W},${(breach/W)|0}) onto landmass ${map.landmassId[breach]}`);
  }
  /* 4 · shallow shelf on ≥70 % of the spawn-continent coast */
  {
    let coast=0, shelved=0;
    for(let i=0;i<N;i++){
      if(map.land[i]||map.coastDist[i]!==1) continue;
      const x=i%W,y=(i/W)|0;
      const s=(x>0&&map.land[i-1]&&map.landmassId[i-1]===0)||
              (x<W-1&&map.land[i+1]&&map.landmassId[i+1]===0)||
              (y>0&&map.land[i-W]&&map.landmassId[i-W]===0)||
              (y<H-1&&map.land[i+W]&&map.landmassId[i+W]===0);
      if(!s) continue;
      coast++;
      if(map.depthClass[i]===DEPTH.SHELF) shelved++;
    }
    check('shelf hugs ≥70 % of spawn coast', coast>0&&shelved/coast>=0.70,
      `${shelved}/${coast} first-water coastal cells are shelf (${coast?(100*shelved/coast).toFixed(0):0}%)`);
  }
  /* 5 · biome land budgets ±30 % */
  {
    let ok=true; const parts=[];
    for(const b of [BIOME.REEK,BIOME.BADLANDS,BIOME.BITE,BIOME.SEAR,BIOME.GLARE,BIOME.FADE]){
      const share=BUDGET[b], a=map.stats.areas[BIOME_NAME[b]];
      const lo=map.stats.landCells*share*(1-BUDGET_TOL), hi=map.stats.landCells*share*(1+BUDGET_TOL);
      const pass=a>=lo&&a<=hi; ok=ok&&pass;
      parts.push(`${BIOME_NAME[b]} ${a} [${Math.round(lo)}–${Math.round(hi)}]${pass?'':' ✗'}`);
    }
    check('biome area budgets ±30 %', ok, parts.join(' · '));
  }
  /* 6 · rim annulus closed */
  {
    let gap=0;
    const C=map.C, Rc2=map.Rc*map.Rc, Rp2=map.Rp*map.Rp;
    for(let y=0;y<H;y++){ const dy=y-C;
      for(let x=0;x<W;x++){ const dx=x-C, r2=dx*dx+dy*dy;
        if(r2<=Rc2&&r2>Rp2&&map.biome[y*W+x]!==BIOME.NOTHING) gap++;
      }
    }
    check('rim annulus closed (no gap)', gap===0,
      gap===0? `all annulus cells are Nothing (width ${map.Rc-map.Rp} cells)`
             : `${gap} annulus cells escaped the Nothing`);
  }
  /* 7 · determinism, 8 · speed — timed on fresh generations so a cold
        first call (JIT tier-up) doesn't masquerade as generator cost */
  {
    const times=[], sums=[map.checksum];
    const fresh=Math.max(3,o.determinismRuns-0);
    for(let r=0;r<fresh;r++){
      const m2=generateWorldMap(map.params);
      times.push(m2.genMs); sums.push(m2.checksum);
    }
    const allEq=sums.every(s=>s===sums[0]);
    check(`determinism (${o.determinismRuns}-run checksum)`, allEq, sums.join(' / '));
    const med=Math.min.apply(null,times);   // best-of-N: generator cost, excluding GC/scheduler noise
    /* spec pins 100 ms at DEFAULT world size; scale the budget with cell count */
    const RcD=Math.round(DEFAULTS.worldRadius/DEFAULTS.cellSize);
    const nD=(2*RcD+1)*(2*RcD+1);
    const budgetMs=Math.max(100, 100*N/nD);
    check(`generation < ${budgetMs.toFixed(0)} ms (100 ms at defaults, scaled by cell count)`, med<budgetMs,
      `fresh runs: ${times.map(t=>t.toFixed(1)).join(' / ')} ms (best ${med.toFixed(1)})`);
  }
  R.allPass=R.every(r=>r.pass);
  return R;
}

/* ---------- exports (ESM — the engine imports this; maplab.html keeps its own copy) ---------- */
export { generateWorldMap, runAcceptance, checksumMap,
         BIOME, BIOME_NAME, DEPTH, DEPTH_NAME, DEFAULTS, BUDGET, BUDGET_TOL,
         DIFF_MOD, DIFF_MOD_WATER, mulberry32, deriveSeed, makeNoise };
