/*
 * engine.js — MIYUKI REVERSI STUDIO 思考エンジン
 *
 * 画面を固めないよう Web Worker の中で動かすことを前提にしています（通常のスクリプトとしても動作）。
 *  - 中盤: 反復深化 + PVS（主変化探索）+ 置換表 + 着手順序づけ（相手の着手可能数が少ない手から）
 *  - 評価: 着手可能数 / 潜在的着手可能数 / 辺パターン表（確定石・隅・C打ち）/ X打ち / 偶数理論
 *  - 終盤: 残りマスが少なくなったら勝敗読み切り（WLD）→ 石差の完全読み切り
 *  - 定石: 画面側から渡された定石手を、探索で大きく損しないか確認してから採用
 */
function createReversiEngine() {
  'use strict';

  const INF = 1000000;
  const WIN = 10000;            // 終局の評価: 勝ち = WIN + 石差 * DISC
  const DISC = 100;
  const MAX_PLY = 96;
  const now = () => performance.now();

  /* ---------- 盤面の下準備（方向ごとの直線・隣接マス） ---------- */
  const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  const RAYS = new Array(64);
  const NEIGH = new Array(64);
  for (let sq = 0; sq < 64; sq++) {
    const r = sq >> 3, c = sq & 7, rays = [], nb = [];
    for (const [dr, dc] of DIRS) {
      const line = [];
      let y = r + dr, x = c + dc;
      while (y >= 0 && y < 8 && x >= 0 && x < 8) { line.push(y * 8 + x); y += dr; x += dc; }
      if (line.length) nb.push(line[0]);
      if (line.length >= 2) rays.push(Int8Array.from(line));
    }
    RAYS[sq] = rays;
    NEIGH[sq] = Int8Array.from(nb);
  }
  const CORNERS = [0, 7, 56, 63];
  const X_OF = [9, 14, 49, 54];   // 各隅の斜め隣
  const EDGES = [
    [0, 1, 2, 3, 4, 5, 6, 7], [56, 57, 58, 59, 60, 61, 62, 63],
    [0, 8, 16, 24, 32, 40, 48, 56], [7, 15, 23, 31, 39, 47, 55, 63]
  ].map(e => Int8Array.from(e));
  // 着手順序づけ用の静的な優先度（隅 > 辺 > 中央 > C > X）
  const PRIO = Int8Array.from([
    20, -6, 8, 6, 6, 8, -6, 20,
    -6, -12, -2, -1, -1, -2, -12, -6,
    8, -2, 3, 1, 1, 3, -2, 8,
    6, -1, 1, 0, 0, 1, -1, 6,
    6, -1, 1, 0, 0, 1, -1, 6,
    8, -2, 3, 1, 1, 3, -2, 8,
    -6, -12, -2, -1, -1, -2, -12, -6,
    20, -6, 8, 6, 6, 8, -6, 20
  ]);

  /* ---------- 辺パターン表（3^8 = 6561 通りを起動時に計算） ---------- */
  const EDGE_TABLE = new Int32Array(6561);
  (function buildEdgeTable() {
    const cells = new Int8Array(8), stable = new Int8Array(8);
    for (let idx = 0; idx < 6561; idx++) {
      let t = idx;
      for (let i = 0; i < 8; i++) { const d = t % 3; t = (t - d) / 3; cells[i] = d === 1 ? 1 : d === 2 ? -1 : 0; }
      stable.fill(0);
      let full = true;
      for (let i = 0; i < 8; i++) if (!cells[i]) full = false;
      if (full) stable.fill(1);
      else {
        if (cells[0]) for (let i = 0; i < 8 && cells[i] === cells[0]; i++) stable[i] = 1;
        if (cells[7]) for (let i = 7; i >= 0 && cells[i] === cells[7]; i--) stable[i] = 1;
      }
      let v = 0;
      for (let i = 0; i < 8; i++) if (cells[i] && stable[i]) v += cells[i] * 12;   // 辺の確定石
      v += (cells[0] + cells[7]) * 30;                                           // 隅
      // 隅が空いているのに C マスへ打っている形は危険
      for (const [corner, cSq, step] of [[0, 1, 1], [7, 6, -1]]) {
        const col = cells[cSq];
        if (cells[corner] !== 0 || col === 0) continue;
        v -= col * 14;
        let j = cSq;
        while (j >= 0 && j < 8 && cells[j] === col) j += step;
        if (j >= 0 && j < 8 && cells[j] === -col) v -= col * 22;   // 相手が今すぐ隅を取れる
      }
      EDGE_TABLE[idx] = v;
    }
  })();

  /* ---------- ゾブリストハッシュ（置換表のキー） ---------- */
  let seed = 0x2545f491;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; };
  const ZB_LO = new Int32Array(64), ZB_HI = new Int32Array(64), ZW_LO = new Int32Array(64), ZW_HI = new Int32Array(64);
  const ZF_LO = new Int32Array(64), ZF_HI = new Int32Array(64);
  for (let i = 0; i < 64; i++) {
    ZB_LO[i] = rnd(); ZB_HI[i] = rnd(); ZW_LO[i] = rnd(); ZW_HI[i] = rnd();
    ZF_LO[i] = ZB_LO[i] ^ ZW_LO[i]; ZF_HI[i] = ZB_HI[i] ^ ZW_HI[i];
  }
  const ZS_LO = rnd(), ZS_HI = rnd();

  /* ---------- 探索用の状態 ---------- */
  const board = new Int8Array(64);
  let empties = 0, discSum = 0, hLo = 0, hHi = 0;
  const fstack = new Int8Array(64 * 64);
  let fsp = 0;
  const moveBuf = new Int8Array(64 * MAX_PLY);
  const scoreBuf = new Int32Array(64 * MAX_PLY);
  const hist = new Int32Array(128);
  const nextE = new Int8Array(65), prevE = new Int8Array(65);   // 空きマスの連結リスト（64 = 先頭）
  const W = new Float64Array(64);
  let weightsSig = '';
  let nodes = 0, deadline = Infinity;
  const ABORT = { abort: true };

  // 置換表（中盤用・終盤用）は最初の探索時に確保
  const TT_SIZE = 1 << 20, TT_MASK = TT_SIZE - 1;
  const EG_SIZE = 1 << 19, EG_MASK = EG_SIZE - 1;
  let ttKey, ttDepth, ttFlag, ttVal, ttMove, egKey, egLo, egUp, egMove;
  function ensureTables() {
    if (ttKey) return;
    ttKey = new Int32Array(TT_SIZE); ttDepth = new Int8Array(TT_SIZE).fill(-1);
    ttFlag = new Uint8Array(TT_SIZE); ttVal = new Int32Array(TT_SIZE); ttMove = new Int8Array(TT_SIZE);
    egKey = new Int32Array(EG_SIZE); egLo = new Int8Array(EG_SIZE); egUp = new Int8Array(EG_SIZE);
    egMove = new Int8Array(EG_SIZE).fill(-1);
  }
  function clearTables() {
    if (!ttKey) return;
    ttDepth.fill(-1); egMove.fill(-1); egKey.fill(0); egLo.fill(-64); egUp.fill(64);
  }

  function setBoard(arr) {
    empties = 0; discSum = 0; hLo = 0; hHi = 0; fsp = 0;
    for (let i = 0; i < 64; i++) {
      const v = arr[i] | 0;
      board[i] = v;
      if (v === 0) empties++;
      else { discSum += v; if (v === 1) { hLo ^= ZB_LO[i]; hHi ^= ZB_HI[i]; } else { hLo ^= ZW_LO[i]; hHi ^= ZW_HI[i]; } }
    }
  }
  function setWeights(w) {
    if (!w || w.length !== 64) return;
    const sig = w.join(',');
    if (sig === weightsSig) return;
    weightsSig = sig;
    for (let i = 0; i < 64; i++) W[i] = Number(w[i]) || 0;
    clearTables();
  }

  /* ---------- 着手・取り消し ---------- */
  function canMove(sq, side) {
    const rays = RAYS[sq], opp = -side;
    for (let k = 0; k < rays.length; k++) {
      const ray = rays[k];
      if (board[ray[0]] !== opp) continue;
      for (let j = 1; j < ray.length; j++) {
        const v = board[ray[j]];
        if (v === opp) continue;
        if (v === side) return true;
        break;
      }
    }
    return false;
  }
  function doMove(sq, side) {
    const rays = RAYS[sq], opp = -side;
    let n = 0;
    for (let k = 0; k < rays.length; k++) {
      const ray = rays[k];
      if (board[ray[0]] !== opp) continue;
      let j = 1;
      while (j < ray.length && board[ray[j]] === opp) j++;
      if (j < ray.length && board[ray[j]] === side) {
        for (let t = 0; t < j; t++) {
          const s = ray[t];
          board[s] = side; fstack[fsp++] = s; hLo ^= ZF_LO[s]; hHi ^= ZF_HI[s];
        }
        n += j;
      }
    }
    board[sq] = side; empties--; discSum += side * (2 * n + 1);
    if (side === 1) { hLo ^= ZB_LO[sq]; hHi ^= ZB_HI[sq]; } else { hLo ^= ZW_LO[sq]; hHi ^= ZW_HI[sq]; }
    return n;
  }
  function undoMove(sq, side, n) {
    const opp = -side;
    for (let t = 0; t < n; t++) { const s = fstack[--fsp]; board[s] = opp; hLo ^= ZF_LO[s]; hHi ^= ZF_HI[s]; }
    board[sq] = 0; empties++; discSum -= side * (2 * n + 1);
    if (side === 1) { hLo ^= ZB_LO[sq]; hHi ^= ZB_HI[sq]; } else { hLo ^= ZW_LO[sq]; hHi ^= ZW_HI[sq]; }
  }
  function genMoves(side, base) {
    let n = 0;
    for (let sq = 0; sq < 64; sq++) if (board[sq] === 0 && canMove(sq, side)) moveBuf[base + n++] = sq;
    return n;
  }
  function mobility(side) {
    let n = 0;
    for (let sq = 0; sq < 64; sq++) if (board[sq] === 0 && canMove(sq, side)) n++;
    return n;
  }
  function snapshot() { return { b: board.slice(), empties, discSum, hLo, hHi, fsp }; }
  function restore(s) { board.set(s.b); empties = s.empties; discSum = s.discSum; hLo = s.hLo; hHi = s.hHi; fsp = s.fsp; }
  function tick() { if ((++nodes & 1023) === 0 && now() > deadline) throw ABORT; }

  /* ---------- 評価関数 ---------- */
  function finalScore(side) {
    const d = discSum * side;
    return d > 0 ? WIN + d * DISC : d < 0 ? -WIN + d * DISC : 0;
  }
  function evaluate(side) {
    const e = empties, opp = -side;
    let myMob = 0, opMob = 0, myPot = 0, opPot = 0, myFr = 0, opFr = 0, disc = 0, pos = 0;
    for (let sq = 0; sq < 64; sq++) {
      const v = board[sq], nb = NEIGH[sq];
      if (v === 0) {
        let adjMe = false, adjOp = false;
        for (let k = 0; k < nb.length; k++) { const w = board[nb[k]]; if (w === side) adjMe = true; else if (w === opp) adjOp = true; }
        if (adjOp) { myPot++; if (canMove(sq, side)) myMob++; }
        if (adjMe) { opPot++; if (canMove(sq, opp)) opMob++; }
      } else {
        const s = v === side ? 1 : -1;
        disc += s; pos += s * W[sq];
        for (let k = 0; k < nb.length; k++) if (board[nb[k]] === 0) { if (s > 0) myFr++; else opFr++; break; }
      }
    }
    if (myMob === 0 && opMob === 0) return finalScore(side);

    let score = 0;
    // 1) 着手可能数（相手の選択肢を減らすほど良い）
    const mobW = e > 44 ? 9 : e > 24 ? 8 : e > 12 ? 6 : 4;
    score += (myMob - opMob) * mobW + 36 * (myMob - opMob) / (myMob + opMob + 2);
    if (opMob === 0) score += 18;          // 相手をパスに追い込める
    else if (myMob === 0) score -= 18;
    // 2) 潜在的な着手可能数と、外側に接する石（壁）の少なさ
    const potW = e > 30 ? 3 : e > 15 ? 2 : 1;
    score += (myPot - opPot) * potW + (opFr - myFr) * potW;
    // 3) 辺パターン（隅・辺の確定石・C打ち）
    for (let k = 0; k < 4; k++) {
      const edge = EDGES[k];
      let idx = 0;
      for (let i = 7; i >= 0; i--) { const v = board[edge[i]]; idx = idx * 3 + (v === side ? 1 : v === 0 ? 0 : 2); }
      score += EDGE_TABLE[idx];
    }
    // 4) 隅が空いている X マス
    const xPen = e > 20 ? 24 : 12;
    for (let k = 0; k < 4; k++) {
      if (board[CORNERS[k]] !== 0) continue;
      const x = board[X_OF[k]];
      if (x) score += x === side ? -xPen : xPen;
    }
    // 5) マスの重み表（評価値エディタで変更可能）
    score += pos * 0.2;
    // 6) 石数: 序盤は少ないほうが良く、終盤は多いほうが良い
    if (e >= 40) score -= disc * 0.6;
    else if (e <= 14) score += disc * (e <= 8 ? 6 : 3);
    // 7) 偶数理論: 最後の一手を打てる側が有利
    if (e <= 24) score += (e & 1) ? 5 : -5;
    score = Math.round(score);
    return score > 9000 ? 9000 : score < -9000 ? -9000 : score;
  }

  /* ---------- 中盤探索: PVS + 置換表 ---------- */
  function orderMoves(base, n, side, ttm, depth) {
    const hb = side === 1 ? 0 : 64;
    for (let i = 0; i < n; i++) {
      const sq = moveBuf[base + i];
      let s;
      if (sq === ttm) s = 1 << 30;
      else if (depth >= 3) {
        const f = doMove(sq, side);
        const om = mobility(-side);
        undoMove(sq, side, f);
        s = -om * 4096 + PRIO[sq] * 64 + (hist[hb + sq] >> 4);
      } else s = PRIO[sq] * 4096 + hist[hb + sq];
      scoreBuf[base + i] = s;
    }
    for (let i = 1; i < n; i++) {
      const m = moveBuf[base + i], s = scoreBuf[base + i];
      let j = i - 1;
      while (j >= 0 && scoreBuf[base + j] < s) { moveBuf[base + j + 1] = moveBuf[base + j]; scoreBuf[base + j + 1] = scoreBuf[base + j]; j--; }
      moveBuf[base + j + 1] = m; scoreBuf[base + j + 1] = s;
    }
  }
  function negamax(depth, alpha, beta, side, passed, ply) {
    tick();
    if (depth <= 0) return evaluate(side);
    const kLo = side === 1 ? hLo : hLo ^ ZS_LO, kHi = side === 1 ? hHi : hHi ^ ZS_HI;
    const idx = kLo & TT_MASK;
    let ttm = -1;
    if (ttKey[idx] === kHi && ttDepth[idx] >= 0) {
      ttm = ttMove[idx];
      if (ttDepth[idx] >= depth) {
        const v = ttVal[idx], f = ttFlag[idx];
        if (f === 1) return v;
        if (f === 2 && v >= beta) return v;
        if (f === 3 && v <= alpha) return v;
      }
    }
    const base = ply * 64;
    const n = genMoves(side, base);
    if (n === 0) {
      if (passed) return finalScore(side);
      return -negamax(depth, -beta, -alpha, -side, true, ply + 1);
    }
    orderMoves(base, n, side, ttm, depth);
    let best = -INF, bestMove = -1, a = alpha;
    for (let i = 0; i < n; i++) {
      const sq = moveBuf[base + i];
      const f = doMove(sq, side);
      let v;
      if (i === 0) v = -negamax(depth - 1, -beta, -a, -side, false, ply + 1);
      else {
        v = -negamax(depth - 1, -a - 1, -a, -side, false, ply + 1);
        if (v > a && v < beta) v = -negamax(depth - 1, -beta, -a, -side, false, ply + 1);
      }
      undoMove(sq, side, f);
      if (v > best) {
        best = v; bestMove = sq;
        if (v > a) { a = v; if (a >= beta) { hist[(side === 1 ? 0 : 64) + sq] += depth * depth; break; } }
      }
    }
    if (ttKey[idx] !== kHi || depth >= ttDepth[idx]) {
      ttKey[idx] = kHi; ttDepth[idx] = depth; ttVal[idx] = best; ttMove[idx] = bestMove;
      ttFlag[idx] = best <= alpha ? 3 : best >= beta ? 2 : 1;
    }
    return best;
  }
  function midgameRoot(side, rootMoves, maxDepth, softEnd) {
    let order = rootMoves.slice();
    const scores = new Map();
    let result = null;
    for (let depth = 1; depth <= maxDepth; depth++) {
      let alpha = -INF, bestVal = -INF, bestMove = -1, done = 0;
      const snap = snapshot();
      try {
        for (let i = 0; i < order.length; i++) {
          const sq = order[i];
          const f = doMove(sq, side);
          let v;
          if (i === 0) v = -negamax(depth - 1, -INF, INF, -side, false, 1);
          else {
            v = -negamax(depth - 1, -alpha - 1, -alpha, -side, false, 1);
            if (v > alpha) v = -negamax(depth - 1, -INF, -alpha, -side, false, 1);
          }
          undoMove(sq, side, f);
          scores.set(sq, v);
          if (v > bestVal) { bestVal = v; bestMove = sq; }
          if (v > alpha) alpha = v;
          done++;
        }
      } catch (err) {
        if (err !== ABORT) throw err;
        restore(snap);
        // 途中までの結果でも、前回の最善手より良いと確かめられた手は採用できる
        if (done > 0 && result && bestMove !== result.move && bestVal > scores.get(result.move)) result = { move: bestMove, value: bestVal, depth, scores };
        return { result, aborted: true };
      }
      result = { move: bestMove, value: bestVal, depth, scores: new Map(scores) };
      order.sort((x, y) => scores.get(y) - scores.get(x));
      if (depth >= empties) break;                 // 最後まで読めた
      if (now() > softEnd) break;                  // 次の深さは時間内に終わらない見込み
    }
    return { result, aborted: false };
  }

  /* ---------- 終盤探索: 完全読み切り ---------- */
  function buildEmptyList(order) {
    let prev = 64;
    for (const sq of order) { nextE[prev] = sq; prevE[sq] = prev; prev = sq; }
    nextE[prev] = 64; prevE[64] = prev;
  }
  function unlink(sq) { nextE[prevE[sq]] = nextE[sq]; prevE[nextE[sq]] = prevE[sq]; }
  function relink(sq) { nextE[prevE[sq]] = sq; prevE[nextE[sq]] = sq; }
  function egMobility(side) {
    let n = 0;
    for (let sq = nextE[64]; sq !== 64; sq = nextE[sq]) if (canMove(sq, side)) n++;
    return n;
  }
  // 戻り値: 手番側から見た最終石差（空きマスは数えない＝画面の勝敗判定と同じ）
  function solve(alpha, beta, side, passed, ply) {
    tick();
    if (empties === 0) return discSum * side;
    const useTT = empties >= 9;
    let idx = 0, kHi = 0, ttm = -1;
    if (useTT) {
      const kLo = side === 1 ? hLo : hLo ^ ZS_LO;
      kHi = side === 1 ? hHi : hHi ^ ZS_HI;
      idx = kLo & EG_MASK;
      if (egKey[idx] === kHi && egMove[idx] >= 0) {
        const lo = egLo[idx], up = egUp[idx];
        if (lo >= beta) return lo;
        if (up <= alpha) return up;
        if (lo === up) return lo;
        if (lo > alpha) alpha = lo;
        if (up < beta) beta = up;
        ttm = egMove[idx];
      }
    }
    const alphaOrig = alpha;
    let best = -INF, bestMove = -1;
    if (empties >= 7) {
      // 速攻順（相手の着手可能数が少なくなる手から読む）
      const base = ply * 64;
      let n = 0;
      for (let sq = nextE[64]; sq !== 64; sq = nextE[sq]) {
        if (!canMove(sq, side)) continue;
        const f = doMove(sq, side); unlink(sq);
        let s = -egMobility(-side) * 64 + PRIO[sq];
        if (sq === ttm) s += 1 << 20;
        relink(sq); undoMove(sq, side, f);
        moveBuf[base + n] = sq; scoreBuf[base + n] = s; n++;
      }
      for (let i = 1; i < n; i++) {
        const m = moveBuf[base + i], s = scoreBuf[base + i];
        let j = i - 1;
        while (j >= 0 && scoreBuf[base + j] < s) { moveBuf[base + j + 1] = moveBuf[base + j]; scoreBuf[base + j + 1] = scoreBuf[base + j]; j--; }
        moveBuf[base + j + 1] = m; scoreBuf[base + j + 1] = s;
      }
      for (let i = 0; i < n; i++) {
        const sq = moveBuf[base + i];
        const f = doMove(sq, side); unlink(sq);
        let v;
        if (i === 0) v = -solve(-beta, -alpha, -side, false, ply + 1);
        else {
          v = -solve(-alpha - 1, -alpha, -side, false, ply + 1);
          if (v > alpha && v < beta) v = -solve(-beta, -alpha, -side, false, ply + 1);
        }
        relink(sq); undoMove(sq, side, f);
        if (v > best) { best = v; bestMove = sq; if (v > alpha) { alpha = v; if (alpha >= beta) break; } }
      }
    } else {
      for (let sq = nextE[64]; sq !== 64; sq = nextE[sq]) {
        if (!canMove(sq, side)) continue;
        const f = doMove(sq, side); unlink(sq);
        const v = -solve(-beta, -alpha, -side, false, ply + 1);
        relink(sq); undoMove(sq, side, f);
        if (v > best) { best = v; bestMove = sq; if (v > alpha) { alpha = v; if (alpha >= beta) break; } }
      }
    }
    if (bestMove < 0) {
      if (passed) return discSum * side;
      return -solve(-beta, -alpha, -side, true, ply + 1);
    }
    if (useTT) {
      if (egKey[idx] !== kHi || egMove[idx] < 0) { egKey[idx] = kHi; egLo[idx] = -64; egUp[idx] = 64; }
      if (best <= alphaOrig) egUp[idx] = Math.min(egUp[idx], best);
      else if (best >= beta) egLo[idx] = Math.max(egLo[idx], best);
      else { egLo[idx] = best; egUp[idx] = best; }
      egMove[idx] = bestMove;
    }
    return best;
  }
  function solveRoot(side, order, alpha, beta) {
    const emptyOrder = [];
    for (let sq = 0; sq < 64; sq++) if (board[sq] === 0) emptyOrder.push(sq);
    emptyOrder.sort((a, b) => PRIO[b] - PRIO[a]);
    buildEmptyList(emptyOrder);
    const snap = snapshot();
    let best = -INF, bestMove = -1;
    const values = new Map();
    try {
      for (let i = 0; i < order.length; i++) {
        const sq = order[i];
        const f = doMove(sq, side); unlink(sq);
        let v;
        if (i === 0) v = -solve(-beta, -alpha, -side, false, 1);
        else {
          v = -solve(-alpha - 1, -alpha, -side, false, 1);
          if (v > alpha && v < beta) v = -solve(-beta, -alpha, -side, false, 1);
        }
        relink(sq); undoMove(sq, side, f);
        values.set(sq, v);
        if (v > best) { best = v; bestMove = sq; if (v > alpha) { alpha = v; if (alpha >= beta) break; } }
      }
    } catch (err) {
      if (err !== ABORT) throw err;
      restore(snap);
      return null;
    }
    return { move: bestMove, value: best, values };
  }

  /* ---------- 思考の入口 ---------- */
  // req: { board:number[64], side:1|-1, weights:number[64], level:{depth,solve,budget}, book:[{sq,name}] }
  function think(req) {
    const t0 = now();
    ensureTables();
    setWeights(req.weights);
    setBoard(req.board);
    const side = req.side, L = req.level;
    for (let i = 0; i < 128; i++) hist[i] >>= 2;
    nodes = 0;
    let rootMoves = [];
    for (let sq = 0; sq < 64; sq++) if (board[sq] === 0 && canMove(sq, side)) rootMoves.push(sq);
    if (!rootMoves.length) return null;
    rootMoves.sort((a, b) => PRIO[b] - PRIO[a]);
    const E = empties;
    const budget = L.budget;
    const hardEnd = t0 + budget;
    const out = (o) => Object.assign({ empties: E, nodes, ms: Math.round(now() - t0) }, o);

    if (rootMoves.length === 1) {
      const f = doMove(rootMoves[0], side);
      const v = -evaluate(-side);
      undoMove(rootMoves[0], side, f);
      return out({ move: rootMoves[0], value: v, depth: 0, mode: 'forced' });
    }

    // --- 終盤: 読み切り ---
    if (E <= L.solve) {
      let mid = null;
      if (E > 12) {
        // 読み切れない場合の保険として先に中盤探索。残りマスが多いほど保険に時間を回す
        deadline = hardEnd;
        const share = E <= 16 ? 0.1 : E <= 18 ? 0.25 : 0.45;
        mid = midgameRoot(side, rootMoves, L.depth, t0 + budget * share).result;
        if (mid) rootMoves = [...mid.scores.keys()].sort((x, y) => mid.scores.get(y) - mid.scores.get(x));
      }
      deadline = hardEnd;
      const wld = solveRoot(side, rootMoves, -1, 1);
      if (wld) {
        const verdict = wld.value > 0 ? 'win' : wld.value < 0 ? 'loss' : 'draw';
        const ordered = [wld.move, ...rootMoves.filter(m => m !== wld.move)];
        const exact = solveRoot(side, ordered, -65, 65);
        if (exact) {
          const d = exact.value;
          return out({ move: exact.move, value: d > 0 ? WIN + d * DISC : d < 0 ? -WIN + d * DISC : 0, depth: E, mode: 'exact', exact: d, wld: verdict });
        }
        if (verdict !== 'loss' || !mid) {
          const v = verdict === 'win' ? WIN : verdict === 'loss' ? -WIN : 0;
          return out({ move: wld.move, value: v, depth: E, mode: 'wld', wld: verdict });
        }
        return out({ move: mid.move, value: mid.value, depth: mid.depth, mode: 'search', wld: 'loss' });
      }
      if (mid) return out({ move: mid.move, value: mid.value, depth: mid.depth, mode: 'search', solveFailed: true });
      return out({ move: rootMoves[0], value: 0, depth: 0, mode: 'search', solveFailed: true });
    }

    // --- 中盤: 反復深化 ---
    deadline = hardEnd;
    const book = (req.book || []).filter(b => rootMoves.includes(b.sq));
    const soft = t0 + budget * (book.length ? 0.25 : 0.45);
    const { result } = midgameRoot(side, rootMoves, L.depth, soft);
    const res = result || { move: rootMoves[0], value: 0, depth: 0, scores: new Map() };
    if (book.length) {
      // 定石手が探索の最善から大きく劣らなければ採用（悪い定石データを鵜呑みにしない）
      let pick = null;
      for (const b of book) {
        const v = res.scores.get(b.sq);
        if (v === undefined) continue;
        if (v >= res.value - 40 && (!pick || v > pick.v)) pick = { b, v };
      }
      if (pick) return out({ move: pick.b.sq, value: pick.v, depth: res.depth, mode: 'book', bookName: pick.b.name, bookSym: !!pick.b.sym });
    }
    return out({ move: res.move, value: res.value, depth: res.depth, mode: 'search' });
  }

  // 画面側の静的評価（候補手の数値・形勢グラフ用）
  function staticEval(arr, side, weights) {
    setWeights(weights);
    setBoard(arr);
    return evaluate(side);
  }

  return { think, staticEval };
}

function reversiWorkerMain(scope) {
  const engine = createReversiEngine();
  scope.onmessage = function (e) {
    const req = e.data;
    let res;
    try { res = engine.think(req) || { move: -1 }; }
    catch (err) { res = { error: String((err && err.message) || err), move: -1 }; }
    res.id = req.id;
    scope.postMessage(res);
  };
}

if (typeof window === 'undefined' && typeof self !== 'undefined' && typeof importScripts === 'function') {
  reversiWorkerMain(self);
} else if (typeof window !== 'undefined') {
  window.ReversiEngine = {
    create: createReversiEngine,
    // file:// で開いても Worker を作れるよう、ソースから Blob を組み立てる
    workerSource: createReversiEngine.toString() + '\n(' + reversiWorkerMain.toString() + ')(self);'
  };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { createReversiEngine };
