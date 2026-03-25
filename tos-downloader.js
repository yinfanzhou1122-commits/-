/**
 * tos-downloader.js
 * 从火山引擎 TOS 断点续传下载图片包，解压到指定目录
 * 通过 IPC 向 Electron 主进程报告进度
 */
import { TosClient, TosClientError, TosServerError, DataTransferType } from '@volcengine/tos-sdk';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { createWriteStream } from 'fs';

// ── 配置（从环境变量读取）──────────────────────────
export const TOS_CONFIG = {
    accessKeyId:     process.env.TOS_ACCESS_KEY     || '',
    accessKeySecret: process.env.TOS_SECRET_KEY     || '',
    region:          process.env.TOS_REGION         || 'cn-beijing',
    endpoint:        process.env.TOS_ENDPOINT       || '',
    bucket:          process.env.TOS_BUCKET         || '',
    objectKey:       process.env.TOS_OBJECT_KEY     || 'image.zip',
};

/**
 * 创建 TOS 客户端
 */
function createClient() {
    return new TosClient({
        accessKeyId:     TOS_CONFIG.accessKeyId,
        accessKeySecret: TOS_CONFIG.accessKeySecret,
        region:          TOS_CONFIG.region,
        endpoint:        TOS_CONFIG.endpoint || undefined,
    });
}

/**
 * 检查图片目录是否已存在且有效
 * @param {string} imageDir
 */
export function isImageDirReady(imageDir) {
    if (!fs.existsSync(imageDir)) return false;
    try {
        const entries = fs.readdirSync(imageDir);
        return entries.length > 0;
    } catch {
        return false;
    }
}

/**
 * 断点续传下载图片包并解压
 * @param {object} options
 * @param {string} options.imageDir       - 最终图片目录
 * @param {string} options.tempDir        - 临时文件目录
 * @param {function} options.onProgress   - 进度回调 ({ phase, percent, speed, downloaded, total })
 * @param {function} options.onError      - 错误回调
 * @param {function} options.onComplete   - 完成回调
 */
export async function downloadImages({ imageDir, tempDir, onProgress, onError, onComplete }) {
    const zipPath       = path.join(tempDir, 'image.zip');
    const checkpointPath = path.join(tempDir, 'image.checkpoint');

    // 确保临时目录存在
    await fsp.mkdir(tempDir, { recursive: true });
    await fsp.mkdir(imageDir, { recursive: true });

    const client = createClient();

    try {
        onProgress({ phase: 'download', percent: 0, downloaded: 0, total: 0, speed: 0 });

        let lastBytes = 0;
        let lastTime  = Date.now();

        await client.downloadFile({
            bucket:    TOS_CONFIG.bucket,
            key:       TOS_CONFIG.objectKey,
            filePath:  zipPath,
            partSize:  10 * 1024 * 1024,  // 10MB 分片
            taskNum:   5,                  // 5 并发
            checkpoint: checkpointPath,
            dataTransferStatusChange: (event) => {
                if (event.type === DataTransferType.Rw) {
                    const now = Date.now();
                    const elapsed = (now - lastTime) / 1000 || 0.001;
                    const speed = (event.rwOnceBytes / elapsed / 1024 / 1024); // MB/s
                    lastBytes = event.consumedBytes;
                    lastTime  = now;

                    const percent = event.totalBytes
                        ? Math.floor((event.consumedBytes / event.totalBytes) * 100)
                        : 0;

                    onProgress({
                        phase:      'download',
                        percent,
                        downloaded: event.consumedBytes,
                        total:      event.totalBytes,
                        speed:      speed.toFixed(2),
                    });
                } else if (event.type === DataTransferType.Succeed) {
                    onProgress({ phase: 'download', percent: 100, downloaded: event.totalBytes, total: event.totalBytes, speed: 0 });
                } else if (event.type === DataTransferType.Failed) {
                    onError(new Error('下载失败'));
                }
            },
        });

        // 解压
        onProgress({ phase: 'extract', percent: 0, downloaded: 0, total: 0, speed: 0 });
        await extractZip(zipPath, imageDir, onProgress);

        // 清理临时文件
        try {
            await fsp.unlink(zipPath);
            await fsp.unlink(checkpointPath).catch(() => {});
        } catch {}

        // 写入完成标记文件
        await fsp.writeFile(path.join(imageDir, '.download_complete'), new Date().toISOString());

        onComplete();
    } catch (error) {
        let msg = error.message || String(error);
        // AggregateError 包含多个子错误，提取详细信息
        if (error.name === 'AggregateError' || error instanceof AggregateError) {
            const errors = error.errors || [];
            const details = errors.map(e => e.message || String(e)).join('; ');
            msg = `AggregateError: ${details || '多个请求同时失败，请检查网络或 TOS 配置'}`;
        } else if (error instanceof TosClientError) {
            msg = `TOS 客户端错误: ${error.message}`;
        } else if (error instanceof TosServerError) {
            msg = `TOS 服务端错误 [${error.statusCode}]: ${error.message} (code: ${error.code})`;
        }
        onError(new Error(msg));
    }
}

/**
 * 解压 ZIP 文件（使用 Node 内置 zlib + 流，或调用系统命令）
 */
async function extractZip(zipPath, destDir, onProgress) {
    // 使用动态 import 加载 unzipper（在 dependencies 中）
    try {
        const { default: unzipper } = await import('unzipper');
        await new Promise((resolve, reject) => {
            let extractedCount = 0;
            fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: destDir }))
                .on('entry', () => {
                    extractedCount++;
                    if (extractedCount % 50 === 0) {
                        onProgress({ phase: 'extract', percent: -1, extracted: extractedCount, speed: 0 });
                    }
                })
                .on('finish', resolve)
                .on('error', reject);
        });
    } catch (e) {
        // fallback：如果 unzipper 不可用，抛出提示
        throw new Error(`解压失败，请确保已安装 unzipper: ${e.message}`);
    }
}
