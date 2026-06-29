/**
 * preload.js — Rivift OS Electron preloadスクリプト
 * ─────────────────────────────────────────────
 * 【フェーズ5】rendererプロセス(index.html)とメインプロセス(main.js)の間で、
 * BrowserView操作のIPCを安全に橋渡しする。
 *
 * contextIsolation: true の状態でも、contextBridge経由なら
 * rendererのグローバルスコープ(window)に安全に関数を生やせる。
 * Node.js自体やfs等の生のAPIはrendererに渡らないため、
 * 任意のWebコンテンツ(ブラウザアプリで開いた外部サイト等)から
 * このAPIが悪用されるリスクは無い。
 *
 * フロント側からは window.riviftBrowserView.* として呼び出せる。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('riviftBrowserView', {
    // 新しいタブ(BrowserView)を作成する
    create: (tabId, url) => ipcRenderer.invoke('rivift-browserview-create', { tabId, url }),

    // タブを表示する(座標: { x, y, width, height })
    show: (tabId, bounds) => ipcRenderer.invoke('rivift-browserview-show', { tabId, bounds }),

    // タブを隠す
    hide: (tabId) => ipcRenderer.invoke('rivift-browserview-hide', { tabId }),

    // 座標だけ更新する(ウィンドウリサイズ追従用)
    setBounds: (tabId, bounds) => ipcRenderer.invoke('rivift-browserview-set-bounds', { tabId, bounds }),

    // URLへ遷移する
    loadURL: (tabId, url) => ipcRenderer.invoke('rivift-browserview-load-url', { tabId, url }),

    // 戻る/進む/リロード/停止
    goBack: (tabId) => ipcRenderer.invoke('rivift-browserview-nav', { tabId, action: 'back' }),
    goForward: (tabId) => ipcRenderer.invoke('rivift-browserview-nav', { tabId, action: 'forward' }),
    reload: (tabId) => ipcRenderer.invoke('rivift-browserview-nav', { tabId, action: 'reload' }),
    stop: (tabId) => ipcRenderer.invoke('rivift-browserview-nav', { tabId, action: 'stop' }),

    // タブを破棄する
    destroy: (tabId) => ipcRenderer.invoke('rivift-browserview-destroy', { tabId }),

    // ── メインプロセスからの通知を受け取るイベントリスナー登録 ──
    onTitleUpdated: (callback) => {
        ipcRenderer.on('rivift-browserview-title', (event, data) => callback(data));
    },
    onLoadingChanged: (callback) => {
        ipcRenderer.on('rivift-browserview-loading', (event, data) => callback(data));
    },
    onNavigated: (callback) => {
        ipcRenderer.on('rivift-browserview-navigated', (event, data) => callback(data));
    },
    onError: (callback) => {
        ipcRenderer.on('rivift-browserview-error', (event, data) => callback(data));
    },
    onFaviconUpdated: (callback) => {
        ipcRenderer.on('rivift-browserview-favicon', (event, data) => callback(data));
    },
});
