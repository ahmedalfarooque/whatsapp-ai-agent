<#
.SYNOPSIS
  The ONE local entry point: opens the local window on production's data — http://workspace.localhost:3100/dashboard — starting scripts/dev-proxy.cjs only when needed.
.DESCRIPTION
  What it does, in order, and it stops with a clear message the moment anything is not as expected:
    1. resolves the repository from its own location (never from the current directory) and checks it is this project;
    2. looks at port 3100: if a process listens there it identifies it by PID and command line — a dev-proxy.cjs started from THIS repository is reused
       (never duplicated); a dev-proxy.cjs from another checkout is reported and, with -Replace, stopped; anything else is reported and never touched;
    3. starts the proxy when nothing suitable is running (hidden window, log in data/runtime/local-window.log);
    4. proves it answers (/dashboard/build-info.json says environment local-ui, data source production, this checkout's commit; production /health is 200);
    5. prints the commit, environment mode, data source, the fact that NO local database or WhatsApp session is involved, and opens the URL.
  It also reports, without touching it, what listens on port 3000 (the ISOLATED local backend, `npm run dev`, own data/app.db) so the two can never be confused.
  Nothing here reads or prints secrets. Port 3005 is never inspected or used.
.EXAMPLE
  pwsh scripts/local-window.ps1              # read-only window on production's data (the normal case)
  pwsh scripts/local-window.ps1 -Write       # the proxy allows the approved business-content writes (--write-business-data)
  pwsh scripts/local-window.ps1 -NoOpen      # do not open the browser
  pwsh scripts/local-window.ps1 -Stop        # stop the proxy this repository started (only a positively identified one)
#>
[CmdletBinding()]
param(
  [switch]$Write,
  [switch]$NoOpen,
  [switch]$Replace,
  [switch]$Stop,
  [int]$Port = 3100
)
$ErrorActionPreference = 'Stop'
$Root = (& git -C $PSScriptRoot rev-parse --show-toplevel 2>$null)
if (-not $Root) { Write-Error 'ABORT[repo]: not inside a git repository'; exit 1 }
$Root = (Resolve-Path $Root).Path
if (-not (Test-Path (Join-Path $Root 'scripts\dev-proxy.cjs')) -or -not (Test-Path (Join-Path $Root 'scripts\project-sync.cjs'))) { Write-Error 'ABORT[repo]: not the WhatsApp AI Agent project'; exit 1 }
if ((& git -C $Root remote get-url origin) -notmatch 'ahmedalfarooque/whatsapp-ai-agent') { Write-Error 'ABORT[repo]: origin is not the WhatsApp AI Agent repository'; exit 1 }
if ($Port -eq 3005 -or $Port -eq 3000) { Write-Error "ABORT[port]: port $Port is reserved (3000 = the backend, 3005 = another project)"; exit 1 }
$Url = "http://workspace.localhost:$Port/dashboard"
$Mode = if ($Write) { 'business-data' } else { 'read-only' }

function Listener([int]$p) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $null }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
  [pscustomobject]@{ Pid = $c.OwningProcess; Address = $c.LocalAddress; Command = [string]$proc.CommandLine; Exe = [string]$proc.ExecutablePath; Started = $proc.CreationDate }
}
# A dev-proxy of THIS repository: node + dev-proxy.cjs, and either a relative script path (started from this root) or an absolute path under this root.
function IsOurProxy($l) {
  if (-not $l -or $l.Command -notmatch 'dev-proxy\.cjs') { return $false }
  if ($l.Command -match [regex]::Escape($Root)) { return $true }
  # relative invocation: the process's working directory is not readable here, so confirm through the proxy's own stamp (its commit must be this checkout's)
  try {
    $stamp = Stamp
    return ($stamp.environment -eq 'local-ui') -and ($stamp.fullCommit -eq (& git -C $Root rev-parse HEAD))
  } catch { return $false }
}
# .NET does not resolve *.localhost names the way browsers do, so the proxy is reached by address with the Host header it requires.
function Stamp { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/dashboard/build-info.json" -Headers @{ Host = "workspace.localhost:$Port" } -TimeoutSec 10 }

$backend = Listener 3000
if ($backend) {
  $kind = if ($backend.Command -match 'tsx|dist[\\/]index\.js|src[\\/]index\.ts') { 'the ISOLATED local backend (own local database, local sessions; not production data)' } else { 'something that is not this project''s backend' }
  Write-Host "note: port 3000 is used by pid $($backend.Pid) — $kind. It is left alone. http://localhost:3000 is NOT the production-data window."
} else {
  Write-Host 'note: nothing listens on port 3000 (the isolated local backend is not running; it is a separate mode: npm run dev).'
}

$existing = Listener $Port
if ($Stop) {
  if (-not $existing) { Write-Host "nothing listens on port $Port"; exit 0 }
  if (-not (IsOurProxy $existing)) { Write-Error "ABORT[stop]: pid $($existing.Pid) on port $Port is not a dev-proxy of this repository (command: $($existing.Command)); not stopped"; exit 1 }
  Stop-Process -Id $existing.Pid -Force
  Write-Host "stopped the local window proxy (pid $($existing.Pid))"
  exit 0
}

$reuse = $false
if ($existing) {
  if (IsOurProxy $existing) {
    $reuse = $true
    Write-Host "reusing the running local window proxy: pid $($existing.Pid), started $($existing.Started)"
  } elseif ($existing.Command -match 'dev-proxy\.cjs') {
    Write-Host "port $Port is used by a dev-proxy that is NOT from this checkout: pid $($existing.Pid), command: $($existing.Command)"
    if (-not $Replace) { Write-Error "ABORT[port]: a stale proxy from another checkout holds port $Port. Re-run with -Replace to stop it, or stop it yourself."; exit 1 }
    Stop-Process -Id $existing.Pid -Force; Start-Sleep -Seconds 1
    Write-Host "stopped the stale proxy pid $($existing.Pid)"
  } else {
    Write-Error "ABORT[port]: port $Port is used by pid $($existing.Pid) (exe: $($existing.Exe); command: $($existing.Command)), which is not this project's proxy. Not touched; free the port or use -Port."
    exit 1
  }
}
if ($reuse -and $Write) { Write-Host 'note: the running proxy keeps its own mode; -Write applies only to a proxy started by this call (use -Stop first to change the mode).' }

if (-not $reuse) {
  $runtime = Join-Path $Root 'data\runtime'; New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  # Detached through cmd's `start /b` with its own log redirection: a child started with PowerShell's -RedirectStandardOutput keeps the
  # launcher's console handles and makes the calling shell wait for the proxy to exit.
  $log = Join-Path $runtime 'local-window.log'
  $cmdLine = "start /b `"`" `"$((Get-Command node).Source)`" scripts/dev-proxy.cjs --port $Port$(if ($Write) { ' --write-business-data' }) > `"$log`" 2>&1"
  Start-Process -FilePath $env:ComSpec -ArgumentList '/d', '/c', $cmdLine -WorkingDirectory $Root -WindowStyle Hidden
  $ready = $false
  for ($i = 0; $i -lt 30 -and -not $ready; $i++) { Start-Sleep -Milliseconds 500; $ready = [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) }
  if (-not $ready) { Write-Error "ABORT[start]: the proxy did not start listening on port $Port (see data\runtime\local-window.log)"; exit 1 }
  $started = Listener $Port
  Write-Host "started the local window proxy: pid $($started.Pid), mode $Mode (log: data\runtime\local-window.log)"
}

# ---- proof: the window answers, says what it is, and production is reachable
try { $stamp = Stamp } catch { Write-Error "ABORT[verify]: $Url/build-info.json is not answering ($($_.Exception.Message))"; exit 1 }
$head = (& git -C $Root rev-parse HEAD)
if ($stamp.environment -ne 'local-ui' -or $stamp.dataSource -ne 'production') { Write-Error "ABORT[verify]: the window reports environment '$($stamp.environment)' / data '$($stamp.dataSource)', not the local window on production data"; exit 1 }
if ($stamp.fullCommit -ne $head) { Write-Error "ABORT[verify]: the running proxy serves commit $($stamp.commit) but this checkout is at $($head.Substring(0,7)); run with -Stop then again to restart it on the current code"; exit 1 }
try { $health = (Invoke-WebRequest -Uri 'https://whatsapp.alfarooque.com/health' -UseBasicParsing -TimeoutSec 15).StatusCode } catch { $health = 'unreachable' }
if ($health -ne 200) { Write-Error "ABORT[verify]: production /health is $health; the window would show errors, not data"; exit 1 }

Write-Host ''
Write-Host "LOCAL WINDOW READY: $Url"
Write-Host "  UI:            this checkout, commit $($stamp.commit) ($($stamp.branch))$(if ($stamp.uncommittedChanges) { ' + uncommitted changes' })"
Write-Host "  data source:   PRODUCTION (live) — https://whatsapp.alfarooque.com, through its own login and permissions; mode $($stamp.mode)"
Write-Host '  local storage: none — no local database, no WhatsApp session, nothing copied (the isolated backend on port 3000 is a different mode)'
Write-Host '  sign in with your normal production account; the footer shows "Build <commit> · Local window" and the live-sync status'
if (-not $NoOpen) { Start-Process $Url }
exit 0
