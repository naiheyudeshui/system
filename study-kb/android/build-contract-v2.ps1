param(
    [Parameter(Mandatory=$true)][string]$StudioRoot,
    [Parameter(Mandatory=$true)][string]$PlanFile,
    [string]$AndroidSdk = $env:ANDROID_HOME,
    [string]$Python = $env:STUDY_BUILD_PYTHON
)

$ErrorActionPreference = 'Stop'
if (-not $Python) { $Python = (& py -3 -c 'import sys; print(sys.executable)').Trim() }
if (-not $AndroidSdk) { $AndroidSdk = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
$studio = (Resolve-Path -LiteralPath $StudioRoot).Path
$plan = (Resolve-Path -LiteralPath $PlanFile).Path
$sdk = (Resolve-Path -LiteralPath $AndroidSdk).Path
$branch = (& git -C $studio branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $branch -ne 'feat/workbench-contract-v2') {
    throw 'StudioRoot must select the actual feat/workbench-contract-v2 worktree.'
}
$consumerBranch = (& git -C $PSScriptRoot branch --show-current).Trim()
if ($consumerBranch -ne 'feat/workbench-contract-v2') {
    throw 'Run this builder from the isolated system contract-v2 worktree.'
}
$old = @{}
foreach ($name in @('STUDY_BUILD_PYTHON','STUDY_STUDIO_ROOT','STUDY_CONTRACT_PLAN_ROOT','ANDROID_HOME')) {
    $old[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
Push-Location $PSScriptRoot
try {
    $env:STUDY_BUILD_PYTHON = $Python
    $env:STUDY_STUDIO_ROOT = $studio
    $env:STUDY_CONTRACT_PLAN_ROOT = $plan
    $env:ANDROID_HOME = $sdk
    & ./gradlew.bat :app:assembleDebug -PcontractV2=true --console=plain
    if ($LASTEXITCODE -ne 0) { throw 'Contract-v2 Gradle build failed.' }
    $artifact = Join-Path $PSScriptRoot 'app/build/outputs/apk/debug/app-debug.apk'
    $verifier = Get-ChildItem -LiteralPath (Join-Path $sdk 'build-tools') -Directory |
        Sort-Object Name -Descending | Select-Object -First 1
    & (Join-Path $verifier.FullName 'apksigner.bat') verify $artifact
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    $named = Join-Path (Split-Path $artifact) 'study-kb-contract-v2-debug.apk'
    Copy-Item -LiteralPath $artifact -Destination $named -Force
    Get-FileHash -LiteralPath $named -Algorithm SHA256
    Write-Output "Independent test APK: $named"
} finally {
    Pop-Location
    foreach ($name in $old.Keys) {
        [Environment]::SetEnvironmentVariable($name, $old[$name], 'Process')
    }
}
