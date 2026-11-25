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
   * 自己対戦の棋譜の最終石差を予測するよう学習で求めました（評価 10 ≒ 石 1個ぶん）。
   * ここにあるのは weights.js（パターン評価）を読み込めなかったときに使う、特徴量だけの重みです。
   *  0 着手可能数の差        1 着手可能数の比     2 相手をパスに追い込む(+1)/自分がパス(-1)
   *  3 潜在的着手可能数の差  4 壁（外側に接する石）の少なさ  5 辺の確定石の差
   *  6 隅の数の差            7 隅が空いた C 打ち   8 すぐ隅を取られる C 打ち
   *  9 隅が空いた X 打ち    10 マスの重み表（評価値エディタ）  11 石数の差
   * 12 偶数理論（残りマスが奇数なら +1）  13 隅に打てるかどうかの差  14 手番
   */
  const NF = 15, STAGES = 12;
  const stageOf = (e) => (e >= 60 ? 59 : e) / 5 | 0;
  const COEF = Float64Array.from([
    29.25, 40.8, -5.9, -16.16, 13.82, 5.54, 33.47, -7.33, -29.17, -20.75, -0.22, 6.43, 11.3, 1.88, -2.53,   // 残り 0〜4 マス
    23.6, 48.31, -13.8, -11.11, 13.56, 7.31, 41.58, -7.02, -29.97, -27.22, -0.23, 5.07, 3.52, 6.73, -9.36,   // 残り 5〜9 マス
    16.6, 72.03, -21.63, -7.01, 13.13, 9.33, 50.12, -5.92, -39.52, -33.08, -0.21, 3.44, 0.41, 13.77, -13.96,   // 残り 10〜14 マス
    9.52, 122.07, -34.47, -2.33, 12.07, 10.53, 57.44, -4.94, -48.47, -38.94, -0.13, 1.9, 0.77, 17.17, -16.63,   // 残り 15〜19 マス
    5.9, 148.87, -52.69, 0.5, 11.87, 11.62, 63.58, 1.1, -60.64, -43.02, -0.02, 0.87, -1.19, 19.27, -23.08,   // 残り 20〜24 マス
    2.38, 160.77, -79.41, 2.74, 12.88, 12.98, 60.77, 6.58, -55.71, -49.86, 0.16, 0.15, -0.19, 29, -22.75,   // 残り 25〜29 マス
    -1.35, 231.99, -75.83, 3.26, 13.39, 15.54, 66.76, 5.95, -46.3, -57.68, 0.38, -0.45, -2.4, 36.87, -29.07,   // 残り 30〜34 マス
    -4.33, 290.04, -89.04, 3.27, 13.16, 19.38, 65.43, 11.47, -58.3, -82.39, 0.52, -0.86, 3.19, 25.53, -28.16,   // 残り 35〜39 マス
    -3.39, 271.45, -204.03, 3.33, 13.32, 23.71, 57.86, -8.41, -34.84, -104.02, 0.59, -1.69, -1.54, 0.67, -25.81,   // 残り 40〜44 マス
    -0.35, 146.13, -42.29, 3.74, 13.07, 32.45, 59.64, -27.55, -82.03, -126.06, 0.66, -0.27, -6.72, 3.87, -21.09,   // 残り 45〜49 マス
    1.61, 108.5, 127.44, 4.64, 12.37, 33.93, 37.29, -40.8, -11.12, -130.62, 0.62, 0.48, 0.45, 6.72, -19.18,   // 残り 50〜54 マス
    -1.45, 141.55, 75.6, 5.79, 4.43, 46.46, 22.52, -59.22, -96.44, -139.81, 0.65, -5.92, -1.65, 0.88, -23.4,   // 残り 55〜60 マス
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
  /* ---------- パターン評価 ---------- */
  /*
   * 盤面の決まった場所（辺・隅・行・斜め）の石の並びごとに点数表を持ち、その合計を評価に加えます。
   * 点数表は自己対戦の棋譜から学習したもので、weights.js から読み込みます（読み込むまでは上の特徴量だけで評価）。
   * 回転・反転して重なる場所は同じ点数表を共有します（全 46 か所）。
   */
  const PATTERN_DEFS = [
    [0, 1, 2, 3, 4, 5, 6, 7, 9, 14],          // 辺 + X マス 2つ
    [0, 1, 2, 8, 9, 10, 16, 17, 18],          // 隅の 3×3
    [0, 1, 2, 3, 4, 8, 9, 10, 11, 12],        // 隅の 2×5
    [8, 9, 10, 11, 12, 13, 14, 15],           // 2 行目
    [16, 17, 18, 19, 20, 21, 22, 23],         // 3 行目
    [24, 25, 26, 27, 28, 29, 30, 31],         // 4 行目
    [0, 9, 18, 27, 36, 45, 54, 63],           // 対角線（8マス）
    [1, 10, 19, 28, 37, 46, 55],              // 斜め 7マス
    [2, 11, 20, 29, 38, 47],                  // 斜め 6マス
    [3, 12, 21, 30, 39],                      // 斜め 5マス
    [4, 13, 22, 31]                           // 斜め 4マス
  ];
  const D4 = [(r, c) => [r, c], (r, c) => [r, 7 - c], (r, c) => [7 - r, c], (r, c) => [7 - r, 7 - c],
    (r, c) => [c, r], (r, c) => [c, 7 - r], (r, c) => [7 - c, r], (r, c) => [7 - c, 7 - r]];
  const PT = PATTERN_DEFS.map(def => ({ len: def.length, size: 3 ** def.length, canon: null, nCanon: 0, cpos: null }));
  const PT_OFF = [];
  let PT_TOTAL = 0;
  for (const t of PT) { PT_OFF.push(PT_TOTAL); PT_TOTAL += t.size; }
  const INST_TYPE = [], INST_SQ = [];
  PATTERN_DEFS.forEach((def, ti) => {
    const seen = new Set(), selfPerms = [];
    for (const g of D4) {
      const sqs = def.map(sq => { const [r, c] = g(sq >> 3, sq & 7); return r * 8 + c; });
      const key = sqs.slice().sort((a, b) => a - b).join(',');
      if (key === def.slice().sort((a, b) => a - b).join(',')) selfPerms.push(sqs.map(sq => def.indexOf(sq)));
      if (seen.has(key)) continue;
      seen.add(key); INST_TYPE.push(ti); INST_SQ.push(sqs);
    }
    // 自分自身と重なる対称（例: 辺の左右反転）では、同じ並びを同じ添字にまとめる
    const t = PT[ti], pw = [];
    for (let i = 0, p = 1; i < t.len; i++, p *= 3) pw.push(p);
    const canon = new Int32Array(t.size), cpos = new Int32Array(t.size), digits = new Int8Array(t.len);
    let n = 0;
    for (let idx = 0; idx < t.size; idx++) {
      let x = idx;
      for (let i = 0; i < t.len; i++) { digits[i] = x % 3; x = (x - digits[i]) / 3; }
      let best = idx;
      for (const perm of selfPerms) {
        let v = 0;
        for (let i = 0; i < t.len; i++) v += pw[i] * digits[perm[i]];
        if (v < best) best = v;
      }
      canon[idx] = best;
      if (best === idx) cpos[idx] = n++;
    }
    for (let idx = 0; idx < t.size; idx++) cpos[idx] = cpos[canon[idx]];
    t.canon = canon; t.cpos = cpos; t.nCanon = n;
  });
  const NI = INST_TYPE.length;
  const INST_OFF = Int32Array.from(INST_TYPE.map(ti => PT_OFF[ti]));
  // マスごとに「どの場所の何桁目か」を並べておく（石のあるマスだけ足せば添字になる）
  const SQ_START = new Int32Array(65), SQ_INST = [], SQ_POW = [];
  for (let sq = 0; sq < 64; sq++) {
    SQ_START[sq] = SQ_INST.length;
    INST_SQ.forEach((sqs, i) => { const k = sqs.indexOf(sq); if (k >= 0) { SQ_INST.push(i); SQ_POW.push(3 ** k); } });
  }
  SQ_START[64] = SQ_INST.length;
  const SQI = Int32Array.from(SQ_INST), SQP = Int32Array.from(SQ_POW);
  const PIDX = new Int32Array(NI);
  function patternIndex(pL, pH, oL, oH) {
    PIDX.fill(0);
    let x = pL;
    while (x) { const b = x & -x, sq = 31 - Math.clz32(b); x ^= b; for (let j = SQ_START[sq]; j < SQ_START[sq + 1]; j++) PIDX[SQI[j]] += SQP[j]; }
    x = pH;
    while (x) { const b = x & -x, sq = 63 - Math.clz32(b); x ^= b; for (let j = SQ_START[sq]; j < SQ_START[sq + 1]; j++) PIDX[SQI[j]] += SQP[j]; }
    x = oL;
    while (x) { const b = x & -x, sq = 31 - Math.clz32(b); x ^= b; for (let j = SQ_START[sq]; j < SQ_START[sq + 1]; j++) PIDX[SQI[j]] += 2 * SQP[j]; }
    x = oH;
    while (x) { const b = x & -x, sq = 63 - Math.clz32(b); x ^= b; for (let j = SQ_START[sq]; j < SQ_START[sq + 1]; j++) PIDX[SQI[j]] += 2 * SQP[j]; }
  }
  let PW = null, PCOEF = null, PSCALE = 1;   // 読み込んだ点数表（段階ごとに全添字ぶん展開）と、併用する特徴量の重み
  // data: 段階ごと・種類ごとに、対称でまとめた添字の順に並べた int8 の列
  function loadPatterns(info, data) {
    const nCanonTotal = PT.reduce((a, t) => a + t.nCanon, 0);
    if (!info || !data || data.length !== nCanonTotal * STAGES || !info.coef || info.coef.length !== NF * STAGES) return false;
    PW = new Int16Array(PT_TOTAL * STAGES);
    let p = 0;
    for (let st = 0; st < STAGES; st++) {
      for (let ti = 0; ti < PT.length; ti++) {
        const t = PT[ti], base = st * PT_TOTAL + PT_OFF[ti];
        for (let idx = 0; idx < t.size; idx++) PW[base + idx] = data[p + t.cpos[idx]];
        p += t.nCanon;
      }
    }
    PCOEF = Float64Array.from(info.coef);
    PSCALE = info.scale || 1;
    clearTables();
    return true;
  }

  function evaluate(pL, pH, oL, oH) {
    const e = features(pL, pH, oL, oH);
    if (e < 0) return finalScore(finalDiff(pL, pH, oL, oH));
    const st = stageOf(e), base = st * NF;
    let score = 0;
    if (PW) {
      for (let k = 0; k < NF; k++) score += PCOEF[base + k] * F[k];
      patternIndex(pL, pH, oL, oH);
      const pb = st * PT_TOTAL;
      let ps = 0;
      for (let i = 0; i < NI; i++) ps += PW[pb + INST_OFF[i] + PIDX[i]];
      score += ps * PSCALE;
    } else {
      for (let k = 0; k < NF; k++) score += COEF[base + k] * F[k];
    }
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
  // 学習ツール用: ビットボードから、段階・特徴量・パターンの添字（対称でまとめた位置）を求める
  const TIDX = new Int32Array(NI);
  function trainView(pL, pH, oL, oH) {
    const e = features(pL, pH, oL, oH);
    if (e < 0) return -1;
    patternIndex(pL, pH, oL, oH);
    for (let i = 0; i < NI; i++) { const t = PT[INST_TYPE[i]]; TIDX[i] = t.cpos[PIDX[i]]; }
    return e;
  }
  const patternInfo = { NI, types: PT.map(t => ({ len: t.len, nCanon: t.nCanon })), instType: INST_TYPE.slice() };

  return { think, staticEval, featureVector, setCoef, loadPatterns, trainView, patternInfo, F, TIDX, NF, STAGES, stageOf };
}

function reversiWorkerMain(scope) {
  const engine = createReversiEngine();
  scope.onmessage = function (e) {
    const req = e.data;
    // パターン評価の点数表を受け取る（返事はしない）
    if (req && req.type === 'patterns') { engine.loadPatterns(req.info, req.data); return; }
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
