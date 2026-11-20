@echo off
rem Portable version: double-click to start AI Ali. Keep the window open while you use it.
title AI Ali
"%~dp0runtime\node.exe" "%~dp0app\src\desktop.js"
if errorlevel 1 pause
