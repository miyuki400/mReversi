// 自己対戦で学習用の棋譜を作る。使い方: node tools/gen-games.js <エンジン> <局数> <深さ(例 5,6)> <出力名> <乱数の種>
//   出力: Int32 の 6 個組 [pL,pH,oL,oH,空きマス数,手番側から見た最終石差]（環境変数 EPS: 中盤でランダムに打つ確率）
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs=require('fs');
const W=[[120,-25,20,5,5,20,-25,120],[-25,-45,-5,-5,-5,-5,-45,-25],[20,-5,15,3,3,15,-5,20],[5,-5,3,3,3,3,-5,5],[5,-5,3,3,3,3,-5,5],[20,-5,15,3,3,15,-5,20],[-25,-45,-5,-5,-5,-5,-45,-25],[120,-25,20,5,5,20,-25,120]].flat();
const dirs=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
function flips(b,p,side){if(b[p])return[];const R=p>>3,C=p&7,o=[];for(const[dr,dc]of dirs){let y=R+dr,x=C+dc,l=[];while(y>=0&&y<8&&x>=0&&x<8&&b[y*8+x]===-side){l.push(y*8+x);y+=dr;x+=dc}if(l.length&&y>=0&&y<8&&x>=0&&x<8&&b[y*8+x]===side)o.push(...l)}return o}
function legal(b,s){const o=[];for(let i=0;i<64;i++){const f=flips(b,i,s);if(f.length)o.push({pos:i,f})}return o}
function bits(b,side){let pL=0,pH=0,oL=0,oH=0;for(let i=0;i<64;i++){if(!b[i])continue;const m=i<32?1<<i:1<<(i-32);if(b[i]===side){if(i<32)pL|=m;else pH|=m}else{if(i<32)oL|=m;else oH|=m}}return[pL,pH,oL,oH]}
if(isMainThread){
  const [E,games,depth,out,seed]=[process.argv[2],+process.argv[3],process.argv[4],process.argv[5],+process.argv[6]||1];
  const nW=4;
  for(let w=0;w<nW;w++){const wk=new Worker(__filename,{workerData:{E,games:Math.ceil(games/nW),depth,seed:seed*1000+w,solve:+(process.env.SOLVE||14)}});
    wk.on('message',m=>{fs.writeFileSync(out+'_'+w+'.bin',Buffer.from(m.buffer));console.log('worker',w,m.length/6)})}
}else{
  const eng=require(require('path').resolve(workerData.E)).createReversiEngine();const EPS=+(process.env.EPS||0.03);
  const depths=workerData.depth.split(',').map(Number);
  let s=workerData.seed*7919+17;const r=()=>{s=(Math.imul(s,1103515245)+12345)&0x7fffffff;return s/0x7fffffff};
  const rows=[];
  for(let g=0;g<workerData.games;g++){
    let b=Array(64).fill(0);b[27]=-1;b[28]=1;b[35]=1;b[36]=-1;let side=1,ply=0;const nRand=4+Math.floor(r()*11);const rec=[];
    const depth=depths[g%depths.length];
    for(;;){let m=legal(b,side);if(!m.length){side=-side;m=legal(b,side);if(!m.length)break}
      let mv;
      if(ply<nRand||(b.filter(v=>!v).length>16&&r()<EPS))mv=m[Math.floor(r()*m.length)];
      else{const e=b.filter(v=>!v).length;rec.push([...bits(b,side),e,side]);const res=eng.think({board:b.slice(),side,weights:W,level:{depth,solve:workerData.solve,budget:1e9},book:[]});mv=m.find(x=>x.pos===res.move)||m[0]}
      b[mv.pos]=side;for(const i of mv.f)b[i]=side;side=-side;ply++}
    const diff=b.reduce((a,v)=>a+v,0);
    for(const x of rec)rows.push(x[0],x[1],x[2],x[3],x[4],x[5]*diff);
  }
  parentPort.postMessage(Int32Array.from(rows));
}
