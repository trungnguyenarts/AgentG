// Controls Manager - Model & Mode selection via scrape-click-scrape
class ControlsManager {
    constructor() {
        this.modelChip = document.getElementById('modelChip');
        this.modeChip = document.getElementById('modeChip');
        this.modelModal = document.getElementById('modelModal');
        this.modeModal = document.getElementById('modeModal');
        this.modelList = document.getElementById('modelList');
        this.modeList = document.getElementById('modeList');
        this.modelClose = document.getElementById('modelClose');
        this.modeClose = document.getElementById('modeClose');

        this.currentModelText = null;
        this.currentModeText = null;
        this.lastButtons = [];
        this.lastOpenPanels = [];

        // Keywords to identify model vs mode buttons
        this.MODEL_KEYWORDS = ['gemini', 'claude', 'pro', 'sonnet', 'gpt', 'flash', 'haiku', 'llama', 'opus', 'oss'];
        this.MODE_VALUES = ['Planning', 'Fast', 'Agent'];

        this.init();
    }

    init() {
        // Chip click handlers
        this.modelChip.addEventListener('click', () => this.handleModelClick());
        this.modeChip.addEventListener('click', () => this.handleModeClick());

        // Modal close handlers
        this.modelClose.addEventListener('click', () => this.closeModelModal());
        this.modeClose.addEventListener('click', () => this.closeModeModal());
        this.modelModal.addEventListener('click', (e) => {
            if (e.target === this.modelModal) this.closeModelModal();
        });
        this.modeModal.addEventListener('click', (e) => {
            if (e.target === this.modeModal) this.closeModeModal();
        });

        // Initial poll + periodic refresh
        setTimeout(() => this.pollControls(), 2000);
        setInterval(() => this.pollControls(), 5000);

        // Also refresh when snapshot updates
        if (window.wsManager) {
            window.wsManager.on('snapshot_update', () => {
                setTimeout(() => this.pollControls(), 500);
            });
        }
    }

    // --- Polling & Detection ---

    async pollControls() {
        try {
            const res = await fetch('/controls');
            if (!res.ok) return;
            const data = await res.json();
            this.lastButtons = data.buttons || [];
            this.lastOpenPanels = data.openPanels || [];
            this.detectModel();
            this.detectMode();
        } catch (e) {
            // Silent fail - controls are supplementary
        }
    }

    detectModel() {
        // Strategy: find button with headlessui-popover-button or headlessui-menu-button ID
        // AND text containing model keywords
        for (const btn of this.lastButtons) {
            const isHeadlessUI = btn.id.startsWith('headlessui-popover-button') ||
                                 btn.id.startsWith('headlessui-menu-button');
            if (!isHeadlessUI) continue;

            const textLower = btn.text.toLowerCase();
            if (this.MODEL_KEYWORDS.some(kw => textLower.includes(kw))) {
                if (btn.text !== this.currentModelText) {
                    this.currentModelText = btn.text;
                    this.modelChip.textContent = this.truncate(btn.text, 22);
                    this.modelChip.title = btn.text;
                }
                return;
            }
        }

        // Fallback: look for any button with model keywords (some UIs don't use headlessui)
        for (const btn of this.lastButtons) {
            const textLower = btn.text.toLowerCase();
            // Must have headlessui ID or match multiple model keywords
            const modelMatches = this.MODEL_KEYWORDS.filter(kw => textLower.includes(kw));
            if (modelMatches.length >= 1 && btn.text.length < 50) {
                // Exclude mode buttons
                if (this.MODE_VALUES.includes(btn.text)) continue;
                if (btn.text !== this.currentModelText) {
                    this.currentModelText = btn.text;
                    this.modelChip.textContent = this.truncate(btn.text, 22);
                    this.modelChip.title = btn.text;
                }
                return;
            }
        }
    }

    detectMode() {
        // Strategy: find button with exact text match for mode values
        // AND WITHOUT headlessui ID prefix
        for (const btn of this.lastButtons) {
            const isHeadlessUI = btn.id.startsWith('headlessui-popover') ||
                                 btn.id.startsWith('headlessui-menu');
            if (isHeadlessUI) continue;

            if (this.MODE_VALUES.includes(btn.text)) {
                if (btn.text !== this.currentModeText) {
                    this.currentModeText = btn.text;
                    this.modeChip.textContent = btn.text;
                    this.modeChip.title = `Mode: ${btn.text}`;
                }
                return;
            }
        }
    }

    truncate(text, maxLen) {
        if (text.length > maxLen) return text.substring(0, maxLen - 1) + '\u2026';
        return text;
    }

    // --- Model Selection Flow ---

