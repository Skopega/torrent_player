@echo off
setlocal
title Torrent Player Reset
cd /d "%~dp0"

echo ============================================================
echo  Reset: stop leftover processes from start.bat / build-docker.bat
echo  Will kill: Node.js, headless Chrome, Docker containers,
echo             Docker Desktop and then shut down WSL.
echo ============================================================
echo.
choice /C YN /N /M "Continue? [Y/N] "
if errorlevel 2 exit /b 0
echo.

rem ---- Re-launch elevated so Docker Desktop / WSL can be killed ----
net session >nul 2>&1
if errorlevel 1 (
    echo Requesting administrator rights...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b 0
)

rem [1/6] Headless Chrome / Chromium spawned by the Playwright server
echo [1/6] Killing headless Chrome / Chromium...
powershell -NoProfile -Command "$ids = Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('chrome.exe','msedge.exe','chromium.exe','headless_shell.exe') -and $_.CommandLine -match '--headless' } | Select-Object -ExpandProperty ProcessId; if ($ids) { $ids | ForEach-Object { taskkill /F /T /PID $_ 2>$null | Out-Null }; Write-Host ('  killed ' + @($ids).Count + ' process(es)') } else { Write-Host '  none found' }"

rem [2/6] Node.js (server, npm build, watch, panel backend, etc.)
echo [2/6] Killing Node.js...
taskkill /IM node.exe /F /T >nul 2>&1
echo   done.

rem [3/6] Docker containers (kill + compose down)
echo [3/6] Stopping Docker containers...
for /f "delims=" %%i in ('docker ps -q 2^>nul') do docker kill %%i >nul 2>&1
if exist "%~dp0docker-compose.yml" docker compose down >nul 2>&1
echo   done.

rem [4/6] Docker Desktop processes
echo [4/6] Killing Docker Desktop...
for %%P in ("Docker Desktop.exe" "Docker Desktop Backend.exe" "com.docker.backend.exe" "com.docker.build.exe" "com.docker.service.exe" "vpnkit.exe" "dockerd.exe" "docker-proxy.exe") do taskkill /IM %%P /F /T >nul 2>&1
echo   done.

rem [5/6] Shut down WSL (also stops the docker-desktop VM)
echo [5/6] Shutting down WSL...
wsl --shutdown 2>nul
echo   done.

echo.
echo Reset complete. Use build-docker.bat or start.bat to launch again
echo (build-docker.bat will restart Docker Desktop automatically).
echo.
pause
endlocal
