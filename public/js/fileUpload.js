// File Upload Manager
// Handles file selection, preview, and uploading

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

        // Create thumbnail for images
        if (file.type.startsWith('image/')) {
            const img = document.createElement('img');
            img.src = URL.createObjectURL(file);
            chip.appendChild(img);
        } else {
            // File icon for non-images
            const icon = document.createElement('div');
            icon.textContent = this.getFileIcon(file.type);
            icon.style.cssText = 'font-size: 24px; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center;';
            chip.appendChild(icon);
        }

        // File name
        const name = document.createElement('div');
        name.className = 'file-chip-name';
        name.textContent = file.name;
        chip.appendChild(name);

        // Remove button
        const removeBtn = document.createElement('button');
        removeBtn.className = 'file-chip-remove';
        removeBtn.textContent = '×';
        removeBtn.setAttribute('aria-label', 'Remove file');
        removeBtn.addEventListener('click', () => {
            this.removeFile(index);
        });
        chip.appendChild(removeBtn);

        return chip;
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

    async uploadFiles() {
        if (this.selectedFiles.length === 0) return [];

        const uploadedFiles = [];

        for (const file of this.selectedFiles) {
            // Skip already uploaded files (like voice recordings)
            if (file.isPreUploaded) {
                uploadedFiles.push(file.serverResult);
                continue;
            }

            try {
                const formData = new FormData();
                formData.append('file', file);
                // ... continues

                const response = await fetch('/upload', {
                    method: 'POST',
                    body: formData
                });

                if (!response.ok) {
                    throw new Error(`Upload failed: ${response.statusText}`);
                }

                const result = await response.json();
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
