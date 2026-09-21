@echo off
rem AgentHub Notifier launcher. Local only -- no network access.
setlocal
set "PYTHONPATH=%~dp0;%PYTHONPATH%"
python -X utf8 -m agenthub_notifier %*
exit /b %ERRORLEVEL%
