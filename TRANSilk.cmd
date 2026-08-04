@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo TRANSilk 需要 Node.js 22 或更高版本。
  pause
  exit /b 1
)
if not exist "node_modules\ink\package.json" (
  echo 首次启动，正在安装依赖……
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败。
    pause
    exit /b 1
  )
)
node src\cli.mjs
if errorlevel 1 pause
