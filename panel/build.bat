@echo off
setlocal
cd /d "%~dp0"

set "CSC="
for %%F in (
  "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
  "%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) do if exist "%%~F" set "CSC=%%~F"

if not defined CSC (
    echo [ERROR] csc.exe not found ^(.NET Framework 4.x missing^).
    pause
    exit /b 1
)

echo Compiling panel.exe with %CSC%...
"%CSC%" /nologo /target:winexe /optimize+ /out:"%~dp0panel.exe" ^
    /r:System.dll /r:System.Core.dll /r:System.Drawing.dll ^
    /r:System.Windows.Forms.dll /r:System.Net.Http.dll ^
    /r:System.Runtime.Serialization.dll /r:System.Xml.dll ^
    "%~dp0TorrentPlayerPanel.cs"

if errorlevel 1 (
    echo [ERROR] Compilation failed.
    pause
    exit /b 1
)

echo.
echo Done: %~dp0panel.exe
pause
endlocal
