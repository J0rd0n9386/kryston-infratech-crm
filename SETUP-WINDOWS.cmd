@echo off
cd /d "%~dp0"
call npm ci --no-audit --no-fund
if errorlevel 1 exit /b 1
call npm run setup
if errorlevel 1 exit /b 1
call npm run migrate
if errorlevel 1 exit /b 1
echo Setup complete. On a fresh database run npm run bootstrap-admin, then npm start.
pause
