const express = require('express');
const { exec } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const router = express.Router();

const APP_DIR = path.resolve(__dirname, '..');
const PKG_PATH = path.join(APP_DIR, 'package.json');

// RIVIFT_UPDATE_URL の書式:
//   gh:owner/repo          → GitHub Releases から最新を取得
//   https://example.com/   → latest.json を取得
const UPDATE_SOURCE = (process.env.RIVIFT_UPDATE_URL || '').trim();

function getCurrentVersion() {
    try {
        return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')).version || '0.0.0';
    } catch { return '0.0.0'; }
}

function semverGt(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return true;
        if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return false;
}

function parseTagAsVersion(tag) {
    return (tag || '').replace(/^v/, '');
}

// GitHub Releases から最新情報を取得
async function fetchFromGitHub(repo) {
    const api = `https://api.github.com/repos/${repo}/releases/latest`;
    const res = await fetch(api, {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'RiviftOS' },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
    const data = await res.json();

    const version = parseTagAsVersion(data.tag_name);
    // 最初の zip アセットを探す
    const asset = (data.assets || []).find(a => a.name.endsWith('.zip') || a.content_type === 'application/zip');
    if (!asset) throw new Error('No zip asset found in the latest release');

    return {
        version,
        downloadUrl: asset.browser_download_url,
        size: asset.size,
        changelog: data.body || '',
        releaseUrl: data.html_url,
    };
}

// Static latest.json から取得
async function fetchFromJson(url) {
    const base = url.replace(/\/+$/, '');
    const res = await fetch(`${base}/latest.json`, {
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
        version: data.version,
        downloadUrl: data.download_url,
        sha256: data.sha256 || '',
        changelog: data.changelog || '',
    };
}

// GET /api/system/update/check
router.get('/update/check', async (req, res) => {
    try {
        const currentVersion = getCurrentVersion();

        if (!UPDATE_SOURCE) {
            return res.json({ ok: false, error: 'アップデートサーバーが設定されていません（RIVIFT_UPDATE_URL）', currentVersion });
        }

        let info;
        if (UPDATE_SOURCE.startsWith('gh:')) {
            const repo = UPDATE_SOURCE.slice(3);
            info = await fetchFromGitHub(repo);
        } else {
            info = await fetchFromJson(UPDATE_SOURCE);
        }

        const hasUpdate = semverGt(info.version, currentVersion);

        res.json({
            ok: true,
            currentVersion,
            latestVersion: info.version,
            hasUpdate,
            downloadUrl: info.downloadUrl,
            sha256: info.sha256 || undefined,
            changelog: info.changelog,
        });
    } catch (e) {
        res.json({ ok: false, error: e.message, currentVersion: getCurrentVersion() });
    }
});

// POST /api/system/update/apply
router.post('/update/apply', async (req, res) => {
    const { downloadUrl, sha256 } = req.body;
    if (!downloadUrl) {
        return res.status(400).json({ ok: false, error: 'downloadUrl is required' });
    }

    const updateDir = '/tmp/rivift-update';
    const zipPath = path.join(updateDir, 'update.zip');
    const extractDir = path.join(updateDir, 'extracted');
    const backupDir = path.join(updateDir, 'backup');

    try {
        await fsp.mkdir(updateDir, { recursive: true });

        const dl = await fetch(downloadUrl, { signal: AbortSignal.timeout(120000) });
        if (!dl.ok) throw new Error(`Download failed (HTTP ${dl.status})`);

        const buf = Buffer.from(await dl.arrayBuffer());

        if (sha256) {
            const hash = crypto.createHash('sha256').update(buf).digest('hex');
            if (hash !== sha256.toLowerCase()) {
                throw new Error('SHA256 mismatch — download may be corrupted');
            }
        }

        await fsp.writeFile(zipPath, buf);

        await fsp.mkdir(extractDir, { recursive: true });
        await new Promise((resolve, reject) => {
            exec(`unzip -o "${zipPath}" -d "${extractDir}"`, { timeout: 60000 }, (err, so, se) => {
                if (err) reject(new Error(`Extract failed: ${se || err.message}`));
                else resolve(so);
            });
        });

        const entries = await fsp.readdir(extractDir);
        const appRoot = entries.find(e =>
            e === 'package.json' || fs.existsSync(path.join(extractDir, e, 'package.json'))
        );
        const sourceDir = appRoot && appRoot !== 'package.json'
            ? path.join(extractDir, appRoot) : extractDir;

        if (!fs.existsSync(path.join(sourceDir, 'package.json'))) {
            throw new Error('Invalid update: package.json not found');
        }

        const hasMainJs = fs.existsSync(path.join(sourceDir, 'main.js'));
        const hasBackend = fs.existsSync(path.join(sourceDir, 'backend', 'server.js'));
        if (!hasMainJs || !hasBackend) {
            throw new Error('Invalid update: missing main.js or backend/server.js');
        }

        await fsp.rm(backupDir, { recursive: true, force: true });
        await fsp.cp(APP_DIR, backupDir, { recursive: true });

        await fsp.rm(path.join(APP_DIR, 'node_modules'), { recursive: true, force: true }).catch(() => {});
        await fsp.rm(path.join(APP_DIR, 'backend', 'node_modules'), { recursive: true, force: true }).catch(() => {});

        await copyDir(sourceDir, APP_DIR);

        exec('npm install 2>&1', { cwd: APP_DIR, timeout: 180000 }, (err, stdout) => {
            if (err) {
                console.error('[update] npm install failed, rolling back:', stdout);
                rollback(APP_DIR, backupDir);
                return;
            }
            exec('npm install 2>&1', { cwd: path.join(APP_DIR, 'backend'), timeout: 120000 }, (err2) => {
                if (err2) console.warn('[update] backend npm install failed:', err2.message);
            });
        });

        res.json({ ok: true, status: 'applied', message: 'アップデートが適用されました。再起動します。' });

        setTimeout(() => {
            exec('sudo /sbin/reboot', (e) => {
                if (e) console.error('[update] reboot failed:', e.message);
            });
        }, 2000);

    } catch (e) {
        await rollback(APP_DIR, backupDir).catch(() => {});
        res.status(500).json({ ok: false, error: e.message });
    }
});

async function copyDir(src, dest) {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            await copyDir(s, d);
        } else {
            await fsp.copyFile(s, d);
        }
    }
}

async function rollback(appDir, backupDir) {
    console.error('[update] Rolling back to previous version...');
    await fsp.rm(appDir, { recursive: true, force: true }).catch(() => {});
    await fsp.cp(backupDir, appDir, { recursive: true }).catch(() => {});
    exec('sudo /sbin/reboot', () => {});
}

module.exports = router;
