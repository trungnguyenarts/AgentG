import fs from 'fs/promises';
import path from 'path';

// Configuration
const MAX_AGE_DAYS = 7; // Keep files for 7 days
const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // Run every 6 hours
const MIN_FILES_TO_KEEP = 10; // Safety net: always keep at least 10 newest files

/**
 * Get all files in upload directories with metadata
 */
async function getAllFiles(uploadDir) {
    const folders = ['audio', 'files'];
    const allFiles = [];

    for (const folder of folders) {
        const dir = path.join(uploadDir, folder);

        try {
            const files = await fs.readdir(dir);

            for (const file of files) {
                const filePath = path.join(dir, file);
                try {
                    const stats = await fs.stat(filePath);
                    allFiles.push({
                        path: filePath,
                        name: file,
                        folder: folder,
                        size: stats.size,
                        createdAt: stats.birthtimeMs,
                        modifiedAt: stats.mtimeMs
                    });
                } catch (err) {
                    console.warn(`⚠️ Could not stat file ${file}:`, err.message);
                }
            }
        } catch (err) {
            console.warn(`⚠️ Could not read directory ${folder}:`, err.message);
        }
    }

    return allFiles;
}

/**
 * Clean up old files based on age
 */
async function cleanupOldFiles(uploadDir) {
    console.log('🧹 Starting cache cleanup...');

    const now = Date.now();
    const maxAge = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

    const allFiles = await getAllFiles(uploadDir);

    // Sort by creation time (newest first)
    allFiles.sort((a, b) => b.createdAt - a.createdAt);

    let deletedCount = 0;
    let deletedSize = 0;

    for (let i = 0; i < allFiles.length; i++) {
        const file = allFiles[i];
        const age = now - file.createdAt;

        // Safety: Keep at least MIN_FILES_TO_KEEP newest files
        if (i < MIN_FILES_TO_KEEP) {
            continue;
        }

        // Delete if older than MAX_AGE_DAYS
        if (age > maxAge) {
            try {
                await fs.unlink(file.path);
                deletedCount++;
                deletedSize += file.size;

                const ageDays = Math.floor(age / (24 * 60 * 60 * 1000));
                console.log(`🗑️  Deleted: ${file.name} (${ageDays} days old, ${formatBytes(file.size)})`);
            } catch (err) {
                console.error(`❌ Failed to delete ${file.name}:`, err.message);
            }
        }
    }

    if (deletedCount > 0) {
        console.log(`✅ Cleanup complete: ${deletedCount} files deleted (${formatBytes(deletedSize)} freed)`);
    } else {
        console.log('✅ Cleanup complete: No old files to delete');
    }

    return { deletedCount, deletedSize };
}

/**
 * Get cache statistics
 */
export async function getCacheStats(uploadDir) {
    const allFiles = await getAllFiles(uploadDir);

    const stats = {
        totalFiles: allFiles.length,
        totalSize: 0,
        byFolder: {
            audio: { count: 0, size: 0 },
            files: { count: 0, size: 0 }
        },
        oldestFile: null,
        newestFile: null
    };

    for (const file of allFiles) {
        stats.totalSize += file.size;
        stats.byFolder[file.folder].count++;
        stats.byFolder[file.folder].size += file.size;

        if (!stats.oldestFile || file.createdAt < stats.oldestFile.createdAt) {
            stats.oldestFile = file;
        }
        if (!stats.newestFile || file.createdAt > stats.newestFile.createdAt) {
            stats.newestFile = file;
        }
    }

    return stats;
}

/**
 * Start automatic cleanup scheduler
 */
export function startCleanupScheduler(uploadDir) {
    console.log(`🚀 Cache cleanup scheduler started (runs every ${CLEANUP_INTERVAL / 1000 / 60 / 60} hours)`);
    console.log(`📋 Policy: Delete files older than ${MAX_AGE_DAYS} days (keeping at least ${MIN_FILES_TO_KEEP} newest)`);

    // Run cleanup on startup
    cleanupOldFiles(uploadDir).catch(err => {
        console.error('❌ Cleanup failed on startup:', err);
    });

    // Schedule periodic cleanup
    const intervalId = setInterval(() => {
        cleanupOldFiles(uploadDir).catch(err => {
            console.error('❌ Scheduled cleanup failed:', err);
        });
    }, CLEANUP_INTERVAL);

    // Return cleanup function for graceful shutdown
    return () => {
        clearInterval(intervalId);
        console.log('🛑 Cache cleanup scheduler stopped');
    };
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export { cleanupOldFiles };
