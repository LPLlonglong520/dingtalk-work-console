@echo off
chcp 65001 >nul
title DWS 独立登录（仅首次需要）
echo ================================================
echo  为本地桥完成一次独立登录（仅首次需要）
echo  将自动打开浏览器，请用钉钉扫码授权
echo ============================================
set QWORK_SHIM_ROUTE=dws
"%USERPROFILE%\.qwenworkcn\bin\ext\dws-core-windows-amd64.exe" auth login
echo.
echo 如果上方显示登录成功，即可关闭本窗口，然后运行「启动本地桥.bat」
pause
