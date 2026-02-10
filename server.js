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
                return { port, url: found.webSocketDebuggerUrl, title: found.title };
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
        return { port: match.port, url: match.url };
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
        // Try multiple selectors to find chat content
        // 1. Chat messages container (text-ide-message-block-bot-color)
        let chatContainer = document.querySelector('div[class*="text-ide-message-block-bot-color"]');
        // 2. Scrollable chat area (new Antigravity)
        if (!chatContainer) chatContainer = document.querySelector('div.relative.flex.w-full.grow.flex-col.overflow-clip.overflow-y-auto');
        // 3. Legacy cascade
        if (!chatContainer) chatContainer = document.getElementById('cascade');
        if (!chatContainer) return { error: 'cascade not found', debug: document.body?.innerHTML?.substring(0, 200) };

        const containerStyles = window.getComputedStyle(chatContainer);
        const clone = chatContainer.cloneNode(true);

        // Remove input/editor area from clone
        const inputEditor = clone.querySelector('[contenteditable="true"]');
        if (inputEditor) {
            const inputContainer = inputEditor.closest('div');
            if (inputContainer && inputContainer !== clone) inputContainer.remove();
        }

        // Remove style tags
        const styleTags = clone.querySelectorAll('style');
        styleTags.forEach(tag => tag.remove());

        // Strip inline color styles
        function stripColorStyles(element) {
            if (element.style) {
                element.style.color = '';
                element.style.backgroundColor = '';
                element.style.background = '';
                element.style.borderColor = '';
                element.style.fill = '';
                element.style.stroke = '';
            }
            for (const child of element.children) stripColorStyles(child);
        }
        stripColorStyles(clone);

        const html = clone.outerHTML;
        let allCSS = '';
        for (const sheet of document.styleSheets) {
            try {
                for (const rule of sheet.cssRules) allCSS += rule.cssText + '\\n';
            } catch (e) { }
        }

        return {
            html: html,
            css: allCSS,
            backgroundColor: containerStyles.backgroundColor,
            color: containerStyles.color,
            fontFamily: containerStyles.fontFamily
        };
    })()`;

    const contexts = cdp.getContexts();

    // Sort contexts: prioritize cascade-panel contexts (where chat lives)
    const sorted = [...contexts].sort((a, b) => {
        const aIsCascade = (a.origin || '').includes('cascade') || (a.name || '').includes('cascade') ? -1 : 0;
        const bIsCascade = (b.origin || '').includes('cascade') || (b.name || '').includes('cascade') ? -1 : 0;
        return aIsCascade - bIsCascade;
    });

    for (const ctx of sorted) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: CAPTURE_SCRIPT,
                returnByValue: true,
                contextId: ctx.id
            });
            if (result.result && result.result.value) {
                const val = result.result.value;
                // Skip if error or HTML is too short (empty container)
                if (val.error) continue;
                if (val.html && val.html.length > 200) return val;
            }
        } catch (e) { }
    }

    // Fallback: return whatever we can get (even short HTML)
    for (const ctx of sorted) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: CAPTURE_SCRIPT,
                returnByValue: true,
                contextId: ctx.id
            });
            if (result.result && result.result.value && !result.result.value.error) {
                return result.result.value;
            }
        } catch (e) { }
    }
    return null;
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
                    let cascade = document.querySelector('div.relative.flex.w-full.grow.flex-col.overflow-clip.overflow-y-auto');
                    if (!cascade) cascade = document.getElementById('cascade');
                    const editor = document.querySelector('[contenteditable="true"]');
                    const hasValidEditor = editor && editor.offsetParent !== null;
                    const hasCascade = cascade && cascade.offsetParent !== null;
                    
                    return {
                        hasCascade: hasCascade,
                        hasEditor: hasValidEditor,
                        isValid: hasCascade && hasValidEditor,
                        url: window.location.href
                    };
                })()`,
                returnByValue: true,
                contextId: ctx.id
            });

            if (check?.result?.value?.isValid) {
                console.log(`✅ Found Antigravity chat context ${ctx.id} (${ctx.name})`);
                console.log(`   - Has cascade: ${check.result.value.hasCascade}`);
                console.log(`   - Has editor: ${check.result.value.hasEditor}`);
                console.log(`   - URL: ${check.result.value.url}`);
                targetContext = ctx;
                break;
            }
        } catch (e) {
            console.log(`   ⚠️ Context ${ctx.id} check failed: ${e.message}`);
        }
    }

    if (!targetContext) {
        console.error("❌ Could not find valid Antigravity chat context!");
        console.log("Available contexts:");
        contexts.forEach(ctx => console.log(`   - Context ${ctx.id}: ${ctx.name}`));
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

        let editor = document.querySelector('[data-lexical-editor="true"][contenteditable="true"]');
        if (!editor) editor = document.querySelector('[contenteditable="true"]');
        
        if (!editor) {
            console.error("❌ Editor not found!");
            return { ok:false, error:"editor_not_found" };
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
             editor.dispatchEvent(new InputEvent("input", { bubbles:true }));
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
            const arrowIcons = [...document.querySelectorAll('svg')].filter(svg => 
                svg.classList.contains('lucide-arrow-right') || 
                svg.classList.contains('codicon-send') ||
                svg.innerHTML.includes('arrow-right') ||
                svg.innerHTML.includes('M12 5l7 7-7 7') // Common arrow path
            );
            console.log("Found " + arrowIcons.length + " arrow icons");
            if (arrowIcons.length > 0) {
                submit = arrowIcons[0].closest('button');
            }
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
        editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter", code:"Enter", keyCode: 13, which: 13 }));
        editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles:true, key:"Enter", code:"Enter", keyCode: 13, which: 13 }));
        
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
    // Look for "Run command?" text which appears in the approval prompt
    const runCommandText = [...document.querySelectorAll('#cascade *')].find(
        el => el.textContent?.includes('Run command?') && el.offsetParent !== null
    );

    // Look for Accept/Reject buttons
    const acceptBtn = document.querySelector('#cascade button[class*="accept"], #cascade button:has(svg.lucide-check)') ||
        [...document.querySelectorAll('#cascade button')].find(btn =>
            btn.textContent?.toLowerCase().includes('accept') && btn.offsetParent !== null
        );

    const rejectBtn = document.querySelector('#cascade button[class*="reject"], #cascade button:has(svg.lucide-x)') ||
        [...document.querySelectorAll('#cascade button')].find(btn =>
            btn.textContent?.toLowerCase().includes('reject') && btn.offsetParent !== null
        );

    if (runCommandText || acceptBtn || rejectBtn) {
        // Try to get command info
        let commandText = '';
        const codeBlock = document.querySelector('#cascade pre code, #cascade .code-block');
        if (codeBlock) {
            commandText = codeBlock.textContent?.slice(0, 200) || '';
        }

        return {
            hasPendingAction: true,
            hasAcceptButton: !!acceptBtn,
            hasRejectButton: !!rejectBtn,
            commandPreview: commandText,
            prompt: runCommandText?.textContent?.slice(0, 100) || 'Action requires approval'
        };
    }

    return { hasPendingAction: false };
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

    // Strategy 1: Find by text content
    let targetBtn = [...document.querySelectorAll('#cascade button')].find(btn => {
        const text = btn.textContent?.toLowerCase() || '';
        if (actionType === 'accept') {
            return (text.includes('accept') || text.includes('run') || text.includes('yes')) && btn.offsetParent !== null;
        } else {
            return (text.includes('reject') || text.includes('cancel') || text.includes('no')) && btn.offsetParent !== null;
        }
    });

    // Strategy 2: Find by icon (lucide icons)
    if (!targetBtn) {
        if (actionType === 'accept') {
            targetBtn = document.querySelector('#cascade button:has(svg.lucide-check), #cascade button:has(svg[class*="check"])');
        } else {
            targetBtn = document.querySelector('#cascade button:has(svg.lucide-x), #cascade button:has(svg[class*="x"])');
        }
    }

    // Strategy 3: Simulate keyboard shortcut
    if (!targetBtn) {
        const editor = document.querySelector('[contenteditable="true"]');
        if (editor) {
            if (actionType === 'accept') {
                // Alt+Enter for accept
                editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', altKey: true, bubbles: true }));
                return { ok: true, method: 'keyboard_alt_enter' };
            } else {
                // Escape for reject
                editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
                return { ok: true, method: 'keyboard_escape' };
            }
        }
    }

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
    const allButtons = [...document.querySelectorAll('#cascade button')];
    const confirmBtnCandidate = allButtons.find(b => b.textContent.toLowerCase().includes('confirm'));
    if (confirmBtnCandidate) {
        console.log('[StepConfirm Debug] Found Confirm Button:', confirmBtnCandidate.textContent);
    }

    // 1. Look for "Confirmation required" text anywhere in cascade
    // We look for a container or text element
    const confirmText = [...document.querySelectorAll('#cascade *')].find(
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

// Click Confirm or Deny button in step confirmation
async function clickConfirmation(cdp, action) {
    const CLICK_SCRIPT = `(async () => {
    const actionType = "${action}";

    // Find button by text content
    let targetBtn = [...document.querySelectorAll('#cascade button')].find(btn => {
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
            console.log(`✅ Connected! Found ${cdpConnection.getContexts().length} execution contexts\n`);

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

    // Model selection endpoint (placeholder)
    app.post('/set-model', async (req, res) => {
        const { model } = req.body;

        console.log(`🤖 Attempting to set model: ${model}`);

        // TODO: Implement CDP model switching
        // This requires finding the model dropdown and clicking the option

        console.warn('⚠️ Model switching not yet implemented');

        res.json({
            success: false,
            reason: 'not_implemented',
            currentModel: model,
            message: 'Model switching not yet implemented'
        });
    });

    // Mode selection endpoint (placeholder)
    app.post('/set-mode', async (req, res) => {
        const { mode } = req.body;

        console.log(`⚙️ Attempting to set mode: ${mode}`);

        // TODO: Implement CDP mode switching

        console.warn('⚠️ Mode switching not yet implemented');

        res.json({
            success: false,
            reason: 'not_implemented',
            currentMode: mode,
            message: 'Mode switching not yet implemented'
        });
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
            const [commandApproval, stepConfirmation, browserPermission] = await Promise.all([
                checkPendingAction(cdpConnection),
                checkStepConfirmation(cdpConnection),
                checkBrowserPermission(cdpConnection)
            ]);

            res.json({
                commandApproval,
                stepConfirmation,
                browserPermission
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

        await initCDP();

        const { server, wss } = await createServer();

        // Start background polling
        startPolling(wss);

        const PORT = process.env.PORT || 3000;
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
            console.log(`📱 Access from mobile: http://<your-ip>:${PORT}`);
        });
    } catch (err) {
        console.error('❌ Fatal error:', err.message);
        process.exit(1);
    }
}

main();
