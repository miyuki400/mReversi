// 学習結果を weights.js にまとめる。使い方: node tools/build-weights.js <学習結果.json> weights.js "説明"
const fs=require('fs'),zlib=require('zlib');
const info=JSON.parse(fs.readFileSync(process.argv[2]));const i8=fs.readFileSync(process.argv[2].replace('.json','.i8'));
const gz=zlib.gzipSync(i8,{level:9});
const out=`/*
 * weights.js — パターン評価の点数表（engine.js が読み込みます）
 * ${process.argv[4]||''}
 * coef: 段階（12）× 特徴量（15）の重み / data: 段階×パターンごとの点数（int8, gzip 圧縮して base64）
 */
window.REVERSI_PATTERN = {
  version: 1,
  scale: ${info.scale},
  coef: ${JSON.stringify(info.coef)},
  data: '${gz.toString('base64')}'
};
`;
fs.writeFileSync(process.argv[3],out);console.log('raw',i8.length,'gz',gz.length,'file',out.length);
