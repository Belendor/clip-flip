@echo off
title ClipFlip Local Dev Server
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File ".\scripts\dev.ps1"
pause
