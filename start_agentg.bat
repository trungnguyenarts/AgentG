@echo off
echo ===========================================
echo   🚀 AgentG Launcher
echo ===========================================
echo.
echo [1/2] Starting Antigravity with Remote Debugging (Port 9000)...
start "" "C:\Users\Admin\AppData\Local\Programs\Antigravity\Antigravity.exe" "d:\MY_obsidian\TRUNGNGUYENARTS\.agent\MYAGENT-workspace.code-workspace" --remote-debugging-port=9000
echo.
echo [2/3] Waiting 5 seconds for Antigravity to initialize...
timeout /t 5 >nul
echo.
echo [3/3] Starting AgentG Server...
echo.
npm start
echo.
echo ===========================================
pause
