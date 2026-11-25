// 棋譜から点数表を学習する。使い方: node tools/train-patterns.js <出力.json> <棋譜.bin> ...（.i8 も同じ名前で出力）
// env: EPOCHS, LRP, LRC, L2, MINCNT, QSCALE
const fs=require('fs');
const eng=require(require('path').join(__dirname,'..','engine.js')).createReversiEngine();
const {NF,STAGES,patternInfo,F,TIDX}=eng;const NI=patternInfo.NI;
const W0=[[120,-25,20,5,5,20,-25,120],[-25,-45,-5,-5,-5,-5,-45,-25],[20,-5,15,3,3,15,-5,20],[5,-5,3,3,3,3,-5,5],[5,-5,3,3,3,3,-5,5],[20,-5,15,3,3,15,-5,20],[-25,-45,-5,-5,-5,-5,-45,-25],[120,-25,20,5,5,20,-25,120]].flat();
eng.featureVector(Array(64).fill(0).map((_,i)=>i===27||i===36?-1:i===28||i===35?1:0),1,W0); // set weights
const EPOCHS=+(process.env.EPOCHS||10),LRP=+(process.env.LRP||0.003),LRC=+(process.env.LRC||0.0005),L2=+(process.env.L2||0.002),MINCNT=+(process.env.MINCNT||3),QSCALE=+(process.env.QSCALE||2),SCALE=10;
const typeOff=[];let NC=0;for(const t of patternInfo.types){typeOff.push(NC);NC+=t.nCanon}
const instOff=Int32Array.from(patternInfo.instType.map(t=>typeOff[t]));
// load
const parts=process.argv.slice(3).map(f=>{const b=fs.readFileSync(f);return new Int32Array(b.buffer,b.byteOffset,b.length/4)});
let total=parts.reduce((a,p)=>a+p.length/6,0);const D=new Int32Array(total*6);{let o=0;for(const p of parts){D.set(p,o);o+=p.length}}
console.log('positions',total);
// 同じ局面は 1つにまとめ、結果（石差）は平均する
{const m=new Map();let u=0;const lab=new Float64Array(total),cn=new Int32Array(total);
 for(let i=0;i<total;i++){const k=D[i*6]+','+D[i*6+1]+','+D[i*6+2]+','+D[i*6+3];let j=m.get(k);if(j===undefined){j=u++;m.set(k,j);for(let q=0;q<5;q++)D[j*6+q]=D[i*6+q]}lab[j]+=D[i*6+5];cn[j]++}
 for(let j=0;j<u;j++)D[j*6+5]=Math.round(lab[j]/cn[j]);
 console.log('unique',u);total=u}
