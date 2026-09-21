# AgentHub Notifier launcher for PowerShell. Local only -- no network access.
# Usage: .\agenthub-notifier.ps1 completed --agent "Claude Code"
$env:PYTHONPATH = "$PSScriptRoot;$env:PYTHONPATH"
& python -X utf8 -m agenthub_notifier @args
exit $LASTEXITCODE
