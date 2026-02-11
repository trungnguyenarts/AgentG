#!/usr/bin/env node
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import multer from 'multer';
import fs from 'fs/promises';
import { startCleanupScheduler, getCacheStats } from './utils/cache-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORTS = [9000, 9001, 9222, 9002, 9003]; // Prioritize 9000/9001
const POLL_INTERVAL = 3000; // 3 seconds

// Shared CDP connection
let cdpConnection = null;
let lastSnapshot = null;
let lastSnapshotHash = null;

// Instance management
let discoveredInstances = [];
let activeTargetId = null;

// Ensure upload directories exist
async function ensureUploadDirs() {
    const dirs = ['uploads', 'uploads/files', 'uploads/audio'];
    for (const dir of dirs) {
        try {
            await fs.mkdir(join(__dirname, dir), { recursive: true });
        } catch (err) { }
    }
}

// Multer configuration for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const folder = file.fieldname === 'audio' ? 'uploads/audio' : 'uploads/files';
        cb(null, join(__dirname, folder));
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${file.originalname}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
    fileFilter: (req, file, cb) => {
        cb(null, true);
    }
});

// Helper: HTTP GET JSON
function getJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(2000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

// Discover ALL Antigravity CDP targets across all ports
async function discoverAllTargets() {
    const allTargets = [];
    const seen = new Set();

    const checkPort = async (port) => {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            return list
                .filter(t =>
                    (t.url?.includes('workbench.html') || (t.title && t.title.includes('Antigravity'))) &&
                    t.type !== 'worker' &&
                    t.webSocketDebuggerUrl
                )
                .map(t => ({
                    id: t.id,
                    port,
                    url: t.webSocketDebuggerUrl,
                    title: t.title || `Target ${t.id.substring(0, 8)}`,
                    pageUrl: t.url
                }));
        } catch (e) {
            return [];
        }
    };

    const results = await Promise.all(PORTS.map(checkPort));
    for (const portTargets of results) {
        for (const t of portTargets) {
            if (!seen.has(t.url)) {
                seen.add(t.url);
                allTargets.push(t);
            }
        }
    }
    return allTargets;
}

// Find Antigravity CDP endpoint (Parallel)
async function discoverCDP() {
    console.log(`🔍 Scanning ports ${PORTS.join(', ')} in parallel...`);

    const checkPort = async (port) => {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            // Look for workbench specifically
            const found = list.find(t =>
                (t.url?.includes('workbench.html') || (t.title && t.title.includes('Antigravity'))) &&
                t.type !== 'worker'
            );
            if (found && found.webSocketDebuggerUrl) {
                return { port, url: found.webSocketDebuggerUrl, title: found.title, id: found.id };
            }
        } catch (e) {
            // error connecting to this port, ignore
        }
        return null;
    };

    // Run checks in parallel but preserve priority order from PORTS array
    const results = await Promise.all(PORTS.map(checkPort));

    // Find the first valid result according to PORTS order
    const match = results.find(r => r !== null);

    if (match) {
        console.log(`🎯 Found candidate on port ${match.port}: ${match.title}`);
        return { port: match.port, url: match.url, id: match.id };
    }

    throw new Error('CDP not found. Ensure Antigravity is running with remote debugging enabled.');
}

// Connect to CDP
async function connectCDP(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const call = (method, params, timeout = 10000) => new Promise((resolve, reject) => {
        const id = idCounter++;
        let timeoutId;

        const handler = (msg) => {
            const data = JSON.parse(msg);
            if (data.id === id) {
                clearTimeout(timeoutId);
                ws.off('message', handler);
                if (data.error) reject(data.error);
                else resolve(data.result);
            }
        };

        timeoutId = setTimeout(() => {
            ws.off('message', handler);
            reject(new Error(`CDP call timeout: ${method}`));
        }, timeout);

        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });

    let contexts = [];
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.method === 'Runtime.executionContextCreated') {
                const ctx = data.params.context;
                // Avoid duplicates
                if (!contexts.find(c => c.id === ctx.id)) {
                    contexts.push(ctx);
                }
            } else if (data.method === 'Runtime.executionContextDestroyed') {
                const id = data.params.executionContextId;
                contexts = contexts.filter(c => c.id !== id);
            } else if (data.method === 'Runtime.executionContextsCleared') {
                contexts = [];
            }
        } catch (e) { }
    });

    await call("Runtime.enable", {});

    // Explicitly request existing contexts
    // Some might already exist before we enabled Runtime
    try {
        // This is a bit of a hack but can trigger context updates
        await call("Runtime.disable", {});
        await call("Runtime.enable", {});
    } catch (e) { }

    // Wait for at least one context (max 5s)
    let waitCount = 0;
    while (contexts.length === 0 && waitCount < 10) {
        await new Promise(r => setTimeout(r, 500));
        waitCount++;
    }

    return { ws, call, getContexts: () => contexts };
}

// Check CDP status
function getCDPStatus() {
    return {
        connected: !!cdpConnection,
        contextCount: cdpConnection?.getContexts().length || 0,
        retryCount: cdpRetryCount
    };
}

// Capture chat snapshot
async function captureSnapshot(cdp) {
    const CAPTURE_SCRIPT = `(() => {
        try {
            const containerSelectors = [
                'div.relative.flex.w-full.grow.flex-col.overflow-clip.overflow-y-auto', 
                '#conversation > div.relative.flex.flex-col',
                '#conversation',
                'div.relative.flex.w-full.grow.flex-col.overflow-clip',
                'div.flex.w-full.grow.flex-col.overflow-hidden',
                '#chat',
                '#cascade',
                '.titlebar.cascade-panel-open',
                '.cascade-bar'
            ];
            
            let container;
            for (const sel of containerSelectors) {
                container = document.querySelector(sel);
                if (container) {
                    console.log('[Snapshot] Found container via: ' + sel);
                    break;
                }
            }

            if (!container) return { error: 'chat container not found' };

            const clone = container.cloneNode(true);
            clone.id = 'agentg-chat-content';

            // Cleanup spacers and styles
            clone.querySelectorAll('[style]').forEach(el => {
                if (el.style.minHeight && parseInt(el.style.minHeight) > 2000) el.style.minHeight = 'auto';
            });
            const inputEditor = clone.querySelector('[contenteditable="true"]');
            if (inputEditor) {
                let inputContainer = inputEditor.closest('div.flex-col') || inputEditor.closest('div');
                if (inputContainer && inputContainer !== clone) inputContainer.remove();
            }
            clone.querySelectorAll('style').forEach(tag => tag.remove());

            // Add Snapshot Reset Styles directly to the clone
            const styleTag = document.createElement('style');
            styleTag.textContent = \`
                #agentg-chat-content { 
                    width: 100% !important; 
                    max-width: 100% !important; 
                    word-wrap: break-word !important; 
                    overflow-wrap: break-word !important; 
                    display: flex !important; 
                    flex-direction: column !important; 
                    gap: 12px !important;
                    padding: 12px !important;
                    box-sizing: border-box !important;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
                } 
                #agentg-chat-content *, #agentg-chat-content *::before, #agentg-chat-content *::after { 
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
                }
                #agentg-chat-content img { 
                    max-width: 100% !important; 
                    height: auto !important; 
                    object-fit: contain !important; 
                    border-radius: 8px !important; 
                    margin: 8px 0 !important; 
                    display: block !important;
                } 
                #agentg-chat-content * { 
                    max-width: 100% !important; 
                    box-sizing: border-box !important; 
                }
                /* Hide vertical scrollbar placeholders */
                #agentg-chat-content::-webkit-scrollbar { display: none !important; }
            \`;
            clone.appendChild(styleTag);

            const html = clone.outerHTML;
            let allCSS = '';
            for (const sheet of document.styleSheets) {
                try {
                    for (const rule of sheet.cssRules) {
                        let text = rule.cssText;
                        if (text.length > 5000) continue;
                        text = text.replace(/(^|[\\\\s,}])body(?=[\\\\s,{])/gi, '$1#agentg-chat-content');
                        text = text.replace(/(^|[\\\\s,}])html(?=[\\\\s,{])/gi, '$1#agentg-chat-content');
                        allCSS += text + '\\n';
                    }
                } catch (e) { }
            }
            const styles = window.getComputedStyle(container);
            return {
                html: html,
                css: allCSS,
                backgroundColor: styles.backgroundColor,
                color: styles.color,
                fontFamily: styles.fontFamily
            };
        } catch (e) { return { error: e.toString() }; }
    })()`;

    const contexts = cdp.getContexts();
    let bestSnapshot = null;
    let maxScore = -1;

    console.log(`🔍 Sweeping ${contexts.length} contexts for real chat...`);

    for (const ctx of contexts) {
        try {
            const probeResult = await cdp.call("Runtime.evaluate", {
                expression: `(() => {
    // Refined message counting: prioritize data-message-id, fallback to bubble/row
    const messages = document.querySelectorAll('[data-message-id], .chat-bubble, .message-row').length;
    const hasConversation = !!document.getElementById('conversation');
    const hasCascade = !!document.getElementById('cascade');
    const hasLexical = !!document.querySelector('[data-lexical-editor="true"]');
    const isAgentManager = document.title === 'Agent Manager' || !!document.querySelector('.agent-manager-container');

    return {
        messageCount: messages,
        hasConversation,
        hasCascade,
        hasLexical,
        isAgentManager,
        htmlLength: document.body.innerHTML.length,
        title: document.title,
        protocol: window.location.protocol
    };
})()`,
                returnByValue: true,
                contextId: ctx.id
            });

            if (probeResult.result && probeResult.result.value) {
                const info = probeResult.result.value;

                const snapResult = await cdp.call("Runtime.evaluate", {
                    expression: CAPTURE_SCRIPT,
                    returnByValue: true,
                    contextId: ctx.id
                });

                if (snapResult.result && snapResult.result.value && !snapResult.result.value.error) {
                    const snap = snapResult.result.value;

                    // STRICT SCORING LOGIC (Multiplier Strategy)
                    let score = (info.messageCount * 20000);
                    if (info.hasLexical) score += 10000;

                    // The "Golden" Multiplier: If it has #conversation or #cascade, it MUST win
                    if (info.hasConversation || info.hasCascade) {
                        score += 50000;
                        score *= 10;
                    }

                    if (info.isAgentManager) score -= 1000000; // Nuclear penalty
                    if (info.protocol === 'vscode-webview:') score += 10000;

                    score += info.htmlLength / 1000;

                    console.log(`   [Context ${ctx.id}]Name: "${ctx.name || 'n/a'}", Messages: ${info.messageCount}, Lexical: ${info.hasLexical}, Conv: ${info.hasConversation || info.hasCascade}, Score: ${Math.round(score)} `);

                    if (score > maxScore) {
                        maxScore = score;
                        bestSnapshot = snap;
                        console.log(`     -> NEW WINNER(Score: ${Math.round(score)})`);
                    }
                }
            }
        } catch (e) {
            console.log(`   [Context ${ctx.id}]Failed: ${e.message} `);
        }
    }

    return bestSnapshot;
}

