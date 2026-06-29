/**
 * routes/system.js
 * ─────────────────────────────────────────────
 * 【フェーズ1】電源操作・画面の明るさ・音量を本物のLinuxコマンドに繋ぐAPI。
 *
 * 設計方針:
 *   - reboot/shutdown は root権限が必要 → sudoersで「このコマンドだけ」許可する
 *     (server.js自体をrootで動かさない。最小権限の原則)
 *   - 明るさは sysfs の backlight ディレクトリ配下の brightness ファイルへの書き込み
 *     → udevルールでグループ書き込み権限を付与しておけばsudo不要
 *   - 音量は PipeWire(wpctl) を第一候補、無ければ PulseAudio(pactl) にフォールバック
 *
 * 前提となるLinux側の設定（実機セットアップ時に必要）:
 *   1. /etc/sudoers.d/rivift に以下を記載:
 *        riviftuser ALL=(root) NOPASSWD: /sbin/reboot, /sbin/shutdown
 *   2. /etc/udev/rules.d/90-backlight.rules に以下を記載:
 *        SUBSYSTEM=="backlight", ACTION=="add", \
 *          RUN+="/bin/chgrp video /sys/class/backlight/%k/brightness", \
 *          RUN+="/bin/chmod g+w /sys/class/backlight/%k/brightness"
 *      → riviftuser を video グループに入れておく
 *   3. wpctl (PipeWire) または pactl (PulseAudio) がインストールされていること
 *
 * このファイルは「本物のLinuxコマンドを呼ぶ層」を全て集約している。
 * 実機がまだ無い開発中(今の段階)は、execが失敗してもクラッシュしないよう
 * try/catchでエラーをJSONとして返す形にしてある。
 */

const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const router = express.Router();

// ─────────────────────────────────────────────
// 共通ヘルパー: コマンドをPromiseで実行
// ─────────────────────────────────────────────
function run(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr?.trim() || err.message));
            } else {
                resolve(stdout?.trim() || '');
            }
        });
    });
}

// ─────────────────────────────────────────────
// POST /api/system/reboot
// ─────────────────────────────────────────────
router.post('/reboot', async (req, res) => {
    try {
        // 実機: sudoers設定済みのreboot専用コマンドを実行
        await run('sudo /sbin/reboot');
        res.json({ ok: true });
    } catch (e) {
        console.error('[system/reboot] failed:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/system/shutdown
// ─────────────────────────────────────────────
router.post('/shutdown', async (req, res) => {
    try {
        await run('sudo /sbin/shutdown -h now');
        res.json({ ok: true });
    } catch (e) {
        console.error('[system/shutdown] failed:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─────────────────────────────────────────────
// バックライトデバイスの自動検出
// 機種によって intel_backlight / amdgpu_bl0 / acpi_video0 等、
// 名前が変わるため、起動時に /sys/class/backlight/ を覗いて
// 最初に見つかったデバイスを採用する。
// ─────────────────────────────────────────────
const BACKLIGHT_BASE = '/sys/class/backlight';
function findBacklightDevice() {
    try {
        const entries = fs.readdirSync(BACKLIGHT_BASE);
        if (entries.length === 0) return null;
        return path.join(BACKLIGHT_BASE, entries[0]);
    } catch {
        return null; // 実機以外(開発中のVM/コンテナ等)ではここに来る
    }
}

// ─────────────────────────────────────────────
// GET /api/system/brightness  → 現在値を 0-100 で返す
// ─────────────────────────────────────────────
router.get('/brightness', (req, res) => {
    const device = findBacklightDevice();
    if (!device) {
        return res.status(404).json({ ok: false, error: 'バックライトデバイスが見つかりません(開発機の可能性)' });
    }
    try {
        const max = parseInt(fs.readFileSync(path.join(device, 'max_brightness'), 'utf8'), 10);
        const current = parseInt(fs.readFileSync(path.join(device, 'brightness'), 'utf8'), 10);
        res.json({ ok: true, value: Math.round((current / max) * 100) });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/system/brightness  { value: 0-100 }
// ─────────────────────────────────────────────
router.post('/brightness', (req, res) => {
    const value = Number(req.body?.value);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
        return res.status(400).json({ ok: false, error: 'value は 0-100 の数値で指定してください' });
    }
    const device = findBacklightDevice();
    if (!device) {
        return res.status(404).json({ ok: false, error: 'バックライトデバイスが見つかりません(開発機の可能性)' });
    }
    try {
        const max = parseInt(fs.readFileSync(path.join(device, 'max_brightness'), 'utf8'), 10);
        const target = Math.round((value / 100) * max);
        // udevルールでグループ書き込み権限が付与されていればsudo不要で書ける
        fs.writeFileSync(path.join(device, 'brightness'), String(target));
        res.json({ ok: true, value });
    } catch (e) {
        console.error('[system/brightness] failed:', e.message);
        res.status(500).json({ ok: false, error: e.message + ' (udevルールでの権限付与が必要な場合があります)' });
    }
});

// ─────────────────────────────────────────────
// 音量制御: PipeWire(wpctl) → PulseAudio(pactl) の順でフォールバック
// ─────────────────────────────────────────────
async function detectAudioBackend() {
    try {
        await run('which wpctl');
        return 'pipewire';
    } catch { /* fallthrough */ }
    try {
        await run('which pactl');
        return 'pulseaudio';
    } catch { /* fallthrough */ }
    return null;
}

// GET /api/system/volume → 現在値を 0-100 で返す
router.get('/volume', async (req, res) => {
    const backend = await detectAudioBackend();
    try {
        if (backend === 'pipewire') {
            const out = await run('wpctl get-volume @DEFAULT_AUDIO_SINK@');
            // 例: "Volume: 0.45" のような出力をパース
            const match = out.match(/([\d.]+)/);
            const value = match ? Math.round(parseFloat(match[1]) * 100) : null;
            return res.json({ ok: true, backend, value });
        }
        if (backend === 'pulseaudio') {
            const out = await run("pactl get-sink-volume @DEFAULT_SINK@");
            const match = out.match(/(\d+)%/);
            const value = match ? parseInt(match[1], 10) : null;
            return res.json({ ok: true, backend, value });
        }
        return res.status(404).json({ ok: false, error: 'オーディオバックエンドが見つかりません(開発機の可能性)' });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/system/volume  { value: 0-100 }
router.post('/volume', async (req, res) => {
    const value = Number(req.body?.value);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
        return res.status(400).json({ ok: false, error: 'value は 0-100 の数値で指定してください' });
    }
    const backend = await detectAudioBackend();
    try {
        if (backend === 'pipewire') {
            await run(`wpctl set-volume @DEFAULT_AUDIO_SINK@ ${value}%`);
            return res.json({ ok: true, backend, value });
        }
        if (backend === 'pulseaudio') {
            await run(`pactl set-sink-volume @DEFAULT_SINK@ ${value}%`);
            return res.json({ ok: true, backend, value });
        }
        return res.status(404).json({ ok: false, error: 'オーディオバックエンドが見つかりません(開発機の可能性)' });
    } catch (e) {
        console.error('[system/volume] failed:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

module.exports = router;
