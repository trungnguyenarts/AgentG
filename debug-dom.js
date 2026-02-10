#!/usr/bin/env node
import WebSocket from 'ws';
import http from 'http';

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

// Find Antigravity CDP endpoint
async function discoverCDP() {
    const PORTS = [9000, 9001, 9222, 9002, 9003];
    console.log(`🔍 Scanning ports ${PORTS.join(', ')}...`);

    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            const found = list.find(t =>
                (t.url?.includes('workbench.html') || (t.title && t.title.includes('Antigravity'))) &&
                t.type !== 'worker'
            );
            if (found && found.webSocketDebuggerUrl) {
                console.log(`✅ Found on port ${port}: ${found.title}`);
                return { port, url: found.webSocketDebuggerUrl };
            }
        } catch (e) {
            // ignore
        }
    }
    throw new Error('CDP not found');
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
                if (!contexts.find(c => c.id === ctx.id)) {
                    contexts.push(ctx);
                }
            }
        } catch (e) { }
    });

    await call("Runtime.enable", {});
    await new Promise(r => setTimeout(r, 1000));

    return { ws, call, getContexts: () => contexts };
}

// Debug script to inspect DOM
const DEBUG_SCRIPT = `(() => {
    console.log('=== DOM INSPECTION START ===');
    
    // 1. Check for #cascade
    const cascadeById = document.getElementById('cascade');
    console.log('getElementById("cascade"):', cascadeById);
    
    // 2. Check for common chat container selectors
    const selectors = [
        '#cascade',
        '[id^="cascade"]',
        '[class*="chat"]',
        '[class*="conversation"]',
        '[role="main"]',
        'main',
        '.workbench',
        '[class*="workbench"]'
    ];
    
    const results = {};
    selectors.forEach(sel => {
        const el = document.querySelector(sel);
        if (el) {
            results[sel] = {
                found: true,
                id: el.id,
                className: el.className,
                tagName: el.tagName,
                visible: el.offsetParent !== null,
                childCount: el.children.length
            };
        } else {
            results[sel] = { found: false };
        }
    });
    
    // 3. Find all IDs in document
    const allIds = [...document.querySelectorAll('[id]')].map(el => ({
        id: el.id,
        tag: el.tagName,
        visible: el.offsetParent !== null
    }));
    
    // 4. Find contenteditable elements (chat input)
    const editables = [...document.querySelectorAll('[contenteditable="true"]')].map(el => ({
        id: el.id,
        className: el.className,
        visible: el.offsetParent !== null,
        parentId: el.parentElement?.id,
        parentClass: el.parentElement?.className
    }));
    
    return {
        cascadeById: !!cascadeById,
        selectorResults: results,
        allIds: allIds.slice(0, 20), // First 20 IDs
        editables: editables,
        bodyClasses: document.body.className,
        htmlClasses: document.documentElement.className
    };
})()`;

async function main() {
    try {
        console.log('🚀 Starting DOM Debug...\n');

        const { url } = await discoverCDP();
        console.log('🔗 Connecting to CDP...\n');

        const cdp = await connectCDP(url);
        console.log(`✅ Connected! Found ${cdp.getContexts().length} contexts\n`);

        const contexts = cdp.getContexts();
        for (const ctx of contexts) {
            console.log(`\n📍 Inspecting context ${ctx.id} (${ctx.name})...`);

            try {
                const result = await cdp.call("Runtime.evaluate", {
                    expression: DEBUG_SCRIPT,
                    returnByValue: true,
                    contextId: ctx.id
                });

                if (result.result && result.result.value) {
                    console.log('\n');
                    console.log('════════════════════════════════════════');
                    console.log('         DOM INSPECTION RESULTS');
                    console.log('════════════════════════════════════════\n');
                    console.log(JSON.stringify(result.result.value, null, 2));
                    console.log('\n════════════════════════════════════════\n');
                }
            } catch (e) {
                console.log(`   ⚠️ Failed: ${e.message}`);
            }
        }

        cdp.ws.close();
        console.log('\n✅ Debug complete!');

    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    }
}

main();