// Inject message into Antigravity
async function injectMessage(cdp, text) {
    let contexts = cdp.getContexts();
    if (contexts.length === 0) {
        console.log("⏳ No contexts available, waiting for Antigravity...");
        let wait = 0;
        while (cdp.getContexts().length === 0 && wait < 10) {
            await new Promise(r => setTimeout(r, 500));
            wait++;
        }
        contexts = cdp.getContexts();
    }

    if (contexts.length === 0) {
        return { ok: false, reason: "no_context", details: "Antigravity workbench page not found." };
    }

    // Check if Antigravity is busy and wait for it to be ready
    console.log("🔍 Checking if Antigravity is busy...");
    let busyCheckAttempts = 0;
    const MAX_BUSY_WAIT = 20; // 10 seconds max wait

    while (busyCheckAttempts < MAX_BUSY_WAIT) {
        let isBusy = false;

        for (const ctx of contexts) {
            try {
                const busyCheck = await cdp.call("Runtime.evaluate", {
                    expression: `(() => {
    const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
    return cancel && cancel.offsetParent !== null;
})()`,
                    returnByValue: true,
                    contextId: ctx.id
                });

                if (busyCheck?.result?.value === true) {
                    isBusy = true;
                    break;
                }
            } catch (e) { }
        }

        if (!isBusy) {
            console.log("✅ Antigravity is ready!");
            break;
        }

        console.log(`⏳ Antigravity is busy, waiting... (${busyCheckAttempts + 1}/${MAX_BUSY_WAIT})`);
        await new Promise(r => setTimeout(r, 500));
        busyCheckAttempts++;
    }

    if (busyCheckAttempts >= MAX_BUSY_WAIT) {
        return { ok: false, reason: "timeout_busy", details: "Antigravity is still busy after 10 seconds" };
    }


    // Find the context that has BOTH cascade (Antigravity container) AND active editor
    let targetContext = null;
    console.log(`🔍 Scanning ${contexts.length} contexts for Antigravity chat...`);

    for (const ctx of contexts) {
        try {
            const check = await cdp.call("Runtime.evaluate", {
                expression: `(() => {
    // Check for the specific conversation container inside cascade-panel
    const cascadeSelectors = [
        '#conversation > div.relative.flex.flex-col',
        '#conversation',
        'div.relative.flex.w-full.grow.flex-col.overflow-clip.overflow-y-auto',
        'div.flex.w-full.grow.flex-col.overflow-hidden',
        '#chat',
        '#cascade',
        '.titlebar.cascade-panel-open',
        '.cascade-bar'
    ];

    let cascade = null;
    for (const sel of cascadeSelectors) {
        cascade = document.querySelector(sel);
        if (cascade) break;
    }

    const editorSelectors = [
        '#cascade [data-lexical-editor="true"][contenteditable="true"]',
        '[data-lexical-editor="true"][contenteditable="true"]',
        '[contenteditable="true"][role="textbox"]',
        'div.max-h-\\\\[300px\\\\].rounded.cursor-text'
    ];

    let editor = null;
    for (const sel of editorSelectors) {
        const el = [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null).at(-1);
        if (el) {
            editor = el;
            break;
        }
    }

    const hasValidEditor = !!editor;
    const hasCascade = cascade && cascade.offsetParent !== null;

    return {
        hasCascade: hasCascade,
        hasEditor: hasValidEditor,
        isValid: hasCascade && hasValidEditor,
        url: window.location.href,
        foundSelector: cascade ? (cascade.id || cascade.className) : 'none'
    };
})()`,
                returnByValue: true,
                contextId: ctx.id
            });

            if (check?.result?.value?.isValid) {
                console.log(`✅ Found Antigravity chat context ${ctx.id} (${ctx.name})`);
                console.log(`   - Has cascade: ${check.result.value.hasCascade} `);
                console.log(`   - Has editor: ${check.result.value.hasEditor} `);
                console.log(`   - URL: ${check.result.value.url} `);
                targetContext = ctx;
                break;
            }
        } catch (e) {
            console.log(`   ⚠️ Context ${ctx.id} check failed: ${e.message} `);
        }
    }

    if (!targetContext) {
        console.error("❌ Could not find valid Antigravity chat context!");
        console.log("Available contexts:");
        contexts.forEach(ctx => console.log(`   - Context ${ctx.id}: ${ctx.name} `));
        return {
            ok: false,
            reason: "no_valid_context",
            details: "Could not find Antigravity chat UI. Make sure Antigravity is open and visible."
        };
    }

    // Use JSON.stringify to properly escape the text for injection
    const escapedText = JSON.stringify(text);

    const EXPRESSION = `(async () => {
    const textToInject = ${escapedText};
    console.log("🚀 Starting injection for text: " + textToInject.substring(0, 50) + "...");

    // Check for busy state (Cancel button)
    const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
    if (cancel && cancel.offsetParent !== null) {
        // Wait a bit to see if it clears
        await new Promise(r => setTimeout(r, 1000));
        if (document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]')) {
            return { ok: false, reason: "busy", details: "Input is busy (generating response)" };
        }
    }

    const editorSelectors = [
        '#cascade [data-lexical-editor="true"][contenteditable="true"]',
        '[data-lexical-editor="true"][contenteditable="true"]',
        '[contenteditable="true"][role="textbox"]',
        'div.max-h-\\\\[300px\\\\].rounded.cursor-text'
    ];

    let editor = null;
    for (const sel of editorSelectors) {
        const el = [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null).at(-1);
        if (el) {
            editor = el;
            break;
        }
    }

    if (!editor) {
        console.error("❌ Editor not found!");
        return { ok: false, error: "editor_not_found" };
    }

    console.log("✅ Editor found, focusing...");
    editor.focus();

    // 1. Clear existing content
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);

    // 2. Set text via clipboard API (best for Lexical)
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', textToInject);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));

    // 3. Fallback direct entry if empty
    if (!editor.textContent.trim()) {
        console.log("⚠️ Paste failed, using direct textContent...");
        editor.textContent = textToInject;
        editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }

    console.log("📝 Text injected, editor content: " + editor.textContent.substring(0, 50) + "...");

    await new Promise(r => setTimeout(r, 500));

    // Strategy 1: Look for button with data-command attribute (VS Code pattern)
    console.log("🔍 Strategy 1: Looking for button with data-command...");
    let submit = document.querySelector('button[data-command*="submit"], button[data-command*="send"], button[data-command*="chat.submit"]');

    if (!submit) {
        // Strategy 2: Find button within the chat input container
        console.log("🔍 Strategy 2: Looking within input container...");
        const inputContainer = editor.closest('div[class*="input"], div[class*="chat"]');
        if (inputContainer) {
            submit = inputContainer.querySelector('button:not([disabled])');
            console.log("Found " + (submit ? "1" : "0") + " enabled button in container");
        }
    }

    if (!submit) {
        // Strategy 3: Look for button with specific CSS classes
        console.log("🔍 Strategy 3: Looking for buttons with send/submit classes...");
        const buttons = [...document.querySelectorAll('button')].filter(btn => {
            const classes = btn.className.toLowerCase();
            return (classes.includes('send') || classes.includes('submit')) && !btn.disabled;
        });
        if (buttons.length > 0) {
            submit = buttons[0];
            console.log("Found button with send/submit class");
        }
    }

    if (!submit) {
        // Strategy 4: Look for arrow icon (common pattern)
        console.log("🔍 Strategy 4: Looking for arrow-right icon...");
        submit = document.querySelector('button:has(svg.lucide-arrow-right), button:has(svg.lucide-send), button:has(svg.lucide-check)');
    }

    // Try clicking the button if found
    if (submit && !submit.disabled) {
        console.log("✅ Submit button found and enabled, clicking...");
        submit.click();

        // Wait a bit and verify if it worked
        await new Promise(r => setTimeout(r, 300));
        const stillHasContent = editor.textContent.trim().length > 0;

        if (!stillHasContent) {
            console.log("✅ Message sent successfully (editor cleared)");
            return { ok: true, method: "click_submit", verified: true };
        } else {
            console.log("⚠️ Button clicked but editor still has content");
            return { ok: true, method: "click_submit", verified: false };
        }
    } else if (submit) {
        console.log("⚠️ Submit button found but DISABLED");
    } else {
        console.log("❌ Submit button NOT FOUND after all strategies");
    }

    // Strategy 5: Try keyboard shortcuts
    console.log("🔍 Strategy 5: Trying keyboard shortcuts...");

    // Try Cmd+Enter (Mac) or Ctrl+Enter (Windows)
    editor.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        metaKey: true,  // Cmd on Mac
        ctrlKey: true   // Ctrl on Windows
    }));

    await new Promise(r => setTimeout(r, 300));
    const clearedAfterShortcut = editor.textContent.trim().length === 0;

    if (clearedAfterShortcut) {
        console.log("✅ Message sent via keyboard shortcut");
        return { ok: true, method: "keyboard_shortcut", verified: true };
    }

    // Last resort: plain Enter
    console.log("⌨️ Last resort: Trying plain Enter key...");
    editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));
    editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));

    await new Promise(r => setTimeout(r, 300));
    const clearedAfterEnter = editor.textContent.trim().length === 0;

    return {
        ok: clearedAfterEnter,
        method: "enter_keypress",
        verified: clearedAfterEnter,
        editorStillHasContent: !clearedAfterEnter
    };
})()`;

    try {
        const result = await cdp.call("Runtime.evaluate", {
            expression: EXPRESSION,
            returnByValue: true,
            awaitPromise: true,
            contextId: targetContext.id
        });

        console.log("📊 CDP Evaluation result:", JSON.stringify(result, null, 2));

        if (result.result && result.result.value) {
            return result.result.value;
        } else if (result.exceptionDetails) {
            console.error("❌ CDP Exception:", result.exceptionDetails);
            return {
                ok: false,
                reason: "injection_exception",
                details: result.exceptionDetails.text || result.exceptionDetails.exception?.description
            };
        } else if (result.result) {
            return { ok: false, reason: "unknown_result", details: result.result };
        }
    } catch (e) {
        console.error("❌ CDP call exception:", e);
        return { ok: false, reason: "exception", details: e.message };
    }

    return { ok: false, reason: "injection_failed_final" };
}

