/**
 * main.js — Rivift OS Electronメインプロセス
 * ─────────────────────────────────────────────
 * 【フェーズ4】今までNode.js単体 + ブラウザで動かしていたRivift OSを、
 * Electronアプリとして起動する。
 *
 * 【フェーズ5】ブラウザアプリを本物のChromiumで表示するために、
 * 最初は<webview>タグを試したが、近年のElectronでは<webview>が
 * 非推奨化が進んでおり(webviewTag:trueやsandbox:falseを設定しても
 * HTMLElementとして認識されず有効化できないケースがあった)、
 * 代わりにElectron公式が推奨する BrowserView を使う方式に変更した。
 *
 * BrowserViewはDOM要素ではなく、メインプロセス側のJS APIで操作する
 * 「ウィンドウに重ねて表示する別のWebコンテンツ領域」。
 * rendererの index.html 側では、ブラウザアプリのタブ表示領域の
 * 座標・サイズをIPC(window.riviftBrowserView.*)でメインプロセスに伝え、
 * メインプロセスがその座標にBrowserViewを重ねて表示する。
 *
 * やっていること:
 *   1. backend/server.js をこのプロセスの「子プロセス」として起動する
 *   2. バックエンドの /api/health が応答するまで待つ
 *   3. 本物のChromiumウィンドウ(kioskモード)を開き、backendのURLを表示する
 *   4. ブラウザアプリ用に、複数のBrowserViewをタブのように管理するIPCを提供する
 */

const { app, BrowserWindow, BrowserView, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

const isDev = process.argv.includes('--dev');
const BACKEND_PORT = process.env.RIVIFT_PORT || 7890;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

let backendProcess = null;
let mainWindow = null;

// 【フェーズ5】タブID(フロント側で発行するuid文字列) → BrowserViewインスタンス
const browserViews = new Map();
let activeViewId = null;

// ─────────────────────────────────────────────
// バックエンド(Express)を子プロセスとして起動する
// ─────────────────────────────────────────────
function startBackend() {
    return new Promise((resolve, reject) => {
        const serverPath = path.join(__dirname, 'backend', 'server.js');
        backendProcess = spawn(process.execPath, [serverPath], {
            // ELECTRON_RUN_AS_NODE を立てることで、Electronの実行ファイルを
            // 「普通のNode.js」として動かす(別途Node.jsを同梱しなくて済む)
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', RIVIFT_PORT: String(BACKEND_PORT) },
            stdio: isDev ? 'inherit' : 'pipe',
        });

        backendProcess.on('error', (err) => {
            console.error('[main] バックエンド起動に失敗しました:', err);
            reject(err);
        });

        backendProcess.on('exit', (code) => {
            console.log(`[main] バックエンドプロセスが終了しました (code: ${code})`);
            backendProcess = null;
        });

        // バックエンドが /api/health に応答するまでポーリングして待つ
        // (起動直後はまだExpressがlistenしていない可能性があるため)
        let attempts = 0;
        const maxAttempts = 50; // 50 * 200ms = 10秒でタイムアウト
        const checkHealth = async () => {
            attempts++;
            try {
                const res = await fetch(`${BACKEND_URL}/api/health`);
                if (res.ok) {
                    console.log('[main] バックエンドの起動を確認しました');
                    return resolve();
                }
            } catch {
                // まだ起動していない。リトライする。
            }
            if (attempts >= maxAttempts) {
                return reject(new Error('バックエンドの起動がタイムアウトしました'));
            }
            setTimeout(checkHealth, 200);
        };
        checkHealth();
    });
}

// ─────────────────────────────────────────────
// 【フェーズ5】BrowserView管理のIPCハンドラ群
// フロント(index.html)からの呼び出しはpreload.js経由でここに届く。
// ─────────────────────────────────────────────
function setupBrowserViewIPC() {
    // 新しいタブ(BrowserView)を作成する
    ipcMain.handle('rivift-browserview-create', (event, { tabId, url }) => {
        if (browserViews.has(tabId)) return { ok: true }; // 既に存在する場合は何もしない

        const view = new BrowserView({
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                // タブごとに完全に独立したセッションにする(Cookie等を分離)
                partition: `persist:rivift-browser-${tabId}`,
            },
        });
        browserViews.set(tabId, view);

        // ページタイトル・読み込み状態の変化をフロントに通知する
        view.webContents.on('page-title-updated', (e, title) => {
            mainWindow?.webContents.send('rivift-browserview-title', { tabId, title });
        });
        view.webContents.on('did-start-loading', () => {
            mainWindow?.webContents.send('rivift-browserview-loading', { tabId, loading: true });
        });
        view.webContents.on('did-stop-loading', () => {
            mainWindow?.webContents.send('rivift-browserview-loading', { tabId, loading: false });
        });
        view.webContents.on('did-navigate', (e, navUrl) => {
            mainWindow?.webContents.send('rivift-browserview-navigated', { tabId, url: navUrl });
        });
        view.webContents.on('did-navigate-in-page', (e, navUrl) => {
            mainWindow?.webContents.send('rivift-browserview-navigated', { tabId, url: navUrl });
        });
        view.webContents.on('did-fail-load', (e, errorCode, errorDescription) => {
            mainWindow?.webContents.send('rivift-browserview-error', { tabId, errorCode, errorDescription });
        });
        // favicon取得
        view.webContents.on('page-favicon-updated', (e, favicons) => {
            mainWindow?.webContents.send('rivift-browserview-favicon', { tabId, favicon: favicons[0] || '' });
        });

        if (url) view.webContents.loadURL(url);
        return { ok: true };
    });

    // タブを表に出す(他のBrowserViewは隠す) & 座標・サイズを設定する
    ipcMain.handle('rivift-browserview-show', (event, { tabId, bounds }) => {
        const view = browserViews.get(tabId);
        if (!view || !mainWindow) return { ok: false, error: 'view not found' };

        // 他のタブのBrowserViewは一旦ウィンドウから外す(複数表示を防ぐ)
        if (activeViewId && activeViewId !== tabId) {
            const prevView = browserViews.get(activeViewId);
            if (prevView) mainWindow.removeBrowserView(prevView);
        }

        mainWindow.addBrowserView(view);
        if (bounds) view.setBounds(bounds);
        activeViewId = tabId;
        return { ok: true };
    });

    // タブを隠す(BrowserViewをウィンドウから外すだけ、破棄はしない)
    ipcMain.handle('rivift-browserview-hide', (event, { tabId }) => {
        const view = browserViews.get(tabId);
        if (view && mainWindow) mainWindow.removeBrowserView(view);
        if (activeViewId === tabId) activeViewId = null;
        return { ok: true };
    });

    // 座標・サイズだけ更新する(ウィンドウリサイズ追従用)
    ipcMain.handle('rivift-browserview-set-bounds', (event, { tabId, bounds }) => {
        const view = browserViews.get(tabId);
        if (view) view.setBounds(bounds);
        return { ok: true };
    });

    // URLへ遷移する
    ipcMain.handle('rivift-browserview-load-url', (event, { tabId, url }) => {
        const view = browserViews.get(tabId);
        if (!view) return { ok: false, error: 'view not found' };
        view.webContents.loadURL(url);
        return { ok: true };
    });

    // 戻る/進む/リロード/停止
    ipcMain.handle('rivift-browserview-nav', (event, { tabId, action }) => {
        const view = browserViews.get(tabId);
        if (!view) return { ok: false, error: 'view not found' };
        const wc = view.webContents;
        if (action === 'back' && wc.canGoBack()) wc.goBack();
        else if (action === 'forward' && wc.canGoForward()) wc.goForward();
        else if (action === 'reload') wc.reload();
        else if (action === 'stop') wc.stop();
        return { ok: true };
    });

    // タブを破棄する
    ipcMain.handle('rivift-browserview-destroy', (event, { tabId }) => {
        const view = browserViews.get(tabId);
        if (view) {
            if (mainWindow) mainWindow.removeBrowserView(view);
            view.webContents.close();
            browserViews.delete(tabId);
        }
        if (activeViewId === tabId) activeViewId = null;
        return { ok: true };
    });
}

