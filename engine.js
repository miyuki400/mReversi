/*
 * engine.js — MIYUKI REVERSI STUDIO 思考エンジン
 *
 * 画面を固めないよう Web Worker の中で動かすことを前提にしています（通常のスクリプトとしても動作）。
 *  - 盤面: ビットボード（64マスを 32bit 整数 2つで表現）。合法手を 8方向まとめてビット演算で求めます
 *  - 中盤: 反復深化 + PVS（主変化探索）+ 置換表 + 着手順序づけ（相手の着手可能数が少ない手から）
 *  - 評価: 着手可能数 / 潜在的着手可能数 / 辺パターン表（確定石・隅・C打ち）/ X打ち / 偶数理論
 *  - 終盤: 残りマスが少なくなったら勝敗読み切り（WLD）→ 石差の完全読み切り
 *          （速攻順 + 偶数領域優先 + 最後の1マスの専用処理）
 *  - 定石: 画面側から渡された定石手を、探索で大きく損しないか確認してから採用
 */
function createReversiEngine() {
  'use strict';

  const INF = 1000000;
  const WIN = 10000;            // 終局の評価: 勝ち = WIN + 石差 * DISC
  const DISC = 100;
  const MAX_PLY = 96;
  const now = () => performance.now();

  /* ---------- ビット操作の下準備 ---------- */
  // マス sq（= 行*8 + 列）のビット。0〜31 は下位 32bit（L）、32〜63 は上位 32bit（H）
  const BL = new Int32Array(64), BH = new Int32Array(64);
  for (let i = 0; i < 64; i++) { if (i < 32) BL[i] = 1 << i; else BH[i] = 1 << (i - 32); }
  function pop(x) {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return Math.imul((x + (x >>> 4)) & 0x0F0F0F0F, 0x01010101) >>> 24;
  }
  const sqOf = (x) => 31 - Math.clz32(x & -x);   // 最下位ビットのマス番号（x≠0）

  /* ---------- 盤面の下準備（方向ごとの直線） ---------- */
  const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  const RAYS = new Array(64);
  for (let sq = 0; sq < 64; sq++) {
    const r = sq >> 3, c = sq & 7, rays = [];
    for (const [dr, dc] of DIRS) {
      const line = [];
      let y = r + dr, x = c + dc;
      while (y >= 0 && y < 8 && x >= 0 && x < 8) { line.push(y * 8 + x); y += dr; x += dc; }
      if (line.length >= 2) rays.push(Int8Array.from(line));
    }
    RAYS[sq] = rays;
  }
  const CORNERS = [0, 7, 56, 63];
  const X_OF = [9, 14, 49, 54];   // 各隅の斜め隣
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
  // 終盤の偶数理論用: 盤面を 4つの象限に分け、空きマスが奇数の象限から先に打つ
  const QUAD = new Int8Array(64);
  for (let sq = 0; sq < 64; sq++) QUAD[sq] = 1 << (((sq >> 5) << 1) | ((sq & 7) >> 2));

  /* ---------- 辺パターン表（3^8 = 6561 通りを起動時に計算） ---------- */
  // 辺 8マスの並びごとに「確定石の差」「隅が空いた C 打ち」「すぐ隅を取られる C 打ち」を数えておく
  const EDGE_ST = new Int8Array(6561), EDGE_CS = new Int8Array(6561), EDGE_CD = new Int8Array(6561);
  (function buildEdgeTables() {
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
      let st = 0, cs = 0, cd = 0;
      for (let i = 0; i < 8; i++) if (cells[i] && stable[i]) st += cells[i];
      for (const [corner, cSq, step] of [[0, 1, 1], [7, 6, -1]]) {
        const col = cells[cSq];
        if (cells[corner] !== 0 || col === 0) continue;
        cs += col;
        let j = cSq;
        while (j >= 0 && j < 8 && cells[j] === col) j += step;
        if (j >= 0 && j < 8 && cells[j] === -col) cd += col;   // 相手が今すぐ隅を取れる
      }
      EDGE_ST[idx] = st; EDGE_CS[idx] = cs; EDGE_CD[idx] = cd;
    }
  })();
  // 8bit の並び → 3進数の添字（自分=1, 相手=2 として足し合わせる）
  const TERN = new Int32Array(256);
  for (let b = 0; b < 256; b++) { let v = 0, p = 1; for (let i = 0; i < 8; i++, p *= 3) if (b & (1 << i)) v += p; TERN[b] = v; }
  // 左端・右端の列（8マス）を 8bit に集める
  const colBits = (L, H) => (Math.imul(L & 0x01010101, 0x10204080) >>> 28) | ((Math.imul(H & 0x01010101, 0x10204080) >>> 28) << 4);

  /* ---------- 合法手・反転・周辺マス（ビット演算） ---------- */
  let rL = 0, rH = 0;   // 64bit の計算結果を返すためのレジスタ
  // 方向 +d（マス番号が増える向き）に、相手石をはさんで打てるマスを探す
  function fillUp(pL, pH, mL, mH, d) {
    const e = 32 - d;
    let tL = mL & (pL << d), tH = mH & ((pH << d) | (pL >>> e));
    for (let k = 0; k < 5; k++) { const sL = tL << d, sH = (tH << d) | (tL >>> e); tL |= mL & sL; tH |= mH & sH; }
    rL |= tL << d; rH |= (tH << d) | (tL >>> e);
  }
  // 方向 -d（マス番号が減る向き）
  function fillDown(pL, pH, mL, mH, d) {
    const e = 32 - d;
    let tL = mL & ((pL >>> d) | (pH << e)), tH = mH & (pH >>> d);
    for (let k = 0; k < 5; k++) { const sL = (tL >>> d) | (tH << e), sH = tH >>> d; tL |= mL & sL; tH |= mH & sH; }
    rL |= (tL >>> d) | (tH << e); rH |= tH >>> d;
  }
  // 手番側（P）の合法手を rL/rH に入れる
  function genMask(pL, pH, oL, oH) {
    rL = 0; rH = 0;
    const iL = oL & 0x7E7E7E7E, iH = oH & 0x7E7E7E7E;   // 横・斜めは左右の端をまたがない
    fillUp(pL, pH, iL, iH, 1); fillDown(pL, pH, iL, iH, 1);
    fillUp(pL, pH, oL, oH, 8); fillDown(pL, pH, oL, oH, 8);
    fillUp(pL, pH, iL, iH, 7); fillDown(pL, pH, iL, iH, 7);
    fillUp(pL, pH, iL, iH, 9); fillDown(pL, pH, iL, iH, 9);
    rL &= ~(pL | oL); rH &= ~(pH | oH);
  }
  function mobCount(pL, pH, oL, oH) { genMask(pL, pH, oL, oH); return pop(rL) + pop(rH); }
  // 8方向の隣接マスを rL/rH に入れる
  function expand(xL, xH) {
    const aL = xL & 0x7F7F7F7F, aH = xH & 0x7F7F7F7F;   // h列以外（列が増える向きへずらせる）
    const bL = xL & 0xFEFEFEFE, bH = xH & 0xFEFEFEFE;   // a列以外（列が減る向きへずらせる）
    rL = (xL << 8) | (xL >>> 8) | (xH << 24) | (aL << 1) | (bL >>> 1) | (bH << 31) |
      (aL << 9) | (bL << 7) | (aL >>> 7) | (aH << 25) | (bL >>> 9) | (bH << 23);
    rH = (xH << 8) | (xL >>> 24) | (xH >>> 8) | (aH << 1) | (aL >>> 31) | (bH >>> 1) |
      (aH << 9) | (aL >>> 23) | (bH << 7) | (bL >>> 25) | (aH >>> 7) | (bH >>> 9);
  }
  // マス sq に打ったときに返る石を rL/rH に入れる
  function flips(sq, pL, pH, oL, oH) {
    const rays = RAYS[sq];
    let fl = 0, fh = 0;
    for (let k = 0; k < rays.length; k++) {
      const ray = rays[k];
      let s = ray[0];
      if (!((oL & BL[s]) | (oH & BH[s]))) continue;
      let lL = BL[s], lH = BH[s], j = 1;
      for (; j < ray.length; j++) {
        s = ray[j];
        if ((oL & BL[s]) | (oH & BH[s])) { lL |= BL[s]; lH |= BH[s]; } else break;
      }
      if (j < ray.length && ((pL & BL[s]) | (pH & BH[s]))) { fl |= lL; fh |= lH; }
    }
    rL = fl; rH = fh;
  }

  /* ---------- 置換表のハッシュ ---------- */
  function hash(pL, pH, oL, oH) {
    let h = Math.imul(pL ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((pH + 0x7f4a7c15) | 0, 0xc2b2ae35) ^
      Math.imul(oL ^ 0x165667b1, 0x27d4eb2f) ^ Math.imul((oH + 0x61c88647) | 0, 0x2545f491);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    return h;
  }

  /* ---------- 探索用の状態 ---------- */
  const moveBuf = new Int8Array(64 * MAX_PLY);
  const scoreBuf = new Int32Array(64 * MAX_PLY);
  const flBuf = new Int32Array(64 * MAX_PLY), fhBuf = new Int32Array(64 * MAX_PLY);
  const hist = new Int32Array(128);
  const nextE = new Int8Array(65), prevE = new Int8Array(65);   // 空きマスの連結リスト（64 = 先頭）
  const W = new Float64Array(64);
  const ROWW = new Float64Array(8 * 256);   // 行ごとの 8bit → マスの重みの合計
  let weightsSig = '';
  let nodes = 0, deadline = Infinity;
  const ABORT = { abort: true };
  
  // 置換表（中盤用・終盤用）は最初の探索時に確保。局面は 4つの整数で完全に照合する
  const TT_SIZE = 1 << 20, TT_MASK = TT_SIZE - 1;
  const EG_SIZE = 1 << 19, EG_MASK = EG_SIZE - 1;
  let ttPL, ttPH, ttOL, ttOH, ttDepth, ttFlag, ttVal, ttMove;
  let egPL, egPH, egOL, egOH, egLo, egUp, egMove;
  function ensureTables() {
    if (ttPL) return;
    ttPL = new Int32Array(TT_SIZE); ttPH = new Int32Array(TT_SIZE); ttOL = new Int32Array(TT_SIZE); ttOH = new Int32Array(TT_SIZE);
    ttDepth = new Int8Array(TT_SIZE).fill(-1); ttFlag = new Uint8Array(TT_SIZE); ttVal = new Int32Array(TT_SIZE); ttMove = new Int8Array(TT_SIZE);
    egPL = new Int32Array(EG_SIZE); egPH = new Int32Array(EG_SIZE); egOL = new Int32Array(EG_SIZE); egOH = new Int32Array(EG_SIZE);
    egLo = new Int8Array(EG_SIZE); egUp = new Int8Array(EG_SIZE); egMove = new Int8Array(EG_SIZE).fill(-1);
  }
  function clearTables() {
    if (!ttPL) return;
    ttDepth.fill(-1); egMove.fill(-1);
  }

  function setWeights(w) {
    if (!w || w.length !== 64) return;
    const sig = w.join(',');
    if (sig === weightsSig) return;
    weightsSig = sig;
    for (let i = 0; i < 64; i++) W[i] = Number(w[i]) || 0;
    for (let r = 0; r < 8; r++) for (let b = 0; b < 256; b++) {
      let s = 0;
      for (let i = 0; i < 8; i++) if (b & (1 << i)) s += W[r * 8 + i];
      ROWW[r * 256 + b] = s;
    }
    clearTables();
  }
  function tick() { if ((++nodes & 1023) === 0 && now() > deadline) throw ABORT; }

  /* ---------- 評価関数（手番側 P から見た値） ---------- */
  function finalDiff(pL, pH, oL, oH) { return pop(pL) + pop(pH) - pop(oL) - pop(oH); }
  function finalScore(d) { return d > 0 ? WIN + d * DISC : d < 0 ? -WIN + d * DISC : 0; }
  /*
   * 評価は「特徴量 × 重み」の和です。重みは残りマス数の段階（STAGES 段階）ごとに別々で、
   * 自己対戦 1万6千局（約 82万局面）の最終石差を予測するよう、従来の手作りの重みを出発点にした
   * リッジ回帰で求めました（評価 10 ≒ 石 1個ぶん）。
   *  0 着手可能数の差        1 着手可能数の比     2 相手をパスに追い込む(+1)/自分がパス(-1)
   *  3 潜在的着手可能数の差  4 壁（外側に接する石）の少なさ  5 辺の確定石の差
   *  6 隅の数の差            7 隅が空いた C 打ち   8 すぐ隅を取られる C 打ち
   *  9 隅が空いた X 打ち    10 マスの重み表（評価値エディタ）  11 石数の差
   * 12 偶数理論（残りマスが奇数なら +1）  13 隅に打てるかどうかの差  14 手番
   */
  const NF = 15, STAGES = 12;
  const stageOf = (e) => (e >= 60 ? 59 : e) / 5 | 0;
  const COEF = Float64Array.from([
    19.02, 37.85, 17.88, -1.58, 12.24, 6.75, 29.45, -8.06, -22.65, -15, -0.21, 6.19, 6.4, 2.17, 0.25,   // 残り 0〜4 マス
    21.15, 37.67, 17.19, -3.44, 12.51, 8.06, 29.89, -6.61, -23.43, -16.2, -0.17, 5.2, 5.68, 3.82, -2.29,   // 残り 5〜9 マス
    20.26, 37.52, 17.54, -3.37, 12.97, 9.39, 30.12, -5.32, -23.48, -17.39, -0.1, 4.22, 5.04, 5.09, -5.24,   // 残り 10〜14 マス
    17.77, 37.23, 17.67, -0.85, 12.37, 10.27, 29.64, -3.29, -23.19, -17.99, -0.03, 3.32, 4.15, 4.57, -7.84,   // 残り 15〜19 マス
    15.6, 37.04, 17.83, 1.48, 10.4, 12.02, 29.22, -1.38, -22.6, -27.11, 0.03, 1.72, 4.26, 1.99, -9.19,   // 残り 20〜24 マス
    15.21, 36.8, 17.96, 2.58, 8.16, 14.3, 29.02, -0.47, -21.97, -25.27, 0.16, -0.25, 0.16, 0.62, -9.42,   // 残り 25〜29 マス
    15, 36.67, 18, 3.05, 7.81, 15.54, 29.2, -1.67, -21.52, -25.29, 0.37, -0.6, 0.48, 0.53, -8.48,   // 残り 30〜34 マス
    11.95, 36.39, 18.01, 3.81, 9.18, 16.29, 29.47, -4.4, -21.51, -26.51, 0.67, -0.42, 0.04, 1.51, -7.59,   // 残り 35〜39 マス
    7.6, 36.06, 18.03, 4.88, 7.33, 15.4, 29.75, -9.25, -21.62, -27.42, 0.94, -3.79, 0.58, 2.2, -7.92,   // 残り 40〜44 マス
    7.4, 35.99, 18.05, 4.7, 5.55, 12.46, 29.55, -12.38, -21.66, -27.61, 1.21, -5.38, 0.95, 2.3, -6.64,   // 残り 45〜49 マス
    8.11, 35.91, 18.03, 3.08, 4.36, 10.66, 29.29, -13.21, -21.81, -26.94, 1.69, -3.88, 3.03, 1.79, -2.63,   // 残り 50〜54 マス
    1.67, 35.3, 18, 1.39, 5.03, 10.88, 29.52, -13.49, -21.96, -25.45, 2.9, -2.91, 5.76, 0.75, -0.21,   // 残り 55〜60 マス
  ]);
  const F = new Float64Array(NF);
  function features(pL, pH, oL, oH) {
    const eL = ~(pL | oL), eH = ~(pH | oH);
    const e = pop(eL) + pop(eH);
    genMask(pL, pH, oL, oH);
    const myMob = pop(rL) + pop(rH), myCor = pop(rL & 0x81) + pop(rH & 0x81000000);
    genMask(oL, oH, pL, pH);
    const opMob = pop(rL) + pop(rH), opCor = pop(rL & 0x81) + pop(rH & 0x81000000);
    if (myMob === 0 && opMob === 0) return -1;
    expand(oL, oH); const myPot = pop(rL & eL) + pop(rH & eH);
    expand(pL, pH); const opPot = pop(rL & eL) + pop(rH & eH);
    expand(eL, eH); const myFr = pop(rL & pL) + pop(rH & pH), opFr = pop(rL & oL) + pop(rH & oH);
    F[0] = myMob - opMob;
    F[1] = (myMob - opMob) / (myMob + opMob + 2);
    F[2] = opMob === 0 ? 1 : myMob === 0 ? -1 : 0;
    F[3] = myPot - opPot;
    F[4] = opFr - myFr;
    const i0 = TERN[pL & 255] + 2 * TERN[oL & 255];
    const i1 = TERN[pH >>> 24] + 2 * TERN[oH >>> 24];
    const i2 = TERN[colBits(pL, pH)] + 2 * TERN[colBits(oL, oH)];
    const i3 = TERN[colBits(pL >>> 7, pH >>> 7)] + 2 * TERN[colBits(oL >>> 7, oH >>> 7)];
    F[5] = EDGE_ST[i0] + EDGE_ST[i1] + EDGE_ST[i2] + EDGE_ST[i3];
    F[6] = pop(pL & 0x81) + pop(pH & 0x81000000) - pop(oL & 0x81) - pop(oH & 0x81000000);
    F[7] = EDGE_CS[i0] + EDGE_CS[i1] + EDGE_CS[i2] + EDGE_CS[i3];
    F[8] = EDGE_CD[i0] + EDGE_CD[i1] + EDGE_CD[i2] + EDGE_CD[i3];
    let x = 0;
    for (let k = 0; k < 4; k++) {
      const c = CORNERS[k];
      if ((pL & BL[c]) | (pH & BH[c]) | (oL & BL[c]) | (oH & BH[c])) continue;
      const s = X_OF[k];
      if ((pL & BL[s]) | (pH & BH[s])) x++;
      else if ((oL & BL[s]) | (oH & BH[s])) x--;
    }
    F[9] = x;
    let pos = 0;
    for (let r = 0; r < 4; r++) {
      const sh = r * 8;
      pos += ROWW[r * 256 + ((pL >>> sh) & 255)] - ROWW[r * 256 + ((oL >>> sh) & 255)];
      pos += ROWW[(r + 4) * 256 + ((pH >>> sh) & 255)] - ROWW[(r + 4) * 256 + ((oH >>> sh) & 255)];
    }
    F[10] = pos;
    F[11] = finalDiff(pL, pH, oL, oH);
    F[12] = (e & 1) ? 1 : -1;
    F[13] = myCor - opCor;
    F[14] = 1;
    return e;
  }
  function evaluate(pL, pH, oL, oH) {
    const e = features(pL, pH, oL, oH);
    if (e < 0) return finalScore(finalDiff(pL, pH, oL, oH));
    const base = stageOf(e) * NF;
    let score = 0;
    for (let k = 0; k < NF; k++) score += COEF[base + k] * F[k];
    score = Math.round(score);
    return score > 9000 ? 9000 : score < -9000 ? -9000 : score;
  }

  /* ---------- 中盤探索: PVS + 置換表 ---------- */
  // 合法手を moveBuf[base..] に並べ、返る石も一緒に覚えておく
  function listMoves(pL, pH, oL, oH, base) {
    genMask(pL, pH, oL, oH);
    let mL = rL, mH = rH, n = 0;
    while (mL) { const sq = sqOf(mL); mL &= mL - 1; flips(sq, pL, pH, oL, oH); moveBuf[base + n] = sq; flBuf[base + n] = rL; fhBuf[base + n] = rH; n++; }
    while (mH) { const sq = 32 + sqOf(mH); mH &= mH - 1; flips(sq, pL, pH, oL, oH); moveBuf[base + n] = sq; flBuf[base + n] = rL; fhBuf[base + n] = rH; n++; }
    return n;
  }
  function sortMoves(base, n) {
    for (let i = 1; i < n; i++) {
      const m = moveBuf[base + i], s = scoreBuf[base + i], a = flBuf[base + i], b = fhBuf[base + i];
      let j = i - 1;
      while (j >= 0 && scoreBuf[base + j] < s) {
        moveBuf[base + j + 1] = moveBuf[base + j]; scoreBuf[base + j + 1] = scoreBuf[base + j];
        flBuf[base + j + 1] = flBuf[base + j]; fhBuf[base + j + 1] = fhBuf[base + j]; j--;
      }
      moveBuf[base + j + 1] = m; scoreBuf[base + j + 1] = s; flBuf[base + j + 1] = a; fhBuf[base + j + 1] = b;
    }
  }
  function orderMoves(pL, pH, oL, oH, base, n, hb, ttm, depth) {
    for (let i = 0; i < n; i++) {
      const sq = moveBuf[base + i];
      let s;
      if (sq === ttm) s = 1 << 30;
      else if (depth >= 3) {
        const fl = flBuf[base + i], fh = fhBuf[base + i];
        const om = mobCount(oL & ~fl, oH & ~fh, pL | fl | BL[sq], pH | fh | BH[sq]);
        s = -om * 4096 + PRIO[sq] * 64 + (hist[hb + sq] >> 4);
      } else s = PRIO[sq] * 4096 + hist[hb + sq];
      scoreBuf[base + i] = s;
    }
    sortMoves(base, n);
  }
  function negamax(pL, pH, oL, oH, depth, alpha, beta, passed, ply, hb) {
    tick();
    if (depth <= 0) return evaluate(pL, pH, oL, oH);
    const idx = hash(pL, pH, oL, oH) & TT_MASK;
    const hit = ttPL[idx] === pL && ttPH[idx] === pH && ttOL[idx] === oL && ttOH[idx] === oH && ttDepth[idx] >= 0;
    let ttm = -1;
    if (hit) {
      ttm = ttMove[idx];
      if (ttDepth[idx] >= depth) {
        const v = ttVal[idx], f = ttFlag[idx];
        if (f === 1) return v;
        if (f === 2 && v >= beta) return v;
        if (f === 3 && v <= alpha) return v;
      }
    }
    const base = ply * 64;
    const n = listMoves(pL, pH, oL, oH, base);
    if (n === 0) {
      if (passed) return finalScore(finalDiff(pL, pH, oL, oH));
      return -negamax(oL, oH, pL, pH, depth, -beta, -alpha, true, ply + 1, hb ^ 64);
    }
    orderMoves(pL, pH, oL, oH, base, n, hb, ttm, depth);
    let best = -INF, bestMove = -1, a = alpha;
    for (let i = 0; i < n; i++) {
      const sq = moveBuf[base + i], fl = flBuf[base + i], fh = fhBuf[base + i];
      const nPL = oL & ~fl, nPH = oH & ~fh, nOL = pL | fl | BL[sq], nOH = pH | fh | BH[sq];
      let v;
      if (i === 0) v = -negamax(nPL, nPH, nOL, nOH, depth - 1, -beta, -a, false, ply + 1, hb ^ 64);
      else {
        v = -negamax(nPL, nPH, nOL, nOH, depth - 1, -a - 1, -a, false, ply + 1, hb ^ 64);
        if (v > a && v < beta) v = -negamax(nPL, nPH, nOL, nOH, depth - 1, -beta, -a, false, ply + 1, hb ^ 64);
      }
      if (v > best) {
        best = v; bestMove = sq;
        if (v > a) { a = v; if (a >= beta) { hist[hb + sq] += depth * depth; break; } }
      }
    }
    if (!hit || depth >= ttDepth[idx]) {
      ttPL[idx] = pL; ttPH[idx] = pH; ttOL[idx] = oL; ttOH[idx] = oH;
      ttDepth[idx] = depth; ttVal[idx] = best; ttMove[idx] = bestMove;
      ttFlag[idx] = best <= alpha ? 3 : best >= beta ? 2 : 1;
    }
    return best;
  }
  // 局面 S（手番側 P / 相手 O）で sq に打った後の局面を返す（手番は相手に移る）
  function child(S, sq) {
    flips(sq, S.pL, S.pH, S.oL, S.oH);
    return { pL: S.oL & ~rL, pH: S.oH & ~rH, oL: S.pL | rL | BL[sq], oH: S.pH | rH | BH[sq] };
  }
  function midgameRoot(S, rootMoves, maxDepth, softEnd, hb, E) {
    let order = rootMoves.slice();
    const scores = new Map();
    let result = null;
    for (let depth = 1; depth <= maxDepth; depth++) {
      let alpha = -INF, bestVal = -INF, bestMove = -1, done = 0;
      try {
        for (let i = 0; i < order.length; i++) {
          const sq = order[i], c = child(S, sq);
          let v;
          if (i === 0) v = -negamax(c.pL, c.pH, c.oL, c.oH, depth - 1, -INF, INF, false, 1, hb ^ 64);
          else {
            v = -negamax(c.pL, c.pH, c.oL, c.oH, depth - 1, -alpha - 1, -alpha, false, 1, hb ^ 64);
            if (v > alpha) v = -negamax(c.pL, c.pH, c.oL, c.oH, depth - 1, -INF, -alpha, false, 1, hb ^ 64);
          }
          scores.set(sq, v);
          if (v > bestVal) { bestVal = v; bestMove = sq; }
          if (v > alpha) alpha = v;
          done++;
        }
      } catch (err) {
        if (err !== ABORT) throw err;
        // 途中までの結果でも、前回の最善手より良いと確かめられた手は採用できる
        if (done > 0 && result && bestMove !== result.move && bestVal > scores.get(result.move)) result = { move: bestMove, value: bestVal, depth, scores };
        return { result, aborted: true };
      }
      result = { move: bestMove, value: bestVal, depth, scores: new Map(scores) };
      order.sort((x, y) => scores.get(y) - scores.get(x));
      if (depth >= E) break;                       // 最後まで読めた
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
  // 残り1マス: 打つ・打たないを直接数える
  function solveLast(pL, pH, oL, oH) {
    nodes++;
    const sq = nextE[64], d = finalDiff(pL, pH, oL, oH);
    flips(sq, pL, pH, oL, oH);
    let n = pop(rL) + pop(rH);
    if (n) return d + 2 * n + 1;
    flips(sq, oL, oH, pL, pH);
    n = pop(rL) + pop(rH);
    if (n) return d - 2 * n - 1;
    return d;
  }
  // 残りが少ないとき: 合法手の一覧を作らず、空きマスに直接打ってみる。
  // 空きマスが奇数の象限 → 偶数の象限の順に読む（偶数理論）
  function solveShallow(pL, pH, oL, oH, alpha, beta, passed, e, parity) {
    if (e === 1) return solveLast(pL, pH, oL, oH);
    tick();
    let best = -INF;
    for (let pass = 0; pass < 2; pass++) {
      for (let sq = nextE[64]; sq !== 64; sq = nextE[sq]) {
        if (((parity & QUAD[sq]) !== 0) === (pass === 1)) continue;
        flips(sq, pL, pH, oL, oH);
        const fl = rL, fh = rH;
        if (!(fl | fh)) continue;
        unlink(sq);
        const v = -solveShallow(oL & ~fl, oH & ~fh, pL | fl | BL[sq], pH | fh | BH[sq], -beta, -alpha, false, e - 1, parity ^ QUAD[sq]);
        relink(sq);
        if (v > best) { best = v; if (v > alpha) { alpha = v; if (alpha >= beta) return best; } }
      }
    }
    if (best === -INF) {
      if (passed) return finalDiff(pL, pH, oL, oH);
      return -solveShallow(oL, oH, pL, pH, -beta, -alpha, true, e, parity);
    }
    return best;
  }
  // 戻り値: 手番側から見た最終石差（空きマスは数えない＝画面の勝敗判定と同じ）
  function solve(pL, pH, oL, oH, alpha, beta, passed, ply, e, parity) {
    if (e < 7) return solveShallow(pL, pH, oL, oH, alpha, beta, passed, e, parity);
    tick();
    const useTT = e >= 7;
    let idx = 0, ttm = -1;
    if (useTT) {
      idx = hash(pL, pH, oL, oH) & EG_MASK;
      if (egMove[idx] >= 0 && egPL[idx] === pL && egPH[idx] === pH && egOL[idx] === oL && egOH[idx] === oH) {
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
    genMask(pL, pH, oL, oH);
    const mL = rL, mH = rH;
    if (mL | mH) {
      {
        // 速攻順（相手の着手可能数が少なくなる手から読む）
        const base = ply * 64;
        let n = 0;
        for (let sq = nextE[64]; sq !== 64; sq = nextE[sq]) {
          if (!((mL & BL[sq]) | (mH & BH[sq]))) continue;
          flips(sq, pL, pH, oL, oH);
          const fl = rL, fh = rH;
          const nPL = oL & ~fl, nPH = oH & ~fh, nOL = pL | fl | BL[sq], nOH = pH | fh | BH[sq];
          genMask(nPL, nPH, nOL, nOH);
          // 相手の着手可能数（隅は 2 倍に数える）と、相手の潜在的な着手可能数が少ない手から
          const mob = pop(rL) + pop(rH) + pop(rL & 0x00000081) + pop(rH & 0x81000000);
          expand(nOL, nOH);
          const pot = pop(rL & ~(nPL | nOL)) + pop(rH & ~(nPH | nOH));
          const s = -mob * 64 - pot * 16 + PRIO[sq] + (sq === ttm ? 1 << 20 : 0);
          moveBuf[base + n] = sq; scoreBuf[base + n] = s; flBuf[base + n] = fl; fhBuf[base + n] = fh; n++;
        }
        sortMoves(base, n);
        for (let i = 0; i < n; i++) {
          const sq = moveBuf[base + i], fl = flBuf[base + i], fh = fhBuf[base + i];
          const nPL = oL & ~fl, nPH = oH & ~fh, nOL = pL | fl | BL[sq], nOH = pH | fh | BH[sq], np = parity ^ QUAD[sq];
          unlink(sq);
          let v;
          if (i === 0) v = -solve(nPL, nPH, nOL, nOH, -beta, -alpha, false, ply + 1, e - 1, np);
          else {
            v = -solve(nPL, nPH, nOL, nOH, -alpha - 1, -alpha, false, ply + 1, e - 1, np);
            if (v > alpha && v < beta) v = -solve(nPL, nPH, nOL, nOH, -beta, -alpha, false, ply + 1, e - 1, np);
          }
          relink(sq);
          if (v > best) { best = v; bestMove = sq; if (v > alpha) { alpha = v; if (alpha >= beta) break; } }
        }
      }
    } else {
      if (passed) return finalDiff(pL, pH, oL, oH);
      return -solve(oL, oH, pL, pH, -beta, -alpha, true, ply + 1, e, parity);
    }
    if (useTT) {
      if (egMove[idx] < 0 || egPL[idx] !== pL || egPH[idx] !== pH || egOL[idx] !== oL || egOH[idx] !== oH) {
        egPL[idx] = pL; egPH[idx] = pH; egOL[idx] = oL; egOH[idx] = oH; egLo[idx] = -64; egUp[idx] = 64;
      }
      if (best <= alphaOrig) egUp[idx] = Math.min(egUp[idx], best);
      else if (best >= beta) egLo[idx] = Math.max(egLo[idx], best);
      else { egLo[idx] = best; egUp[idx] = best; }
      egMove[idx] = bestMove;
    }
    return best;
  }
  function solveRoot(S, order, alpha, beta, E) {
    const emptyOrder = [];
    let parity = 0;
    for (let sq = 0; sq < 64; sq++) {
      if (!((S.pL | S.oL) & BL[sq]) && !((S.pH | S.oH) & BH[sq])) { emptyOrder.push(sq); parity ^= QUAD[sq]; }
    }
    emptyOrder.sort((a, b) => PRIO[b] - PRIO[a]);
    buildEmptyList(emptyOrder);
    let best = -INF, bestMove = -1;
    const values = new Map();
    try {
      for (let i = 0; i < order.length; i++) {
        const sq = order[i], c = child(S, sq);
        unlink(sq);
        let v;
        const np = parity ^ QUAD[sq];
        if (i === 0) v = -solve(c.pL, c.pH, c.oL, c.oH, -beta, -alpha, false, 1, E - 1, np);
        else {
          v = -solve(c.pL, c.pH, c.oL, c.oH, -alpha - 1, -alpha, false, 1, E - 1, np);
          if (v > alpha && v < beta) v = -solve(c.pL, c.pH, c.oL, c.oH, -beta, -alpha, false, 1, E - 1, np);
        }
        relink(sq);
        values.set(sq, v);
        if (v > best) { best = v; bestMove = sq; if (v > alpha) { alpha = v; if (alpha >= beta) break; } }
      }
    } catch (err) {
      if (err !== ABORT) throw err;
      return null;
    }
    return { move: bestMove, value: best, values };
  }

  // 石差を「g 石差以上か？」という幅0の探索の二分法で絞り込む（広い窓で読むより速い）。
  // 最善の石差は [lo, hi] の範囲にあることが分かっている前提
  function solveExact(S, order, lo, hi, E) {
    let move = order[0];
    while (lo < hi) {
      const g = (lo + hi + 1) >> 1;
      const r = solveRoot(S, order, g - 1, g, E);
      if (!r) return null;
      if (r.value >= g) { lo = r.value; move = r.move; order = [move, ...order.filter(m => m !== move)]; }
      else hi = r.value;
    }
    return { move, value: lo };
  }

  /* ---------- 盤面の受け渡し ---------- */
  // 配列（黒=1 / 白=-1 / 空=0）を、手番側 side から見た P/O のビットボードにする
  function toBits(arr, side) {
    const S = { pL: 0, pH: 0, oL: 0, oH: 0 };
    for (let i = 0; i < 64; i++) {
      const v = arr[i] | 0;
      if (!v) continue;
      if (v === side) { S.pL |= BL[i]; S.pH |= BH[i]; } else { S.oL |= BL[i]; S.oH |= BH[i]; }
    }
    return S;
  }

  /* ---------- 思考の入口 ---------- */
  // req: { board:number[64], side:1|-1, weights:number[64], level:{depth,solve,budget}, book:[{sq,name}] }
  function think(req) {
    const t0 = now();
    ensureTables();
    setWeights(req.weights);
    const side = req.side, L = req.level;
    const S = toBits(req.board, side);
    const hb = side === 1 ? 0 : 64;
    for (let i = 0; i < 128; i++) hist[i] >>= 2;
    nodes = 0;
    genMask(S.pL, S.pH, S.oL, S.oH);
    let rootMoves = [];
    for (let sq = 0; sq < 64; sq++) if ((rL & BL[sq]) | (rH & BH[sq])) rootMoves.push(sq);
    if (!rootMoves.length) return null;
    rootMoves.sort((a, b) => PRIO[b] - PRIO[a]);
    const E = 64 - pop(S.pL) - pop(S.pH) - pop(S.oL) - pop(S.oH);
    const budget = L.budget;
    const hardEnd = t0 + budget;
    const out = (o) => Object.assign({ empties: E, nodes, ms: Math.round(now() - t0) }, o);

    if (rootMoves.length === 1) {
      const c = child(S, rootMoves[0]);
      const v = -evaluate(c.pL, c.pH, c.oL, c.oH);
      return out({ move: rootMoves[0], value: v, depth: 0, mode: 'forced' });
    }

    // --- 終盤: 読み切り ---
    if (E <= L.solve) {
      let mid = null;
      if (E > 12) {
        // 読み切れない場合の保険として先に中盤探索。残りマスが多いほど保険に時間を回す
        deadline = hardEnd;
        const share = E <= 16 ? 0.1 : E <= 18 ? 0.25 : 0.45;
        mid = midgameRoot(S, rootMoves, L.depth, t0 + budget * share, hb, E).result;
        if (mid) rootMoves = [...mid.scores.keys()].sort((x, y) => mid.scores.get(y) - mid.scores.get(x));
      }
      deadline = hardEnd;
      const wld = solveRoot(S, rootMoves, -1, 1, E);
      if (wld) {
        const verdict = wld.value > 0 ? 'win' : wld.value < 0 ? 'loss' : 'draw';
        const ordered = [wld.move, ...rootMoves.filter(m => m !== wld.move)];
        // 勝敗が分かっているので、石差はその範囲だけを読めばよい（引き分けなら石差は 0）
        const exact = verdict === 'draw' ? { move: wld.move, value: 0 }
          : verdict === 'win' ? solveExact(S, ordered, 1, 64, E) : solveExact(S, ordered, -64, -1, E);
        if (exact) {
          const d = exact.value;
          return out({ move: exact.move, value: finalScore(d), depth: E, mode: 'exact', exact: d, wld: verdict });
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
    const { result } = midgameRoot(S, rootMoves, L.depth, soft, hb, E);
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
    const S = toBits(arr, side);
    return evaluate(S.pL, S.pH, S.oL, S.oH);
  }

  // 評価の調整ツール用: 局面の特徴量（手番側から見た値）と段階を返す
  function featureVector(arr, side, weights) {
    setWeights(weights);
    const S = toBits(arr, side);
    const e = features(S.pL, S.pH, S.oL, S.oH);
    return e < 0 ? null : { stage: stageOf(e), empties: e, f: Array.from(F) };
  }
  function setCoef(arr) { COEF.set(arr); clearTables(); }

  return { think, staticEval, featureVector, setCoef, NF, STAGES };
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