// Check if there's a pending action requiring approval
async function checkPendingAction(cdp) {
    const CHECK_SCRIPT = `(() => {
    const scope = document.getElementById('conversation') || document.getElementById('cascade') || document.body;

    // STRICT detection: Find the approval prompt container
    // Antigravity shows "Run command?" or "Run tool?" text near Reject/Run buttons
    // The buttons are inside a flex container: <div class="ml-auto flex items-center gap-1">

    // Step 1: Find the prompt text element
    const promptEl = [...scope.querySelectorAll('*')].find(el => {
        const t = el.textContent || '';
        return (t.includes('Run command?') || t.includes('Run tool?') || t.includes('Action requires approval'))
            && el.offsetParent !== null
            && el.children.length < 10; // Avoid matching huge parent containers
    });

    if (!promptEl) {
        return { hasPendingAction: false };
    }

    // Step 2: Find the approval container (ancestor with Reject + Run buttons nearby)
    // Walk up from promptEl to find a container that also holds the action buttons
    let container = promptEl;
    let runBtn = null;
    let rejectBtn = null;

    for (let i = 0; i < 8; i++) {
        container = container.parentElement;
        if (!container) break;

        const btns = [...container.querySelectorAll('button')].filter(b => b.offsetParent !== null);

        runBtn = btns.find(b => {
            const text = (b.textContent || '').trim();
            return /^Run\\b/i.test(text) && !text.toLowerCase().startsWith('always');
        });

        rejectBtn = btns.find(b => {
            const text = (b.textContent || '').trim().toLowerCase();
            return text === 'reject' || text.startsWith('reject');
        });

        if (runBtn || rejectBtn) break;
    }

    // Must have at least the prompt text to be considered a real pending action
    let commandText = '';
    const codeBlock = scope.querySelector('pre code, .code-block');
    if (codeBlock) {
        commandText = codeBlock.textContent?.slice(0, 200) || '';
    }

    return {
        hasPendingAction: true,
        hasAcceptButton: !!runBtn,
        hasRejectButton: !!rejectBtn,
        commandPreview: commandText,
        prompt: promptEl.textContent?.slice(0, 100) || 'Action requires approval'
    };
})()`;

    const contexts = cdp.getContexts();
    for (const ctx of contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: CHECK_SCRIPT,
                returnByValue: true,
                contextId: ctx.id
            });

            if (result.result && result.result.value && result.result.value.hasPendingAction) {
                return result.result.value;
            }
        } catch (e) { }
    }

    return { hasPendingAction: false };
}

// Click Accept or Reject button
async function clickActionButton(cdp, action) {
    const CLICK_SCRIPT = `(async () => {
    const actionType = "${action}";
    const scope = document.getElementById('conversation') || document.getElementById('cascade') || document.body;
    let targetBtn = null;

    // Strategy 1: Find the "Run command?" prompt, then locate buttons in its container
    const promptEl = [...scope.querySelectorAll('*')].find(el => {
        const t = el.textContent || '';
        return (t.includes('Run command?') || t.includes('Run tool?'))
            && el.offsetParent !== null
            && el.children.length < 10;
    });

    if (promptEl) {
        // Walk up from prompt to find container with action buttons
        let container = promptEl;
        for (let i = 0; i < 8; i++) {
            container = container.parentElement;
            if (!container) break;

            const btns = [...container.querySelectorAll('button')].filter(b => b.offsetParent !== null);

            if (actionType === 'accept') {
                // Find "Run" button (NOT "Always run")
                targetBtn = btns.find(b => {
                    const text = (b.textContent || '').trim();
                    return /^Run\\b/i.test(text) && !text.toLowerCase().startsWith('always');
                });
                // Fallback: bg-primary button in this container
                if (!targetBtn) {
                    targetBtn = btns.find(b => b.classList.contains('bg-primary'));
                }
            } else {
                // Find "Reject" button
                targetBtn = btns.find(b => {
                    const text = (b.textContent || '').trim().toLowerCase();
                    return text === 'reject' || text.startsWith('reject');
                });
            }

            if (targetBtn) break;
        }
    }

    // Strategy 2: Broader search - buttons with specific classes anywhere on page
    if (!targetBtn) {
        const allBtns = [...scope.querySelectorAll('button')].filter(b => b.offsetParent !== null);
        if (actionType === 'accept') {
            targetBtn = allBtns.find(b => {
                const text = (b.textContent || '').trim();
                return /^Run\\b/i.test(text) && !text.toLowerCase().startsWith('always');
            });
        } else {
            targetBtn = allBtns.find(b => {
                const text = (b.textContent || '').trim().toLowerCase();
                return text === 'reject';
            });
        }
    }

    // Strategy 3: Keyboard shortcut fallback
    if (!targetBtn) {
        const editor = document.querySelector('[contenteditable="true"]');
        if (editor) {
            if (actionType === 'accept') {
                editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', altKey: true, bubbles: true }));
                return { ok: true, method: 'keyboard_alt_enter' };
            } else {
                editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
                return { ok: true, method: 'keyboard_escape' };
            }
        }
    }

    if (!targetBtn) {
        return { ok: false, reason: 'button_not_found', action: actionType };
    }

    targetBtn.click();

    return {
        ok: true,
        method: 'button_click',
        action: actionType,
        buttonText: targetBtn.textContent?.slice(0, 50)
    };
})()`;

    const contexts = cdp.getContexts();
    for (const ctx of contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: CLICK_SCRIPT,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });

            if (result.result && result.result.value) {
                return result.result.value;
            }
        } catch (e) { }
    }

    return { ok: false, reason: "no_context" };
}

// Check for step confirmation prompts
// Check for step confirmation prompts
async function checkStepConfirmation(cdp) {
    const CHECK_SCRIPT = `(() => {
    // Debug: Log potential candidates
    const scope = document.getElementById('conversation') || document.getElementById('cascade') || document.body;
    const allButtons = [...scope.querySelectorAll('button')];
    const confirmBtnCandidate = allButtons.find(b => b.textContent.toLowerCase().includes('confirm'));
    if (confirmBtnCandidate) {
        console.log('[StepConfirm Debug] Found Confirm Button:', confirmBtnCandidate.textContent);
    }

    // 1. Look for "Confirmation required" text anywhere in cascade
    // We look for a container or text element
    const confirmText = [...scope.querySelectorAll('*')].find(
        el => el.textContent && el.textContent.includes('Confirmation required')
            && el.children.length === 0 // Leaf node or text node preferred
            && el.offsetParent !== null // Visible
    );

    // 2. Look for Confirm/Deny buttons anywhere in cascade
    const confirmBtn = allButtons.find(btn =>
        btn.textContent?.toLowerCase().includes('confirm') && btn.offsetParent !== null
    );

    const denyBtn = allButtons.find(btn =>
        (btn.textContent?.toLowerCase().includes('deny') ||
            btn.textContent?.toLowerCase().includes('cancel')) && btn.offsetParent !== null
    );

    // 3. Validation: Must have BOTH text AND at least one button
    if (confirmText && (confirmBtn || denyBtn)) {
        // Try to get distinct confirmation message
        let message = '';
        // Look for the nearest message container or paragraph
        // Usually the text is close to the button or the header
        const container = confirmText.closest('div') || confirmText.parentElement;
        if (container) {
            message = container.innerText.slice(0, 300); // Get context text
        }

        console.log('[StepConfirm Debug] Match Found!', { message, hasConfirm: !!confirmBtn });

        return {
            hasConfirmation: true,
            hasConfirmButton: !!confirmBtn,
            hasDenyButton: !!denyBtn,
            message: message || 'Confirmation required'
        };
    }

    return { hasConfirmation: false };
})()`

        ;

    const contexts = cdp.getContexts();
    for (const ctx of contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: CHECK_SCRIPT,
                returnByValue: true,
                contextId: ctx.id
            });

            if (result.result && result.result.value && result.result.value.hasConfirmation) {
                return result.result.value;
            }
        } catch (e) { }
    }

    return { hasConfirmation: false };
}

// Check for browser permission dialogs
// Check for browser permission dialogs (Global Search)
// Check for browser permission dialogs (Global Search)
async function checkBrowserPermission(cdp) {
    const CHECK_SCRIPT = `(() => {
    // robust search for permission text using TreeWalker
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    let foundNode = null;

    while (node = walker.nextNode()) {
        const text = node.textContent;
        // Check for key phrases
        if ((text.includes('Agent needs permission') ||
            text.includes('needs permission to act') ||
            text.includes('Opening URL in Browser')) &&
            !text.includes('This is a browser security dialog')) { // Exclude our own popup

            const parent = node.parentElement;
            if (!parent) continue;

            // STRICT MODE: Only accept if parent is a known dialog container
            // This prevents detecting text in chat history, editor, terminal, etc.
            if (!parent.closest('.monaco-dialog-box') &&
                !parent.closest('.notification-toast') &&
                !parent.closest('.notifications-center')) {
                continue;
            }

            // Check visibility
            if (parent.offsetParent !== null) {
                foundNode = node;
                break;
            }
        }
    }

    if (foundNode) {
        // Extract clean message
        const container = foundNode.parentElement.closest('.monaco-dialog-box') ||
            foundNode.parentElement.closest('.notification-toast') ||
            foundNode.parentElement.closest('div') ||
            foundNode.parentElement;

        let message = container.innerText.slice(0, 200).replace(/\\n/g, ' ').trim();

        return {
            hasPermissionDialog: true,
            hasAllowButton: false,
            hasDenyButton: false,
            message: message || 'Browser permission required'
        };
    }

    return { hasPermissionDialog: false };
})()`;

    const contexts = cdp.getContexts();
    for (const ctx of contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: CHECK_SCRIPT,
                returnByValue: true,
                contextId: ctx.id
            });

            if (result.result && result.result.value && result.result.value.hasPermissionDialog) {
                return result.result.value;
            }
        } catch (e) { }
    }

    return { hasPermissionDialog: false };
}

