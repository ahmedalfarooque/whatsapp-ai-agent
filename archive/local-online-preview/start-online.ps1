param([switch]$NoOpen, [string]$SyncSession)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
$ownsLock = -not $SyncSession
if ($ownsLock) {
  $SyncSession = 'online-' + [guid]::NewGuid().ToString()
  & node scripts/project-sync.cjs start Codex 'Build and start online preview' $SyncSession
  if ($LASTEXITCODE -ne 0) { throw 'Another writer is active. Wait for its handoff.' }
}
$runState = Join-Path $projectRoot 'data/runtime'
$outcome = 'Online launch did not complete.'
try {
  & node scripts/project-sync.cjs guard $SyncSession
  if ($LASTEXITCODE -ne 0) { throw 'Project writer lock is unavailable.' }
  New-Item -ItemType Directory -Path $runState -Force | Out-Null
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'Build failed; the running server was not changed.' }
  $nodeExe = (Get-Command node).Source
  $port = [int](& $nodeExe -e "console.log(require('./dist/config/env').env.PORT)")
  $serverFile = Join-Path $runState 'server.json'
  if (Test-Path -LiteralPath $serverFile) {
    $previous = Get-Content -LiteralPath $serverFile -Raw | ConvertFrom-Json
    $oldProcess = Get-Process -Id $previous.pid -ErrorAction SilentlyContinue
    if ($oldProcess -and $oldProcess.StartTime.ToUniversalTime().ToString('o') -eq $previous.startedAt) {
      # This PID and creation time were recorded by this launcher. Include its
      # browser children so they cannot retain a lock on the linked session.
      & taskkill.exe /PID $oldProcess.Id /T /F | Out-Null
      $oldProcess.WaitForExit(10000) | Out-Null
    }
  }
  if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
    throw "Port $port is used by a process this launcher does not own. Stop that server before retrying."
  }
  $server = Start-Process -FilePath $nodeExe -ArgumentList ('"' + (Join-Path $projectRoot 'dist/index.js') + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runState 'server.log') -RedirectStandardError (Join-Path $runState 'server-error.log') -PassThru
  @{pid=$server.Id; startedAt=$server.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $serverFile
  $healthy = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try { $healthy = (Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2).status -eq 'ok' } catch {}
    if ($healthy) { break }
    Start-Sleep -Seconds 1
  }
  if (-not $healthy) { throw 'Server did not become healthy. Check data/runtime/server-error.log.' }
  $tunnelExe = Join-Path $runState 'cloudflared.exe'
  if (-not (Test-Path -LiteralPath $tunnelExe)) {
    # Fetch the official release and check its published digest before execution.
    $release = Invoke-RestMethod 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest'
    $asset = $release.assets | Where-Object name -EQ 'cloudflared-windows-amd64.exe' | Select-Object -First 1
    if (-not $asset -or $asset.digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Official release checksum unavailable.' }
    $downloadPath = $tunnelExe + '.download'
    Invoke-WebRequest $asset.browser_download_url -OutFile $downloadPath
    if ((Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.digest.Substring(7)) {
      Remove-Item -LiteralPath $downloadPath
      throw 'Cloudflared checksum mismatch.'
    }
    Move-Item -LiteralPath $downloadPath -Destination $tunnelExe
  }
  $tunnelFile = Join-Path $runState 'tunnel.json'
  $tunnelUrl = $null
  if (Test-Path -LiteralPath $tunnelFile) {
    $previousTunnel = Get-Content -LiteralPath $tunnelFile -Raw | ConvertFrom-Json
    $runningTunnel = Get-Process -Id $previousTunnel.pid -ErrorAction SilentlyContinue
    if ($runningTunnel -and $runningTunnel.StartTime.ToUniversalTime().ToString('o') -eq $previousTunnel.startedAt) { $tunnelUrl = $previousTunnel.url }
  }
  if (-not $tunnelUrl) {
    $tunnelLog = Join-Path $runState 'tunnel-error.log'
    $tunnel = Start-Process -FilePath $tunnelExe -ArgumentList @('tunnel','--url',"http://127.0.0.1:$port",'--no-autoupdate') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runState 'tunnel.log') -RedirectStandardError $tunnelLog -PassThru
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
      if (Test-Path -LiteralPath $tunnelLog) {
        $logText = Get-Content -LiteralPath $tunnelLog -Raw
        if ($logText) {
          $match = [regex]::Match($logText, 'https://[a-z0-9-]+\.trycloudflare\.com')
          if ($match.Success) { $tunnelUrl = $match.Value; break }
        }
      }
      Start-Sleep -Seconds 1
    }
    if (-not $tunnelUrl) { throw 'Public tunnel unavailable. Local dashboard is running.' }
    @{pid=$tunnel.Id; startedAt=$tunnel.StartTime.ToUniversalTime().ToString('o'); url=$tunnelUrl} | ConvertTo-Json | Set-Content -LiteralPath $tunnelFile
  }
  $online = $false
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    try { $online = (Invoke-RestMethod "$tunnelUrl/health" -TimeoutSec 5).status -eq 'ok' } catch {}
    if ($online) { break }
    Start-Sleep -Seconds 2
  }
  if (-not $online) {
    # Some networks cannot resolve new trycloudflare hostnames. Use an alternate
    # preview provider without changing the computer's DNS configuration.
    $fallback = Start-Process -FilePath $nodeExe -ArgumentList @(('"' + (Join-Path $projectRoot 'scripts/preview-tunnel.cjs') + '"'), "$port") -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runState 'alternate-tunnel.log') -RedirectStandardError (Join-Path $runState 'alternate-tunnel-error.log') -PassThru
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
      $fallbackText = Get-Content -LiteralPath (Join-Path $runState 'alternate-tunnel.log') -Raw -ErrorAction SilentlyContinue
      if ($fallbackText -and $fallbackText -match 'https://[a-z0-9-]+\.loca\.lt') { $fallbackUrl = $Matches[0]; break }
      Start-Sleep -Seconds 1
    }
    if (-not $fallbackUrl) { Stop-Process -Id $fallback.Id -ErrorAction SilentlyContinue; throw 'Both preview tunnels are unavailable. The local dashboard is running.' }
    $online = (Invoke-RestMethod "$fallbackUrl/health" -TimeoutSec 15).status -eq 'ok'
    if (-not $online) { throw 'Alternate tunnel health check failed.' }
    $oldTunnelState = Get-Content -LiteralPath $tunnelFile -Raw | ConvertFrom-Json
    $oldTunnelProcess = Get-Process -Id $oldTunnelState.pid -ErrorAction SilentlyContinue
    if ($oldTunnelProcess -and $oldTunnelProcess.StartTime.ToUniversalTime().ToString('o') -eq $oldTunnelState.startedAt) { Stop-Process -Id $oldTunnelProcess.Id }
    $tunnelUrl = $fallbackUrl
    @{pid=$fallback.Id; startedAt=$fallback.StartTime.ToUniversalTime().ToString('o'); url=$tunnelUrl} | ConvertTo-Json | Set-Content -LiteralPath $tunnelFile
  }
  $dashboardUrl = "$tunnelUrl/dashboard#/integrations"
  Set-Content -LiteralPath (Join-Path $runState 'online-url.txt') -Value $dashboardUrl
  $outcome = 'Built application, started background server, and verified HTTPS preview health. Phone scan and message round trip remain user actions.'
  Write-Host "Dashboard: $dashboardUrl"
  Write-Host 'This temporary link requires this PC to remain awake. Sign in, then click Connect with QR.'
  if ($tunnelUrl -like '*.loca.lt') { Write-Host 'If the tunnel shows a welcome page, enter the host IP displayed on that page and click Continue.' }
  if (-not $NoOpen) { Start-Process $dashboardUrl }
} catch {
  if ($tunnel -and -not $tunnelUrl) { Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue }
  throw
} finally {
  if ($ownsLock) {
    @{summary=$outcome; reason='User launched the one-click online preview.'; tests='Build and local/public health checks run by the launcher; inspect terminal for completion.'; nextSteps='Scan the WhatsApp code. For permanent hosting, use an always-on server and fixed HTTPS domain.'} | ConvertTo-Json | Set-Content -LiteralPath '.project-sync/report.json'
    & node scripts/project-sync.cjs finish $SyncSession .project-sync/report.json
  }
}
