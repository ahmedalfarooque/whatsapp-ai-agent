<#
.SYNOPSIS
  Runs the FULL production release (scripts/release-full.sh) from the Windows checkout, with the arguments the script needs filled in and verified.
.DESCRIPTION
  release-full.sh runs ON the Oracle server and needs two commit hashes: --base = the commit production is live on NOW, --target = the commit of
  origin/master to fast-forward to. Running it locally, or without the hashes, aborts by design. This wrapper:
    1. takes the target from this checkout's HEAD (must be master == origin/master, clean tracked tree);
    2. reads the base from production itself, read-only: the published build stamp (/dashboard/build-info.json) and, over ssh, the live checkout's
       HEAD — both must agree, or it stops;
    3. refuses a base that is not an ancestor of the target (a fast-forward would be impossible);
    4. stages the script on the server (CRLF stripped) and runs the REHEARSAL: `--check-only`, which writes nothing;
    5. only with -Apply, and only after the rehearsal passed, runs the release itself (verified backup, fast-forward, build, restart of the one
       service, proof, automatic rollback — all inside release-full.sh) and then prints the three-way status.
  Nothing here touches port 3005, the database or any WhatsApp session; the production-deploy permission gate is respected, not bypassed.
.EXAMPLE
  pwsh scripts/release-full.ps1                 # rehearsal for HEAD (base read from production)
  pwsh scripts/release-full.ps1 -Target e12c51d # rehearsal for a named commit (must equal master == origin/master)
  pwsh scripts/release-full.ps1 -Apply          # rehearsal, then the real release
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$Target,
  [string]$Base,
  [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\oracle-whatsapp-ai.key'),
  [string]$Site = 'https://whatsapp.alfarooque.com'
)
$ErrorActionPreference = 'Stop'
$Server = 'ubuntu@130.110.112.192'
$ServerRepo = '/home/ubuntu/whatsapp-ai-agent'
$Remote = '/tmp/release-full.sh'
$Root = (& git -C $PSScriptRoot rev-parse --show-toplevel 2>$null)
if (-not $Root) { Write-Error 'ABORT[repo]: not inside a git repository'; exit 1 }
if ((& git -C $Root remote get-url origin) -notmatch 'ahmedalfarooque/whatsapp-ai-agent') { Write-Error 'ABORT[repo]: origin is not the WhatsApp AI Agent repository'; exit 1 }
if (-not (Test-Path (Join-Path $Root 'scripts\release-full.sh'))) { Write-Error 'ABORT[repo]: scripts/release-full.sh is missing'; exit 1 }
# The OpenSSH client is resolved ONCE as an application: PowerShell command names are case-insensitive, so a function
# named Ssh that ran `& ssh` would call itself until the call depth overflowed (seen on the first rehearsal of cc31bc4).
$SshExe = (Get-Command ssh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $SshExe) { Write-Error 'ABORT[ssh]: the OpenSSH client (ssh.exe) is not installed'; exit 1 }
function Invoke-Server([string]$Command) { & $SshExe -i $KeyPath -o BatchMode=yes -o ConnectTimeout=20 $Server $Command }

# ---- 1. the target: this checkout's master, identical to GitHub
$branch = (& git -C $Root branch --show-current)
if ($branch -ne 'master') { Write-Error "ABORT[target]: current branch is $branch, not master"; exit 1 }
& git -C $Root fetch -q origin
$head = (& git -C $Root rev-parse HEAD)
$remoteHead = (& git -C $Root rev-parse origin/master)
if ($head -ne $remoteHead) { Write-Error "ABORT[target]: master ($($head.Substring(0,7))) and origin/master ($($remoteHead.Substring(0,7))) differ; push or reconcile first"; exit 1 }
if ((& git -C $Root status --porcelain --untracked-files=no | Where-Object { $_ -notmatch '\.project-sync/' }).Count -gt 0) { Write-Error 'ABORT[target]: the tracked tree has uncommitted changes (coordination files excluded)'; exit 1 }
$targetFull = if ($Target) { (& git -C $Root rev-parse --verify "$Target^{commit}" 2>$null) } else { $head }
if (-not $targetFull) { Write-Error "ABORT[target]: unknown commit $Target"; exit 1 }
if ($targetFull -ne $head) { Write-Error "ABORT[target]: $($targetFull.Substring(0,7)) is not master == origin/master ($($head.Substring(0,7))); the server only fast-forwards to origin/master"; exit 1 }
Write-Host "target = $($targetFull.Substring(0,7)) (master == origin/master)"

