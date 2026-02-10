# AgentG Cache Management

## Overview

AgentG now includes automatic cache management for the `uploads/` folder to prevent unlimited growth of temporary files.

## Features

### ✅ Automatic Cleanup
- **Schedule:** Runs every 6 hours
- **Retention:** Deletes files older than 7 days
- **Safety Net:** Always keeps at least 10 newest files
- **Startup:** Runs cleanup on server startup

### 📊 Cache Statistics API

**Endpoint:** `GET /api/cache/stats`

**Response:**
```json
{
  "success": true,
  "stats": {
    "totalFiles": 50,
    "totalSize": 38636069,
    "totalSizeFormatted": "36.85 MB",
    "byFolder": {
      "audio": {
        "count": 36,
        "size": 4682552,
        "sizeFormatted": "4.47 MB"
      },
      "files": {
        "count": 14,
        "size": 33953517,
        "sizeFormatted": "32.38 MB"
      }
    },
    "oldestFile": {
      "name": "1768658028442-IMG_0338.jpeg",
      "age": "0 days"
    },
    "newestFile": {
      "name": "1768692137560-voice_1768692118879.webm",
      "age": "0 days"
    }
  }
}
```

## Configuration

Edit `config/cache.config.js` to customize:

```javascript
export default {
    maxAgeDays: 7,              // Delete files older than N days
    cleanupIntervalHours: 6,    // Run cleanup every N hours
    minFilesToKeep: 10,         // Safety: keep at least N newest files
    enableMetrics: true         // Log cache metrics
};
```

## How It Works

### Time-Based Cleanup (Current Implementation)

1. **On Startup:** Server runs cleanup immediately
2. **Scheduled:** Cleanup runs every 6 hours automatically
3. **Logic:**
   - Scan `uploads/audio/` and `uploads/files/`
   - Identify files older than 7 days
   - Keep at least 10 newest files (safety net)
   - Delete old files and log results

### Example Log Output

```
🚀 Cache cleanup scheduler started (runs every 6 hours)
📋 Policy: Delete files older than 7 days (keeping at least 10 newest)
🧹 Starting cache cleanup...
🗑️  Deleted: 1768000000000-old-recording.webm (8 days old, 2.34 MB)
🗑️  Deleted: 1768100000000-old-image.png (9 days old, 1.12 MB)
✅ Cleanup complete: 2 files deleted (3.46 MB freed)
```

## Future Upgrades

The system is designed for easy upgrades:

### Option 2: Size-Based LRU Cache
- Add maximum cache size limit (e.g., 5GB)
- Evict least recently used files when limit exceeded
- Track file access times

### Option 3: Hybrid (Time + Size)
- Combine time-based and size-based strategies
- Hard limit: 30 days
- Soft limit: 5GB with LRU eviction

### Option 4: Database-Tracked Cache
- Store file metadata in SQLite/PostgreSQL
- Track access counts and patterns
- Full audit trail

## Manual Cleanup

To manually trigger cleanup:

```javascript
import { cleanupOldFiles } from './utils/cache-manager.js';

// Run cleanup once
await cleanupOldFiles('./uploads');
```

## Monitoring

### Check Cache Stats via API

```bash
curl http://localhost:3000/api/cache/stats
```

### Check Server Logs

The cleanup scheduler logs all operations:
- Startup confirmation
- Files deleted (with age and size)
- Total cleanup results

## Troubleshooting

### Cleanup Not Running

**Check server logs for:**
```
🚀 Cache cleanup scheduler started (runs every 6 hours)
```

If missing, ensure `server.js` imports and calls `startCleanupScheduler()`.

### Files Not Being Deleted

**Possible reasons:**
1. Files are newer than 7 days (check `maxAgeDays` in config)
2. Safety net protecting newest 10 files (check `minFilesToKeep`)
3. Permission issues (check file ownership)

### Adjust Retention Policy

Edit `config/cache.config.js`:

```javascript
// Keep files for 30 days instead of 7
maxAgeDays: 30,

// Keep at least 20 newest files
minFilesToKeep: 20,
```

Restart server for changes to take effect.

## Architecture

```
AgentG/
├── server.js                    # Main server (imports cache manager)
├── utils/
│   └── cache-manager.js         # Cache management logic
├── config/
│   └── cache.config.js          # Configuration
└── uploads/
    ├── audio/                   # Voice recordings (auto-cleaned)
    └── files/                   # Other uploads (auto-cleaned)
```

## Implementation Details

### Files Created/Modified

1. **`utils/cache-manager.js`** (NEW)
   - Core cleanup logic
   - Cache statistics
   - Scheduler management

2. **`config/cache.config.js`** (NEW)
   - Centralized configuration
   - Easy customization

3. **`server.js`** (MODIFIED)
   - Import cache manager
   - Start scheduler on startup
   - Add `/api/cache/stats` endpoint
   - Graceful shutdown handler

### Key Functions

- `startCleanupScheduler(uploadDir)` - Start automatic cleanup
- `cleanupOldFiles(uploadDir)` - Run cleanup once
- `getCacheStats(uploadDir)` - Get cache statistics

## Testing

### Verify Cleanup Works

1. **Check current stats:**
   ```bash
   curl http://localhost:3000/api/cache/stats
   ```

2. **Create old test file:**
   ```bash
   # Manually modify file timestamp to simulate old file
   # (PowerShell example)
   $file = "uploads/audio/test-old.webm"
   echo "test" > $file
   (Get-Item $file).LastWriteTime = (Get-Date).AddDays(-10)
   ```

3. **Restart server and check logs:**
   ```
   🗑️  Deleted: test-old.webm (10 days old, ...)
   ```

### Verify Safety Net

1. Upload exactly 10 files
2. Modify all timestamps to be 10 days old
3. Restart server
4. **Expected:** No files deleted (safety net protects 10 newest)

## Performance Impact

- **Startup:** < 100ms for typical cache size (< 1000 files)
- **Scheduled Cleanup:** < 500ms every 6 hours
- **Stats Endpoint:** < 50ms response time
- **Memory:** Minimal (< 1MB for file metadata)

## Security

- Only deletes files in `uploads/audio/` and `uploads/files/`
- Never deletes files outside upload directories
- Graceful error handling (failed deletes are logged, not fatal)
- No external dependencies

---

**Version:** 1.0.0  
**Implementation Date:** 2026-01-18  
**Strategy:** Time-Based Cleanup (Option 1)