const stageOf=eng.stageOf;
const stageOfRow=new Int8Array(total);for(let i=0;i<total;i++)stageOfRow[i]=stageOf(D[i*6+4]);
let rs=12345;const rnd=()=>{rs^=rs<<13;rs^=rs>>>17;rs^=rs<<5;return (rs>>>0)/4294967296};
// warm start linear coefs from engine's current linear model
const initCoef=JSON.parse(process.env.INITCOEF?fs.readFileSync(process.env.INITCOEF):'null');
const outCoef=new Array(NF*STAGES).fill(0);const outPat=new Int8Array(NC*STAGES);
let sumErrT=0,sumErrQ=0,sumN=0;
for(let s=0;s<STAGES;s++){
  // select rows
  const sel=[];const val=[];
  for(let i=0;i<total;i++){const d=Math.abs(stageOfRow[i]-s);if(d>1)continue;const isVal=((i*2654435761)>>>0)%20===0;if(isVal){if(d===0)val.push(i);continue}if(d===1&&rnd()<0.5)continue;sel.push(i)}
  const build=(rows)=>{const n=rows.length,IX=new Int32Array(n*NI),FX=new Float32Array(n*NF),Y=new Float32Array(n);let m=0;
    for(const i of rows){const e=eng.trainView(D[i*6],D[i*6+1],D[i*6+2],D[i*6+3]);if(e<0)continue;for(let k=0;k<NI;k++)IX[m*NI+k]=instOff[k]+TIDX[k];for(let k=0;k<NF;k++)FX[m*NF+k]=F[k];Y[m]=D[i*6+5]*SCALE;m++}
    return {n:m,IX,FX,Y}};
  const T=build(sel),V=build(val);
  // feature std for normalization
  const sd=new Float64Array(NF);for(let k=0;k<NF;k++){let a=0;for(let m=0;m<T.n;m++)a+=T.FX[m*NF+k]**2;sd[k]=Math.sqrt(a/T.n)||1}
  const c=new Float64Array(NF);if(initCoef)for(let k=0;k<NF;k++)c[k]=initCoef[s*NF+k]*sd[k];
  const w=new Float64Array(NC),cnt=new Int32Array(NC);
  for(let m=0;m<T.n;m++)for(let k=0;k<NI;k++)cnt[T.IX[m*NI+k]]++;
  const order=new Int32Array(T.n);for(let m=0;m<T.n;m++)order[m]=m;
  const predict=(S,m,wq)=>{let p=0;for(let k=0;k<NF;k++)p+=c[k]*S.FX[m*NF+k]/sd[k];for(let k=0;k<NI;k++){const g=S.IX[m*NI+k];p+=wq?wq[g]:w[g]}return p};
  const rmse=(S,wq)=>{let e=0;for(let m=0;m<S.n;m++)e+=(predict(S,m,wq)-S.Y[m])**2;return Math.sqrt(e/Math.max(1,S.n))/SCALE};
  for(let ep=0;ep<EPOCHS;ep++){
    for(let m=T.n-1;m>0;m--){const j=Math.floor(rnd()*(m+1));const t=order[m];order[m]=order[j];order[j]=t}
    const lrp=LRP*(1-ep/EPOCHS*0.8),lrc=LRC*(1-ep/EPOCHS*0.8);
    for(let q=0;q<T.n;q++){const m=order[q];const err=predict(T,m)-T.Y[m];
      for(let k=0;k<NF;k++)c[k]-=lrc*err*T.FX[m*NF+k]/sd[k];
      for(let k=0;k<NI;k++){const g=T.IX[m*NI+k];w[g]-=lrp*(err+L2*w[g]*NI)}}
  }
  // prune rare entries, quantize
  const wq=new Float64Array(NC);let maxw=0,clip=0;
  for(let g=0;g<NC;g++){if(cnt[g]<MINCNT)w[g]=0;let q=Math.round(w[g]/QSCALE);if(q>127){q=127;clip++}if(q<-127){q=-127;clip++}outPat[s*NC+g]=q;wq[g]=q*QSCALE;maxw=Math.max(maxw,Math.abs(w[g]))}
  for(let k=0;k<NF;k++)outCoef[s*NF+k]=Math.round(c[k]/sd[k]*1000)/1000;
  const rt=rmse(T),rv=rmse(V),rq=rmse(V,wq);
  sumErrT+=rv*rv*V.n;sumErrQ+=rq*rq*V.n;sumN+=V.n;
  console.log(`stage ${s} train ${T.n} val ${V.n} rmse train ${rt.toFixed(2)} val ${rv.toFixed(2)} valQ ${rq.toFixed(2)} max|w| ${maxw.toFixed(0)} clipped ${clip}`);
}
console.log('overall val rmse',Math.sqrt(sumErrT/sumN).toFixed(3),'quantized',Math.sqrt(sumErrQ/sumN).toFixed(3));
fs.writeFileSync(process.argv[2],JSON.stringify({coef:outCoef,scale:QSCALE}));
fs.writeFileSync(process.argv[2].replace('.json','.i8'),Buffer.from(outPat.buffer));
