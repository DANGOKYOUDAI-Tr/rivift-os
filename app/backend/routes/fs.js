/**
 * routes/fs.js
 * ─────────────────────────────────────────────
 * 【フェーズ2】VFS(今までのIndexedDB上の仮想ファイルシステム)を
 * 本物のLinuxファイルシステムに繋ぐAPI。
 *
 * 設計方針:
 *   - フロントのVFS Worker(IndexedDB実装)が持っていた13個の操作
 *     (init, listFiles, readFile, writeFile, createFolder, move,
 *      rename, delete, restore, search, put, stat, chmod)
 *     と1対1で対応するエンドポイントを用意する。
 *   - VFS上の「パス」(例: /Documents/memo.txt)は、本物の環境では
 *     ROOT_DIR(ユーザーのホーム配下の専用フォルダ)を起点とした
 *     実パスにマッピングする。
 *     例: ROOT_DIR = /home/riviftuser/RiviftHome
 *         VFSパス "/Documents/memo.txt"
 *         → 実パス "/home/riviftuser/RiviftHome/Documents/memo.txt"
 *   - VFSの「Trash」はOSのゴミ箱概念に対応させる(今回はROOT_DIR内の
 *     .trash フォルダに退避させる簡易実装。本格的にはfreedesktop.org
 *     trash specに準拠させてもよい)。
 *   - セキュリティ: 必ず ROOT_DIR の外に出られないようパスを検証する
 *     (path traversal対策)。これが無いと "../../etc/passwd" のような
 *     パスでホスト全体を読み書きできてしまう。
 *
 * 注意:
 *   VFSの世界では1レコードが { path, parent, name, type, content,
 *   mode, ctime, mtime, atime, size, _enc, special } という形を
 *   持っていたが、本物のファイルシステムでは「メタ情報はOSが管理する
 *   もの」なので、必要な情報は毎回 fs.stat() 等から組み立てて返す。
 */

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const router = express.Router();

// ─────────────────────────────────────────────
// ルートディレクトリ(VFSの "/" が指す実際の場所)
// 環境変数で上書き可能にしておく(Electron化後はuserDataパス等を渡す想定)
// ─────────────────────────────────────────────
const ROOT_DIR = process.env.RIVIFT_HOME || path.join(os.homedir(), 'RiviftHome');
const TRASH_DIR = path.join(ROOT_DIR, '.trash');

// 起動時にROOT_DIR/TRASH_DIRが無ければ作成しておく
async function ensureRootDirs() {
    await fsp.mkdir(ROOT_DIR, { recursive: true });
    await fsp.mkdir(TRASH_DIR, { recursive: true });
}
ensureRootDirs().catch(e => console.error('[fs] ROOT_DIR初期化失敗:', e));

// ─────────────────────────────────────────────
// パス変換ヘルパー: VFSパス → 実パス (path traversal対策込み)
// ─────────────────────────────────────────────
function toRealPath(vfsPath) {
    if (typeof vfsPath !== 'string') throw new Error('path must be a string');
    // 先頭の "/" を取り除いてROOT_DIRと連結
    const cleaned = vfsPath.replace(/^\/+/, '');
    const real = path.normalize(path.join(ROOT_DIR, cleaned));
    // ROOT_DIRの外に出ようとしていないか検証(重要なセキュリティチェック)
    if (!real.startsWith(path.normalize(ROOT_DIR))) {
        throw new Error(`不正なパスです(ROOT_DIR外へのアクセス): ${vfsPath}`);
    }
    return real;
}

// 実パス → VFSパスに戻す(一覧表示時に使用)
function toVfsPath(realPath) {
    const rel = path.relative(ROOT_DIR, realPath).split(path.sep).join('/');
    return '/' + rel;
}

// VFSの "parent" 形式を計算 (例: "/Documents/memo.txt" → "/Documents")
function getParentVfsPath(vfsPath) {
    const idx = vfsPath.lastIndexOf('/');
    if (idx <= 0) return '/';
    return vfsPath.substring(0, idx);
}

// fs.stat結果をVFSのメタ情報形式に変換
async function statToVfsMeta(realPath, vfsPath) {
    const st = await fsp.stat(realPath);
    const name = path.basename(realPath);
    return {
        path: vfsPath,
        parent: getParentVfsPath(vfsPath),
        name,
        type: st.isDirectory() ? 'folder' : 'file',
        ctime: st.ctimeMs,
        mtime: st.mtimeMs,
        atime: st.atimeMs,
        mode: st.mode & 0o777,
        uid: 'user',
        nlink: st.nlink,
        size: st.size,
        _enc: false,
        special: false,
    };
}

