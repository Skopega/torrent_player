@echo off
setlocal
title Torrent Player
cd /d "%~dp0"

rem Use bundled Node from the app folder (no system install).
set "PATH=%~dp0runtime\node;%PATH%"

rem Production mode: JSON errors, no stack traces over HTTP.
set "NODE_ENV=production"

rem Point Playwright at the self-contained Chromium only if it was downloaded.
if exist "%~dp0runtime\playwright-browsers\chromium-1234" set "PLAYWRIGHT_BROWSERS_PATH=%~dp0runtime\playwright-browsers"

if not exist "runtime\node\node.exe" (
    echo [ERROR] Node.js not found in runtime\node. Run setup.bat first.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

rem ---- Close existing server instance if already running ----
echo Checking for existing server instance...
rem If a healthy server is already up (e.g. managed by the tray panel) we do NOT kill it,
rem otherwise the panel and start.bat would fight over the port / data dirs.
powershell -NoProfile -Command "$h = try { (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 2).StatusCode } catch { 0 }; if ($h -eq 200) { Write-Host 'Server already healthy on :3000 - skip.'; exit 7 }"
if %errorlevel% EQU 7 (
    echo.
    echo Server already running, likely managed by the tray panel. Open http://localhost:3000
    pause
    exit /b 0
)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dist[\\/]index\.js|src[\\/]index\.ts' } | ForEach-Object { Write-Host ('Closing server PID ' + $_.ProcessId); taskkill /F /T /PID $_.ProcessId > $null 2>&1 }"
timeout /t 2 /nobreak >nul

echo Building...
call npm run build
if errorlevel 1 (
    echo [ERROR] build failed.
    pause
    exit /b 1
)

rem ---- Allow inbound TCP 3000 so phones on LAN can reach the server ----
netsh advfirewall firewall show rule name="Torrent Player" >nul 2>&1
if errorlevel 1 (
    netsh advfirewall firewall add rule name="Torrent Player" dir=in action=allow protocol=TCP localport=3000 >nul 2>&1
    if errorlevel 1 (
        echo [WARN] Firewall rule for port 3000 could not be added ^(needs admin^).
        echo        Phones on LAN will not connect unless port 3000 is allowed.
    )
)

echo Starting server at http://localhost:3000 ...
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3000'"

call npm start

pause
endlocal