// Check for tool permission dialogs (Allow directory access, Allow command, etc.)
async function checkToolPermission(cdp) {
    const CHECK_SCRIPT = `(() => {
    const scope = document.getElementById('conversation') || document.getElementById('cascade') || document.body;

    // Find "Allow ... ?" or "Allow directory access" text
    const allEls = [...scope.querySelectorAll('p, span, div')];
    const promptEl = allEls.find(el => {
        const text = (el.textContent || '').trim();
        return (text.includes('Allow') && text.includes('access to') && text.includes('?'))
            && el.offsetParent !== null
            && el.children.length < 5;
    });

    if (!promptEl) return { hasToolPermission: false };

    // Walk up to find button container with Deny / Allow Once / Allow This Conversation
    let container = promptEl;
    let denyBtn = null;
    let allowOnceBtn = null;
    let allowConvBtn = null;

    for (let i = 0; i < 8; i++) {
        container = container.parentElement;
        if (!container) break;

        const btns = [...container.querySelectorAll('button')].filter(b => b.offsetParent !== null);

        denyBtn = btns.find(b => (b.textContent || '').trim().toLowerCase() === 'deny');
        allowOnceBtn = btns.find(b => (b.textContent || '').trim().toLowerCase() === 'allow once');
        allowConvBtn = btns.find(b => (b.textContent || '').trim().toLowerCase() === 'allow this conversation');

        if (denyBtn || allowOnceBtn || allowConvBtn) break;
    }

    if (!denyBtn && !allowOnceBtn && !allowConvBtn) return { hasToolPermission: false };

    return {
        hasToolPermission: true,
        hasDenyButton: !!denyBtn,
        hasAllowOnceButton: !!allowOnceBtn,
        hasAllowConversationButton: !!allowConvBtn,
        message: promptEl.textContent?.trim().slice(0, 200) || 'Tool permission required'
    };
})()`;

    const contexts = cdp.getContexts();
    for (const ctx of contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: CHECK_SCRIPT,
                returnByValue: true,
                contextId: ctx.id
            });

            if (result.result && result.result.value && result.result.value.hasToolPermission) {
                return result.result.value;
            }
        } catch (e) { }
    }

    return { hasToolPermission: false };
}

// Click Allow Once / Allow This Conversation / Deny in tool permission dialog
async function clickToolPermission(cdp, action) {
    // action: 'allow_once', 'allow_conversation', 'deny'
    const CLICK_SCRIPT = `(async () => {
    const actionType = "${action}";
    const scope = document.getElementById('conversation') || document.getElementById('cascade') || document.body;

    // Find the permission prompt first
    const allEls = [...scope.querySelectorAll('p, span, div')];
    const promptEl = allEls.find(el => {
        const text = (el.textContent || '').trim();
        return (text.includes('Allow') && text.includes('access to') && text.includes('?'))
            && el.offsetParent !== null
            && el.children.length < 5;
    });

    let targetBtn = null;

    if (promptEl) {
        // Walk up to find buttons
        let container = promptEl;
        for (let i = 0; i < 8; i++) {
            container = container.parentElement;
            if (!container) break;

            const btns = [...container.querySelectorAll('button')].filter(b => b.offsetParent !== null);

            if (actionType === 'allow_once') {
                targetBtn = btns.find(b => (b.textContent || '').trim().toLowerCase() === 'allow once');
            } else if (actionType === 'allow_conversation') {
                targetBtn = btns.find(b => (b.textContent || '').trim().toLowerCase() === 'allow this conversation');
            } else {
                targetBtn = btns.find(b => (b.textContent || '').trim().toLowerCase() === 'deny');
            }

            if (targetBtn) break;
        }
    }

    // Fallback: search all buttons on page
    if (!targetBtn) {
        const allBtns = [...scope.querySelectorAll('button')].filter(b => b.offsetParent !== null);
        if (actionType === 'allow_once') {
            targetBtn = allBtns.find(b => (b.textContent || '').trim().toLowerCase() === 'allow once');
        } else if (actionType === 'allow_conversation') {
            targetBtn = allBtns.find(b => (b.textContent || '').trim().toLowerCase() === 'allow this conversation');
        } else {
            targetBtn = allBtns.find(b => (b.textContent || '').trim().toLowerCase() === 'deny');
        }
    }

    if (!targetBtn) {
        return { ok: false, reason: 'button_not_found', action: actionType };
    }

    targetBtn.click();

    return {
        ok: true,
        method: 'button_click',
        action: actionType,
        buttonText: targetBtn.textContent?.slice(0, 50)
    };
})()`;

    const contexts = cdp.getContexts();
    for (const ctx of contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: CLICK_SCRIPT,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });

            if (result.result && result.result.value) {
                return result.result.value;
            }
        } catch (e) { }
    }

    return { ok: false, reason: "no_context" };
}

// Click Confirm or Deny button in step confirmation
async function clickConfirmation(cdp, action) {
    const CLICK_SCRIPT = `(async () => {
    const actionType = "${action}";

    // Find button by text content
    const scope = document.getElementById('conversation') || document.getElementById('cascade') || document.body;

    let targetBtn = [...scope.querySelectorAll('button')].find(btn => {
        const text = btn.textContent?.toLowerCase() || '';
        if (actionType === 'confirm') {
            return text.includes('confirm') && btn.offsetParent !== null;
        } else {
            return (text.includes('deny') || text.includes('cancel')) && btn.offsetParent !== null;
        }
    });

    if (!targetBtn) {
        return { ok: false, reason: 'button_not_found', action: actionType };
    }

    // Click the button
    targetBtn.click();

    return {
        ok: true,
        method: 'button_click',
        action: actionType,
        buttonText: targetBtn.textContent?.slice(0, 50)
    };
})()`

        ;

    const contexts = cdp.getContexts();
    for (const ctx of contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: CLICK_SCRIPT,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });

            if (result.result && result.result.value) {
                return result.result.value;
            }
        } catch (e) { }
    }

    return { ok: false, reason: "no_context" };
}

// Click an element on the Antigravity desktop via CDP
async function clickElementCDP(cdp, { text, tag, selector }) {
    const CLICK_SCRIPT = `(() => {
        const textToFind = ${JSON.stringify(text || '')};
        const selectorToFind = ${JSON.stringify(selector || '')};

        function isVisible(el) {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 &&
                   window.getComputedStyle(el).visibility !== 'hidden';
        }

        function doClick(el) {
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const opts = { bubbles: true, cancelable: true, view: window,
                           clientX: cx, clientY: cy, screenX: cx, screenY: cy };
            el.dispatchEvent(new PointerEvent('pointerdown', opts));
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new PointerEvent('pointerup', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.dispatchEvent(new MouseEvent('click', opts));
        }

        // Strategy 1: CSS selector
        if (selectorToFind) {
            const el = document.querySelector(selectorToFind);
            if (el && isVisible(el)) {
                doClick(el);
                return { success: true, method: 'selector', target: selectorToFind };
            }
        }

        // Strategy 2: Text match - prioritize BUTTON/A over DIV
        if (textToFind) {
            // First: look inside open popover panels (for dropdown item selection)
            const panels = document.querySelectorAll('[id^="headlessui-popover-panel"], [id^="headlessui-menu-items"], [role="menu"], [role="listbox"]');
            for (const panel of panels) {
                // Find the most specific (leaf) element with matching text inside the panel
                const panelItems = [...panel.querySelectorAll('div, button, li, a, [role="menuitem"], [role="option"]')];
                const leafMatch = panelItems.find(el => {
                    const elText = (el.innerText || el.textContent || '').trim();
                    // Must be exact match AND be a leaf-ish element (no child with same text)
                    if (elText !== textToFind || !isVisible(el)) return false;
                    // Prefer elements without children that also have the same text (leaf nodes)
                    const childWithSameText = [...el.children].find(c => (c.innerText || c.textContent || '').trim() === textToFind);
                    return !childWithSameText;
                });
                if (leafMatch) {
                    doClick(leafMatch);
                    return { success: true, method: 'panel_item', target: textToFind };
                }
            }

            // Second: find buttons/interactive elements with exact text (outside panels)
            const interactiveEls = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')];
            const btnMatch = interactiveEls.find(el =>
                (el.innerText || el.textContent || '').trim() === textToFind && isVisible(el)
            );
            if (btnMatch) {
                doClick(btnMatch);
                return { success: true, method: 'button', target: textToFind };
            }

            // Third: any visible element with exact text match (prefer smallest/leaf)
            const all = [...document.querySelectorAll('*')].filter(el =>
                (el.innerText || el.textContent || '').trim() === textToFind && isVisible(el)
            );
            // Sort by DOM depth (deepest = most specific) and prefer interactive tags
            all.sort((a, b) => {
                const aDepth = getDepth(a);
                const bDepth = getDepth(b);
                const aInteractive = ['BUTTON', 'A'].includes(a.tagName) || a.getAttribute('role') === 'button';
                const bInteractive = ['BUTTON', 'A'].includes(b.tagName) || b.getAttribute('role') === 'button';
                if (aInteractive !== bInteractive) return bInteractive ? 1 : -1;
                return bDepth - aDepth;
            });

            function getDepth(el) {
                let depth = 0;
                let node = el;
                while (node.parentElement) { depth++; node = node.parentElement; }
                return depth;
            }

            if (all.length > 0) {
                doClick(all[0]);
                return { success: true, method: 'text_leaf', target: textToFind };
            }
        }

        return { success: false, error: 'No element found' };
    })()`;

    const contexts = cdp.getContexts();
    for (const ctx of contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: CLICK_SCRIPT,
                returnByValue: true,
                contextId: ctx.id
            });
            const val = result.result?.value;
            if (val && val.success) return val;
        } catch (e) { }
    }
    return { success: false, error: 'No matching context' };
}

