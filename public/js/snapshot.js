// Snapshot Display Manager
// Handles loading and displaying Antigravity chat snapshots

class SnapshotManager {
  constructor() {
    this.chatContainer = document.getElementById('chatContainer');
    this.chatContent = document.getElementById('chatContent');
    this.scrollFab = document.getElementById('scrollFab');

    this.autoRefreshEnabled = true;
    this.userIsScrolling = false;
    this.scrollTimeout = null;
    this.idleTimeout = null;

    this.init();
  }

  init() {
    // Listen for snapshot updates from WebSocket
    window.wsManager.on('snapshot_update', () => {
      if (this.autoRefreshEnabled && !this.userIsScrolling) {
        this.loadSnapshot();
      }
    });

    // Listen for connected event to load initial snapshot
    window.wsManager.on('connected', () => {
      this.loadSnapshot();
    });

    // Handle scroll events
    this.chatContainer.addEventListener('scroll', () => this.handleScroll());

    // Scroll FAB click
    this.scrollFab.addEventListener('click', () => this.scrollToBottom(true));
  }

  async loadSnapshot() {
    try {
      const response = await fetch('/snapshot');

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      // Save scroll position
      const scrollPos = this.chatContainer.scrollTop;
      const isNearBottom = this.isNearBottom();

      // Process HTML to show thumbnails for image links
      let processedHtml = data.html;

      // Regex to find image URLs from our upload folder that aren't already in an img tag
      const imageUrlRegex = /(?<!src=")(http[s]?:\/\/[^\s]+?\.(jpg|jpeg|png|gif|webp))/gi;

      processedHtml = processedHtml.replace(imageUrlRegex, (url) => {
        return `
                    <div class="chat-image-container">
                        <img src="${url}" class="chat-thumbnail" 
                             onclick="window.open('${url}', '_blank')"
                             onload="window.snapshotManager.scrollToBottom(false)">
                    </div>
                `;
      });

      // Regex for audio files
      const audioUrlRegex = /http[s]?:\/\/[^\s]+?\.(webm|ogg|mp3|wav|m4a)/gi;
      processedHtml = processedHtml.replace(audioUrlRegex, (url) => {
        return `
              <div class="chat-audio-container" style="margin: 8px 0;">
                  <audio controls src="${url}" style="width: 100%; max-width: 300px; height: 32px;"></audio>
              </div>
          `;
      });

      // Clear and update content
      this.chatContent.innerHTML = '';

      const styleEl = document.createElement('style');
      styleEl.textContent = `
          ${data.css}
          
          /* Aggressive font and background override */
          #agentg-chat-content,
          #agentg-chat-content *,
          #agentg-chat-content [style*="font-family"] {
            font-family: var(--font-sans) !important;
          }

          #agentg-chat-content {
            background-color: var(--bg-primary) !important;
            padding: 12px !important;
            box-sizing: border-box !important;
          }

          /* Override positioning for snapshot content */
          #chatContent #agentg-chat-content {
            position: relative;
            overflow: visible !important;
            height: auto !important;
            display: flex !important;
            flex-direction: column !important;
          }
          /* Let virtualized scroll container flow naturally after placeholders removed */
          #chatContent [style*="min-height"] {
            min-height: auto !important;
          }
          #chatContent .overflow-hidden {
            overflow: visible !important;
          }
          #chatContent .overflow-clip {
            overflow: visible !important;
          }
          #chatContent .overflow-y-auto {
            overflow: visible !important;
          }
          
          /* Fix code blocks aesthetics */
          pre, code {
            background-color: var(--bg-tertiary) !important;
            color: var(--text-primary) !important;
            border: 1px solid var(--border-default) !important;
          }
          
          pre code {
            background-color: transparent !important;
            border: none !important;
          }

          /* Thumbnail styles */
          .chat-image-container {
            margin: 8px 0;
            max-width: 100%;
          }
          .chat-thumbnail {
            max-width: 200px;
            max-height: 200px;
            border-radius: var(--radius-md);
            border: 1px solid var(--border-default);
            cursor: pointer;
            display: block;
            transition: transform var(--transition-fast);
          }
          .chat-thumbnail:active {
            transform: scale(0.98);
          }
      `;

      const contentWrapper = document.createElement('div');
      contentWrapper.id = 'snapshot-wrapper';
      contentWrapper.innerHTML = processedHtml;

      this.chatContent.appendChild(styleEl);
      this.chatContent.appendChild(contentWrapper);

      // Restore scroll or go to bottom
      if (isNearBottom || scrollPos === 0) {
        this.scrollToBottom(false);
      } else {
        this.chatContainer.scrollTop = scrollPos;
      }

    } catch (error) {
      console.error('Failed to load snapshot:', error);
      this.chatContent.innerHTML = `
        <div class="loading-state">
          <p style="color: var(--error);">Failed to load chat</p>
          <button onclick="window.snapshotManager.loadSnapshot()" 
                  style="margin-top: 12px; padding: 8px 16px; background: var(--accent-primary); 
                         color: white; border: none; border-radius: var(--radius-md); cursor: pointer;">
            Retry
          </button>
        </div>
      `;
    }
  }

  handleScroll() {
    this.userIsScrolling = true;

    clearTimeout(this.scrollTimeout);
    clearTimeout(this.idleTimeout);

    // Show/hide scroll FAB
    const nearBottom = this.isNearBottom();
    this.scrollFab.classList.toggle('show', !nearBottom);

    // Resume auto-refresh after scroll stops
    this.scrollTimeout = setTimeout(() => {
      this.userIsScrolling = false;
    }, 500);

    // Full resume after idle
    this.idleTimeout = setTimeout(() => {
      this.autoRefreshEnabled = true;
    }, 10000);
  }

  isNearBottom() {
    const threshold = 100;
    return (
      this.chatContainer.scrollHeight -
      this.chatContainer.scrollTop -
      this.chatContainer.clientHeight
    ) < threshold;
  }

  scrollToBottom(smooth = true) {
    this.chatContainer.scrollTo({
      top: this.chatContainer.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto'
    });
  }
}

// Initialize snapshot manager
window.snapshotManager = new SnapshotManager();