// ─────────────────────────────────────────────
// POST /api/fs/init
// 本物のファイルシステムには「初期化」概念は薄いが、
// 互換性のためROOT_DIR配下の必須フォルダ群を確実に作る。
// ─────────────────────────────────────────────
router.post('/init', async (req, res) => {
    try {
        const requiredFolders = ['Apps', 'Documents', 'Pictures', 'Music', 'Videos', 'Downloads',
            'System', 'System/Calendar', 'System/Models', 'System/Wallpapers'];
        for (const folder of requiredFolders) {
            await fsp.mkdir(path.join(ROOT_DIR, folder), { recursive: true });
        }
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─────────────────────────────────────────────
// GET /api/fs/list?path=/Documents
// ─────────────────────────────────────────────
router.get('/list', async (req, res) => {
    try {
        const vfsPath = req.query.path || '/';
        const realPath = toRealPath(vfsPath);
        const entries = await fsp.readdir(realPath, { withFileTypes: true });

        const items = await Promise.all(entries.map(async (entry) => {
            const childVfsPath = (vfsPath === '/' ? '' : vfsPath) + '/' + entry.name;
            const childRealPath = path.join(realPath, entry.name);
            return statToVfsMeta(childRealPath, childVfsPath);
        }));

        // フォルダ優先 → 名前昇順 (元のVFS Workerの並び順を再現)
        items.sort((a, b) => {
            if (a.type === 'folder' && b.type !== 'folder') return -1;
            if (a.type !== 'folder' && b.type === 'folder') return 1;
            return a.name.localeCompare(b.name, 'ja');
        });

        res.json({ ok: true, items });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─────────────────────────────────────────────
// GET /api/fs/read?path=/Documents/memo.txt
// テキストはそのまま、バイナリはbase64で返す(encodingで判別)
// ─────────────────────────────────────────────
router.get('/read', async (req, res) => {
    try {
        const vfsPath = req.query.path;
        const realPath = toRealPath(vfsPath);
        const st = await fsp.stat(realPath);

        if (st.isDirectory()) {
            return res.status(400).json({ ok: false, error: 'フォルダは読み込めません(listFilesを使ってください)' });
        }

        const meta = await statToVfsMeta(realPath, vfsPath);

        // テキストとして読めるかをまず試す(画像等のバイナリはbase64にフォールバック)
        // 簡易判定: 拡張子ベース。本格的には file-type 判定ライブラリ等を使うとよい。
        const textExt = ['.txt', '.md', '.json', '.js', '.html', '.css', '.csv', '.log'];
        const isLikelyText = textExt.includes(path.extname(realPath).toLowerCase());

        let content, encoding;
        if (isLikelyText) {
            content = await fsp.readFile(realPath, 'utf8');
            encoding = 'utf8';
        } else {
            const buf = await fsp.readFile(realPath);
            content = buf.toString('base64');
            encoding = 'base64';
        }

        res.json({ ok: true, ...meta, content, encoding });
    } catch (e) {
        // ファイルが存在しない場合は404として明確に区別する。
        // VFS Workerの元の挙動(ファイルが無ければnullを返すだけ)に合わせるため、
        // これを500(サーバーエラー)にしてしまうと、フロント側が「本当の異常」と
        // 区別できず、インストール済みアプリ一覧等の「無くて当然」のファイル読み込みで
        // 毎回エラーログが出てしまう。
        if (e.code === 'ENOENT') {
            return res.status(404).json({ ok: false, error: 'ファイルが見つかりません', code: 'ENOENT' });
        }
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/fs/write  { parentPath, fileName, type, content, encoding }
// VFS Workerの writeFile(parentPath, fileName, type, content) に対応
// ─────────────────────────────────────────────
router.post('/write', async (req, res) => {
    try {
        const { parentPath, fileName, content, encoding } = req.body;
        const vfsPath = (parentPath === '/' ? '' : parentPath) + '/' + fileName;
        const realPath = toRealPath(vfsPath);

        await fsp.mkdir(path.dirname(realPath), { recursive: true });

        if (encoding === 'base64') {
            await fsp.writeFile(realPath, Buffer.from(content, 'base64'));
        } else {
            await fsp.writeFile(realPath, content ?? '', 'utf8');
        }

        const meta = await statToVfsMeta(realPath, vfsPath);
        res.json({ ok: true, ...meta });
    } catch (e) {
        console.error('[fs/write] failed:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/fs/mkdir  { parentPath, folderName }
// VFS Workerの createFolder(parentPath, folderName, isSpecial) に対応
// ─────────────────────────────────────────────
router.post('/mkdir', async (req, res) => {
    try {
        const { parentPath, folderName } = req.body;
        const vfsPath = (parentPath === '/' ? '' : parentPath) + '/' + folderName;
        const realPath = toRealPath(vfsPath);
        await fsp.mkdir(realPath, { recursive: true });
        const meta = await statToVfsMeta(realPath, vfsPath);
        res.json({ ok: true, ...meta });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/fs/move  { sourcePath, destFolderPath }
// ─────────────────────────────────────────────
router.post('/move', async (req, res) => {
    try {
        const { sourcePath, destFolderPath } = req.body;
        const srcReal = toRealPath(sourcePath);
        const fileName = path.basename(srcReal);
        const destVfsPath = (destFolderPath === '/' ? '' : destFolderPath) + '/' + fileName;
        const destReal = toRealPath(destVfsPath);

        await fsp.rename(srcReal, destReal);
        const meta = await statToVfsMeta(destReal, destVfsPath);
        res.json({ ok: true, ...meta });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/fs/rename  { oldPath, newName }
// ─────────────────────────────────────────────
router.post('/rename', async (req, res) => {
    try {
        const { oldPath, newName } = req.body;
        const oldReal = toRealPath(oldPath);
        const newReal = path.join(path.dirname(oldReal), newName);

        if (!newReal.startsWith(path.normalize(ROOT_DIR))) {
            throw new Error('不正なパスです');
        }

        await fsp.rename(oldReal, newReal);
        const newVfsPath = toVfsPath(newReal);
        const meta = await statToVfsMeta(newReal, newVfsPath);
        res.json({ ok: true, ...meta });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/fs/delete  { path, permanent }
// permanent=false → .trash へ移動(VFSの「ゴミ箱」概念を再現)
// permanent=true  → 完全削除
// ─────────────────────────────────────────────
router.post('/delete', async (req, res) => {
    try {
        const { path: vfsPath, permanent } = req.body;
        const realPath = toRealPath(vfsPath);
        const st = await fsp.stat(realPath);

        if (permanent) {
            if (st.isDirectory()) {
                await fsp.rm(realPath, { recursive: true, force: true });
            } else {
                await fsp.unlink(realPath);
            }
        } else {
            // ゴミ箱へ移動。名前衝突を避けるためタイムスタンプを付与する。
            const trashName = `${Date.now()}_${path.basename(realPath)}`;
            const trashPath = path.join(TRASH_DIR, trashName);
            await fsp.rename(realPath, trashPath);
            // 元の場所への復元情報をメタファイルとして残す(restoreで使用)
            await fsp.writeFile(trashPath + '.origin', vfsPath, 'utf8');
        }

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/fs/restore  { path }
// ゴミ箱からの復元。pathはゴミ箱内の名前(trashName)を受け取る想定。
// ─────────────────────────────────────────────
router.post('/restore', async (req, res) => {
    try {
        const { path: trashName } = req.body;
        const trashPath = path.join(TRASH_DIR, trashName);
        const originPath = trashPath + '.origin';

        const originVfsPath = await fsp.readFile(originPath, 'utf8');
        const destReal = toRealPath(originVfsPath);

        await fsp.mkdir(path.dirname(destReal), { recursive: true });
        await fsp.rename(trashPath, destReal);
        await fsp.unlink(originPath).catch(() => {});

        const meta = await statToVfsMeta(destReal, originVfsPath);
        res.json({ ok: true, ...meta });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─────────────────────────────────────────────
// GET /api/fs/search?query=keyword
// ROOT_DIR配下を再帰的に検索する(ファイルのみ、フォルダは除外)
// ─────────────────────────────────────────────
router.get('/search', async (req, res) => {
    try {
        const query = (req.query.query || '').toLowerCase();
        const results = [];

        async function walk(dir, vfsDir) {
            const entries = await fsp.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                // .trashディレクトリは検索対象から除外
                if (entry.name === '.trash') continue;
                const childReal = path.join(dir, entry.name);
                const childVfs = (vfsDir === '/' ? '' : vfsDir) + '/' + entry.name;
                if (entry.isDirectory()) {
                    await walk(childReal, childVfs);
                } else {
                    if (!query || entry.name.toLowerCase().includes(query)) {
                        results.push(await statToVfsMeta(childReal, childVfs));
                    }
                }
            }
        }
        await walk(ROOT_DIR, '/');
        res.json({ ok: true, items: results });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─────────────────────────────────────────────
// GET /api/fs/stat?path=/Documents/memo.txt
// ─────────────────────────────────────────────
router.get('/stat', async (req, res) => {
    try {
        const vfsPath = req.query.path;
        const realPath = toRealPath(vfsPath);
        const meta = await statToVfsMeta(realPath, vfsPath);
        res.json({ ok: true, ...meta });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/fs/chmod  { path, mode }
// mode は 8進数の権限(例: 0o644 → 420)
// ─────────────────────────────────────────────
router.post('/chmod', async (req, res) => {
    try {
        const { path: vfsPath, mode } = req.body;
        const realPath = toRealPath(vfsPath);
        await fsp.chmod(realPath, mode);
        const meta = await statToVfsMeta(realPath, vfsPath);
        res.json({ ok: true, ...meta });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

module.exports = router;
