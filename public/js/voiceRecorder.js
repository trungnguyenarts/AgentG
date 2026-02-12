// Voice Recorder Manager
// Press & hold to record, release to stop
// Real-time waveform visualization via Web Audio API

class VoiceRecorderManager {
    constructor() {
        this.voiceBtn = document.getElementById('voiceBtn');
        this.voiceOverlay = document.getElementById('voiceOverlay');
        this.voiceTimer = document.getElementById('voiceTimer');
        this.voiceCancelBtn = document.getElementById('voiceCancelBtn');
        this.voiceStopBtn = document.getElementById('voiceStopBtn');
        this.voiceSendBtn = document.getElementById('voiceSendBtn');
        this.waveformCanvas = document.getElementById('waveformCanvas');

        // Mic Setup Modal (Fallback)
        this.micSetupModal = document.getElementById('micSetupModal');

        this.mediaRecorder = null;
        this.audioChunks = [];
        this.stream = null;

        // Audio analysis
        this.audioContext = null;
        this.analyser = null;
        this.animFrameId = null;

        // Timer state
        this.elapsedTime = 0; // Total ms recorded
        this.lastResumeTime = null; // Timestamp of last resume
        this.timerInterval = null;

        this.recordedBlob = null;

        this.isRecording = false;
        this.isPaused = false;
        this.isCanceled = false;

        this.init();
    }

    init() {
        if (!this.voiceBtn) return;

        // Change from hold to tap
        this.voiceBtn.addEventListener('click', (e) => {
            if (this.isRecording) {
                this.togglePause();
            } else {
                this.startRecording();
            }
        });

        // UI events
        if (this.voiceCancelBtn) this.voiceCancelBtn.addEventListener('click', () => this.cancelRecording());
        if (this.voiceStopBtn) this.voiceStopBtn.addEventListener('click', () => this.stopRecording());
        if (this.voiceSendBtn) this.voiceSendBtn.addEventListener('click', () => this.sendRecording());
    }

