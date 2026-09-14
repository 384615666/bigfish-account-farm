@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo First run: installing local dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. Please check the network and Node.js.
    pause
    exit /b 1
  )
)
if not exist dist-renderer\index.html (
  echo Preparing interface...
  call npm run build:renderer
  if errorlevel 1 (
    echo [ERROR] Renderer build failed.
    pause
    exit /b 1
  )
)
echo Starting app...
call npm run start
if errorlevel 1 (
  echo [ERROR] App exited abnormally. See messages above.
  pause
)