// ─────────────────────────────────────────────
// メインウィンドウ(Rivift OSの画面そのもの)を作成
// ─────────────────────────────────────────────
function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        // 本番(ISO化後の実機)では kiosk:true にして、OSのデスクトップ環境として
        // 全画面・枠なしで起動する。開発中は通常のウィンドウとして確認しやすくする。
        kiosk: !isDev,
        fullscreen: !isDev ? true : false,
        frame: isDev, // 開発中はウィンドウ枠を残してリロード等をしやすくする
        backgroundColor: '#000000',
        webPreferences: {
            // 【フェーズ5】BrowserViewとのIPC通信のためpreload.jsを使う。
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    mainWindow.loadURL(BACKEND_URL);

    if (isDev) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ─────────────────────────────────────────────
// アプリのライフサイクル
// ─────────────────────────────────────────────
app.whenReady().then(async () => {
    try {
        setupBrowserViewIPC();
        await startBackend();
        createMainWindow();
    } catch (err) {
        console.error('[main] 起動に失敗しました:', err);
        app.quit();
    }
});

app.on('window-all-closed', () => {
    // OSのシェルとして動く想定なので、ウィンドウが閉じてもアプリ自体は
    // (kioskモードでは通常閉じる手段が無いが)念のためバックエンドを片付けて終了する。
    if (backendProcess) backendProcess.kill();
    app.quit();
});

app.on('before-quit', () => {
    if (backendProcess) backendProcess.kill();
});

// macOS的な「Dockに残る」挙動は今回のキオスク用途では不要なので無効化
app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

