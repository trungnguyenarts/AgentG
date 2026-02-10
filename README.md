# AgentG - Mobile Monitor for Antigravity

> **Modern mobile interface for monitoring and interacting with Antigravity chat sessions**

![AgentG Banner](https://via.placeholder.com/1200x400/0a0a0a/3b82f6?text=AgentG+-+Mobile+Monitor)

A real-time mobile interface with modern UI, voice recording, file uploads, and model/mode selection for Antigravity.

## ✨ Features

### 🎨 Modern Minimal UI
- **Dark/Light Theme** - Toggle with localStorage persistence
- **CSS Design System** - Modern color palette with glassmorphism effects
- **Responsive Mobile-First** - Optimized for touch interactions
- **Real-time Updates** - WebSocket connection for instant chat sync

### 📱 Core Functionality
- ✅ **Real-time Chat Monitoring** - Snapshot-based display with auto-scroll
- ✅ **Message Sending** - Direct text injection via CDP
- ✅ **File Upload** - 📎 Multi-file selection with thumbnail preview (up to 50MB)
- ✅ **Voice Recording** - 🎙️ Press \u0026 hold to record audio (like WhatsApp)
- ✅ **Model Selection** - Choose between Claude, Gemini, GPT models
- ✅ **Mode Selection** - Switch between Planning and Fast modes

### 🔧 Technical Stack
- **Frontend**: Vanilla JavaScript (6 modular components)
- **Backend**: Express.js + WebSocket + Multer
- **Integration**: Chrome DevTools Protocol (CDP)
- **Styling**: CSS Variables with modern design tokens

## 🚀 Quick Start

### 1. Start Antigravity with CDP

```bash
antigravity . --remote-debugging-port=9000
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Start AgentG Server

```bash
npm start
```

### 4. Access from Mobile

Open your browser and navigate to:
```
http://<your-local-ip>:3000
```

**Examples:**
- Local Network: `http://192.168.1.3:3000`
- Tailscale VPN: `http://100.86.148.61:3000`

## 📱 How It Works

### Architecture Overview

```
Mobile Browser
      ↓
  AgentG Server (Express + WebSocket)
      ↓
  Chrome DevTools Protocol (CDP)
      ↓
  Antigravity Desktop App
```

### Components

#### 1. **Snapshot Capture (Read)**
- Connects to Antigravity via CDP on port 9000
- Captures chat HTML \u0026 CSS every 3 seconds
- Only broadcasts updates when content changes
- Preserves formatting and styles

#### 2. **Message Injection (Write)**
- Locates Antigravity chat input via multiple selector strategies
- Injects text and triggers submit button
- Handles "busy" state detection

#### 3. **File Upload**
- Multer middleware for file handling
- Preview thumbnails for images/videos
- Storage in `uploads/` directory
- *Note: CDP file injection not yet implemented*

#### 4. **Voice Recording**
- MediaRecorder API with press-hold interaction
- Supports WebM, OGG, MP4 audio formats
- Timer display and waveform animation
- Upload to server then manual attachment

## 🎨 UI Components

### JavaScript Modules

| Module | Purpose |
|--------|---------|
| `theme.js` | Dark/Light theme switcher |
| `websocket.js` | Real-time connection manager |
| `snapshot.js` | Chat display and scroll handling |
| `fileUpload.js` | File selection and preview |
| `voiceRecorder.js` | Press-hold audio recording |
| `modelSelector.js` | Model/Mode dropdown logic |
| `main.js` | App controller and message sending |

### Design Tokens

```css
/* Dark Theme (Default) */
--bg-primary: #0a0a0a
--bg-secondary: #1a1a1a
--text-primary: #ffffff
--accent-primary: #3b82f6

/* Light Theme */
--bg-primary: #ffffff
--bg-secondary: #f5f5f5
--text-primary: #0a0a0a
--accent-primary: #2563eb
```

## ⚙️ API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/snapshot` | GET | Get current chat snapshot |
| `/send` | POST | Send message to Antigravity |
| `/upload` | POST | Upload file (image/video/doc) |
| `/upload-voice` | POST | Upload voice recording |
| `/inject-file` | POST | Inject file into Antigravity (placeholder) |
| `/set-model` | POST | Switch AI model (placeholder) |
| `/set-mode` | POST | Switch conversation mode (placeholder) |

## 🛠️ Development

### Project Structure

```
AgentG/
├── server.js              # Express server + CDP logic
├── package.json           # Dependencies
├── uploads/              # Temp file storage
│   ├── audio/
│   └── files/
└── public/
    ├── index.html        # Main HTML structure
    ├── style.css         # Design system
    └── js/
        ├── theme.js
        ├── websocket.js
        ├── snapshot.js
        ├── fileUpload.js
        ├── voiceRecorder.js
        ├── modelSelector.js
        └── main.js
```

### Environment

- **Node.js**: >= 16.0.0
- **Browser**: Chromium-based with CDP support
- **Network**: Local LAN or VPN (Tailscale recommended)

## ⚠️ Known Limitations

- **File Injection**: Files upload successfully but require manual drag-drop into Antigravity (CDP file injection complex)
- **Model/Mode Switching**: UI implemented but CDP automation pending (requires UI selector discovery)
- **Voice Recording**: Requires HTTPS or `localhost` for microphone access

## 📝 TODO

- [ ] Implement CDP file drag-drop injection
- [ ] Implement CDP model/mode selector automation
- [ ] Add file upload progress indicator
- [ ] Add voice waveform visualization
- [ ] Implement file cleanup cron job (delete uploads > 1 hour)
- [ ] Add authentication for multi-user access

## 📄 License

MIT

## 🙏 Credits

Original concept: Open source mobile monitor for Antigravity

AgentG rebuild by: [@trungnguyenarts](https://github.com/trungnguyenarts)

---

**Made with ❤️ for mobile Antigravity monitoring**
