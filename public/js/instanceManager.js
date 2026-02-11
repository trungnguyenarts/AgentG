// Instance Manager - Navigate between Antigravity chat sessions
class InstanceManager {
    constructor() {
        this.instanceBtn = document.getElementById('instanceBtn');
        this.instanceModal = document.getElementById('instanceModal');
        this.instanceList = document.getElementById('instanceList');
        this.instanceClose = document.getElementById('instanceClose');
        this.sessions = [];
        this.isExpanded = false;

        this.init();
    }

    init() {
        this.instanceBtn.addEventListener('click', () => this.openModal());
        this.instanceClose.addEventListener('click', () => this.closeModal());
        this.instanceModal.addEventListener('click', (e) => {
            if (e.target === this.instanceModal) this.closeModal();
        });
    }

    async openModal() {
        this.instanceModal.classList.add('show');
        this.instanceList.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
        this.isExpanded = false;

        try {
            const res = await fetch('/sessions');
            if (!res.ok) throw new Error('Failed to fetch');
            const data = await res.json();
            this.renderSessionView(data);
        } catch (e) {
            this.instanceList.innerHTML = '<p style="color: var(--error); padding: 16px; text-align: center;">Failed to load sessions</p>';
        }
    }

    renderSessionView(data) {
        this.instanceList.innerHTML = '';

        // "New Conversation" button at top
        const newBtn = document.createElement('button');
        newBtn.className = 'option-item';
        newBtn.style.cssText = 'color: var(--accent-primary); font-weight: 600; border-bottom: 1px solid var(--border-default);';
        newBtn.innerHTML = '<span style="margin-right: 6px;">+</span> New Conversation';
        newBtn.addEventListener('click', () => this.newConversation());
        this.instanceList.appendChild(newBtn);

        // Check if we have sectioned data (from quick-input dialog)
        const hasSections = data.sections && data.sections.length > 0 &&
                           data.sections.some(s => s.count > 0 || s.showMore);

        if (hasSections) {
            this.renderSectionedView(data);
        } else {
            this.renderFlatView(data);
        }
    }

    renderSectionedView(data) {
        // Group sessions by section header
        const sessionsBySection = {};
        for (const session of data.sessions) {
            const sec = session.section || '';
            if (!sessionsBySection[sec]) sessionsBySection[sec] = [];
            sessionsBySection[sec].push(session);
        }

        for (const secInfo of data.sections) {
            const sessions = sessionsBySection[secInfo.header] || [];

            // Section header
            if (secInfo.header) {
                const header = document.createElement('div');
                header.className = 'session-section-header';
                header.textContent = secInfo.header;
                this.instanceList.appendChild(header);
            }

            // Session items
            sessions.forEach(session => {
                const item = document.createElement('button');
                item.className = 'option-item';
                item.innerHTML = `<span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${this.escapeHtml(session.text)}</span>`;
                item.addEventListener('click', () => this.clickSession(session.text));
                this.instanceList.appendChild(item);
            });

            // "Show N more..." button if available
            if (secInfo.showMore) {
                const showMoreBtn = document.createElement('button');
                showMoreBtn.className = 'option-item session-show-more';
                showMoreBtn.textContent = secInfo.showMore;
                const sectionType = secInfo.header.toLowerCase().includes('other') ? 'other' : 'recent';
                showMoreBtn.addEventListener('click', () => this.showMore(sectionType));
                this.instanceList.appendChild(showMoreBtn);
            }
        }

        if (data.sessions.length === 0) {
            const hint = document.createElement('p');
            hint.style.cssText = 'color: var(--text-tertiary); padding: 12px 16px; text-align: center; font-size: 13px;';
            hint.textContent = 'No chat sessions found';
            this.instanceList.appendChild(hint);
        }
    }

    renderFlatView(data) {
        if (data.sessions.length > 0) {
            data.sessions.forEach(session => {
                const item = document.createElement('button');
                item.className = 'option-item';
                item.innerHTML = `<span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${this.escapeHtml(session.text)}</span>`;
                item.addEventListener('click', () => this.clickSession(session.text));
                this.instanceList.appendChild(item);
            });

            // "See all" button if available (sidebar view)
            if (data.hasSeeAll) {
                const seeAllBtn = document.createElement('button');
                seeAllBtn.className = 'option-item session-show-more';
                seeAllBtn.textContent = 'See all conversations...';
                seeAllBtn.addEventListener('click', () => this.seeAll());
                this.instanceList.appendChild(seeAllBtn);
            }
        } else {
            const hint = document.createElement('p');
            hint.style.cssText = 'color: var(--text-tertiary); padding: 12px 16px; text-align: center; font-size: 13px;';
            hint.textContent = 'No chat sessions found';
            this.instanceList.appendChild(hint);
        }
    }

