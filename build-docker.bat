@echo off
setlocal

echo Searching for Docker Desktop...
set "DOCKER_EXE="
if exist "C:\Program Files\Docker\Docker\Docker Desktop.exe" set "DOCKER_EXE=C:\Program Files\Docker\Docker\Docker Desktop.exe"
if exist "D:\Docker\Docker Desktop.exe" set "DOCKER_EXE=D:\Docker\Docker Desktop.exe"

if not defined DOCKER_EXE (
    echo ERROR: Docker Desktop not found on C: or D:.
    echo Install Docker Desktop or add its path.
    exit /b 1
)

echo Starting %DOCKER_EXE%...
start "" "%DOCKER_EXE%"
echo Waiting for Docker daemon...
docker info >nul 2>&1
if errorlevel 1 (
    timeout /t 5 /nobreak >nul
)
:wait_docker
docker info >nul 2>&1
if errorlevel 1 (
    timeout /t 3 /nobreak >nul
    goto wait_docker
)
echo Docker is ready.

cd /d "%~dp0"
if errorlevel 1 (
    echo Failed to change directory.
    exit /b 1
)

echo Running npm run build...
call npm run build
if errorlevel 1 (
    echo npm build failed.
    exit /b 1
)

echo Building Docker image...
docker build -t torrent-player .
if errorlevel 1 (
    echo Docker build failed.
    exit /b 1
)

echo Saving image to torrent-player.tar...
docker save -o torrent-player.tar torrent-player
if errorlevel 1 (
    echo Docker save failed.
    exit /b 1
)

echo Done.
echo.
echo Put the tar on the server and execute:
echo   sudo docker load ^< /path/to/your/server/torrent-player.tar
echo (replace /path/to/your/server/ with the actual folder where you put the tar)
echo.
echo Press any key to close...
pause >nul
endlocal
