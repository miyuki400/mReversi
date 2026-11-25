(() => {
'use strict';
const N=8, EMPTY=0, BLACK=1, WHITE=-1, dirs=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
const $=id=>document.getElementById(id);
const baseWeights=[[120,-25,20,5,5,20,-25,120],[-25,-45,-5,-5,-5,-5,-45,-25],[20,-5,15,3,3,15,-5,20],[5,-5,3,3,3,3,-5,5],[5,-5,3,3,3,3,-5,5],[20,-5,15,3,3,15,-5,20],[-25,-45,-5,-5,-5,-5,-45,-25],[120,-25,20,5,5,20,-25,120]];
// depth: 中盤の最大読み深さ / solve: 残りマスがこれ以下なら終盤読み切り / budget: 1手の思考時間上限(ms)
const levels={beginner:{depth:2,solve:6,budget:1500,book:false},intermediate:{depth:4,solve:10,budget:1500,book:false},advanced:{depth:6,solve:14,budget:1500,book:true},strong:{depth:60,solve:20,budget:1500,book:true,longFrom:17,endBudget:3000}};
const LEVEL_NAMES={beginner:'初級',intermediate:'中級',advanced:'上級',strong:'最強'};
const COACH_MS=1000;
const PASS_DELAY=2000;
const RESULT_DELAY=2000;
const LONG_SHOW_MS=1000;  // 長考モードでこれ以上考えていたら「長考中」を表示
const LONG_MIN_MS=600;    // 「長考中」を出したら、ちらつかないよう最低これだけは見せる
let weights=baseWeights.flat(), human=BLACK, board, turn, history=[], moveHistory=[], evalHistory=[], gameStarted=false, thinking=false, finished=false, passTimer=null, cpuToken=0, lastFlips=[], recommendedPos=null, guidePersistent=null, lastCPUAction=null, coachKey="", coachMove=null, passPending=false, resultTimer=null, resultShowing=false, thinkTimer=null, longThink=null, cpuProofText="", cpuLog=[], lastCpuMsg="";
function initial(){const b=Array(64).fill(EMPTY);b[27]=WHITE;b[28]=BLACK;b[35]=BLACK;b[36]=WHITE;return b}
function coord(i){return String.fromCharCode(97+i%8)+(Math.floor(i/8)+1)}
function flipsAt(b,pos,side){if(b[pos]!==EMPTY)return[];const r=pos>>3,c=pos&7,out=[];for(const[dr,dc]of dirs){let y=r+dr,x=c+dc,line=[];while(y>=0&&y<8&&x>=0&&x<8&&b[y*8+x]===-side){line.push(y*8+x);y+=dr;x+=dc}if(line.length&&y>=0&&y<8&&x>=0&&x<8&&b[y*8+x]===side)out.push(...line)}return out}
function legal(b,side){const out=[];for(let i=0;i<64;i++)if(b[i]===EMPTY){const f=flipsAt(b,i,side);if(f.length)out.push({pos:i,flips:f})}return out}
function play(b,m,side){const n=b.slice();n[m.pos]=side;for(const i of m.flips)n[i]=side;return n}
function count(b,s){return b.reduce((a,v)=>a+(v===s),0)}
function emptyCount(b){return count(b,EMPTY)}
function terminal(b){return !legal(b,BLACK).length&&!legal(b,WHITE).length}

/* ---- 思考エンジン（engine.js）との橋渡し ---- */
const engineLocal=window.ReversiEngine.create();
// 画面表示用の静的評価（候補手の数値・形勢グラフ）
function evaluate(b,side){return engineLocal.staticEval(b,side,weights)}
function makeWorker(){try{const url=URL.createObjectURL(new Blob([window.ReversiEngine.workerSource],{type:'text/javascript'})),w=new Worker(url);if(patternPayload)w.postMessage(patternPayload);return w}catch(e){return null}}
// パターン評価の点数表（weights.js）を展開して、画面側のエンジンと Worker に渡す。読み込めない環境では従来の評価のまま
let patternPayload=null;
async function loadPatterns(){const P=window.REVERSI_PATTERN;if(!P||typeof DecompressionStream==='undefined')return;
  try{const bin=Uint8Array.from(atob(P.data),c=>c.charCodeAt(0));
    const buf=await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const info={coef:P.coef,scale:P.scale},data=new Int8Array(buf);
    if(!engineLocal.loadPatterns(info,data))return;
    patternPayload={type:'patterns',info,data};document.documentElement.dataset.eval='pattern';
    for(const ch of [cpuCh,coachCh])if(ch.worker)ch.worker.postMessage(patternPayload);
    if(gameStarted&&!thinking){coachKey='';render()}
  }catch(e){console.warn('パターン評価を読み込めませんでした',e)}}
function createChannel(){return{worker:makeWorker(),pending:null,seq:0}}
// 思考は Web Worker で行うので、考えている間も画面は固まらない。Worker が使えない環境では画面側で計算する
function runEngine(ch,req,cb){
  cancelEngine(ch);
  const id=++ch.seq;req.id=id;ch.pending=id;
  const fallback=()=>setTimeout(()=>{if(ch.pending!==id)return;ch.pending=null;let r;try{r=engineLocal.think(req)||{move:-1}}catch(e){r={move:-1,error:String(e.message||e)}}cb(r)},30);
  if(!ch.worker){fallback();return}
  ch.worker.onmessage=e=>{const r=e.data;if(ch.pending!==r.id)return;ch.pending=null;cb(r)};
  ch.worker.onerror=ev=>{if(ev&&ev.preventDefault)ev.preventDefault();if(ch.worker)ch.worker.terminate();ch.worker=null;if(ch.pending===id)fallback()};
  ch.worker.postMessage(req);
}
function cancelEngine(ch){if(ch.pending!=null){ch.pending=null;if(ch.worker){ch.worker.terminate();ch.worker=makeWorker()}}}
const cpuCh=createChannel(),coachCh=createChannel();
loadPatterns();
function formatNodes(n){return n>=1e8?(n/1e8).toFixed(1)+'億':n>=1e4?Math.round(n/1e4).toLocaleString()+'万':String(n)}
function formatSec(ms){return (ms/1000).toFixed(2)+'秒'}
function snapshots(){history.push({board:board.slice(),turn,moveHistory:moveHistory.slice(),evalHistory:evalHistory.slice(),finished});$('undoBtn').disabled=false}
function start(){cpuToken++;cancelEngine(cpuCh);cpuLog=[];$('cpuReport').hidden=true;cpuProofText='';cpuProof.textContent='';cpuProof.hidden=true;lastFlips=[];recommendedPos=null;guidePersistent=null;lastCPUAction=null;coachKey='';coachMove=null;clearPass();clearResult();clearThink();human=Number(document.querySelector('#colorChoice .selected').dataset.color);board=initial();turn=BLACK;history=[];moveHistory=[];evalHistory=[0];gameStarted=true;finished=false;$('setupPanel').hidden=true;$('gameLayout').hidden=false;$('resultBanner').hidden=true;$('reviewText').hidden=true;$('undoBtn').disabled=true;render();if(human!==BLACK)cpuTurn()}
function render(){if(!gameStarted)return;const moves=turn===human&&!finished?legal(board,human):[];let scored=[];if(moves.length){scored=moves.map(m=>({pos:m.pos,value:evaluate(play(board,m,human),human)})).sort((a,b)=>b.value-a.value)}recommendedPos=scored.length?scored[0].pos:null;updateCoach(moves,scored);const best=new Map(scored.map(x=>[x.pos,x.value])),max=Math.max(1,...scored.map(x=>Math.abs(x.value))),boardEl=$('board');boardEl.innerHTML='';for(let i=0;i<64;i++){const cell=document.createElement('button');cell.className='cell';cell.setAttribute('role','gridcell');cell.setAttribute('aria-label',`${coord(i)}${board[i]===BLACK?' 黒':board[i]===WHITE?' 白':''}${best.has(i)?' 合法手':''}`);if(best.has(i)&&!thinking)cell.classList.add('legal');if(i===recommendedPos&&!thinking)cell.classList.add('recommended');if(lastCPUAction){if(i===lastCPUAction.pos)cell.classList.add('cpu-last-move');if(lastCPUAction.flips.includes(i))cell.classList.add('cpu-flipped')}if([0,7,56,63].includes(i))cell.classList.add('corner-hint');if(board[i]){const disc=document.createElement('span');disc.className='disc '+(board[i]===BLACK?'black':'white');cell.append(disc)}else if(best.has(i)&&!thinking){const label=document.createElement('span');label.className='cell-eval';label.textContent=(best.get(i)>0?'+':'')+Math.round(best.get(i)/max*9);cell.append(label)}cell.disabled=!best.has(i)||thinking||finished;cell.addEventListener('pointerenter',()=>{if(turn===human)drawFlipGuide(i)});cell.addEventListener('focus',()=>{if(turn===human)drawFlipGuide(i)});cell.addEventListener('pointerleave',restoreFlipGuide);cell.addEventListener('blur',restoreFlipGuide);cell.addEventListener('click',()=>humanMove(i));boardEl.append(cell)}const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.id='flipGuide';svg.setAttribute('viewBox','0 0 100 100');svg.classList.add('flip-guide');boardEl.append(svg);if(guidePersistent)paintGuide(guidePersistent.pos,guidePersistent.side,guidePersistent.flips);$('youColor').textContent=human===BLACK?'黒':'白';$('cpuColor').textContent=human===BLACK?'白':'黒';$('youScore').textContent=count(board,human);$('cpuScore').textContent=count(board,-human);$('turnText').textContent=(turn===BLACK?'黒':'白')+'の手番';$('turnDot').className='stone '+(turn===BLACK?'black':'white');$('moveCount').textContent=moveHistory.length+'手目';$('gameTitle').textContent=finished?'対局終了':thinking?'CPUが思考中…':turn===human?'あなたの番です':'CPUの番です';$('thinkingBadge').hidden=!thinking;$('undoBtn').disabled=history.length<2||thinking;$('statusText').textContent=turn===human&&!finished?(lastCpuMsg&&cpuLog.length&&cpuLog[cpuLog.length-1].n===moveHistory.length?lastCpuMsg+` あなたの合法手は${moves.length}か所です。`:`合法手 ${moves.length}か所 · 候補に乗せると反転ラインを表示します。`):thinking?'盤面を読みながら次の一手を探しています。':'パス判定は自動で行います。';drawChart();updateOpening();if(passPending){showPassOverlay();$('statusText').textContent=passStatus()}if(resultShowing)showResultOverlay();if(longThink)showThinkOverlay();if(!finished&&!thinking&&!legal(board,turn).length)schedulePass()}function paintGuide(pos,side,flips){const svg=$('flipGuide');if(!svg)return;svg.innerHTML='';const set=new Set(flips),r=pos>>3,c=pos&7,NS='http://www.w3.org/2000/svg';for(const[dr,dc]of dirs){let y=r+dr,x=c+dc,last=null;while(y>=0&&y<8&&x>=0&&x<8&&set.has(y*8+x)){last={r:y,c:x};y+=dr;x+=dc}if(last){const line=document.createElementNS(NS,'line');line.setAttribute('x1',String(c*12.5+6.25));line.setAttribute('y1',String(r*12.5+6.25));line.setAttribute('x2',String(last.c*12.5+6.25));line.setAttribute('y2',String(last.r*12.5+6.25));line.setAttribute('class','flip-guide-line');svg.append(line)}}}function drawFlipGuide(pos){const m=legal(board,turn).find(x=>x.pos===pos);if(turn===human&&!thinking&&m)paintGuide(pos,turn,m.flips)}
function restoreFlipGuide(){if(guidePersistent)paintGuide(guidePersistent.pos,guidePersistent.side,guidePersistent.flips);else{const svg=$('flipGuide');if(svg)svg.innerHTML=''}}function humanMove(i){if(!gameStarted||turn!==human||thinking||finished)return;const m=legal(board,human).find(x=>x.pos===i);if(!m)return;snapshots();applyMove(m,human);if(!finished&&turn!==human&&legal(board,turn).length)cpuTurn()}
function applyMove(m,side){clearPass();if(side===human)guidePersistent={pos:m.pos,side,flips:m.flips.slice()};else{lastCPUAction={pos:m.pos,flips:m.flips.slice()};if(-side===human)guidePersistent=null}board=play(board,m,side);turn=-side;moveHistory.push({pos:m.pos,side});evalHistory.push(evaluate(board,human));if(terminal(board)){finish();return}render()}function schedulePass(){if(passPending||finished||thinking)return;passPending=true;$('passContinue').hidden=false;showPassOverlay();$('statusText').textContent=passStatus();passTimer=setTimeout(()=>{passTimer=null;continuePass()},PASS_DELAY)}
function clearPass(){if(passTimer){clearTimeout(passTimer);passTimer=null}passPending=false;$('passContinue').hidden=true;const o=document.querySelector('#board .is-pass');if(o)o.remove()}
function passStatus(){return`${turn===BLACK?'黒':'白'}パス · 2秒後に自動で進みます。`}
function showPassOverlay(){const boardEl=$('board');if(!boardEl||boardEl.querySelector('.is-pass'))return;const o=document.createElement('div');o.className='pass-overlay is-pass';o.setAttribute('role','status');o.setAttribute('aria-live','polite');const who=turn===human?'あなた':'CPU',color=turn===BLACK?'黒':'白';o.innerHTML=`<div class="pass-card"><span class="stone ${turn===BLACK?'black':'white'}"></span><strong>PASS</strong><small>${who}（${color}）は打てる場所がありません</small><i class="pass-progress"></i></div>`;boardEl.append(o)}
// 終局時: パス表示と同じ形のカードで「対局結果」を2秒間表示する
function showResultOverlay(){const boardEl=$('board');if(!boardEl||boardEl.querySelector('.result-overlay'))return;const you=count(board,human),cpu=count(board,-human),won=you>cpu,draw=you===cpu,o=document.createElement('div');o.className='pass-overlay result-overlay';o.setAttribute('role','status');o.setAttribute('aria-live','polite');o.innerHTML=`<div class="pass-card result-card ${won?'win':draw?'draw':'loss'}"><small class="result-kicker">対局結果</small><strong>${draw?'引き分け':won?'あなたの勝ち':'CPUの勝ち'}</strong><span class="result-score"><span class="stone ${human===BLACK?'black':'white'}"></span><b>${you}</b><i>–</i><b>${cpu}</b><span class="stone ${human===BLACK?'white':'black'}"></span></span><small>あなた（${human===BLACK?'黒':'白'}） · CPU（${human===BLACK?'白':'黒'}）</small><i class="pass-progress"></i></div>`;boardEl.append(o)}
// 長考中: パス表示と同じ形のカードで、考えている時間の目安をバーで表示する
function showThinkOverlay(){const boardEl=$('board');if(!longThink||!boardEl||boardEl.querySelector('.think-overlay'))return;const t=longThink,el=Math.round(performance.now()-t.start),color=t.side===BLACK?'黒':'白',o=document.createElement('div');o.className='pass-overlay think-overlay';o.setAttribute('role','status');o.setAttribute('aria-live','polite');o.innerHTML=`<div class="pass-card think-card"><span class="stone ${t.side===BLACK?'black':'white'}"></span><strong>長考中</strong><small>CPU（${color}）が残り${t.empt}マスを最後まで読んでいます</small><i class="think-progress" style="animation-duration:${t.budget}ms;animation-delay:-${el}ms"></i></div>`;boardEl.append(o)}
function clearThink(){if(thinkTimer){clearTimeout(thinkTimer);thinkTimer=null}longThink=null;const o=document.querySelector('#board .think-overlay');if(o)o.remove()}
function scheduleResult(){clearResult();resultShowing=true;showResultOverlay();resultTimer=setTimeout(()=>{resultTimer=null;clearResult()},RESULT_DELAY)}
function clearResult(){if(resultTimer){clearTimeout(resultTimer);resultTimer=null}resultShowing=false;const o=document.querySelector('#board .result-overlay');if(o)o.remove()}
function continuePass(){if(!passPending||finished||thinking)return;clearPass();if(terminal(board)){finish();return}turn=-turn;if(turn===human)guidePersistent=null;if(terminal(board)){finish();return}render();if(turn!==human)cpuTurn()}
// 初期配置を変えない4つの対称変換（そのまま・対角線2本での反転・180度回転）
const SYMS=[(c,r)=>[c,r],(c,r)=>[r,c],(c,r)=>[7-r,7-c],(c,r)=>[7-c,7-r]];
function symPos(name,t){const[x,y]=SYMS[t](name.charCodeAt(0)-97,Number(name.slice(1))-1);return y*8+x}
function bookLines(seq){const out=[];
  for(const line of window.REVERSI_BOOK||[])for(let t=0;t<SYMS.length;t++){
    if(seq.length>line.moves.length)continue;
    if(seq.every((p,i)=>symPos(line.moves[i],t)===p))out.push({line,sym:t,next:seq.length<line.moves.length?symPos(line.moves[seq.length],t):null});
  }
  return out}
function bookCandidates(side){const seq=moveHistory.map(m=>m.pos),ok=new Set(legal(board,side).map(m=>m.pos)),seen=new Map();
  for(const b of bookLines(seq))if(b.next!=null&&ok.has(b.next)&&!seen.has(b.next))seen.set(b.next,{sq:b.next,name:b.line.name,sym:b.sym!==0});
  return[...seen.values()]}
function cpuTurn(){if(finished||thinking||turn===human||!legal(board,turn).length)return;
  thinking=true;const token=++cpuToken;render();
  const levelKey=$('levelSelect').value,L=levels[levelKey],side=turn,empt=emptyCount(board),started=performance.now();
  // 最強モードの終盤（残り17〜20マス）は、完全読みのために最大3秒まで長考する
  const long=!!L.endBudget&&empt>=L.longFrom&&empt<=L.solve,budget=long?L.endBudget:L.budget;
  const req={board:board.slice(),side,weights:weights.slice(),level:{depth:L.depth,solve:L.solve,budget},book:L.book?bookCandidates(side):[]};
  clearThink();
  if(long)thinkTimer=setTimeout(()=>{thinkTimer=null;if(token!==cpuToken||!thinking)return;longThink={start:started,shown:performance.now(),budget,empt,side};showThinkOverlay();$('statusText').textContent=`CPUが長考中です。残り${empt}マスを最後まで読み切ろうとしています（最大${budget/1000}秒）。`},LONG_SHOW_MS);
  runEngine(cpuCh,req,r=>{
    // 一瞬で打つと何が起きたか追いにくいので、最低0.3秒は「考える」
    const now=performance.now(),wait=Math.max(0,300-(now-started),longThink?longThink.shown+LONG_MIN_MS-now:0);
    setTimeout(()=>{if(token!==cpuToken||finished||!gameStarted||turn!==side)return;
      thinking=false;clearThink();
      const ms=legal(board,side),m=ms.find(x=>x.pos===r.move)||ms[0];
      if(!m){render();return}
      snapshots();applyMove(m,side);
      logCpuMove(r,m,empt,levelKey)},wait)})}
function logCpuMove(r,m,empt,levelKey){
  const e={n:moveHistory.length,pos:m.pos,mode:r.mode||'search',depth:r.depth||0,ms:r.ms||0,nodes:r.nodes||0,empt,exact:r.exact,wld:r.wld,book:r.bookName,bookSym:r.bookSym,corner:[0,7,56,63].includes(m.pos),level:levelKey};
  cpuLog.push(e);
  const mv=coord(m.pos).toUpperCase();
  const msg=e.mode==='book'?`CPU：定石「${e.book}」${e.bookSym?'（回転・反転した同じ形）':''}に沿って ${mv}。探索でも損がないことを確かめました。`
    :e.mode==='forced'?`CPU：打てる場所が ${mv} だけでした。`
    :e.mode==='exact'?`CPU：残り${empt}マスを最後まで完全に読み切って ${mv}（${formatSec(e.ms)}・${formatNodes(e.nodes)}局面）。`
    :e.mode==='wld'?`CPU：残り${empt}マスの勝敗を読み切って ${mv}（${formatSec(e.ms)}）。`
    :`CPU：${e.depth}手先まで読んで ${mv}（${formatSec(e.ms)}・${formatNodes(e.nodes)}局面）。`;
  lastCpuMsg=msg;
  if(!finished)$('statusText').textContent=passPending?msg+` ${turn===BLACK?'黒':'白'}はパスです。2秒後に自動で進みます。`:turn===human?msg+` あなたの合法手は${legal(board,human).length}か所です。`:msg;
  const proven=(e.mode==='exact'&&e.exact>0)||(e.mode==='wld'&&e.wld==='win');
  if(proven&&$('cpuProof').hidden){
    cpuProofText=e.mode==='exact'?`CPUの勝ち確定 · 残り${empt}マスを完全に読み切りました。この先あなたがどう打っても、CPUは最低 ${e.exact} 石差で勝ちます。`:`CPUの勝ち確定 · 残り${empt}マスの勝敗を読み切りました（石差まではまだ読み切れていません）。`;
    $('cpuProof').hidden=false;$('cpuProof').textContent=cpuProofText}}
function finish(){finished=true;thinking=false;clearPass();clearThink();const you=count(board,human),cpu=count(board,-human),won=you>cpu,draw=you===cpu;const banner=$('resultBanner');banner.hidden=false;banner.className='result-banner '+(won?'win':draw?'':'loss');banner.textContent=`${draw?'引き分け':won?'あなたの勝ち':'CPUの勝ち'} · あなた ${you} – ${cpu} CPU`;$('gameTitle').textContent='対局終了';$('turnText').textContent='終局';$('turnDot').className='stone '+(turn===BLACK?'black':'white');const biggest=evalHistory.reduce((best,v,i)=>Math.abs(v-(evalHistory[i-1]||0))>best.delta?{delta:Math.abs(v-(evalHistory[i-1]||0)),i}:best,{delta:0,i:0});renderCpuReport();$('reviewText').hidden=false;$('reviewText').textContent=biggest.i?`振り返り：${biggest.i}手目付近で形勢が大きく動きました。${won?'勝ちを支えた手や角の活用を振り返り、同じ判断を再現しましょう。':draw?'終盤の着手可能数と角周辺の安全性を見直してみましょう。':'その前後の候補手と相手の返しを比べ、角・着手可能数・中割りの観点で再検討しましょう。'}`:`振り返り：最後まで形勢を大きく崩さず進みました。石数だけでなく、角と着手可能数の推移も見直してみましょう。`;render();scheduleResult()}
function undo(){if(history.length<2||thinking)return;clearPass();clearResult();clearThink();cpuProofText='';lastFlips=[];guidePersistent=null;lastCPUAction=null;coachKey='';coachMove=null;cpuToken++;thinking=false;cancelEngine(cpuCh);history.pop();const h=history.pop();board=h.board;turn=h.turn;moveHistory=h.moveHistory;evalHistory=h.evalHistory;finished=h.finished;cpuLog=cpuLog.filter(e=>e.n<=moveHistory.length);$('cpuProof').hidden=true;$('cpuReport').hidden=true;$('resultBanner').hidden=true;$('reviewText').hidden=true;render()}function updateCoach(moves,scored){const rec=$('recommendation');
  if(!gameStarted||finished){rec.hidden=true;$('adviceText').textContent=finished?'対局を振り返り、各候補の狙いを確認しましょう。':'対局開始後、最強CPUと同じ探索で候補を読みます。';return}
  rec.hidden=!moves.length;
  if(!moves.length){$('adviceText').textContent='合法手がないためパスです。相手の次の着手を待ちましょう。';return}
  const key=board.join('')+'|'+weights.join(',')+'|'+human;
  if(key!==coachKey){coachKey=key;coachMove=null;
    const S=levels.strong;
    runEngine(coachCh,{board:board.slice(),side:human,weights:weights.slice(),level:{depth:S.depth,solve:S.solve,budget:COACH_MS},book:[]},r=>{
      if(coachKey!==key)return;coachMove=r;
      if(gameStarted&&!finished&&!thinking&&turn===human)render()})}
  if(!coachMove||coachMove.move<0){recommendedPos=null;
    $('adviceText').textContent='最強CPUと同じ探索で、あなたの候補手を読んでいます…';
    $('recommendMove').textContent='…';$('recommendEval').textContent='';return}
  const best=scored.find(x=>x.pos===coachMove.move)||scored[0],p=best.pos;
  recommendedPos=p;
  const r=p>>3,c=p&7,flips=legal(board,human).find(m=>m.pos===p).flips,opp=legal(play(board,{pos:p,flips},human),-human).length,corner=[0,7,56,63],x=[9,14,49,54],edge=r===0||r===7||c===0||c===7;
  let why=corner.includes(p)?'角を確保して、確定石を作る足場になります':x.includes(p)?'X打ちに近い危険な位置です。隅を渡さないか確認しましょう':edge?'辺の形と隅へのつながりを確認しましょう':opp<=3?'相手の選択肢を絞る手です':'中央を保ち、相手の返しを少なくする候補です';
  const cm=coachMove,basis=cm.mode==='exact'?`残り${cm.empties}マスの完全読み`:cm.mode==='wld'?`残り${cm.empties}マスの勝敗読み`:cm.mode==='forced'?'唯一の合法手':`${cm.depth}手先までの探索`;
  let verdict='';
  if(cm.mode==='exact')verdict=cm.exact>0?` 最善を続ければ ${cm.exact} 石差で勝てます。`:cm.exact<0?` 最善を尽くしても ${-cm.exact} 石差の負けですが、相手のミスを待ちましょう。`:' 最善同士なら引き分けです。';
  else if(cm.mode==='wld')verdict=cm.wld==='win'?' 最善を続ければ勝てる局面です。':cm.wld==='draw'?' 最善同士なら引き分けです。':'';
  $('adviceText').textContent=`最強CPU（${basis}）のおすすめは ${coord(p).toUpperCase()} です。${why}。相手の合法手は約${opp}か所になる見込みです。${verdict}`;
  $('recommendMove').textContent=coord(p).toUpperCase();
  $('recommendEval').textContent=cm.mode==='exact'?`完全読み · ${cm.exact>0?'+':''}${cm.exact}石`:'最強 · '+(cm.value>0?'+':'')+Math.round(cm.value)}
function renderCpuReport(){const card=$('cpuReport'),body=$('cpuReportBody');
  if(!cpuLog.length){card.hidden=true;return}
  const log=cpuLog,book=log.filter(e=>e.mode==='book'),search=log.filter(e=>e.mode==='search'),solved=log.filter(e=>e.mode==='exact'||e.mode==='wld');
  const sum=(a,f)=>a.reduce((t,e)=>t+f(e),0);
  const avgDepth=search.length?(sum(search,e=>e.depth)/search.length).toFixed(1):'—',maxDepth=search.length?Math.max(...search.map(e=>e.depth)):'—';
  const avgMs=sum(log,e=>e.ms)/log.length,maxMs=Math.max(...log.map(e=>e.ms)),nodes=sum(log,e=>e.nodes);
  const proof=log.find(e=>(e.mode==='exact'&&e.exact>0)||(e.mode==='wld'&&e.wld==='win'));
  const corners=log.filter(e=>e.corner).map(e=>`${e.n}手目 ${coord(e.pos).toUpperCase()}`);
  const names=[...new Set(book.map(e=>e.book))];
  const esc=t=>String(t).replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
  const stat=(k,v)=>`<div><dt>${k}</dt><dd>${v}</dd></div>`;
  const notes=[];
  if(names.length)notes.push(`序盤は定石「${names.map(esc).join('」「')}」を${book.length}手使いました。`);
  if(corners.length)notes.push(`CPUが隅を取った手: ${corners.join('、')}。`);
  if(proof)notes.push(`${proof.n}手目（残り${proof.empt}マス）の時点で、CPUは勝ちを読み切っていました。`);
  else if(solved.length)notes.push(`残り${solved[0].empt}マスから最後まで読み切って打ちました。`);
  body.innerHTML=`<p class="report-level">レベル: ${LEVEL_NAMES[log[log.length-1].level]||''} · CPUの着手 ${log.length}手</p>
  <dl class="report-stats">${stat('定石',book.length+'手')}${stat('中盤の探索',search.length?`${search.length}手 · 平均${avgDepth}手先（最大${maxDepth}手先）`:'—')}${stat('終盤の読み切り',solved.length?`${solved.length}手 · 残り${solved[0].empt}マスから`:'なし')}${stat('思考時間',`平均${formatSec(avgMs)} · 最長${formatSec(maxMs)}`)}${stat('読んだ局面',`合計 約${formatNodes(nodes)}`)}</dl>
  ${notes.length?`<p class="report-notes">${notes.join('')}</p>`:''}
  <h4>このCPUが強い理由</h4>
  <ul class="report-list">
    <li><b>深く読む</b> 1手1.5秒の持ち時間の中で、浅い読みから少しずつ深くしていきます（反復深化）。盤面を64ビットの「ビットボード」で持ち、合法手をビット演算でまとめて求めるので、1秒あたり100万局面以上を読めます。一度読んだ局面を覚える「置換表」と、有望な手から先に読む工夫で、中盤で10〜13手先まで読みます。</li>
    <li><b>隅と辺を正しく評価</b> 辺に並ぶ石の形6561通りをあらかじめ調べておき、隅と確定石を高く、隅が空いたままのC打ち・X打ちを大きく減点します。</li>
    <li><b>パターンで形を覚えた評価</b> 辺・隅・行・斜めなど盤面46か所の石の並びごとに点数表を持ち、着手可能数などと合わせて局面を評価します。点数表は、約10万局の自己対戦の結果から序盤〜終盤の12段階ごとに学習しました。</li>
    <li><b>相手の選択肢を奪う</b> 自分の打てる場所を増やし、相手の打てる場所を減らす手を重視します。相手をパスに追い込む手は特に高く評価します。</li>
    <li><b>終盤は完全読み</b> 残り約20マスからは最大3秒まで長考し、勝ち負けを、さらに石差まで最後の一手まで読み切ります。空きマスが奇数の区画から打つ「偶数理論」の順で読み、勝ちを読み切ったら、その勝ちを逃さない手を選びます。</li>
    <li><b>定石は検証してから</b> 回転・反転した同じ形でも定石を認識し、探索で損がないことを確かめてから使います。</li>
  </ul>`;
  card.hidden=false}
function updateOpening(){const seq=moveHistory.map(m=>m.pos);
  const hits=bookLines(seq),found=hits.find(h=>h.sym===0)||hits[0];
  if(found){const name=found.line.name+(found.sym?'（回転・反転形）':'');
    $('openingName').textContent=`CPUの定石 · ${name}`;
    $('openingText').textContent=seq.length===0?'上級・最強モードは登録された定石から開始します。相手が別の手を選ぶと、定石を外れて探索で応じます。':moveHistory.at(-1)?.side===human?`現在は${name}の進行候補です。CPUは定石手が探索でも悪くないことを確かめてから打ちます。`:`CPUは${name}の手順に沿って進行しています。定石の分岐を外れた場合は探索で続けます。`}
  else{$('openingName').textContent='CPUの定石外 · 探索中';$('openingText').textContent='登録した定石ラインから外れています。CPUは現在の局面評価と探索で次の手を選んでいます。'}}
function drawChart(){const canvas=$('evalChart');if(!canvas)return;const rect=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;canvas.width=Math.max(1,rect.width*dpr);canvas.height=Math.max(1,rect.height*dpr);const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);const w=rect.width,h=rect.height,pad=12;ctx.clearRect(0,0,w,h);ctx.strokeStyle='#e6ece7';ctx.lineWidth=1;for(let j=0;j<3;j++){let y=pad+j*(h-2*pad)/2;ctx.beginPath();ctx.moveTo(pad,y);ctx.lineTo(w-pad,y);ctx.stroke()}ctx.fillStyle='#98a59d';ctx.font='9px sans-serif';ctx.fillText('+',1,pad+3);ctx.fillText('0',3,h/2+3);ctx.fillText('−',2,h-pad+3);if(evalHistory.length<2)return;const cap=v=>Math.max(-100,Math.min(100,v))/200,xy=(v,i)=>({x:pad+i*(w-2*pad)/60,y:h/2-cap(v)*(h-2*pad)});for(let i=1;i<evalHistory.length;i++){const a=xy(evalHistory[i-1],i-1),b=xy(evalHistory[i],i),positive=(evalHistory[i-1]+evalHistory[i])>=0;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=positive?'#4f936b':'#d58a67';ctx.lineWidth=2.4;ctx.stroke()}ctx.fillStyle='#607269';ctx.font='9px sans-serif';ctx.fillText('有利',pad,h-1)}function createWeightGrid(){const grid=$('weightGrid');grid.innerHTML='';weights.forEach((v,i)=>{const input=document.createElement('input');input.type='number';input.value=v;input.setAttribute('aria-label',`${coord(i)}の評価値`);input.addEventListener('input',()=>{const n=Number(input.value);if(Number.isFinite(n)){weights[i]=n;if(gameStarted)render()}});grid.append(input)})}
document.querySelectorAll('#colorChoice button').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('#colorChoice button').forEach(x=>x.classList.toggle('selected',x===b))}));$('startBtn').addEventListener('click',start);$('passContinue').addEventListener('click',continuePass);$('undoBtn').addEventListener('click',undo);$('restartBtn').addEventListener('click',()=>{cpuToken++;thinking=false;cancelEngine(cpuCh);cancelEngine(coachCh);coachKey='';clearPass();clearResult();clearThink();cpuProofText='' ;$('cpuProof').hidden=true;gameStarted=false;$('gameLayout').hidden=true;$('setupPanel').hidden=false});$('debugToggle').addEventListener('click',()=>{const p=$('debugPanel');p.hidden=!p.hidden;$('debugToggle').innerHTML=p.hidden?'評価値エディタ <span>＋</span>':'評価値エディタ <span>−</span>';if(!p.hidden)p.scrollIntoView({behavior:'smooth',block:'nearest'})});$('resetWeights').addEventListener('click',()=>{weights=baseWeights.flat();createWeightGrid();if(gameStarted)render()});window.addEventListener('resize',drawChart);createWeightGrid();
})();






























