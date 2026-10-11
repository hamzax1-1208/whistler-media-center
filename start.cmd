@echo off
title Whistler Media Center (server mode)
cd /d "%~dp0"
node server.js --open %*
