// Node.js 用: engine.js に weights.js のパターン評価を読み込んだエンジンを作る（tools のスクリプトに渡すエンジン）
const path = require('path'), zlib = require('zlib');
const base = require(path.join(__dirname, '..', 'engine.js'));
global.window = global.window || {};
require(path.join(__dirname, '..', 'weights.js'));
const P = global.window.REVERSI_PATTERN;
const data = new Int8Array(zlib.gunzipSync(Buffer.from(P.data, 'base64')));
module.exports = {
  createReversiEngine() {
    const e = base.createReversiEngine();
    if (!e.loadPatterns({ coef: P.coef, scale: P.scale }, data)) throw new Error('weights.js を読み込めませんでした');
    return e;
  }
};
