/**
 * Rivift OS バックエンドサーバー
 * ─────────────────────────────────────────────
 * 【フェーズ0】今回のスコープ:
 *   - renderer/index.html (今までのRivift OS本体) を
 *     ただのWebサーバーとしてlocalhostに配信するだけ。
 *   - まだファイル操作API・電源API・ターミナルAPIは無い。
 *
 * 【今後増えていく予定】(コメントは道しるべとして残す)
 *   - routes/system.js  → 電源(reboot/shutdown)・明るさ・音量 ★優先度1
 *   - routes/fs.js       → 本物のファイルシステム操作        ★優先度2
 *   - routes/terminal.js → node-pty + WebSocketで本物のシェル ★優先度5
 *
 * このファイルが「Rivift OSの心臓部」になる。
 * Electron化した後も、ElectronのメインプロセスからこのExpress
 * サーバーをバックグラウンドで起動する形は変わらない。
 */

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.RIVIFT_PORT || 7890;

// ── 静的ファイル配信 ──────────────────────────────
// renderer/ 以下(index.html, 将来的に画像やアイコン等)をそのまま配信する。
// 本物のOSになってからも、ここがRivift OSのUI(画面そのもの)の配信元になる。
app.use(express.static(path.join(__dirname, '..', 'renderer')));

// JSON bodyを今後のAPI(POST /api/system/reboot 等)で使えるようにしておく
// limitは大きめに: 画像等のバイナリをbase64で送る場合に備える(フェーズ2のfs.write用)
app.use(express.json({ limit: '50mb' }));

// ── ヘルスチェック用 ──────────────────────────────
// 後でElectronのメインプロセスが「バックエンドがちゃんと立ち上がったか」を
// 確認するために使う想定のエンドポイント。
app.get('/api/health', (req, res) => {
    res.json({ ok: true, phase: 2, message: 'Rivift backend is alive' });
});

// ── フェーズ1: 電源操作・明るさ・音量API ──────────────────
const systemRoutes = require('./routes/system');
app.use('/api/system', systemRoutes);

// ── フェーズ2: ファイルシステム連携API ────────────────────
const fsRoutes = require('./routes/fs');
app.use('/api/fs', fsRoutes);

// ── フェーズ3: アップデートシステム ────────────────────────
const updateRoutes = require('./routes/update');
app.use('/api/system', updateRoutes);

// ── 今後ここに追加していく ──────────────────────────────

const httpServer = app.listen(PORT, '127.0.0.1', () => {
    console.log(`[Rivift Backend] http://localhost:${PORT} で起動しました`);
    console.log(`[Rivift Backend] ブラウザで上記URLを開くとRivift OSが表示されます`);
});

// ── フェーズ6: ターミナル本物化(node-pty + WebSocket) ──────────────
// node-ptyがインストールされていない/ビルドされていない環境でも
// 他の機能(電源・VFS)が動き続けるよう、try/catchで守っておく。
try {
    const { attachTerminalServer } = require('./routes/terminal');
    attachTerminalServer(httpServer);
} catch (e) {
    console.warn('[Rivift Backend] ターミナル機能(node-pty)が利用できません:', e.message);
    console.warn('[Rivift Backend] `npm install node-pty` 後に再起動すると有効になります');
}