    async handleModelClick() {
        if (!this.currentModelText) {
            // No model detected yet, try polling first
            await this.pollControls();
            if (!this.currentModelText) return;
        }

        // Step 1: Click the model button on desktop
        this.modelChip.classList.add('active');
        try {
            await fetch('/click', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: this.currentModelText })
            });
        } catch (e) {
            this.modelChip.classList.remove('active');
            return;
        }

        // Step 2: Wait for dropdown to open, then scrape options
        await this.waitForDropdownAndShow('model');
    }

    // --- Mode Selection Flow ---

    async handleModeClick() {
        if (!this.currentModeText) {
            await this.pollControls();
            if (!this.currentModeText) return;
        }

        // Step 1: Click the mode button on desktop
        this.modeChip.classList.add('active');
        try {
            await fetch('/click', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: this.currentModeText })
            });
        } catch (e) {
            this.modeChip.classList.remove('active');
            return;
        }

        // Step 2: Wait for dropdown to open, then scrape options
        await this.waitForDropdownAndShow('mode');
    }

    // --- Shared Dropdown Detection & Display ---

    async waitForDropdownAndShow(type) {
        // Try up to 3 times with increasing delays
        const delays = [500, 800, 1200];

        for (const delay of delays) {
            await new Promise(r => setTimeout(r, delay));
            await this.pollControls();

            if (this.lastOpenPanels.length > 0) {
                const options = this.extractOptions(type);
                if (options.length > 0) {
                    this.showOptionsModal(type, options);
                    return;
                }
                // Panel open but no matching options for this type -
                // for mode, the dropdown text may include descriptions
                // that don't cleanly match. Keep trying.
            }
        }

        // Dropdown didn't open or no matching items found
        // For mode: the click itself might have toggled the mode directly
        // (some Antigravity versions toggle without dropdown)
        await this.pollControls();

        this.modelChip.classList.remove('active');
        this.modeChip.classList.remove('active');
    }

    extractOptions(type) {
        // Filter words that indicate non-model/mode panels (quick-input, workspace picker, etc.)
        const EXCLUDE_WORDS = ['workspace', 'open in', 'current window', 'select where', 'select a conversation'];

        // Classify each panel as 'model' or 'mode' based on its content
        for (const panel of this.lastOpenPanels) {
            const items = panel.items.filter(i => i.text);

            // Skip panels that look like workspace/session pickers
            const panelText = items.map(i => i.text.toLowerCase()).join(' ');
            if (EXCLUDE_WORDS.some(w => panelText.includes(w))) continue;

            // Check if this panel contains model-like items
            const hasModelItems = items.some(i =>
                this.MODEL_KEYWORDS.some(kw => i.text.toLowerCase().includes(kw))
            );

            // Check if this panel contains mode-like items
            const hasModeItems = items.some(i =>
                this.MODE_VALUES.some(m => i.text === m || i.text.startsWith(m))
            );

            if (type === 'model' && hasModelItems) {
                // Return only model items from this panel
                return items.filter(i =>
                    this.MODEL_KEYWORDS.some(kw => i.text.toLowerCase().includes(kw))
                );
            }

            if (type === 'mode' && hasModeItems && !hasModelItems) {
                // Return only clean mode items (extract just the mode name, strip descriptions)
                const modeItems = [];
                for (const item of items) {
                    for (const m of this.MODE_VALUES) {
                        if (item.text === m || item.text.startsWith(m)) {
                            // Strip description text - take only the mode name
                            modeItems.push({ text: m, tag: item.tag });
                            break;
                        }
                    }
                }
                return modeItems;
            }
        }

        return [];
    }

    showOptionsModal(type, options) {
        const modal = type === 'model' ? this.modelModal : this.modeModal;
        const list = type === 'model' ? this.modelList : this.modeList;
        const currentText = type === 'model' ? this.currentModelText : this.currentModeText;

        list.innerHTML = '';
        options.forEach(opt => {
            const item = document.createElement('button');
            const isSelected = opt.text === currentText;
            item.className = 'option-item' + (isSelected ? ' selected' : '');
            item.innerHTML = `
                <span style="flex: 1;">${opt.text}</span>
                ${isSelected ? '<span class="option-check" style="color: var(--accent-primary);">&#10003;</span>' : ''}
            `;
            item.addEventListener('click', () => this.selectOption(type, opt.text));
            list.appendChild(item);
        });

        modal.classList.add('show');
        this.modelChip.classList.remove('active');
        this.modeChip.classList.remove('active');
    }

    async selectOption(type, optionText) {
        // Close modal immediately for responsiveness
        if (type === 'model') this.closeModelModal();
        else this.closeModeModal();

        // Click the option on desktop
        try {
            await fetch('/click', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: optionText })
            });
        } catch (e) {
            console.error('Failed to select option:', e);
            return;
        }

        // Optimistic update
        if (type === 'model') {
            this.currentModelText = optionText;
            this.modelChip.textContent = this.truncate(optionText, 22);
            this.modelChip.title = optionText;
        } else {
            this.currentModeText = optionText;
            this.modeChip.textContent = optionText;
        }

        // Verify via poll after a delay
        setTimeout(() => this.pollControls(), 1000);
    }

    closeModelModal() {
        this.modelModal.classList.remove('show');
    }

    closeModeModal() {
        this.modeModal.classList.remove('show');
    }
}

// Initialize when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.controlsManager = new ControlsManager();
    });
} else {
    window.controlsManager = new ControlsManager();
}