# ---- 2. the base: what production is ACTUALLY on, read two ways (read-only)
if (-not (Test-Path $KeyPath)) { Write-Error "ABORT[ssh]: key not found: $KeyPath"; exit 1 }
$stampCommit = $null
try { $stamp = Invoke-RestMethod -Uri "$Site/dashboard/build-info.json" -TimeoutSec 20 -Headers @{ 'Cache-Control' = 'no-cache' }; $stampCommit = [string]($stamp.fullCommit ?? $stamp.commit) } catch { Write-Host "note: the published build stamp could not be read ($($_.Exception.Message))" }
$liveHead = (Invoke-Server "git -C $ServerRepo rev-parse HEAD" 2>$null | Select-Object -First 1)
if ($liveHead -notmatch '^[0-9a-f]{40}$') { Write-Error "ABORT[base]: could not read production's live commit over ssh (is the key loaded and the server reachable?)"; exit 1 }
if ($stampCommit -and -not $liveHead.StartsWith($stampCommit)) { Write-Error "ABORT[base]: production's checkout is $($liveHead.Substring(0,7)) but its published stamp says $($stampCommit.Substring(0,7)); inspect before releasing"; exit 1 }
if ($Base -and -not $liveHead.StartsWith($Base)) { Write-Error "ABORT[base]: -Base $Base does not match production's live commit $($liveHead.Substring(0,7))"; exit 1 }
$baseFull = $liveHead
Write-Host "base   = $($baseFull.Substring(0,7)) (production checkout HEAD$(if ($stampCommit) { ', stamp agrees' }))"
if ($baseFull -eq $targetFull) { Write-Host 'Production already runs this commit; nothing to release.'; exit 0 }
& git -C $Root merge-base --is-ancestor $baseFull $targetFull 2>$null
if ($LASTEXITCODE -ne 0) { Write-Error "ABORT[base]: production's commit $($baseFull.Substring(0,7)) is not an ancestor of $($targetFull.Substring(0,7)): a fast-forward release is impossible"; exit 1 }
$changes = (& git -C $Root diff --name-only $baseFull $targetFull)
Write-Host "release = $($baseFull.Substring(0,7)) -> $($targetFull.Substring(0,7)): $($changes.Count) files; migrations: $(($changes | Where-Object { $_ -like 'src/memory/migrations/*' }) -join ', ')$(if (-not ($changes | Where-Object { $_ -like 'src/memory/migrations/*' })) { 'none' }); package files: $(($changes | Where-Object { $_ -in 'package.json','package-lock.json' }).Count)"

# ---- 3. stage the script (CRLF stripped) and rehearse: --check-only writes nothing
Get-Content -Raw (Join-Path $Root 'scripts\release-full.sh') | & $SshExe -i $KeyPath -o BatchMode=yes -o ConnectTimeout=20 $Server "tr -d '\r' > $Remote"
if ($LASTEXITCODE -ne 0) { Write-Error 'ABORT[stage]: could not stage the script on the server'; exit 1 }
Write-Host "rehearsal: bash $Remote --base $($baseFull.Substring(0,7)) --target $($targetFull.Substring(0,7)) --check-only"
Invoke-Server "bash $Remote --base $baseFull --target $targetFull --check-only"
if ($LASTEXITCODE -ne 0) { Write-Error "REHEARSAL FAILED (exit $LASTEXITCODE): nothing was changed on production; read the ABORT line above"; exit 1 }
Write-Host 'REHEARSAL PASSED: preconditions, fingerprints and fast-forward verified; nothing was written.'
if (-not $Apply) {
  Write-Host "To release: pwsh scripts/release-full.ps1 -Target $($targetFull.Substring(0,7)) -Apply"
  Write-Host "(equivalent on the server: bash $Remote --base $baseFull --target $targetFull)"
  exit 0
}

# ---- 4. the release itself (backup, fast-forward, build, restart, proof, rollback are inside release-full.sh)
Write-Host "release:   bash $Remote --base $($baseFull.Substring(0,7)) --target $($targetFull.Substring(0,7))"
Invoke-Server "bash $Remote --base $baseFull --target $targetFull"
$code = $LASTEXITCODE
& (Join-Path $PSScriptRoot 'release-status.ps1')
if ($code -ne 0) { Write-Error "RELEASE FAILED (exit $code): release-full.sh rolled back if it had changed anything; see its output and the status above"; exit 1 }
Write-Host 'RELEASED: verify the status above names the target on the checkout, the stamp and the served files.'
exit 0
