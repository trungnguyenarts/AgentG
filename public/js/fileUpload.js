// File Upload Manager
// Handles file selection, preview, uploading with progress

class FileUploadManager {
    constructor() {
        this.attachBtn = document.getElementById('attachBtn');
        this.fileInput = document.getElementById('fileInput');
        this.filePreviewArea = document.getElementById('filePreviewArea');

        this.selectedFiles = [];

        this.init();
    }

    init() {
        // Attach button click → trigger file input
        this.attachBtn.addEventListener('click', () => {
            this.fileInput.click();
        });

        // File input change
        this.fileInput.addEventListener('change', (e) => {
            this.handleFileSelection(e.target.files);
        });
    }

    handleFileSelection(files) {
        // Add new files to selection
        Array.from(files).forEach(file => {
            // Check file size (1GB limit)
            if (file.size > 1024 * 1024 * 1024) {
                alert(`File "${file.name}" is too large. Max size is 1GB.`);
                return;
            }

            this.selectedFiles.push(file);
        });

        // Update preview
        this.updatePreview();

        // Reset file input so same file can be selected again
        this.fileInput.value = '';
    }

    updatePreview() {
        if (this.selectedFiles.length === 0) {
            this.filePreviewArea.classList.add('hidden');
            return;
        }

        this.filePreviewArea.classList.remove('hidden');
        this.filePreviewArea.innerHTML = '';

        this.selectedFiles.forEach((file, index) => {
            const chip = this.createFileChip(file, index);
            this.filePreviewArea.appendChild(chip);
        });
    }

    createFileChip(file, index) {
        const chip = document.createElement('div');
        chip.className = 'file-chip';
        chip.dataset.index = index;

        // Create thumbnail for images
        if (file.type && file.type.startsWith('image/') && !file.isPreUploaded) {
            const img = document.createElement('img');
            img.src = URL.createObjectURL(file);
            chip.appendChild(img);
        } else {
            // File icon for non-images
            const icon = document.createElement('div');
            icon.textContent = this.getFileIcon(file.type || '');
            icon.style.cssText = 'font-size: 24px; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center;';
            chip.appendChild(icon);
        }

        // File name
        const name = document.createElement('div');
        name.className = 'file-chip-name';
        name.textContent = file.name;
        chip.appendChild(name);

        // Progress bar (hidden by default)
        const progressWrap = document.createElement('div');
        progressWrap.className = 'file-progress-wrap hidden';
        const progressBar = document.createElement('div');
        progressBar.className = 'file-progress-bar';
        progressWrap.appendChild(progressBar);
        chip.appendChild(progressWrap);

        // Remove button
        const removeBtn = document.createElement('button');
        removeBtn.className = 'file-chip-remove';
        removeBtn.textContent = '\u00d7';
        removeBtn.setAttribute('aria-label', 'Remove file');
        removeBtn.addEventListener('click', () => {
            this.removeFile(index);
        });
        chip.appendChild(removeBtn);

        return chip;
    }

    removeFile(index) {
        this.selectedFiles.splice(index, 1);
        this.updatePreview();
    }

    getFileIcon(mimeType) {
        if (mimeType.startsWith('video/')) return '🎥';
        if (mimeType.startsWith('audio/')) return '🎵';
        if (mimeType.includes('pdf')) return '📄';
        return '📎';
    }

    addPreUploadedFile(fileInfo) {
        // Create a fake file-like object for the chip rendering
        const virtualFile = {
            name: fileInfo.fileName,
            type: fileInfo.fileType,
            size: 0,
            isPreUploaded: true,
            serverResult: fileInfo
        };
        this.selectedFiles.push(virtualFile);
        this.updatePreview();
    }

    // Upload a single file with XHR for progress tracking
    uploadSingleFile(file, index) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const formData = new FormData();
            formData.append('file', file);

            // Find the chip's progress elements
            const chip = this.filePreviewArea.querySelector(`[data-index="${index}"]`);
            const progressWrap = chip ? chip.querySelector('.file-progress-wrap') : null;
            const progressBar = chip ? chip.querySelector('.file-progress-bar') : null;

            // Show progress bar
            if (progressWrap) progressWrap.classList.remove('hidden');

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable && progressBar) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    progressBar.style.width = pct + '%';
                }
            });

            xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    // Mark complete
                    if (progressBar) progressBar.style.width = '100%';
                    if (chip) chip.classList.add('file-chip-done');
                    try {
                        resolve(JSON.parse(xhr.responseText));
                    } catch (e) {
                        resolve({ success: true });
                    }
                } else {
                    reject(new Error(`Upload failed: ${xhr.statusText}`));
                }
            });

            xhr.addEventListener('error', () => {
                if (chip) chip.classList.add('file-chip-error');
                reject(new Error('Upload failed'));
            });

            xhr.open('POST', '/upload');
            xhr.send(formData);
        });
    }

    async uploadFiles() {
        if (this.selectedFiles.length === 0) return [];

        const uploadedFiles = [];

        for (let i = 0; i < this.selectedFiles.length; i++) {
            const file = this.selectedFiles[i];

            // Skip already uploaded files (like voice recordings)
            if (file.isPreUploaded) {
                uploadedFiles.push(file.serverResult);
                continue;
            }

            try {
                const result = await this.uploadSingleFile(file, i);
                uploadedFiles.push(result);
            } catch (error) {
                console.error(`Failed to upload ${file.name}:`, error);
                alert(`Failed to upload ${file.name}`);
            }
        }

        return uploadedFiles;
    }

    clearFiles() {
        this.selectedFiles = [];
        this.updatePreview();
    }
}

// Initialize file upload manager
window.fileUploadManager = new FileUploadManager();
