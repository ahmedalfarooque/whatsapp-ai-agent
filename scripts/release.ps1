<#
.SYNOPSIS
  The one release command: validate, test, check, (optionally) release, and verify - for the static dashboard release path.
.DESCRIPTION
  Without -Apply this is a rehearsal that changes nothing anywhere: it validates the repository and branch, proves local master == origin/master, reads production's
  live commit, runs typecheck + lint + tests + build, and runs the server-side preconditions of the guarded release (deploy-static-ui.ps1 -CheckOnly) against the
  ACTUAL base (production's live commit) and target (master).
  With -Apply it then performs the release through the existing guarded launcher (which backs up, fast-forwards only, rolls back automatically on a failed
  post-release check) and finishes by running release-status.ps1: it only reports success when production's checkout, its published build stamp and the files it
  serves all match the released commit. On any failure it prints a failure report (step, reason, where the backup is, how to roll back) and exits non-zero.
  It never edits production by any other route, never touches port 3005, never bypasses the launcher's guards or an approval gate. A release that touches
  anything outside the static allow-list (dashboard/, docs/, tests/ and a few text/tool files) is refused by the guards and needs a separately reviewed release.
.EXAMPLE
  pwsh scripts/release.ps1              # rehearsal: tests + check-only, nothing is released
  pwsh scripts/release.ps1 -Apply       # the real release (asks nothing else; run it yourself)
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$SkipChecks,
  [string]$Base,
  [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\oracle-whatsapp-ai.key')
)
$ErrorActionPreference = 'Stop'
$Server = 'ubuntu@130.110.112.192'
$ServerRepo = '/home/ubuntu/whatsapp-ai-agent'
$Root = (& git -C $PSScriptRoot rev-parse --show-toplevel 2>$null)
$steps = New-Object System.Collections.Generic.List[string]
$started = Get-Date

function Fail([string]$Step, [string]$Reason) {
  $report = @(
    "RELEASE FAILED at step: $Step", "Reason: $Reason", "Completed before the failure: $($steps -join ' > ')",
    "Production was changed only if the failed step is 'release' or later; the guarded launcher rolls back automatically and keeps the backup it printed.",
    "To look: pwsh scripts/release-status.ps1", "To roll back by hand (only if status shows production on the new commit and it is unhealthy): ssh $Server, then 'git -C $ServerRepo checkout --detach <previous commit>'; the backup path was printed by the launcher."
  )
  $path = Join-Path ([IO.Path]::GetTempPath()) ("whatsapp-release-failure-{0:yyyyMMdd-HHmmss}.txt" -f $started)
  try { $report | Set-Content -Path $path -Encoding UTF8 } catch { }
  $report | ForEach-Object { Write-Host $_ -ForegroundColor Red }
  Write-Host "(report saved to $path)"
  exit 1
}
function Step([string]$Name) { Write-Host "==> $Name" -ForegroundColor Cyan; $steps.Add($Name) }
function Run([string]$Name, [scriptblock]$Block) { Step $Name; & $Block; if ($LASTEXITCODE -ne 0) { Fail $Name "exit code $LASTEXITCODE" } }

# 1. repository and branch
Step 'validate repository'
if (-not $Root) { Fail 'validate repository' 'not inside a git repository' }
$Root = (Resolve-Path $Root).Path
if (-not (Test-Path (Join-Path $Root 'scripts\project-sync.cjs'))) { Fail 'validate repository' 'not the WhatsApp AI Agent project' }
if ((Split-Path $Root -Leaf) -match 'Rowad Alfa') { Fail 'validate repository' 'refusing the unrelated Rowad Alfa project' }
if ((& git -C $Root remote get-url origin) -notmatch 'ahmedalfarooque/whatsapp-ai-agent') { Fail 'validate repository' 'origin is not the WhatsApp AI Agent repository' }
& git -C $Root fetch --quiet origin
if ((& git -C $Root branch --show-current) -ne 'master') { Fail 'validate branch' 'current branch is not master (merge the reviewed branch into master first)' }
if (& git -C $Root status --porcelain --untracked-files=no -- . ':!.project-sync') { Fail 'validate branch' 'tracked files have uncommitted changes' }
$target = (& git -C $Root rev-parse master)
$originMaster = (& git -C $Root rev-parse origin/master)
if ($target -ne $originMaster) { Fail 'validate branch' "local master ($($target.Substring(0,7))) and origin/master ($($originMaster.Substring(0,7))) differ; push or reconcile first" }
Write-Host "target = master = origin/master = $($target.Substring(0,7))"

# 2. the base is what production is ACTUALLY on (read-only), not what anyone remembers
Step 'read production commit'
if (-not $Base) {
  if (-not (Test-Path $KeyPath)) { Fail 'read production commit' "ssh key not found: $KeyPath" }
  $Base = (& ssh -i $KeyPath -o BatchMode=yes -o ConnectTimeout=15 $Server "git -C $ServerRepo rev-parse HEAD" 2>$null | Select-Object -First 1)
}
if ($Base -notmatch '^[0-9a-f]{7,40}$') { Fail 'read production commit' 'could not read production''s live commit' }
Write-Host "base   = production live HEAD = $($Base.Substring(0,7))"
if ($Base.StartsWith($target.Substring(0, 7)) -or $target.StartsWith($Base)) { Write-Host 'Production already runs this commit; nothing to release.'; & (Join-Path $PSScriptRoot 'release-status.ps1'); exit $LASTEXITCODE }
& git -C $Root merge-base --is-ancestor $Base $target 2>$null
if ($LASTEXITCODE -ne 0) { Fail 'read production commit' "production's commit $($Base.Substring(0,7)) is not an ancestor of master: a fast-forward release is impossible (production has commits GitHub does not)" }
Write-Host "changed files: $(((& git -C $Root diff --name-only $Base $target) | Measure-Object).Count)"

# 3. quality gates
if ($SkipChecks) { Write-Warning 'quality gates SKIPPED (-SkipChecks); the release report will say so' }
else {
  Push-Location $Root
  try {
    Run 'typecheck' { npm run typecheck --silent }
    Run 'lint' { npm run lint --silent }
    Run 'tests' { npm test --silent }
    Run 'build' { npm run build --silent }
  } finally { Pop-Location }
}

# 4. server-side preconditions with the real base and target (writes nothing)
$launcher = Join-Path $PSScriptRoot 'deploy-static-ui.ps1'
Step 'check-only'
& pwsh -NoProfile -File $launcher -Base $Base -Target $target -CheckOnly -KeyPath $KeyPath
if ($LASTEXITCODE -ne 0) { Fail 'check-only' "the guarded launcher refused (exit $LASTEXITCODE); read its ABORT line above" }

if (-not $Apply) {
  Write-Host ''
  Write-Host "REHEARSAL OK: $($Base.Substring(0,7)) -> $($target.Substring(0,7)) passes every check. Nothing was released. Run with -Apply to release." -ForegroundColor Green
  exit 0
}

# 5. the release itself, through the guarded launcher (backup, ff-only, automatic rollback)
Step 'release'
& pwsh -NoProfile -File $launcher -Base $Base -Target $target -KeyPath $KeyPath
if ($LASTEXITCODE -ne 0) { Fail 'release' "the guarded launcher failed (exit $LASTEXITCODE); it rolls back by itself, check the output above for 'ROLLED BACK' and the backup path" }

# 6. independent verification: production's checkout, its stamp and the files it serves must all be the released commit
Step 'verify'
& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'release-status.ps1') -KeyPath $KeyPath
if ($LASTEXITCODE -ne 0) { Fail 'verify' "release-status reports production does not match $($target.Substring(0,7)) (exit $LASTEXITCODE)" }
Write-Host ''
Write-Host "RELEASED AND VERIFIED: production runs $($target.Substring(0,7)) (checkout, build stamp and served files agree)." -ForegroundColor Green
if ($SkipChecks) { Write-Warning 'note: quality gates were skipped for this release' }
exit 0
