@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\better-sqlite3" (
  echo First launch: installing verified dependencies...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo Dependency installation failed. Confirm Node.js 20 or 22 LTS and internet access, then retry.
    pause
    exit /b 1
  )
)

call npm run setup
if errorlevel 1 (
  pause
  exit /b 1
)

call npm start
endlocal
