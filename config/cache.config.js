export default {
    // Time-based cleanup settings
    maxAgeDays: 7,              // Delete files older than 7 days
    cleanupIntervalHours: 6,    // Run cleanup every 6 hours
    minFilesToKeep: 10,         // Always keep at least 10 newest files (safety net)

    // Future: Size-based settings (for Option 2/3 upgrade)
    // maxSizeGB: 5,            // Uncomment to enable size limit
    // enableLRU: false,        // Uncomment to enable LRU eviction

    // Logging
    enableMetrics: true,        // Log cache metrics
    verboseLogging: false       // Detailed logs for debugging
};
