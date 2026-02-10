// WebSocket Connection Manager
// Handles real-time connection to server for snapshot updates

class WebSocketManager {
    constructor() {
        this.ws = null;
        this.reconnectInterval = 2000;
        this.reconnectTimer = null;
        this.listeners = {};
        this.statusDot = document.getElementById('statusDot');
        this.statusText = document.getElementById('statusText');

        this.connect();
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${window.location.host}`;

        try {
            this.ws = new WebSocket(url);

            this.ws.onopen = () => this.handleOpen();
            this.ws.onmessage = (event) => this.handleMessage(event);
            this.ws.onclose = () => this.handleClose();
            this.ws.onerror = (error) => this.handleError(error);
        } catch (error) {
            console.error('WebSocket connection error:', error);
            this.scheduleReconnect();
        }
    }

    handleOpen() {
        console.log('✅ WebSocket connected');
        this.updateStatus('connected', 'Connected');

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.emit('connected');
    }

    handleMessage(event) {
        try {
            const data = JSON.parse(event.data);
            this.emit('message', data);

            // Handle specific message types
            if (data.type === 'snapshot_update') {
                this.emit('snapshot_update', data);
            }
        } catch (error) {
            console.error('Failed to parse WebSocket message:', error);
        }
    }

    handleClose() {
        console.log('❌ WebSocket disconnected');
        this.updateStatus('disconnected', 'Disconnected');
        this.emit('disconnected');
        this.scheduleReconnect();
    }

    handleError(error) {
        console.error('WebSocket error:', error);
        this.updateStatus('error', 'Error');
    }

    scheduleReconnect() {
        if (this.reconnectTimer) return
            ;

        this.updateStatus('reconnecting', 'Reconnecting...');
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.reconnectInterval);
    }

    updateStatus(state, text) {
        this.statusDot.className = 'status-dot';

        if (state === 'connected') {
            this.statusDot.classList.add('connected');
        }

        if (this.statusText) {
            this.statusText.textContent = text;
        }
    }

    // Event emitter pattern
    on(event, callback) {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(callback);
    }

    emit(event, data) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(callback => callback(data));
        }
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        } else {
            console.warn('WebSocket not connected, cannot send message');
        }
    }
}

// Initialize WebSocket manager
window.wsManager = new WebSocketManager();
