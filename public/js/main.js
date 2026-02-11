// Main Application Controller
// Coordinates all modules and handles message sending

class App {
    constructor() {
        this.messageInput = document.getElementById('messageInput');
        this.sendBtn = document.getElementById('sendBtn');

        this.init();
    }

    init() {
        // Send button click
        this.sendBtn.addEventListener('click', () => {
            this.sendMessage();
        });

        // Auto-resize textarea
        this.messageInput.addEventListener('input', () => {
            this.autoResizeTextarea();
        });

        // Prevent zoom on iOS
        this.messageInput.addEventListener('focus', () => {
            this.preventZoom();
            // Scroll input into view for Android
            setTimeout(() => {
                this.messageInput.scrollIntoView({ behavior: 'smooth', block: 'end' });
            }, 300);
        });

        // Handle Android keyboard with visualViewport API
        /* Temporarily disabled - might be causing input to disappear
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', () => {
                const inputSection = document.querySelector('.input-section');
                if (inputSection) {
                    // Adjust input position when keyboard opens/closes
                    const keyboardHeight = window.innerHeight - window.visualViewport.height;
                    inputSection.style.bottom = keyboardHeight + 'px';
                }
            });
        }
        */
    }

    async sendMessage() {
        const message = this.messageInput.value.trim();
        const hasFiles = window.fileUploadManager.selectedFiles.length > 0;

        if (!message && !hasFiles) return;

        // Disable send button
        this.sendBtn.disabled = true;
        this.sendBtn.textContent = 'Sending...';

        try {
            // Upload files first (if any)
            let uploadedFiles = [];
            if (hasFiles) {
                try {
                    uploadedFiles = await window.fileUploadManager.uploadFiles();
                    if (uploadedFiles.length === 0 && window.fileUploadManager.selectedFiles.length > 0) {
                        throw new Error('File upload failed');
                    }
                } catch (uploadError) {
                    console.error('File upload failed:', uploadError);
                    alert(`File upload failed: ${uploadError.message}`);
                    return; // Don't proceed with message if file upload failed
                }
            }


            // Generate message with file URLs for Antigravity to access
            let messageToSend = message;
            if (uploadedFiles.length > 0) {
                const fileRefs = uploadedFiles.map(f => {
                    // Use server-provided URL if it exists, otherwise build it
                    let imageUrl = f.fileUrl;

                    // Defensive check: if URL contains a Windows file path (like C:/), rebuild it
                    // Don't rebuild if it's already a valid HTTP URL
                    if (!imageUrl || /^[A-Z]:\//i.test(imageUrl)) {
                        const baseUrl = window.location.origin;
                        const folder = f.fileType?.startsWith('audio/') ? 'audio' : 'files';
                        imageUrl = `${baseUrl}/uploads/${folder}/${f.fileId}`;
                    }

                    return `📎 ${f.fileName}: ${imageUrl}`;
                }).join('\n');

                // Combine user message with file references
                if (message) {
                    messageToSend = `${message}\n\n${fileRefs}`;
                } else {
                    messageToSend = `[Images attached]\n${fileRefs}`;
                }
            }

            // Send message with file references
            const response = await fetch('/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: messageToSend,
                    files: uploadedFiles
                })
            });

            // Parse response body
            let result;
            try {
                result = await response.json();
            } catch (parseError) {
                // If we can't parse JSON but status is OK, assume success
                if (response.ok) {
                    result = { success: true };
                } else {
                    throw new Error('Server error');
                }
            }

            // Check for actual success
            if (!response.ok || result.success === false) {
                throw new Error(result.reason || result.error || 'Failed to send');
            }

            // Success - clear input and files
            this.messageInput.value = '';
            this.messageInput.style.height = '44px';
            window.fileUploadManager.clearFiles();

            // Refresh snapshot after short delay
            setTimeout(() => {
                window.snapshotManager.loadSnapshot();
            }, 500);

        } catch (error) {
            console.error('Failed to send message:', error);
            alert(`Failed to send: ${error.message}`);
        } finally {
            this.sendBtn.disabled = false;
            this.sendBtn.textContent = 'Send';
        }
    }

    autoResizeTextarea() {
        this.messageInput.style.height = '44px';
        const newHeight = Math.min(this.messageInput.scrollHeight, 120);
        this.messageInput.style.height = newHeight + 'px';
    }

    preventZoom() {
        // Temporarily increase font size to prevent iOS zoom
        const currentSize = window.getComputedStyle(this.messageInput).fontSize;
        const size = parseFloat(currentSize);

        if (size < 16) {
            this.messageInput.style.fontSize = '16px';
        }
    }
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.app = new App();
    });
} else {
    window.app = new App();
}