// Simple hash function
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

// Initialize CDP connection with retry logic
let cdpRetryCount = 0;
const MAX_CDP_RETRIES = 60; // 5 minutes of retries
let snapshotFailCount = 0;
const MAX_SNAPSHOT_FAILS = 5;

async function initCDP() {
    while (cdpRetryCount < MAX_CDP_RETRIES) {
        try {
            console.log('🔍 Discovering VS Code CDP endpoint...');
            const cdpInfo = await discoverCDP();
            console.log(`✅ Found VS Code on port ${cdpInfo.port} `);

            console.log('🔌 Connecting to CDP...');
            cdpConnection = await connectCDP(cdpInfo.url);
            activeTargetId = cdpInfo.id || null;
            console.log(`✅ Connected! Found ${cdpConnection.getContexts().length} execution contexts\n`);

            // Pre-discover all instances
            try { discoveredInstances = await discoverAllTargets(); } catch (e) { }

            cdpRetryCount = 0; // Reset on success
            snapshotFailCount = 0;
            return true;
        } catch (err) {
            cdpRetryCount++;
            console.log(`⏳ CDP not ready(attempt ${cdpRetryCount} / ${MAX_CDP_RETRIES}): ${err.message} `);
            await new Promise(r => setTimeout(r, 5000)); // Wait 5 seconds
        }
    }
    console.error('❌ Failed to connect to CDP after maximum retries');
    return false;
}

// Background polling with auto-reconnect
async function startPolling(wss) {
    setInterval(async () => {
        // Auto-reconnect if no connection
        if (!cdpConnection) {
            console.log('🔄 No CDP connection, attempting reconnect...');
            await initCDP();
            return;
        }

        try {
            const snapshot = await captureSnapshot(cdpConnection);

            // Debug: log snapshot result
            if (!snapshot) {
                snapshotFailCount++;
                console.log(`⚠️ Snapshot returned null(fail #${snapshotFailCount})`);
            } else if (snapshot.error) {
                snapshotFailCount++;
                console.log(`⚠️ Snapshot error: ${snapshot.error} (fail #${snapshotFailCount})`);
                if (snapshot.debug) {
                    console.log(`   - Debug Context: ${snapshot.debug.url} `);
                    console.log(`   - Debug Snippet: ${snapshot.debug.bodySnippet}...`);
                }
            } else {
                snapshotFailCount = 0; // Reset on success
                const hash = hashString(snapshot.html);

                // Only update if content changed
                if (hash !== lastSnapshotHash) {
                    lastSnapshot = snapshot;
                    lastSnapshotHash = hash;

                    // Broadcast to all connected clients
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'snapshot_update',
                                timestamp: new Date().toISOString()
                            }));
                        }
                    });

                    console.log(`📸 Snapshot updated(hash: ${hash})`);
                }
            }

            // If too many failures, try reconnecting
            if (snapshotFailCount >= MAX_SNAPSHOT_FAILS) {
                console.log('🔄 Too many snapshot failures, reconnecting CDP...');
                cdpConnection = null;
                snapshotFailCount = 0;
            }
        } catch (err) {
            console.error('Poll error:', err.message);
            snapshotFailCount++;

            // Check for WebSocket close error
            if (err.message?.includes('WebSocket') || err.message?.includes('close')) {
                console.log('🔄 WebSocket disconnected, will reconnect...');
                cdpConnection = null;
            }
        }
    }, POLL_INTERVAL);
}

