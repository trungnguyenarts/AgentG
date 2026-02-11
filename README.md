# AgentG - Mobile Remote Controller for Antigravity

> **Full-featured mobile remote controller for Antigravity AI app via Chrome DevTools Protocol**

A real-time mobile interface with modern UI, voice recording, file uploads, model/mode selection, session switching, and remote action approval for Antigravity.

## Features

### Core Functionality
- **Real-time Chat Monitoring** - Snapshot-based display with auto-scroll and WebSocket sync
- **Message Sending** - Direct text injection via CDP
- **File Upload** - Multi-file selection with thumbnail preview (up to 50MB)
- **Voice Recording** - Press & hold to record audio (WhatsApp-style)
- **Model Selection** - Choose between Claude, Gemini, GPT and other models via scrape-click-scrape
- **Mode Selection** - Switch between Planning, Fast, and Agent modes
- **Session Switching** - Browse and switch conversations with section support (Recent / Other)
- **Instance Switching** - Multi-window Antigravity support

### Remote Action Approval (4 popup types)
- **Command Approval** - Accept/Reject "Run command?" prompts remotely
- **Tool Permission** - Allow Once / Allow This Conversation / Deny directory/file access requests
- **Step Confirmation** - Confirm/Deny step confirmation dialogs
- **Browser Permission** - Warning for browser-level permission dialogs

### UI
- **Dark/Light Theme** - Toggle with localStorage persistence
- **CSS Design System** - Modern color palette with glassmorphism effects
- **Responsive Mobile-First** - Optimized for touch, iOS Chrome viewport fix (100dvh + safe-area-insets)
- **Real-time Updates** - WebSocket connection for instant chat sync

## Quick Start

### 1. Start Antigravity with CDP

```bash
antigravity . --remote-debugging-port=9000
```

### 2. Install & Run

```bash
npm install
npm start
```

### 3. Access from Mobile

```
http://<your-local-ip>:3000
```

Examples:
- Local Network: `http://192.168.x.x:3000`
- Tailscale VPN: `http://100.x.x.x:3000`

## Architecture

```
Mobile Browser (iOS/Android/Desktop)
      |
  AgentG Server (Express + WebSocket)
      |
  Chrome DevTools Protocol (CDP)
      |
  Antigravity Desktop App
```

### How It Works

1. **Snapshot Capture** - Connects to Antigravity via CDP, captures chat HTML & CSS, broadcasts only on content change
2. **Message Injection** - Locates chat input via multiple selector strategies, injects text and triggers submit
3. **Model/Mode Selection** - Scrape open panels via CDP, detect dropdown items, click to select (scrape-click-scrape pattern)
4. **Session Switching** - Detect quick-input dialog structure with sections, "Show N more..." pagination
5. **Action Approval** - Poll for pending popups every 2s, display on mobile, click correct button via CDP

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/snapshot` | GET | Get current chat snapshot |
| `/send` | POST | Send message to Antigravity |
| `/upload` | POST | Upload file (image/video/doc) |
| `/upload-voice` | POST | Upload voice recording |
| `/controls` | GET | Get current model/mode dropdown state |
| `/click` | POST | Click element on Antigravity UI |
| `/sessions` | GET | List chat sessions (with sections) |
| `/session-click` | POST | Switch to a session by name |
| `/sessions-show-more` | POST | Click "Show N more..." in session list |
| `/sessions-see-all` | POST | Open full session list |
| `/new-conversation` | POST | Start new conversation |
| `/instances` | GET | List Antigravity window instances |
| `/instance` | POST | Switch to a different instance |
| `/check-popups` | GET | Check all popup types at once |
| `/accept` | POST | Click Run/Accept button |
| `/reject` | POST | Click Reject button |
| `/click-confirmation` | POST | Click Confirm/Deny button |
| `/click-tool-permission` | POST | Click Allow Once/Allow Conversation/Deny |
| `/pending-action` | GET | Check for command approval popup |

## Project Structure

```
AgentG/
├── server.js                    # Express server + CDP logic + all endpoints
├── package.json
├── uploads/                     # Temp file storage (gitignored)
└── public/
    ├── index.html               # Main HTML structure + popup modals
    ├── style.css                # Design system + responsive styles
    └── js/
        ├── main.js              # App controller, message sending
        ├── snapshot.js          # Chat display and scroll handling
        ├── actionManager.js     # Popup polling + Accept/Reject/Allow handlers
        ├── controlsManager.js   # Model/Mode dropdown detection
        ├── instanceManager.js   # Session/Instance switching UI
        ├── theme.js             # Dark/Light theme switcher
        ├── websocket.js         # Real-time connection manager
        ├── fileUpload.js        # File selection and preview
        └── voiceRecorder.js     # Press-hold audio recording
```

## Technical Details

### CDP Selectors (Antigravity UI)
- **Model button**: `headlessui-popover-button-*` or `headlessui-menu-button-*` with model keywords
- **Mode button**: Exact text `Planning`/`Fast`/`Agent`, no headlessui ID
- **Chat editor**: `[data-lexical-editor="true"][contenteditable="true"]`
- **Quick-input sessions**: `.text-quickinput-foreground` class elements
- **Run button**: `button.bg-primary` with text starting with "Run"
- **Tool permission buttons**: `bg-ide-button-background` class buttons

### Click Dispatch
Full event sequence for reliable clicks: `pointerdown -> mousedown -> pointerup -> mouseup -> click`

### Environment
- **Node.js**: >= 16.0.0
- **Browser**: Chromium-based with CDP support
- **Network**: Local LAN or VPN (Tailscale recommended)

## Known Limitations

- **File Injection**: Files upload to server but require manual drag-drop into Antigravity
- **Voice Recording**: Requires HTTPS or `localhost` for microphone access
- **Browser Permission dialogs**: Cannot be clicked remotely (OS-level), shown as warning only

## License

MIT

## Credits

AgentG by [@trungnguyenarts](https://github.com/trungnguyenarts)

---

**Made with care for mobile Antigravity remote control**
