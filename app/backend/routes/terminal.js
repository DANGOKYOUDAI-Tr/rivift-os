/**
 * routes/terminal.js
 * ─────────────────────────────────────────────
 * 【フェーズ6】ターミナルアプリを本物のシェル(bash)に繋ぐ。
 *
 * 今までの「ターミナル」アプリは、フロントの独自パーサーが
 * 文字列を解釈して、VFS上で動く"演技"をするものだった。
 * これを本物のPTY(疑似端末)に繋ぎ変える。
 *
 * 仕組み:
 *   - node-pty で本物のbashプロセスを起動する
 *   - WebSocketで、フロント(xterm.js)とbashプロセスの標準入出力を
 *     そのまま双方向にストリーミングする
 *   - 1つのWebSocket接続 = 1つの独立したシェルセッション
 *     (ターミナルウィンドウを複数開けば、複数のbashが同時に動く)
 *
 * 注意:
 *   - node-ptyはネイティブモジュール(C++)なので、`npm install node-pty`時に
 *     OSごとにビルドが必要。Electronで使う場合は `electron-rebuild` で
 *     Electronのバージョンに合わせて再ビルドする必要がある。
 *     (このサンドボックス環境はネットワーク制限でビルドできなかったため、
 *      実機での `npm run rebuild` 相当の作業がセットアップ手順に必要)
 *
 * 使い方(server.js側):
 *   const { attachTerminalServer } = require('./routes/terminal');
 *   attachTerminalServer(httpServer); // httpServerはapp.listen()が返すインスタンス
 */

const pty = require('node-pty');
const WebSocket = require('ws');
const os = require('os');

// ─────────────────────────────────────────────
// 既存のExpress用httpServerにWebSocketサーバーを"相乗り"させる。
// 別ポートを使わず /ws/terminal というパスで区別する。
// ─────────────────────────────────────────────
function attachTerminalServer(httpServer) {
    const wss = new WebSocket.Server({ server: httpServer, path: '/ws/terminal' });

    wss.on('connection', (ws, req) => {
        console.log('[terminal] 新しいターミナル接続');

        // OSごとに使うシェルを切り替える(Linux/macなら bash、Windowsならpowershell)
        const shell = os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');

        const ptyProcess = pty.spawn(shell, [], {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd: process.env.RIVIFT_HOME || os.homedir(),
            env: process.env,
        });

        // ── PTY → フロント ──
        // bashの出力をそのままWebSocketで送る(ANSIエスケープシーケンス含む生データ)
        ptyProcess.onData((data) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'data', data }));
            }
        });

        ptyProcess.onExit(({ exitCode }) => {
            console.log(`[terminal] シェルプロセスが終了しました (code: ${exitCode})`);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'exit', exitCode }));
                ws.close();
            }
        });

        // ── フロント → PTY ──
        // フロントからは { type: 'input', data } と { type: 'resize', cols, rows }
        // の2種類のメッセージを受け取る想定。
        ws.on('message', (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return; // 不正なメッセージは無視
            }

            if (msg.type === 'input') {
                ptyProcess.write(msg.data);
            } else if (msg.type === 'resize') {
                // ターミナルウィンドウのリサイズに追従する
                try {
                    ptyProcess.resize(msg.cols, msg.rows);
                } catch (e) {
                    console.error('[terminal] resize失敗:', e.message);
                }
            }
        });

        ws.on('close', () => {
            console.log('[terminal] ターミナル接続が閉じられました。シェルを終了します。');
            ptyProcess.kill();
        });

        ws.on('error', (err) => {
            console.error('[terminal] WebSocketエラー:', err.message);
            ptyProcess.kill();
        });
    });

    console.log('[terminal] WebSocketターミナルサーバーを /ws/terminal で待機中');
    return wss;
}

module.exports = { attachTerminalServer };