// Create Express app
async function createServer() {
    const app = express();
    const server = http.createServer(app);
    const wss = new WebSocketServer({ server });

    app.use(express.json());
    app.use(express.static(join(__dirname, 'public')));

    // Get current snapshot
    app.get('/snapshot', (req, res) => {
        if (!lastSnapshot) {
            return res.status(503).json({ error: 'No snapshot available yet' });
        }
        res.json(lastSnapshot);
    });

    // Get CDP status
    app.get('/status', (req, res) => {
        res.json(getCDPStatus());
    });

    // Send message
    app.post('/send', async (req, res) => {
        const { message } = req.body;

        console.log(`📩 Received message request: "${message}"`);

        if (!message && (!req.body.files || req.body.files.length === 0)) {
            return res.status(400).json({ error: 'Message or file required' });
        }

        if (!cdpConnection) {
            console.error('❌ CDP not connected');
            return res.status(503).json({ error: 'CDP not connected' });
        }

        try {
            const result = await injectMessage(cdpConnection, message);
            console.log(`✉️ Injection result: `, result);

            if (result.ok) {
                res.json({ success: true, method: result.method });
            } else {
                console.error(`❌ Injection failed: `, result);
                res.status(500).json({ success: false, reason: result.reason, details: result });
            }
        } catch (err) {
            console.error('❌ Exception during message injection:', err);
            res.status(500).json({ success: false, reason: 'exception', error: err.message });
        }
    });

    // File upload endpoint
    app.post('/upload', upload.single('file'), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }

            const fileUrl = `http://${req.headers.host}/uploads/files/${req.file.filename}`;

            console.log(`📎 File uploaded: ${req.file.originalname} -> ${fileUrl}`);

            res.json({
                fileId: req.file.filename,
                fileName: req.file.originalname,
                fileType: req.file.mimetype,
                fileUrl: fileUrl,
                filePath: req.file.path
            });
        } catch (error) {
            console.error('Upload error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Voice recording upload endpoint
    app.post('/upload-voice', upload.single('audio'), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ error: 'No audio file uploaded' });
            }

            const fileUrl = `http://${req.headers.host}/uploads/audio/${req.file.filename}`;

            console.log(`🎙️ Voice uploaded: ${req.file.originalname} -> ${fileUrl}`);

            res.json({
                fileId: req.file.filename,
                fileName: req.file.originalname,
                fileUrl: fileUrl,
                filePath: req.file.path
            });
        } catch (error) {
            console.error('Voice upload error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // File injection endpoint
    app.post('/inject-file', async (req, res) => {
        const { fileUrl, fileName } = req.body;

        console.log(`📎 Injection request for: ${fileName}`);
        console.log(`🔗 URL: ${fileUrl}`);

        if (!cdpConnection) {
            console.error('❌ CDP not connected');
            return res.status(503).json({ error: 'CDP not connected' });
        }

        try {
            // We inject the file URL as a message
            const injectionText = `[File Uploaded: ${fileName}](${fileUrl})`;
            console.log(`⌨️ Injecting text: ${injectionText}`);

            const result = await injectMessage(cdpConnection, injectionText);

            console.log(`✉️ CDP Response:`, result);

            if (result.ok) {
                res.json({ success: true, method: result.method });
            } else {
                console.error(`❌ CDP Injection failed:`, result);
                res.status(500).json({ success: false, reason: result.reason, details: result });
            }
        } catch (err) {
            console.error('❌ Exception during file injection:', err);
            res.status(500).json({ success: false, reason: 'exception', error: err.message });
        }
    });

    // Debug contexts endpoint
    app.get('/debug-contexts', async (req, res) => {
        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        try {
            const contexts = cdpConnection.getContexts();
            const results = [];

            for (const ctx of contexts) {
                try {
                    const probeScript = `(() => {
                        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
                        const isBusy = cancel && cancel.offsetParent !== null;

                        let editor = document.querySelector('[data-lexical-editor="true"][contenteditable="true"]');
                        if (!editor) editor = document.querySelector('[contenteditable="true"]');

                        const cascade = document.getElementById('cascade');

                        return {
                            contextId: ${ctx.id},
                            contextName: "${ctx.name}",
                            hasEditor: !!editor,
                            editorVisible: editor ? editor.offsetParent !== null : false,
                            hasCascade: !!cascade,
                            isBusy: isBusy,
                            url: window.location.href,
                            title: document.title
                        };
                    })()`;

                    const result = await cdpConnection.call("Runtime.evaluate", {
                        expression: probeScript,
                        returnByValue: true,
                        contextId: ctx.id
                    });

                    if (result.result && result.result.value) {
                        results.push(result.result.value);
                    }
                } catch (e) {
                    results.push({
                        contextId: ctx.id,
                        contextName: ctx.name,
                        error: e.message
                    });
                }
            }

            res.json({
                totalContexts: contexts.length,
                contexts: results,
                recommendation: results.find(r => r.hasEditor && r.hasCascade && !r.isBusy)
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Probe all contexts for controls (debug)
    app.get('/probe-controls', async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP not connected' });

        const PROBE = `(() => {
            const allBtns = [...document.querySelectorAll('button, [role="button"], [id^="headlessui"]')];
            const visibleBtns = allBtns.filter(b => b.offsetParent !== null);
            const panels = [...document.querySelectorAll('[id^="headlessui-popover-panel"], [id^="headlessui-menu-items"], [role="menu"], [role="listbox"]')];

            // Also look for model/mode text in the footer area
            const footer = document.querySelector('.flex.items-center.gap-2, [class*="footer"], [class*="status"]');

            return {
                url: window.location.href,
                buttonCount: visibleBtns.length,
                buttons: visibleBtns.slice(0, 30).map(b => ({
                    tag: b.tagName,
                    id: b.id || '',
                    className: (b.className || '').substring(0, 80),
                    text: (b.innerText || b.textContent || '').trim().substring(0, 80),
                    role: b.getAttribute('role') || ''
                })),
                panelCount: panels.length,
                hasConversation: !!document.getElementById('conversation'),
                hasCascade: !!document.getElementById('cascade'),
                bodySnippet: document.body.innerText.substring(0, 500)
            };
        })()`;

        const contexts = cdpConnection.getContexts();
        const results = [];
        for (const ctx of contexts) {
            try {
                const result = await cdpConnection.call("Runtime.evaluate", {
                    expression: PROBE,
                    returnByValue: true,
                    contextId: ctx.id
                });
                if (result.result?.value) {
                    results.push({ contextId: ctx.id, contextName: ctx.name, ...result.result.value });
                }
            } catch (e) {
                results.push({ contextId: ctx.id, error: e.message });
            }
        }
        res.json(results);
    });

    // --- Instance Management (CDP targets) ---

    // List all discovered Antigravity instances (CDP targets)
    app.get('/instances', async (req, res) => {
        try {
            discoveredInstances = await discoverAllTargets();
            res.json({
                activeTargetId,
                instances: discoveredInstances.map(i => ({
                    id: i.id,
                    port: i.port,
                    title: i.title,
                    pageUrl: i.pageUrl,
                    isActive: i.id === activeTargetId
                }))
            });
        } catch (e) {
            console.error('Instance discovery error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // Switch active CDP connection to a different target
    app.post('/instance', async (req, res) => {
        const { targetId } = req.body;
        if (!targetId) return res.status(400).json({ error: 'targetId required' });

        try {
            if (discoveredInstances.length === 0) {
                discoveredInstances = await discoverAllTargets();
            }
            const target = discoveredInstances.find(i => i.id === targetId);
            if (!target) {
                return res.status(404).json({ error: 'Target not found' });
            }

            // Close existing CDP connection
            if (cdpConnection && cdpConnection.ws) {
                try { cdpConnection.ws.close(); } catch (e) { }
            }
            cdpConnection = null;
            lastSnapshot = null;
            lastSnapshotHash = null;

            // Connect to new target
            console.log(`Switching to instance: ${target.title} (${target.id})`);
            cdpConnection = await connectCDP(target.url);
            activeTargetId = target.id;
            snapshotFailCount = 0;
            cdpRetryCount = 0;

            console.log(`Switched to: ${target.title}`);
            res.json({ success: true, activeTargetId, title: target.title });
        } catch (e) {
            console.error('Instance switch error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // --- Chat Session Navigation ---

    // Get list of recent chat sessions from Antigravity sidebar
    app.get('/sessions', async (req, res) => {
        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        const SESSIONS_SCRIPT = `(() => {
            // ===== Quick-Input Dialog Detection =====
            // Antigravity shows sessions in a quick-input dialog with:
            // - Section headers: div.text-quickinput-foreground.text-xs.opacity-50 ("Recent in ...", "Other Conversations")
            // - Session items: div.px-2.5.cursor-pointer.rounded-md.text-quickinput-foreground (NOT pb-1.5)
            // - Show more btns: div.text-quickinput-foreground.text-sm.px-2.5.pb-1.5.cursor-pointer ("Show N more...")

            const sections = [];
            let currentSection = { header: '', sessions: [], showMore: null };

            // Strategy A: Quick-input dialog structure (primary)
            // Find all text-quickinput-foreground elements to understand the layout
            const qiElements = [...document.querySelectorAll('[class*="text-quickinput-foreground"]')].filter(el => {
                return el.offsetParent !== null;
            });

            if (qiElements.length > 0) {
                // Categorize each element
                for (const el of qiElements) {
                    const cls = el.className || '';
                    const text = (el.innerText || el.textContent || '').trim();

                    // Skip empty
                    if (!text) continue;

                    // Section header: text-xs + opacity-50 (e.g., "Recent in VIDEO_TRANS", "Other Conversations")
                    if (cls.includes('text-xs') && cls.includes('opacity-50')) {
                        // Save previous section if it has sessions
                        if (currentSection.sessions.length > 0 || currentSection.showMore) {
                            sections.push(currentSection);
                        }
                        currentSection = { header: text, sessions: [], showMore: null };
                        continue;
                    }

                    // "Show N more..." button: text-sm + pb-1.5 + cursor-pointer
                    if (cls.includes('pb-1.5') && cls.includes('cursor-pointer') && text.toLowerCase().includes('more')) {
                        currentSection.showMore = text;
                        continue;
                    }

                    // Session item: cursor-pointer + rounded-md + px-2.5 (but NOT pb-1.5)
                    if (cls.includes('cursor-pointer') && cls.includes('rounded') && cls.includes('px-2.5') && !cls.includes('pb-1.5')) {
                        // Extract session name (first span text, not timestamp)
                        const nameSpan = el.querySelector('span.truncate, span.min-w-0');
                        let name = '';
                        if (nameSpan) {
                            name = (nameSpan.innerText || nameSpan.textContent || '').trim();
                        }
                        if (!name) {
                            // Fallback: get text from first flex child, strip timestamp
                            const flexChild = el.querySelector('.flex-1, .min-w-0');
                            if (flexChild) {
                                name = (flexChild.innerText || flexChild.textContent || '').trim();
                            }
                        }
                        if (!name) {
                            // Last resort: first line, remove timestamp
                            const fullText = text;
                            const lines = fullText.split('\\n').map(l => l.trim()).filter(l => l);
                            name = lines[0] || '';
                        }
                        // Clean: remove trailing timestamps and workspace paths
                        name = name.replace(/\\d+\\s*(hrs?|hours?|days?|mins?|minutes?|weeks?|secs?|seconds?)\\s*ago$/i, '').trim();
                        // Remove trailing workspace path like "c:/Users/Admin/Documents/GitHub"
                        name = name.replace(/\\s*[a-zA-Z]:[\\\\/][\\w\\-\\.\\\\/]+$/g, '').trim();
                        // Remove trailing bullet
                        name = name.replace(/\\s*●\\s*$/, '').trim();

                        if (name && name.length > 1 && name.length < 200) {
                            currentSection.sessions.push({
                                text: name.substring(0, 120),
                                section: currentSection.header
                            });
                        }
                        continue;
                    }
                }
                // Push last section
                if (currentSection.sessions.length > 0 || currentSection.showMore) {
                    sections.push(currentSection);
                }
            }

            // Strategy B: Sidebar button-based sessions (when quick-input not open)
            const sidebarSessions = [];
            if (sections.length === 0 || sections.every(s => s.sessions.length === 0)) {
                // B1: buttons with title attribute
                const sessionBtnsWithTitle = [...document.querySelectorAll('button[title]')].filter(b => {
                    const cls = b.className || '';
                    return cls.includes('cursor-pointer') && cls.includes('group') &&
                           b.title && b.title.length > 0 && b.offsetParent !== null;
                });

                // B2: buttons by class pattern (no title attr)
                const sessionBtnsByClass = [...document.querySelectorAll('button')].filter(b => {
                    const cls = b.className || '';
                    if (!cls.includes('cursor-pointer') || !cls.includes('group')) return false;
                    if (!cls.includes('grow') && !cls.includes('flex-row')) return false;
                    if (!b.offsetParent) return false;
                    const text = (b.innerText || b.textContent || '').trim();
                    if (!text || text.length < 2 || text.length > 200) return false;
                    if (text === 'Send' || text === 'Planning' || text === 'Fast' || text === 'Agent') return false;
                    return true;
                });

                const sessionBtns = sessionBtnsWithTitle.length > 0 ? sessionBtnsWithTitle : sessionBtnsByClass;
                const useTitle = sessionBtnsWithTitle.length > 0;

                sessionBtns.forEach((btn, idx) => {
                    let name = useTitle && btn.title ? btn.title.trim() : (btn.innerText || btn.textContent || '').trim().split('\\n')[0].trim();
                    if (name && name.length > 1) {
                        sidebarSessions.push({ text: name.substring(0, 120), section: '' });
                    }
                });
            }

            // Build flat sessions list with section info
            const allSessions = [];
            const seen = new Set();

            if (sections.length > 0) {
                for (const sec of sections) {
                    for (const s of sec.sessions) {
                        if (!seen.has(s.text)) {
                            seen.add(s.text);
                            allSessions.push(s);
                        }
                    }
                }
            } else {
                for (const s of sidebarSessions) {
                    if (!seen.has(s.text)) {
                        seen.add(s.text);
                        allSessions.push(s);
                    }
                }
            }

            // Check for "See all" link (sidebar view only)
            const seeAllBtn = [...document.querySelectorAll('div, a, button, span')].find(el => {
                const text = (el.innerText || el.textContent || '').trim().toLowerCase();
                return text === 'see all' && el.offsetParent !== null;
            });

            // Detect view type
            const isQuickInput = sections.length > 0 && sections.some(s => s.sessions.length > 0);

            return {
                hasSeeAll: !!seeAllBtn && !isQuickInput,
                isExpanded: isQuickInput,
                sessionCount: allSessions.length,
                sessions: allSessions.slice(0, 50),
                sections: sections.map(s => ({
                    header: s.header,
                    count: s.sessions.length,
                    showMore: s.showMore
                }))
            };
        })()`;

        const contexts = cdpConnection.getContexts();
        let bestResult = { sessionCount: 0, sessions: [], sections: [] };

        for (const ctx of contexts) {
            try {
                const result = await cdpConnection.call("Runtime.evaluate", {
                    expression: SESSIONS_SCRIPT,
                    returnByValue: true,
                    contextId: ctx.id
                });
                if (result.result?.value) {
                    const val = result.result.value;
                    if (val.sessionCount > bestResult.sessionCount) {
                        bestResult = val;
                    }
                }
            } catch (e) { }
        }

        res.json(bestResult);
    });

    // Click a specific chat session by its title text
    app.post('/session-click', async (req, res) => {
        const { title } = req.body;
        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }
        if (!title) {
            return res.status(400).json({ error: 'title required' });
        }

        const CLICK_SESSION_SCRIPT = `(async () => {
            const targetTitle = ${JSON.stringify(title)};

            function doClick(el) {
                const rect = el.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const opts = { bubbles: true, cancelable: true, view: window,
                               clientX: cx, clientY: cy, screenX: cx, screenY: cy };
                el.dispatchEvent(new PointerEvent('pointerdown', opts));
                el.dispatchEvent(new MouseEvent('mousedown', opts));
                el.dispatchEvent(new PointerEvent('pointerup', opts));
                el.dispatchEvent(new MouseEvent('mouseup', opts));
                el.dispatchEvent(new MouseEvent('click', opts));
            }

            // Auto-dismiss "Select where to open" quick-input dialog
            async function dismissQuickInput() {
                const delays = [300, 500, 800];
                for (const delay of delays) {
                    await new Promise(r => setTimeout(r, delay));
                    const widget = document.querySelector('.quick-input-widget');
                    if (!widget || widget.style.display === 'none') continue;

                    const items = widget.querySelectorAll('.quick-input-list [role="option"], .quick-input-list li, .quick-input-list a');
                    for (const item of items) {
                        const text = (item.innerText || item.textContent || '').trim();
                        if (text.includes('Open in current window')) {
                            doClick(item);
                            return 'auto_opened';
                        }
                    }

                    const focused = widget.querySelector('[aria-selected="true"], .focused, .monaco-list-row:first-child');
                    if (focused) {
                        doClick(focused);
                        return 'auto_first';
                    }
                }
                return null;
            }

            let clicked = false;
            let method = '';

            // Strategy 1: Quick-input dialog session items (text-quickinput-foreground + cursor-pointer + rounded)
            const qiSessions = [...document.querySelectorAll('[class*="text-quickinput-foreground"]')].filter(el => {
                const cls = el.className || '';
                return cls.includes('cursor-pointer') && cls.includes('rounded') &&
                       cls.includes('px-2.5') && !cls.includes('pb-1.5') &&
                       el.offsetParent !== null;
            });
            for (const el of qiSessions) {
                // Extract clean name (same logic as /sessions)
                const nameSpan = el.querySelector('span.truncate, span.min-w-0');
                let name = '';
                if (nameSpan) {
                    name = (nameSpan.innerText || nameSpan.textContent || '').trim();
                }
                if (!name) {
                    const flexChild = el.querySelector('.flex-1, .min-w-0');
                    if (flexChild) name = (flexChild.innerText || flexChild.textContent || '').trim();
                }
                if (!name) {
                    name = (el.innerText || el.textContent || '').trim().split('\\n')[0].trim();
                }
                name = name.replace(/\\d+\\s*(hrs?|hours?|days?|mins?|minutes?|weeks?|secs?|seconds?)\\s*ago$/i, '').trim();
                name = name.replace(/\\s*[a-zA-Z]:[\\\\/][\\w\\-\\.\\\\/]+$/g, '').trim();
                name = name.replace(/\\s*●\\s*$/, '').trim();

                if (name === targetTitle) {
                    doClick(el);
                    clicked = true;
                    method = 'quickinput_match';
                    break;
                }
            }
            // Strategy 1b: fuzzy match in quick-input (startsWith)
            if (!clicked) {
                for (const el of qiSessions) {
                    const fullText = (el.innerText || el.textContent || '').trim();
                    if (fullText.startsWith(targetTitle) || targetTitle.startsWith(fullText.split('\\n')[0].trim())) {
                        doClick(el);
                        clicked = true;
                        method = 'quickinput_fuzzy';
                        break;
                    }
                }
            }

            // Strategy 2: Sidebar button with title attribute
            if (!clicked) {
                const sessionBtn = [...document.querySelectorAll('button[title]')].find(b => {
                    return b.title.trim() === targetTitle && b.offsetParent !== null;
                });
                if (sessionBtn) {
                    doClick(sessionBtn);
                    clicked = true;
                    method = 'title_match';
                }
            }

            // Strategy 3: Sidebar button by class pattern + text content
            if (!clicked) {
                const classBtns = [...document.querySelectorAll('button')].filter(b => {
                    const cls = b.className || '';
                    return cls.includes('cursor-pointer') && cls.includes('group') &&
                           (cls.includes('grow') || cls.includes('flex-row')) &&
                           b.offsetParent !== null;
                });
                for (const btn of classBtns) {
                    const firstLine = (btn.innerText || btn.textContent || '').trim().split('\\n')[0].trim();
                    if (firstLine === targetTitle) {
                        doClick(btn);
                        clicked = true;
                        method = 'sidebar_class';
                        break;
                    }
                }
            }

            // Strategy 4: Any clickable element with exact text match
            if (!clicked) {
                const anyMatch = [...document.querySelectorAll('button, a, [role="button"], .cursor-pointer')].find(el => {
                    const text = (el.innerText || el.textContent || '').trim();
                    return text === targetTitle && el.offsetParent !== null;
                });
                if (anyMatch) {
                    doClick(anyMatch);
                    clicked = true;
                    method = 'any_match';
                }
            }

            if (!clicked) {
                return { success: false, error: 'Session not found: ' + targetTitle };
            }

            // After clicking session from "Other Conversations", auto-dismiss workspace picker
            const quickInputResult = await dismissQuickInput();

            return {
                success: true,
                method: method,
                target: targetTitle,
                quickInput: quickInputResult
            };
        })()`;

        const contexts = cdpConnection.getContexts();
        for (const ctx of contexts) {
            try {
                const result = await cdpConnection.call("Runtime.evaluate", {
                    expression: CLICK_SESSION_SCRIPT,
                    returnByValue: true,
                    awaitPromise: true,
                    contextId: ctx.id
                });
                const val = result.result?.value;
                if (val && val.success) {
                    return res.json(val);
                }
            } catch (e) { }
        }
        res.json({ success: false, error: 'Session not found in any context' });
    });

    // Start a new conversation (Ctrl+Shift+L)
    app.post('/new-conversation', async (req, res) => {
        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        const NEW_CONV_SCRIPT = `(() => {
            function doClick(el) {
                const rect = el.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const opts = { bubbles: true, cancelable: true, view: window,
                               clientX: cx, clientY: cy, screenX: cx, screenY: cy };
                el.dispatchEvent(new PointerEvent('pointerdown', opts));
                el.dispatchEvent(new MouseEvent('mousedown', opts));
                el.dispatchEvent(new PointerEvent('pointerup', opts));
                el.dispatchEvent(new MouseEvent('mouseup', opts));
                el.dispatchEvent(new MouseEvent('click', opts));
            }

            // Strategy 1: Find the "new conversation" button by tooltip/aria-label
            const newBtn = [...document.querySelectorAll('button, a')].find(b => {
                const tooltip = b.getAttribute('data-tooltip-content') || b.getAttribute('aria-label') || b.title || '';
                const text = (b.innerText || b.textContent || '').trim().toLowerCase();
                return (tooltip.toLowerCase().includes('new conversation') ||
                        tooltip.toLowerCase().includes('start a new') ||
                        text.includes('new conversation')) &&
                       b.offsetParent !== null;
            });

            if (newBtn) {
                doClick(newBtn);
                return { success: true, method: 'button_click' };
            }

            // Strategy 2: Dispatch Ctrl+Shift+L keyboard shortcut
            const target = document.activeElement || document.body;
            target.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'l', code: 'KeyL', keyCode: 76, which: 76,
                ctrlKey: true, shiftKey: true,
                bubbles: true, cancelable: true
            }));
            target.dispatchEvent(new KeyboardEvent('keyup', {
                key: 'l', code: 'KeyL', keyCode: 76, which: 76,
                ctrlKey: true, shiftKey: true,
                bubbles: true, cancelable: true
            }));

            return { success: true, method: 'keyboard_shortcut' };
        })()`;

        const contexts = cdpConnection.getContexts();
        for (const ctx of contexts) {
            try {
                const result = await cdpConnection.call("Runtime.evaluate", {
                    expression: NEW_CONV_SCRIPT,
                    returnByValue: true,
                    contextId: ctx.id
                });
                const val = result.result?.value;
                if (val && val.success) {
                    return res.json(val);
                }
            } catch (e) { }
        }
        res.json({ success: false, error: 'Could not create new conversation' });
    });

    // Click "See all" to expand session list
    app.post('/sessions-see-all', async (req, res) => {
        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        const SEE_ALL_SCRIPT = `(() => {
            function doClick(el) {
                const rect = el.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const opts = { bubbles: true, cancelable: true, view: window,
                               clientX: cx, clientY: cy, screenX: cx, screenY: cy };
                el.dispatchEvent(new PointerEvent('pointerdown', opts));
                el.dispatchEvent(new MouseEvent('mousedown', opts));
                el.dispatchEvent(new PointerEvent('pointerup', opts));
                el.dispatchEvent(new MouseEvent('mouseup', opts));
                el.dispatchEvent(new MouseEvent('click', opts));
            }

            const seeAll = [...document.querySelectorAll('div, a, button, span')].find(el => {
                const text = (el.innerText || el.textContent || '').trim().toLowerCase();
                return text === 'see all' && el.offsetParent !== null;
            });

            if (seeAll) {
                doClick(seeAll);
                return { success: true };
            }
            return { success: false, error: 'See all button not found' };
        })()`;

        const contexts = cdpConnection.getContexts();
        for (const ctx of contexts) {
            try {
                const result = await cdpConnection.call("Runtime.evaluate", {
                    expression: SEE_ALL_SCRIPT,
                    returnByValue: true,
                    contextId: ctx.id
                });
                const val = result.result?.value;
                if (val && val.success) {
                    return res.json(val);
                }
            } catch (e) { }
        }
        res.json({ success: false, error: 'See all not found in any context' });
    });

    // Click "Show N more..." button in quick-input dialog
    app.post('/sessions-show-more', async (req, res) => {
        const { section } = req.body; // "recent" or "other" to target specific section
        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        const SHOW_MORE_SCRIPT = `(async () => {
            const targetSection = ${JSON.stringify(section || '')}.toLowerCase();

            function doClick(el) {
                const rect = el.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const opts = { bubbles: true, cancelable: true, view: window,
                               clientX: cx, clientY: cy, screenX: cx, screenY: cy };
                el.dispatchEvent(new PointerEvent('pointerdown', opts));
                el.dispatchEvent(new MouseEvent('mousedown', opts));
                el.dispatchEvent(new PointerEvent('pointerup', opts));
                el.dispatchEvent(new MouseEvent('mouseup', opts));
                el.dispatchEvent(new MouseEvent('click', opts));
            }

            // Find "Show N more..." buttons: text-quickinput-foreground + pb-1.5 + cursor-pointer
            const showMoreBtns = [...document.querySelectorAll('[class*="text-quickinput-foreground"]')].filter(el => {
                const cls = el.className || '';
                const text = (el.innerText || el.textContent || '').trim().toLowerCase();
                return cls.includes('pb-1.5') && cls.includes('cursor-pointer') &&
                       text.includes('more') && el.offsetParent !== null;
            });

            if (showMoreBtns.length === 0) {
                return { success: false, error: 'No "Show more" buttons found' };
            }

            // If section specified, try to find the right one
            let target = showMoreBtns[0]; // default: first one (Recent)
            if (targetSection === 'other' && showMoreBtns.length > 1) {
                target = showMoreBtns[1]; // second one = Other Conversations
            } else if (targetSection === 'recent') {
                target = showMoreBtns[0];
            }

            const btnText = (target.innerText || target.textContent || '').trim();
            doClick(target);

            // Wait for the list to expand
            await new Promise(r => setTimeout(r, 500));

            return { success: true, clicked: btnText };
        })()`;

        const contexts = cdpConnection.getContexts();
        for (const ctx of contexts) {
            try {
                const result = await cdpConnection.call("Runtime.evaluate", {
                    expression: SHOW_MORE_SCRIPT,
                    returnByValue: true,
                    awaitPromise: true,
                    contextId: ctx.id
                });
                const val = result.result?.value;
                if (val && val.success) {
                    return res.json(val);
                }
            } catch (e) { }
        }
        res.json({ success: false, error: 'Show more not found in any context' });
    });

    // --- Click Element (for Model/Mode selection) ---

    // Click an element on the Antigravity desktop
    app.post('/click', async (req, res) => {
        const { text, tag, selector } = req.body;
        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        try {
            const result = await clickElementCDP(cdpConnection, { text, tag, selector });
            res.json(result);
        } catch (e) {
            console.error('Click error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // --- Controls HTML (for Model/Mode detection) ---

    // Get full body HTML for frontend to parse model/mode buttons
    app.get('/controls', async (req, res) => {
        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        const CONTROLS_SCRIPT = `(() => {
            // Extract only buttons and relevant controls to reduce payload
            const btns = [...document.querySelectorAll('button, [role="button"], [id^="headlessui"]')];
            const panels = [...document.querySelectorAll('[id^="headlessui-popover-panel"], [id^="headlessui-menu-items"], [id^="headlessui-listbox-options"], [role="menu"], [role="listbox"], [role="dialog"], .fixed[class*="bg-"], .absolute[class*="border"]')];

            const buttons = btns.map(b => ({
                tag: b.tagName,
                id: b.id || '',
                text: (b.innerText || b.textContent || '').trim().substring(0, 100),
                role: b.getAttribute('role') || '',
                visible: b.offsetParent !== null
            })).filter(b => b.visible && b.text);

            const openPanels = panels.filter(p => {
                // EXCLUDE quick-input-widget panels (session picker, workspace picker)
                // These are NOT model/mode dropdowns
                if (p.closest('.quick-input-widget')) return false;
                const cls = p.className || '';
                if (cls.includes('quick-input') || cls.includes('quickinput')) return false;
                // Exclude panels that contain workspace/path-like items
                const text = (p.innerText || '').toLowerCase();
                if (text.includes('open in workspace') || text.includes('open in current window')) return false;
                if (text.includes('select where to open') || text.includes('select a conversation')) return false;
                return true;
            }).map(p => {
                const items = [...p.querySelectorAll('button, [role="menuitem"], [role="option"], li, .cursor-pointer, a')];
                return {
                    id: p.id || '',
                    role: p.getAttribute('role') || '',
                    items: items.map(i => {
                        // Prefer .font-medium child (title without description)
                        const fm = i.querySelector('.font-medium');
                        let text = fm ? fm.textContent.trim()
                                      : (i.innerText || i.textContent || '').trim();
                        // If text has multiple lines, take only the first line (strip descriptions)
                        const firstLine = text.split('\\n')[0].trim();
                        return { text: firstLine.substring(0, 100), tag: i.tagName, fullText: text.substring(0, 200) };
                    }).filter(i => i.text)
                };
            }).filter(p => p.items.length > 0);

            return { buttons, openPanels };
        })()`;

        // Scan ALL contexts and merge results - prioritize cascade-panel context
        // (model/mode buttons live in cascade-panel, not in workbench)
        const contexts = cdpConnection.getContexts();
        let allButtons = [];
        let allPanels = [];

        for (const ctx of contexts) {
            try {
                const result = await cdpConnection.call("Runtime.evaluate", {
                    expression: CONTROLS_SCRIPT,
                    returnByValue: true,
                    contextId: ctx.id
                });
                if (result.result?.value) {
                    const val = result.result.value;
                    if (val.buttons) allButtons.push(...val.buttons);
                    if (val.openPanels) allPanels.push(...val.openPanels);
                }
            } catch (e) { }
        }

        // Deduplicate buttons by text+id combo
        const seen = new Set();
        allButtons = allButtons.filter(b => {
            const key = `${b.id}|${b.text}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        res.json({ buttons: allButtons, openPanels: allPanels });
    });

    // Check for pending actions requiring approval
    app.get('/pending-action', async (req, res) => {
        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        try {
            const result = await checkPendingAction(cdpConnection);
            res.json(result);
        } catch (err) {
            console.error('Error checking pending action:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // Accept pending action
    app.post('/accept', async (req, res) => {
        console.log('✅ Accept command requested');

        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        try {
            const result = await clickActionButton(cdpConnection, 'accept');
            console.log('Accept result:', result);
            res.json(result);
        } catch (err) {
            console.error('Accept error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Reject pending action
    app.post('/reject', async (req, res) => {
        console.log('❌ Reject command requested');

        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        try {
            const result = await clickActionButton(cdpConnection, 'reject');
            console.log('Reject result:', result);
            res.json(result);
        } catch (err) {
            console.error('Reject error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Check all popup types
    app.get('/check-popups', async (req, res) => {
        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        try {
            const [commandApproval, stepConfirmation, browserPermission, toolPermission] = await Promise.all([
                checkPendingAction(cdpConnection),
                checkStepConfirmation(cdpConnection),
                checkBrowserPermission(cdpConnection),
                checkToolPermission(cdpConnection)
            ]);

            res.json({
                commandApproval,
                stepConfirmation,
                browserPermission,
                toolPermission
            });
        } catch (err) {
            console.error('Error checking popups:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // Click confirmation button (Confirm/Deny)
    app.post('/click-confirmation', async (req, res) => {
        const { action } = req.body; // 'confirm' or 'deny'

        console.log(`🔘 Confirmation ${action} requested`);

        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        if (!action || !['confirm', 'deny'].includes(action.toLowerCase())) {
            return res.status(400).json({ error: 'Action must be "confirm" or "deny"' });
        }

        try {
            const result = await clickConfirmation(cdpConnection, action.toLowerCase());
            console.log(`Confirmation ${action} result:`, result);
            res.json(result);
        } catch (err) {
            console.error(`Confirmation ${action} error:`, err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Click tool permission button (Allow Once / Allow This Conversation / Deny)
    app.post('/click-tool-permission', async (req, res) => {
        const { action } = req.body; // 'allow_once', 'allow_conversation', 'deny'

        console.log(`🔐 Tool permission ${action} requested`);

        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        const validActions = ['allow_once', 'allow_conversation', 'deny'];
        if (!action || !validActions.includes(action.toLowerCase())) {
            return res.status(400).json({ error: 'Action must be "allow_once", "allow_conversation", or "deny"' });
        }

        try {
            const result = await clickToolPermission(cdpConnection, action.toLowerCase());
            console.log(`Tool permission ${action} result:`, result);
            res.json(result);
        } catch (err) {
            console.error(`Tool permission ${action} error:`, err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Cache statistics endpoint
    app.get('/api/cache/stats', async (req, res) => {
        try {
            const stats = await getCacheStats(join(__dirname, 'uploads'));
            res.json({
                success: true,
                stats: {
                    totalFiles: stats.totalFiles,
                    totalSize: stats.totalSize,
                    totalSizeFormatted: formatBytes(stats.totalSize),
                    byFolder: {
                        audio: {
                            count: stats.byFolder.audio.count,
                            size: stats.byFolder.audio.size,
                            sizeFormatted: formatBytes(stats.byFolder.audio.size)
                        },
                        files: {
                            count: stats.byFolder.files.count,
                            size: stats.byFolder.files.size,
                            sizeFormatted: formatBytes(stats.byFolder.files.size)
                        }
                    },
                    oldestFile: stats.oldestFile ? {
                        name: stats.oldestFile.name,
                        age: Math.floor((Date.now() - stats.oldestFile.createdAt) / (24 * 60 * 60 * 1000)) + ' days'
                    } : null,
                    newestFile: stats.newestFile ? {
                        name: stats.newestFile.name,
                        age: Math.floor((Date.now() - stats.newestFile.createdAt) / (24 * 60 * 60 * 1000)) + ' days'
                    } : null
                }
            });
        } catch (err) {
            console.error('❌ Failed to get cache stats:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Helper function for formatting bytes
    function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
    }

    // Serve uploaded files
    app.use('/uploads', express.static(join(__dirname, 'uploads')));

    // WebSocket connection
    wss.on('connection', (ws) => {
        console.log('📱 Client connected');

        ws.on('close', () => {
            console.log('📱 Client disconnected');
        });
    });

    return { server, wss };
}

// Main
async function main() {
    try {
        // Ensure upload directories exist
        await ensureUploadDirs();

        // Start cache cleanup scheduler
        const stopCleanup = startCleanupScheduler(join(__dirname, 'uploads'));

        // Graceful shutdown handler
        process.on('SIGINT', () => {
            console.log('\n🛑 Shutting down gracefully...');
            stopCleanup();
            process.exit(0);
        });

        // Start Express server FIRST (so mobile UI is always accessible)
        const { server, wss } = await createServer();

        const PORT = process.env.PORT || 3000;
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
            console.log(`📱 Access from mobile: http://<your-ip>:${PORT}`);
        });

        // Connect CDP in background (don't block server startup)
        initCDP().then(() => {
            // Start background polling once CDP is connected
            startPolling(wss);
        });
    } catch (err) {
        console.error('❌ Fatal error:', err.message);
        process.exit(1);
    }
}

main();