    async startRecording() {
        if (this.isRecording) return;

        // Reset state
        this.isRecording = true;
        this.isPaused = false;
        this.isCanceled = false;
        this.audioChunks = [];
        this.elapsedTime = 0;

        // Check for media devices access
        const hasMediaDevices = navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
        const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        const isHttps = location.protocol === 'https:';

        if (!hasMediaDevices && !isLocalhost && !isHttps) {
            const ip = location.host;
            alert(`🎙️ Microphone still blocked.\n\nPlease follow the setup guide...`);
            prompt("STEP 1: Copy this Flag URL:", "chrome://flags/#unsafely-treat-insecure-origin-as-secure");
            prompt("STEP 4: Copy this Server URL to add to the list:", `http://${ip}`);
            this.isRecording = false;
            return;
        }

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            alert('🎙️ Audio recording not supported in this browser.');
            this.isRecording = false;
            return;
        }

        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true }
            });

            const mimeType = this.getSupportedMimeType();
            this.mediaRecorder = new MediaRecorder(this.stream, {
                mimeType,
                audioBitsPerSecond: 128000 // 128kbps - High Quality for voice
            });

            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) this.audioChunks.push(e.data);
            };

            this.mediaRecorder.onstop = () => {
                if (!this.isCanceled) this.handleRecordingComplete();
                if (this.stream) this.stream.getTracks().forEach(track => track.stop());
            };

            this.mediaRecorder.start();
            this.lastResumeTime = Date.now();
            this.showRecordingUI();
            this.startTimer();
            this.startWaveform();
            this.voiceBtn.classList.add('recording');

        } catch (error) {
            console.error('Mic access error:', error);
            alert('🎙️ Cannot access microphone: ' + error.message);
            this.isRecording = false;
            this.voiceBtn.classList.remove('recording');
        }
    }

    // --- Waveform Visualization ---

    startWaveform() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = this.audioContext.createMediaStreamSource(this.stream);
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            source.connect(this.analyser);
            this.drawWaveform();
        } catch (e) {
            console.warn('Waveform init failed:', e);
        }
    }

    drawWaveform() {
        if (!this.analyser || !this.waveformCanvas) return;

        const canvas = this.waveformCanvas;
        const ctx = canvas.getContext('2d');
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const draw = () => {
            this.animFrameId = requestAnimationFrame(draw);
            this.analyser.getByteFrequencyData(dataArray);

            // Clear
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Draw bars
            const barCount = 40;
            const barWidth = (canvas.width / barCount) - 2;
            const step = Math.floor(bufferLength / barCount);

            for (let i = 0; i < barCount; i++) {
                const value = dataArray[i * step] || 0;
                const barHeight = (value / 255) * (canvas.height * 0.85);
                const minHeight = 3;
                const h = Math.max(barHeight, minHeight);
                const x = i * (barWidth + 2);
                const y = (canvas.height - h) / 2;

                // Color: accent for active bars, dim for quiet
                if (this.isPaused) {
                    ctx.fillStyle = '#f59e0b88';
                } else {
                    const intensity = value / 255;
                    ctx.fillStyle = intensity > 0.3 ? '#ef4444' : '#ef444466';
                }

                ctx.beginPath();
                ctx.roundRect(x, y, barWidth, h, 2);
                ctx.fill();
            }
        };

        draw();
    }

    stopWaveform() {
        if (this.animFrameId) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }
        if (this.audioContext) {
            this.audioContext.close().catch(() => {});
            this.audioContext = null;
            this.analyser = null;
        }
    }

    // --- Recording Controls ---

    togglePause() {
        if (!this.mediaRecorder || !this.isRecording) return;

        if (this.isPaused) {
            this.mediaRecorder.resume();
            this.isPaused = false;
            this.lastResumeTime = Date.now();
            this.voiceBtn.classList.remove('paused');
            if (this.voiceOverlay) {
                this.voiceOverlay.querySelector('.voice-waveform').classList.remove('paused');
                this.voiceOverlay.querySelector('p').textContent = 'Recording audio...';
            }
        } else {
            this.mediaRecorder.pause();
            this.isPaused = true;
            // Add current session to total elapsed
            this.elapsedTime += (Date.now() - this.lastResumeTime);
            this.lastResumeTime = null;
            this.voiceBtn.classList.add('paused');
            if (this.voiceOverlay) {
                this.voiceOverlay.querySelector('.voice-waveform').classList.add('paused');
                this.voiceOverlay.querySelector('p').textContent = 'Recording paused';
            }
        }
    }

    stopRecording() {
        if (!this.isRecording || !this.mediaRecorder) return;

        if (this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
        }

        this.stopTimer();
        this.stopWaveform();
        this.isRecording = false;
        this.isPaused = false;
        this.voiceBtn.classList.remove('recording', 'paused');

        if (this.voiceStopBtn) this.voiceStopBtn.classList.add('hidden');
        if (this.voiceSendBtn) this.voiceSendBtn.classList.remove('hidden');
    }

    handleRecordingComplete() {
        const mimeType = this.mediaRecorder.mimeType;
        this.recordedBlob = new Blob(this.audioChunks, { type: mimeType });
        if (this.voiceSendBtn) this.voiceSendBtn.classList.remove('hidden');

        const textEl = this.voiceOverlay.querySelector('p');
        if (textEl) textEl.textContent = 'Recording saved. Send or cancel?';
    }

    async sendRecording() {
        if (!this.recordedBlob) return;
        try {
            this.voiceSendBtn.disabled = true;
            this.voiceSendBtn.textContent = 'Sending...';

            const formData = new FormData();
            const ext = this.getFileExtension(this.recordedBlob.type);
            const filename = `voice_${Date.now()}.${ext}`;
            formData.append('audio', this.recordedBlob, filename);

            const res = await fetch('/upload-voice', { method: 'POST', body: formData });
            if (!res.ok) throw new Error('Upload failed');

            const result = await res.json();

            // Add the full server result as a pre-uploaded file
            window.fileUploadManager.addPreUploadedFile({
                ...result,
                fileType: this.recordedBlob.type,
                isPreUploaded: true
            });

            this.hideRecordingUI();
            // No alert needed here as the UI update shows the attachment
        } catch (error) {
            alert('Failed to send voice recording');
            this.voiceSendBtn.disabled = false;
            this.voiceSendBtn.textContent = 'Send';
        }
    }

    cancelRecording() {
        this.isCanceled = true;
        if (this.isRecording) {
            this.stopRecording();
        }
        this.hideRecordingUI();
    }

    showRecordingUI() {
        if (this.voiceOverlay) {
            this.voiceOverlay.classList.add('show');
            this.voiceOverlay.querySelector('.voice-waveform').classList.remove('paused');
            this.voiceOverlay.querySelector('p').textContent = 'Recording audio...';
        }
        if (this.voiceStopBtn) this.voiceStopBtn.classList.remove('hidden');
        if (this.voiceSendBtn) {
            this.voiceSendBtn.classList.add('hidden');
            this.voiceSendBtn.disabled = false;
            this.voiceSendBtn.textContent = 'Send';
        }
        if (this.voiceTimer) this.voiceTimer.textContent = '0:00';
    }

    hideRecordingUI() {
        if (this.voiceOverlay) this.voiceOverlay.classList.remove('show');
        this.stopWaveform();
        this.recordedBlob = null;
        this.audioChunks = [];
        this.isRecording = false;
        this.isPaused = false;
        this.voiceBtn.classList.remove('recording', 'paused');
        this.stopTimer();
    }

    startTimer() {
        this.timerInterval = setInterval(() => {
            let totalMs = this.elapsedTime;
            if (this.lastResumeTime) {
                totalMs += (Date.now() - this.lastResumeTime);
            }
            const totalSeconds = Math.floor(totalMs / 1000);
            const m = Math.floor(totalSeconds / 60);
            const s = (totalSeconds % 60).toString().padStart(2, '0');
            if (this.voiceTimer) this.voiceTimer.textContent = `${m}:${s}`;
        }, 100);
    }

    stopTimer() {
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.timerInterval = null;
    }

    getSupportedMimeType() {
        const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
        return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
    }

    getFileExtension(m) {
        if (m.includes('webm')) return 'webm';
        if (m.includes('ogg')) return 'ogg';
        if (m.includes('mp4')) return 'm4a';
        return 'wav';
    }
}

window.voiceRecorderManager = new VoiceRecorderManager();
