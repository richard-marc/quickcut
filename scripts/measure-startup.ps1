param([int]$Runs = 5)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskExe = Join-Path $taskRoot 'src-tauri\target\release\quickcut.exe'
if (!(Test-Path -LiteralPath $taskExe)) { throw 'Build the release executable first: npm run desktop:build -- --no-bundle' }
$taskLog = Join-Path ([System.IO.Path]::GetTempPath()) ('quickcut-startup-' + [guid]::NewGuid() + '.jsonl')
$taskPreviousLog = $env:QUICKCUT_PERF_LOG
$env:QUICKCUT_PERF_LOG = $taskLog
try {
    $taskResults = @()
    for ($taskRun = 0; $taskRun -lt $Runs; $taskRun++) {
        $taskWatch = [System.Diagnostics.Stopwatch]::StartNew()
        $taskStart = New-Object System.Diagnostics.ProcessStartInfo
        $taskStart.FileName = $taskExe
        $taskStart.UseShellExecute = $false
        $taskProcess = [System.Diagnostics.Process]::Start($taskStart)
        $taskWindowMs = $null
        try {
            while ($taskWatch.ElapsedMilliseconds -lt 10000) {
                $taskProcess.Refresh()
                if ($null -eq $taskWindowMs -and $taskProcess.MainWindowHandle -ne 0) { $taskWindowMs = $taskWatch.Elapsed.TotalMilliseconds }
                if (Test-Path -LiteralPath $taskLog) {
                    $taskLines = @(Get-Content -LiteralPath $taskLog)
                    if ($taskLines.Count -gt $taskRun) {
                        $taskMeasurement = $taskLines[$taskRun] | ConvertFrom-Json
                        $taskResults += [pscustomobject]@{ Run = $taskRun + 1; WindowMs = [math]::Round($taskWindowMs, 1); ShellMs = $taskMeasurement.nativeShellMs; FrontendMs = $taskMeasurement.frontendMs }
                        break
                    }
                }
                Start-Sleep -Milliseconds 5
            }
        } finally {
            if (!$taskProcess.HasExited) { $null = $taskProcess.CloseMainWindow(); if (!$taskProcess.WaitForExit(2000)) { $taskProcess.Kill() } }
            $taskProcess.Dispose()
        }
    }
    $taskResults | Format-Table
    Write-Output "Samples use the existing OS and WebView2 caches. This is not a controlled cold-start benchmark."
    Write-Output "Timing log: $taskLog"
} finally { $env:QUICKCUT_PERF_LOG = $taskPreviousLog }
