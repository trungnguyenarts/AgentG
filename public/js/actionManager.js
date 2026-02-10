// Action Manager - Handles Accept/Reject functionality + All Popups
// Polls for pending actions, confirmations, and permissions

class ActionManager {
    constructor() {
        // Command Approval (existing)
        this.actionBar = document.getElementById('actionBar');
        this.actionText = document.getElementById('actionText');
        this.acceptBtn = document.getElementById('acceptBtn');
        this.rejectBtn = document.getElementById('rejectBtn');

        // Step Confirmation (new)
        this.confirmationPopup = document.getElementById('confirmationPopup');
        this.confirmMessage = document.getElementById('confirmMessage');
        this.confirmBtn = document.getElementById('confirmBtn');
        this.denyBtn = document.getElementById('denyBtn');

        // Browser Permission Warning (new)
        this.permissionWarning = document.getElementById('permissionWarning');
        this.permissionMessage = document.getElementById('permissionMessage');
        this.dismissBtn = document.getElementById('dismissBtn');

        this.pollInterval = 2000; // Check every 2 seconds
        this.isPolling = false;

        this.init();
    }

    init() {
        // Command Approval buttons
        this.acceptBtn.addEventListener('click', () => {
            this.handleAction('accept');
        });

        this.rejectBtn.addEventListener('click', () => {
            this.handleAction('reject');
        });

        // Step Confirmation buttons
        if (this.confirmBtn) {
            this.confirmBtn.addEventListener('click', () => {
                this.handleConfirmation('confirm');
            });
        }

        if (this.denyBtn) {
            this.denyBtn.addEventListener('click', () => {
                this.handleConfirmation('deny');
            });
        }

        // Browser Permission dismiss
        if (this.dismissBtn) {
            this.dismissBtn.addEventListener('click', () => {
                this.hidePermissionWarning();
            });
        }

        // Start polling for all popup types
        this.startPolling();
    }

    startPolling() {
        if (this.isPolling) return;
        this.isPolling = true;

        this.pollForActions();
        this.pollTimer = setInterval(() => {
            this.pollForActions();
        }, this.pollInterval);
    }

    stopPolling() {
        this.isPolling = false;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    async pollForActions() {
        try {
            const response = await fetch('/check-popups');
            if (!response.ok) return;

            const data = await response.json();

            // Priority: Command Approval > Step Confirmation > Browser Permission
            if (data.commandApproval?.hasPendingAction) {
                this.showActionBar(data.commandApproval);
                this.hideStepConfirmation();
                this.hidePermissionWarning();
            } else if (data.stepConfirmation?.hasConfirmation) {
                this.hideActionBar();
                this.showStepConfirmation(data.stepConfirmation);
                this.hidePermissionWarning();
            } else if (data.browserPermission?.hasPermissionDialog) {
                // Check if permission warning is snoozed
                if (this.permissionSnoozedUntil && Date.now() < this.permissionSnoozedUntil) {
                    // Still snoozed, don't show
                    this.hideActionBar();
                    this.hideStepConfirmation();
                } else {
                    this.hideActionBar();
                    this.hideStepConfirmation();
                    this.showBrowserPermission(data.browserPermission);
                }
            } else {
                this.hideActionBar();
                this.hideStepConfirmation();
                this.hidePermissionWarning();
            }
        } catch (error) {
            console.error('Error polling for popups:', error);
        }
    }

    showActionBar(data) {
        // Update text
        let displayText = data.prompt || 'Action requires approval';
        if (data.commandPreview) {
            displayText = `${displayText}: ${data.commandPreview}`;
        }
        this.actionText.textContent = displayText;

        // Show bar
        this.actionBar.classList.remove('hidden');
    }

    hideActionBar() {
        this.actionBar.classList.add('hidden');
    }

    async handleAction(action) {
        // Disable buttons
        this.acceptBtn.disabled = true;
        this.rejectBtn.disabled = true;

        const originalAcceptText = this.acceptBtn.textContent;
        const originalRejectText = this.rejectBtn.textContent;

        if (action === 'accept') {
            this.acceptBtn.textContent = 'Accepting...';
        } else {
            this.rejectBtn.textContent = 'Rejecting...';
        }

        try {
            const response = await fetch(`/${action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            const result = await response.json();

            if (result.ok) {
                console.log(`${action} successful:`, result);
                this.hideActionBar();

                // Refresh snapshot after action
                setTimeout(() => {
                    if (window.snapshotManager) {
                        window.snapshotManager.loadSnapshot();
                    }
                }, 500);
            } else {
                console.error(`${action} failed:`, result);
                alert(`Failed to ${action}: ${result.reason || 'Unknown error'}`);
            }
        } catch (error) {
            console.error(`Error during ${action}:`, error);
            alert(`Failed to ${action}: ${error.message}`);
        } finally {
            // Re-enable buttons
            this.acceptBtn.disabled = false;
            this.rejectBtn.disabled = false;
            this.acceptBtn.textContent = originalAcceptText;
            this.rejectBtn.textContent = originalRejectText;
        }
    }

    // Step Confirmation handlers
    showStepConfirmation(data) {
        if (!this.confirmationPopup) return;

        if (this.confirmMessage) {
            this.confirmMessage.textContent = data.message || 'Confirmation required';
        }

        this.confirmationPopup.classList.add('show');
    }

    hideStepConfirmation() {
        if (this.confirmationPopup) {
            this.confirmationPopup.classList.remove('show');
        }
    }

    async handleConfirmation(action) {
        const isConfirm = action === 'confirm';
        const btn = isConfirm ? this.confirmBtn : this.denyBtn;
        const originalText = btn.textContent;

        btn.disabled = true;
        btn.textContent = isConfirm ? 'Confirming...' : 'Denying...';

        try {
            const response = await fetch('/click-confirmation', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action })
            });

            const result = await response.json();

            if (result.ok) {
                console.log(`Confirmation ${action} successful:`, result);
                this.hideStepConfirmation();

                // Refresh snapshot
                setTimeout(() => {
                    if (window.snapshotManager) {
                        window.snapshotManager.loadSnapshot();
                    }
                }, 500);
            } else {
                console.error(`Confirmation ${action} failed:`, result);
                alert(`Failed to ${action}: ${result.reason || 'Unknown error'}`);
            }
        } catch (error) {
            console.error(`Error during confirmation ${action}:`, error);
            alert(`Failed to ${action}: ${error.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }

    // Browser Permission handlers
    showBrowserPermission(data) {
        if (!this.permissionWarning) return;

        if (this.permissionMessage) {
            this.permissionMessage.textContent = data.message || 'Browser permission required on desktop';
        }

        this.permissionWarning.classList.add('show');
    }

    hidePermissionWarning() {
        if (this.permissionWarning) {
            this.permissionWarning.classList.remove('show');
            // Snooze for 60 seconds to prevent spam
            this.permissionSnoozedUntil = Date.now() + 60000;
        }
    }
}

// Initialize action manager
window.actionManager = new ActionManager();
