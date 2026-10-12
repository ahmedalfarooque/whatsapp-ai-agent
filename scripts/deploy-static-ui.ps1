<#
.SYNOPSIS
  Local launcher for the guarded static dashboard release (scripts/deploy-static-ui.sh). Run from anywhere; it never trusts the caller's directory.
.DESCRIPTION
  Verifies, before anything is sent to the server: the repository root derived from THIS file's location, branch master,
  local master == origin/master == -Target, exactly one copy of the deploy script, and that the script on disk is byte-identical
  to the one committed in -Target (no stale or edited copy). Then streams that script to the production server over ssh.
  -DryRun prints what would run and sends nothing. -CheckOnly runs every server-side precondition and writes nothing.
.EXAMPLE
  pwsh scripts/deploy-static-ui.ps1 -Base 277499d -Target <commit> -CheckOnly
  pwsh scripts/deploy-static-ui.ps1 -Base 277499d -Target <commit>
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{7,40}$')][string]$Base,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{7,40}$')][string]$Target,
  [switch]$CheckOnly,
  [switch]$DryRun,
  [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\oracle-whatsapp-ai.key')
)
$ErrorActionPreference = 'Stop'
$ExpectedServer = 'ubuntu@130.110.112.192'
function Stop-Deploy([string]$Step, [string]$Reason) { Write-Error "ABORT[$Step]: $Reason"; exit 1 }

# project root from this file's own location, never from the current directory
$ScriptDir = $PSScriptRoot
$Root = (& git -C $ScriptDir rev-parse --show-toplevel 2>$null)
if (-not $Root) { Stop-Deploy 'repo' "cannot resolve a git repository from $ScriptDir" }
$Root = (Resolve-Path $Root).Path
if ((Resolve-Path (Join-Path $ScriptDir '..')).Path -ne $Root) { Stop-Deploy 'repo' "launcher is not at <repo>\scripts (repo=$Root)" }
if (-not (Test-Path (Join-Path $Root 'scripts\project-sync.cjs'))) { Stop-Deploy 'repo' 'not the WhatsApp AI Agent project (project-sync.cjs missing)' }
if ((Split-Path $Root -Leaf) -match 'Rowad Alfa') { Stop-Deploy 'repo' 'refusing the unrelated Rowad Alfa project' }
$remote = (& git -C $Root remote get-url origin)
if ($remote -notmatch 'ahmedalfarooque/whatsapp-ai-agent') { Stop-Deploy 'repo' 'origin is not the WhatsApp AI Agent repository' }

# the one trusted script
$ShPath = Join-Path $Root 'scripts\deploy-static-ui.sh'
if (-not (Test-Path $ShPath)) { Stop-Deploy 'script' "missing: $ShPath" }
$copies = @(Get-ChildItem -Path $Root -Recurse -Filter 'deploy-static-ui.sh' -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|dist)\\' })
if ($copies.Count -ne 1) { Stop-Deploy 'script' "expected exactly one deploy-static-ui.sh in the repository, found $($copies.Count)" }

# git state: branch, remote not advanced, target is what we think it is
& git -C $Root fetch --quiet origin
if ((& git -C $Root branch --show-current) -ne 'master') { Stop-Deploy 'git' 'current branch is not master' }
$tFull = (& git -C $Root rev-parse --verify "$Target^{commit}" 2>$null)
if (-not $tFull) { Stop-Deploy 'git' "target $Target is unknown" }
$localMaster = (& git -C $Root rev-parse master)
$originMaster = (& git -C $Root rev-parse origin/master)
if ($originMaster -ne $tFull) { Stop-Deploy 'git' "origin/master ($($originMaster.Substring(0,7))) is not the intended target $Target; push or reconcile first" }
if ($localMaster -ne $tFull) { Stop-Deploy 'git' "local master ($($localMaster.Substring(0,7))) differs from target $Target" }
if (& git -C $Root status --porcelain --untracked-files=no -- . ':!.project-sync') { Stop-Deploy 'git' 'tracked files have uncommitted changes' }

# stale / edited script protection: bytes on disk must equal the committed blob in the target
$blob = (& git -C $Root show "$tFull`:scripts/deploy-static-ui.sh") -join "`n"
$disk = [System.IO.File]::ReadAllText($ShPath) -replace "`r`n", "`n"
if (($blob.TrimEnd("`n")) -ne ($disk.TrimEnd("`n"))) { Stop-Deploy 'script' 'deploy-static-ui.sh on disk differs from the committed version in the target (stale or edited copy)' }

if (-not $DryRun) {
  if (-not (Test-Path $KeyPath)) { Stop-Deploy 'ssh' "ssh key not found: $KeyPath" }
}
$argsLine = "--base $Base --target $Target" + $(if ($CheckOnly) { ' --check-only' } else { '' })
Write-Host "root=$Root"
Write-Host "script=$ShPath (identical to $($tFull.Substring(0,7)):scripts/deploy-static-ui.sh)"
Write-Host "server=$ExpectedServer args=$argsLine"
if ($DryRun) { Write-Host 'DRY RUN: nothing sent'; exit 0 }
$payload = [System.IO.File]::ReadAllText($ShPath) -replace "`r`n", "`n"
$payload | & ssh -i $KeyPath -o BatchMode=yes $ExpectedServer "tr -d '\r' | bash -s -- $argsLine"
exit $LASTEXITCODE
