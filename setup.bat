@echo off
setlocal
title Torrent Player Setup
cd /d "%~dp0"

set "NODE_VER=22.23.2"

rem ---- Node.js (portable) ----
if not exist "runtime\node\node.exe" (
    echo [1/5] Downloading Node.js %NODE_VER% portable...
    rem runtime\ may be missing in a fresh clone (gitignored) - create it first.
    if not exist "runtime" mkdir "runtime"
    powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v%NODE_VER%/node-v%NODE_VER%-win-x64.zip' -OutFile 'runtime\node.zip'"
    if errorlevel 1 ( echo [ERROR] Node download failed. & pause & exit /b 1 )
    powershell -NoProfile -Command "Expand-Archive 'runtime\node.zip' 'runtime' -Force; Rename-Item 'runtime\node-v%NODE_VER%-win-x64' 'node' -Force"
    del /q "runtime\node.zip" >nul 2>nul
) else ( echo [1/5] Node.js present. )
set "PATH=%~dp0runtime\node;%PATH%"

rem ---- npm dependencies ----
if not exist "node_modules\" (
    echo [2/5] Installing npm dependencies...
    call npm install
    if errorlevel 1 ( echo [ERROR] npm install failed. & pause & exit /b 1 )
) else ( echo [2/5] npm dependencies present. )

rem ---- Chrome: use the system Google Chrome (needed for Cloudflare). ----
rem ---- For server/Docker it is installed separately (google-chrome-stable). ----

rem ---- xray-core (for vless subscription) ----
if not exist "runtime\xray\xray.exe" (
    echo [3/5] Downloading xray-core...
    call node scripts\fetch-xray.cjs
    if errorlevel 1 ( echo [WARN] xray download failed. Proxy feature will not work. )
) else ( echo [3/5] xray present. )

rem ---- ffmpeg with QSV (for hardware transcode on Intel iGPU) ----
if not exist "runtime\ffmpeg\ffmpeg.exe" (
    echo [4/5] Downloading ffmpeg with QSV (~160 MB)...
    call node scripts\fetch-ffmpeg.cjs
    if errorlevel 1 ( echo [WARN] ffmpeg download failed. Transcode will fall back to libx264 ^(CPU^). )
) else ( echo [4/5] ffmpeg (QSV) present. )

echo [5/5] Building...
call npm run build

echo.
echo Setup complete. Run start.bat to launch.
pause
endlocal