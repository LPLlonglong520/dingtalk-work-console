@echo off
chcp 65001 >nul
title 钉钉办公交互中心-本地桥
echo 正在启动本地桥服务（保持本窗口开启）...
python "%~dp0local-bridge.py"
pause
