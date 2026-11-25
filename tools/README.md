# 学習ツール（パターン評価）

`weights.js` の点数表は、次の手順で自己対戦から作りました（Node.js 18 以上、4 コアで数時間）。

1. 棋譜を作る（今のエンジンで自己対戦。序盤 4〜14 手と中盤の 3% はランダムに打って局面を散らす）

       EPS=0.03 node tools/gen-games.js tools/engine-node.js 30000 5,6 data/k1 41

2. 点数表を学習する（同じ局面はまとめ、段階ごとに確率的勾配法で最終石差を予測）

       node --max-old-space-size=12000 tools/train-patterns.js data/r.json data/*.bin

3. `weights.js` を作る

       node tools/build-weights.js data/r.json weights.js "説明"

4. 強さを確かめる（新旧のエンジンを、開始局面ごとに先後を入れ替えて対戦）

       node tools/match.js 新しいエンジン.js 古いエンジン.js 200 -5 12 1
