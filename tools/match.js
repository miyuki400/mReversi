// 2つのエンジンを対戦させる。使い方: node tools/match.js <エンジンA> <エンジンB> <開始局面の数> <1手の持ち時間ms（負なら固定の深さ）> [終盤読み切り] [乱数の種]
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const W=[[120,-25,20,5,5,20,-25,120],[-25,-45,-5,-5,-5,-5,-45,-25],[20,-5,15,3,3,15,-5,20],[5,-5,3,3,3,3,-5,5],[5,-5,3,3,3,3,-5,5],[20,-5,15,3,3,15,-5,20],[-25,-45,-5,-5,-5,-5,-45,-25],[120,-25,20,5,5,20,-25,120]].flat();
const dirs=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
function flips(b,p,side){if(b[p])return[];const R=p>>3,C=p&7,o=[];for(const[dr,dc]of dirs){let y=R+dr,x=C+dc,l=[];while(y>=0&&y<8&&x>=0&&x<8&&b[y*8+x]===-side){l.push(y*8+x);y+=dr;x+=dc}if(l.length&&y>=0&&y<8&&x>=0&&x<8&&b[y*8+x]===side)o.push(...l)}return o}
function legal(b,s){const o=[];for(let i=0;i<64;i++){const f=flips(b,i,s);if(f.length)o.push({pos:i,f})}return o}
function initial(){const b=Array(64).fill(0);b[27]=-1;b[28]=1;b[35]=1;b[36]=-1;return b}
if(isMainThread){
  const [A,B,pairs,budget,solve,seed,book]=[process.argv[2],process.argv[3],+process.argv[4]||10,+process.argv[5]||300,+process.argv[6]||20,+process.argv[7]||1,process.argv[8]||''];
  let s=seed*7919+1;const r=()=>{s=(Math.imul(s,1103515245)+12345)&0x7fffffff;return s/0x7fffffff};
  const openings=[];const seen=new Set();
  while(openings.length<pairs){let b=initial(),side=1,seq=[];for(let k=0;k<6;k++){const m=legal(b,side);const mv=m[Math.floor(r()*m.length)];b[mv.pos]=side;for(const i of mv.f)b[i]=side;side=-side;seq.push(mv.pos)}const key=b.join('');if(seen.has(key))continue;seen.add(key);openings.push(seq)}
  const jobs=[];openings.forEach((o,i)=>{jobs.push({o,aBlack:true});jobs.push({o,aBlack:false})});
  let ai=0,res={a:0,b:0,d:0,disc:0},done=0;const nW=4;
  for(let w=0;w<nW;w++){const wk=new Worker(__filename,{workerData:{A,B,budget,solve,book}});const next=()=>{if(ai>=jobs.length){wk.terminate();return}wk.postMessage(jobs[ai++])};
    wk.on('message',m=>{done++;const aScore=m.aBlack?m.diff:-m.diff;res.disc+=aScore;if(aScore>0)res.a++;else if(aScore<0)res.b++;else res.d++;if(done===jobs.length){const n=jobs.length;const sc=(res.a+res.d/2)/n;const elo=sc>0&&sc<1?Math.round(-400*Math.log10(1/sc-1)):NaN;console.log(`A(${A}) vs B(${B}) budget ${budget}: A wins ${res.a}, B wins ${res.b}, draws ${res.d}, score ${(sc*100).toFixed(1)}%, Elo ${elo}, avg disc ${(res.disc/n).toFixed(1)}`)}next()});next()}
}else{
  const P=require('path'),ea=require(P.resolve(workerData.A)).createReversiEngine(),eb=require(P.resolve(workerData.B)).createReversiEngine();
  parentPort.on('message',job=>{let b=initial(),side=1;for(const p of job.o){const m=legal(b,side).find(x=>x.pos===p);b[p]=side;for(const i of m.f)b[i]=side;side=-side}
    for(;;){let m=legal(b,side);if(!m.length){side=-side;m=legal(b,side);if(!m.length)break}
      const useA=(side===1)===job.aBlack;const eng=useA?ea:eb;
      const res=eng.think({board:b.slice(),side,weights:W,level:workerData.budget<0?{depth:-workerData.budget,solve:workerData.solve,budget:1e9}:{depth:60,solve:workerData.solve,budget:workerData.budget},book:[]});
      const mv=m.find(x=>x.pos===res.move)||m[0];b[mv.pos]=side;for(const i of mv.f)b[i]=side;side=-side}
    const diff=b.reduce((a,v)=>a+v,0);parentPort.postMessage({aBlack:job.aBlack,diff})});
}