    async clickSession(title) {
        // Show loading state on the clicked item
        const items = this.instanceList.querySelectorAll('.option-item');
        items.forEach(item => {
            if (item.textContent.trim() === title) {
                item.style.opacity = '0.5';
                item.style.pointerEvents = 'none';
            }
        });

        try {
            const res = await fetch('/session-click', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title })
            });
            const data = await res.json();
            if (data.success) {
                this.closeModal();
                setTimeout(() => {
                    if (window.snapshotManager) window.snapshotManager.loadSnapshot();
                }, 800);
            } else {
                console.error('Session click failed:', data.error);
                // Restore item
                items.forEach(item => {
                    item.style.opacity = '';
                    item.style.pointerEvents = '';
                });
            }
        } catch (e) {
            console.error('Session click failed:', e);
        }
    }

    async newConversation() {
        try {
            const res = await fetch('/new-conversation', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await res.json();
            if (data.success) {
                this.closeModal();
                setTimeout(() => {
                    if (window.snapshotManager) window.snapshotManager.loadSnapshot();
                }, 1000);
            }
        } catch (e) {
            console.error('New conversation failed:', e);
        }
    }

    async showMore(section) {
        try {
            this.instanceList.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';

            const res = await fetch('/sessions-show-more', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ section })
            });
            const showMoreData = await res.json();

            if (showMoreData.success) {
                // Wait for Antigravity to expand the list, then re-fetch
                const delays = [600, 1000, 1500];
                let lastData = null;

                for (const delay of delays) {
                    await new Promise(r => setTimeout(r, delay));
                    try {
                        const sessRes = await fetch('/sessions');
                        if (!sessRes.ok) continue;
                        const data = await sessRes.json();
                        lastData = data;
                        // Break if we got more sessions than before
                        if (data.sessionCount > 6) break;
                    } catch (e) { }
                }

                if (lastData) {
                    // Re-render with "New Conversation" button
                    this.instanceList.innerHTML = '';
                    const newBtn = document.createElement('button');
                    newBtn.className = 'option-item';
                    newBtn.style.cssText = 'color: var(--accent-primary); font-weight: 600; border-bottom: 1px solid var(--border-default);';
                    newBtn.innerHTML = '<span style="margin-right: 6px;">+</span> New Conversation';
                    newBtn.addEventListener('click', () => this.newConversation());
                    this.instanceList.appendChild(newBtn);

                    const hasSections = lastData.sections && lastData.sections.length > 0 &&
                                       lastData.sections.some(s => s.count > 0 || s.showMore);
                    if (hasSections) {
                        this.renderSectionedView(lastData);
                    } else {
                        this.renderFlatView(lastData);
                    }
                }
            }
        } catch (e) {
            console.error('Show more failed:', e);
        }
    }

    async seeAll() {
        try {
            // Click "See all" on Antigravity desktop sidebar
            await fetch('/sessions-see-all', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            this.isExpanded = true;

            this.instanceList.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';

            const delays = [800, 1200, 1500];
            let lastData = null;

            for (const delay of delays) {
                await new Promise(r => setTimeout(r, delay));
                try {
                    const res = await fetch('/sessions');
                    if (!res.ok) continue;
                    const data = await res.json();
                    lastData = data;
                    if (data.isExpanded || data.sessionCount > 3) break;
                } catch (e) { }
            }

            if (lastData) {
                // Full re-render
                this.instanceList.innerHTML = '';
                const newBtn = document.createElement('button');
                newBtn.className = 'option-item';
                newBtn.style.cssText = 'color: var(--accent-primary); font-weight: 600; border-bottom: 1px solid var(--border-default);';
                newBtn.innerHTML = '<span style="margin-right: 6px;">+</span> New Conversation';
                newBtn.addEventListener('click', () => this.newConversation());
                this.instanceList.appendChild(newBtn);

                const hasSections = lastData.sections && lastData.sections.length > 0 &&
                                   lastData.sections.some(s => s.count > 0 || s.showMore);
                if (hasSections) {
                    this.renderSectionedView(lastData);
                } else {
                    this.renderFlatView(lastData);
                }
            } else {
                this.instanceList.innerHTML = '<p style="color: var(--text-tertiary); padding: 16px; text-align: center;">Could not load expanded sessions</p>';
            }
        } catch (e) {
            console.error('See all failed:', e);
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    closeModal() {
        this.instanceModal.classList.remove('show');
    }
}

// Initialize when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.instanceManager = new InstanceManager();
    });
} else {
    window.instanceManager = new InstanceManager();
}
