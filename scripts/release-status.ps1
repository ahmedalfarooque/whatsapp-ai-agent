<#
.SYNOPSIS
  Read-only status of the three places the code lives: this checkout, GitHub (origin/master) and production. Changes nothing anywhere.
.DESCRIPTION
  Prints one table - local branch/commit, origin/master, the commit production's checkout is on (over ssh, read-only), the build stamp production
  publishes at /dashboard/build-info.json, and whether the dashboard files production SERVES are byte-identical to the ones in origin/master.
  GitHub having a commit is never reported as "production runs it"; only production's own checkout, its published stamp and its served files count.
  Exit code: 0 production runs origin/master (checkout, stamp and served files agree) · 2 production is behind or differs · 1 the status could not be read.
.EXAMPLE
  pwsh scripts/release-status.ps1
  pwsh scripts/release-status.ps1 -NoSsh        # public reads only (no server shell): stamp and served files
#>
[CmdletBinding()]
param(
  [string]$Site = 'https://whatsapp.alfarooque.com',
  [switch]$NoSsh,
  [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\oracle-whatsapp-ai.key'),
  [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
$Server = 'ubuntu@130.110.112.192'
$ServerRepo = '/home/ubuntu/whatsapp-ai-agent'
$Root = (& git -C $PSScriptRoot rev-parse --show-toplevel 2>$null)
if (-not $Root) { Write-Error 'not inside a git repository'; exit 1 }
$Root = (Resolve-Path $Root).Path
if (-not (Test-Path (Join-Path $Root 'scripts\project-sync.cjs'))) { Write-Error 'not the WhatsApp AI Agent project'; exit 1 }
if ((& git -C $Root remote get-url origin) -notmatch 'ahmedalfarooque/whatsapp-ai-agent') { Write-Error 'origin is not the WhatsApp AI Agent repository'; exit 1 }

$problems = New-Object System.Collections.Generic.List[string]
function Short([string]$c) { if ($c -and $c.Length -ge 7) { $c.Substring(0, 7) } else { '(unknown)' } }

# ---- local and GitHub
& git -C $Root fetch --quiet origin 2>$null
$branch = (& git -C $Root branch --show-current)
$head = (& git -C $Root rev-parse HEAD)
$localMaster = (& git -C $Root rev-parse master 2>$null)
$origin = (& git -C $Root rev-parse origin/master 2>$null)
$dirty = [bool](& git -C $Root status --porcelain --untracked-files=no -- . ':!.project-sync')
if (-not $origin) { $problems.Add('cannot read origin/master') }

# ---- production checkout (read-only ssh)
$prodHead = $null
if (-not $NoSsh) {
  if (-not (Test-Path $KeyPath)) { $problems.Add("ssh key not found ($KeyPath); use -NoSsh for public reads only") }
  else {
    try { $prodHead = (& ssh -i $KeyPath -o BatchMode=yes -o ConnectTimeout=15 $Server "git -C $ServerRepo rev-parse HEAD" 2>$null | Select-Object -First 1) } catch { }
    if ($prodHead -notmatch '^[0-9a-f]{40}$') { $problems.Add('could not read the commit of production''s checkout over ssh'); $prodHead = $null }
  }
}

# ---- what production publishes and serves
$stamp = $null
try { $stamp = Invoke-RestMethod -Uri "$Site/dashboard/build-info.json" -TimeoutSec 20 -Headers @{ 'Cache-Control' = 'no-cache' } } catch { }
$health = $null
try { $health = (Invoke-WebRequest -Uri "$Site/health" -UseBasicParsing -TimeoutSec 20).StatusCode } catch { $health = 'unreachable' }
$stampCommit = if ($stamp -and $stamp.fullCommit) { [string]$stamp.fullCommit } elseif ($stamp -and $stamp.commit) { [string]$stamp.commit } else { $null }

$served = @{}
$files = @('index.html', 'ui.css', 'tokens.css', 'shell.js', 'app.js')
$mismatch = New-Object System.Collections.Generic.List[string]
foreach ($f in $files) {
  try {
    $wanted = (& git -C $Root show "origin/master:dashboard/$f" 2>$null) -join "`n"
    $bytes = (Invoke-WebRequest -Uri "$Site/dashboard/$f" -UseBasicParsing -TimeoutSec 30).Content
    $got = if ($bytes -is [byte[]]) { [Text.Encoding]::UTF8.GetString($bytes) } else { [string]$bytes }
    $norm = { param($s) ($s -replace "`r`n", "`n").TrimEnd("`n") }
    $served[$f] = if ((& $norm $got) -eq (& $norm $wanted)) { 'identical' } else { 'DIFFERENT'; $mismatch.Add($f) }
  } catch { $served[$f] = 'unreadable'; $problems.Add("could not read $Site/dashboard/$f") }
}

# ---- report
if (-not $Quiet) {
  "{0,-34} {1}" -f 'Local branch / HEAD', "$branch @ $(Short $head)$(if ($dirty) { ' (uncommitted tracked changes)' })"
  "{0,-34} {1}" -f 'Local master', (Short $localMaster)
  "{0,-34} {1}" -f 'GitHub origin/master', (Short $origin)
  "{0,-34} {1}" -f 'Production checkout HEAD', $(if ($NoSsh) { '(not read: -NoSsh)' } else { Short $prodHead })
  "{0,-34} {1}" -f 'Production build stamp', $(if ($stampCommit) { "$(Short $stampCommit) ($($stamp.environment))" } else { 'none published' })
  "{0,-34} {1}" -f 'Production /health', $health
  foreach ($f in $files) { "{0,-34} {1}" -f "Served dashboard/$f vs origin/master", $served[$f] }
}

$verdict = 'IN SYNC'
$code = 0
if ($problems.Count -gt 0) { $verdict = 'UNKNOWN (status incomplete)'; $code = 1 }
if ($localMaster -and $origin -and $localMaster -ne $origin) { $problems.Add("local master $(Short $localMaster) differs from origin/master $(Short $origin)") }
if (-not $NoSsh -and $prodHead -and $origin -and $prodHead -ne $origin) { $verdict = "PRODUCTION BEHIND: checkout is on $(Short $prodHead), GitHub has $(Short $origin)"; $code = 2 }
elseif ($stampCommit -and $origin -and -not $origin.StartsWith($stampCommit.Substring(0, [Math]::Min(7, $stampCommit.Length)))) { $verdict = "PRODUCTION STAMP DIFFERS: stamp $(Short $stampCommit), GitHub $(Short $origin)"; $code = 2 }
elseif ($mismatch.Count -gt 0) { $verdict = "PRODUCTION SERVES DIFFERENT FILES: $($mismatch -join ', ')"; $code = 2 }
elseif ($code -eq 0 -and -not $stampCommit) { $verdict = 'IN SYNC by checkout and served files; production publishes no build stamp (release predates the stamp)' }
if ($health -ne 200 -and $code -eq 0) { $verdict = "HEALTH CHECK FAILED ($health)"; $code = 1 }
if (-not $Quiet) {
  foreach ($p in $problems) { Write-Warning $p }
  Write-Host "VERDICT: $verdict"
}
exit $code
