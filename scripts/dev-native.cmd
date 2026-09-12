@echo off
rem Starts the Expo dev server (Expo Go / dev client) for the Claude Code Browser pane (see .claude/launch.json).
cd /d "%~dp0..\app"
npx expo start --port 8081
