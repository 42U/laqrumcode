@echo off
REM laqrumcode platform dispatcher (Windows cmd.exe).
REM
REM Invoked by Claude Code's plugin loader via .mcp.json on Windows.
REM Detects arch and execs the matching SEA binary. The whole point is
REM to make the plugin install zero-Node-prereq: the SEA binary contains
REM the Node runtime, so once Claude Code copies the plugin files in,
REM no further user setup is needed.

setlocal

REM PROCESSOR_ARCHITECTURE on x64 hosts is "AMD64"; on arm64 hosts it's "ARM64".
REM Under WOW64 (32-bit cmd on 64-bit host), check PROCESSOR_ARCHITEW6432 too.
set "ARCH="
if /I "%PROCESSOR_ARCHITECTURE%"=="AMD64" set "ARCH=x64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if /I "%PROCESSOR_ARCHITEW6432%"=="AMD64" set "ARCH=x64"
if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH=arm64"

if "%ARCH%"=="" (
  echo laqrumcode: unsupported arch %PROCESSOR_ARCHITECTURE% -- supported: x64, arm64. File at https://github.com/42U/laqrumcode/issues 1>&2
  exit /b 1
)

set "BIN=%~dp0laqrumcode-mcp-win32-%ARCH%.exe"
if exist "%BIN%" (
  REM Preferred: SEA mcp-client binary is present (0.7.0+ release).
  REM Zero-Node-prereq. mcp-client spawns laqrumcode-daemon-win32-%ARCH%.exe
  REM itself if a daemon isn't already running.
  "%BIN%" %*
  exit /b %ERRORLEVEL%
)

REM Fallback: invoke the unbundled JS mcp-client via Node. 0.6.x install
REM with no CI artifacts, or a 0.7.0 install where the binary is missing.
REM Requires Node on PATH.
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  if exist "%~dp0..\dist\mcp-client\index.js" (
    node "%~dp0..\dist\mcp-client\index.js" %*
    exit /b %ERRORLEVEL%
  )
  REM Legacy fallback for 0.6.x installs without the new client compiled.
  node "%~dp0..\dist\mcp-server.js" %*
  exit /b %ERRORLEVEL%
)

echo laqrumcode: no usable runtime found. Tried SEA binary at %BIN% (not present) and 'node' (not on PATH). Install Node.js (https://nodejs.org) and restart Claude Code, or wait for a 0.7.0 release artifact for your platform. 1>&2
exit /b 1
