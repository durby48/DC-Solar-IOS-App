@echo off
rem Starts the Expo web dev server for the Claude Code Browser pane (see .claude/launch.json).
cd /d "%~dp0..\app"
npx expo start --web --port 8082
