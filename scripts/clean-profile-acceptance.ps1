[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$VsCodeExe,
  [Parameter(Mandatory=$true)][string]$VsixPath,
  [Parameter(Mandatory=$true)][string]$ProfileRoot
)

$ErrorActionPreference = 'Stop'
$extensionId = 'bujianxingguang.yuanmeng-ai-dev-assistant'
$expectedMissingMessage = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('5YWD5qKmIEFJIOW8gOWPkeWKqeaJi+W3suWNuOi9veaIluWuieijhei3r+W+hOWkseaViA=='))
$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$packageManifest = Get-Content -LiteralPath (Join-Path $workspaceRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$baseVersion = [string]$packageManifest.version
if ($baseVersion -match '^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)-private\.(?<private>\d+)$') {
  $upgradeVersion = "$($Matches.major).$($Matches.minor).$($Matches.patch)-private.$([int]$Matches.private + 1)"
} elseif ($baseVersion -match '^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$') {
  $upgradeVersion = "$($Matches.major).$($Matches.minor).$([int]$Matches.patch + 1)"
} else {
  throw "Unsupported extension version format for lifecycle acceptance: $baseVersion"
}
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'work\acceptance'))
$requestedProfile = [IO.Path]::GetFullPath($ProfileRoot)
$allowedPrefix = $allowedRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $requestedProfile.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "ProfileRoot must stay inside $allowedRoot"
}

$exe = (Resolve-Path -LiteralPath $VsCodeExe).Path
$vsix = (Resolve-Path -LiteralPath $VsixPath).Path
if (-not $vsix.EndsWith('.vsix', [StringComparison]::OrdinalIgnoreCase)) { throw 'VsixPath must point to a .vsix file' }
$cli = if ((Split-Path -Leaf $exe) -ieq 'code.cmd') { $exe } else { Join-Path (Split-Path -Parent $exe) 'bin\code.cmd' }
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { $cli = $exe }

function Invoke-CodeCli([string[]]$Arguments) {
  & $cli @Arguments
  $exitCode = $LASTEXITCODE
  if ($null -eq $exitCode) { $exitCode = 0 }
  if ($exitCode -ne 0) { throw "VSCode CLI failed with exit code ${exitCode}: $($Arguments -join ' ')" }
}

function Stop-IsolatedCode([string]$Profile) {
  $targets = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -in @('Code.exe', 'code.exe') -and
    $null -ne $_.CommandLine -and
    $_.CommandLine.IndexOf($Profile, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  foreach ($target in $targets) { Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($targets.Count -gt 0) { Start-Sleep -Seconds 2 }
}

function Quote-ProcessArgument([string]$Value) {
  if ($Value.Contains('"')) { throw 'Acceptance paths may not contain quote characters.' }
  return '"' + $Value + '"'
}

function Start-IsolatedCode([string]$Profile, [string]$ExtensionDirectory, [string]$Project, [bool]$DisableCompanion = $false) {
  $startedAt = [DateTime]::UtcNow
  $arguments = @(
    '--user-data-dir', $Profile,
    '--extensions-dir', $ExtensionDirectory,
    '--new-window', '--skip-welcome', '--skip-release-notes',
    '--disable-updates', '--disable-telemetry', '--skip-add-to-recently-opened',
    '--disable-experiments', '--disable-gpu', '--disable-crash-reporter',
    $Project
  )
  if ($DisableCompanion) { $arguments += @('--disable-extension', $extensionId) }
  $argumentLine = ($arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' '
  [void](Start-Process -FilePath $exe -ArgumentList $argumentLine -WindowStyle Minimized -PassThru)
  return $startedAt
}

function Get-CurrentExtensionHostLog([string]$Profile, [DateTime]$StartedAt) {
  $logsRoot = Join-Path $Profile 'logs'
  if (-not (Test-Path -LiteralPath $logsRoot -PathType Container)) { return $null }
  return Get-ChildItem -LiteralPath $logsRoot -Recurse -File -Filter 'exthost.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTimeUtc -ge $StartedAt.AddSeconds(-1) } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
}

function Wait-ExtensionHostLog([string]$Profile, [DateTime]$StartedAt) {
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  do {
    $log = Get-CurrentExtensionHostLog $Profile $StartedAt
    if ($null -ne $log) { return $log }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Timed out waiting for an isolated Extension Host log.'
}

function Wait-ActivationLog([string]$Profile, [DateTime]$StartedAt) {
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  do {
    $log = Get-CurrentExtensionHostLog $Profile $StartedAt
    if ($null -ne $log) {
      $match = Select-String -LiteralPath $log.FullName -SimpleMatch "ExtensionService#_doActivateExtension $extensionId" -ErrorAction SilentlyContinue
      if ($null -ne $match) { return $log }
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Timed out waiting for direct companion activation evidence in the isolated Extension Host log.'
}

function Wait-Launcher([string]$ManifestPath, [string]$ExpectedVersion, [string]$ExpectedExtensionDirectory) {
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  do {
    if (Test-Path -LiteralPath $ManifestPath -PathType Leaf) {
      try {
        $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $expectedPrefix = [IO.Path]::GetFullPath($ExpectedExtensionDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        $actualCli = [IO.Path]::GetFullPath([string]$manifest.cliPath)
        if ($manifest.extensionVersion -eq $ExpectedVersion -and $actualCli.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) { return $manifest }
      } catch {
        # Atomic writer may be between retries.
      }
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for launcher version $ExpectedVersion under $ExpectedExtensionDirectory"
}

function Invoke-Launcher([string]$LauncherPath, [string[]]$Arguments) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $lines = & $LauncherPath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = 0 }
    return [pscustomobject]@{ ExitCode = $exitCode; Text = ($lines -join [Environment]::NewLine) }
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Remove-Inspector([string]$InspectorPath, [string]$ProjectPath, [string]$ProfilePath) {
  $resolvedInspector = [IO.Path]::GetFullPath($InspectorPath)
  $projectPrefix = [IO.Path]::GetFullPath($ProjectPath).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $profilePrefix = [IO.Path]::GetFullPath($ProfilePath).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedInspector.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      -not $resolvedInspector.StartsWith($profilePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove inspector outside isolated acceptance project: $resolvedInspector"
  }
  if (Test-Path -LiteralPath $resolvedInspector) { Remove-Item -LiteralPath $resolvedInspector -Recurse -Force }
}

$pathBefore = $env:Path
$profile = $requestedProfile
$extensionDirV1 = Join-Path $profile 'extensions v1'
$extensionDirV2 = Join-Path $profile 'extensions v2'
$project = Join-Path $profile 'project'
$inspector = Join-Path $project '.yuanmeng-inspector'
$launcher = Join-Path $inspector 'bin\ymai.cmd'
$launcherManifest = Join-Path $inspector 'bin\cli-launcher.json'
$upgradeVsix = Join-Path $profile "yuanmeng-ai-dev-assistant-$upgradeVersion-upgrade-fixture.vsix"
$activationLogHashes = @()
$completed = $false

try {
  if (Test-Path -LiteralPath $profile) {
    Stop-IsolatedCode $profile
    Remove-Item -LiteralPath $profile -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $project 'src') | Out-Null
  New-Item -ItemType Directory -Force -Path $extensionDirV1 | Out-Null
  New-Item -ItemType Directory -Force -Path $extensionDirV2 | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $profile 'User') | Out-Null
  [IO.File]::WriteAllText((Join-Path $project 'src\GameEntry.lua'), "return {}`n", [Text.UTF8Encoding]::new($false))
  $settings = [ordered]@{
    'security.workspace.trust.enabled' = $false
    'workbench.startupEditor' = 'none'
    'workbench.welcomePage.walkthroughs.openOnInstall' = $false
    'telemetry.telemetryLevel' = 'off'
    'extensions.autoUpdate' = $false
    'extensions.autoCheckUpdates' = $false
    'update.mode' = 'none'
    'git.enabled' = $false
  }
  [IO.File]::WriteAllText((Join-Path $profile 'User\settings.json'), (($settings | ConvertTo-Json) + "`n"), [Text.UTF8Encoding]::new($false))

  $versionLines = @(& $cli '--version')
  $vscodeVersion = [string]($versionLines | Select-Object -First 1)
  if ($vscodeVersion -notmatch '^\d+\.\d+\.\d+') { throw 'Unable to determine VSCode version for clean-profile evidence.' }

  Invoke-CodeCli @('--user-data-dir', $profile, '--extensions-dir', $extensionDirV1, '--install-extension', $vsix, '--force')
  $started = Start-IsolatedCode $profile $extensionDirV1 $project
  $firstManifest = Wait-Launcher $launcherManifest $baseVersion $extensionDirV1
  $firstActivationLog = Wait-ActivationLog $profile $started
  $firstLauncherHash = (Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash
  $firstManifestHash = (Get-FileHash -LiteralPath $launcherManifest -Algorithm SHA256).Hash
  $firstInvocation = Invoke-Launcher $launcher @('status', '--json')
  if ($firstInvocation.ExitCode -ne 2) { throw "Official-extension-missing smoke expected exit 2, got $($firstInvocation.ExitCode)." }
  $firstPayload = $firstInvocation.Text | ConvertFrom-Json
  if ($firstPayload.code -ne 'OFFLINE' -or $firstPayload.data.link.state -ne 'offline' -or
      $firstPayload.data.link.reasonCode -ne 'OFFICIAL_COMMANDS_MISSING' -or [string]::IsNullOrWhiteSpace([string]$firstPayload.message)) {
    throw 'Official-extension-missing smoke did not return the designed guided offline status.'
  }
  Stop-IsolatedCode $profile
  $activationLogHashes += (Get-FileHash -LiteralPath $firstActivationLog.FullName -Algorithm SHA256).Hash.ToLowerInvariant()

  & node (Join-Path $PSScriptRoot 'build-upgrade-fixture.mjs') $vsix $upgradeVsix '--version' $upgradeVersion | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $upgradeVsix -PathType Leaf)) { throw 'Upgrade fixture builder failed.' }
  Invoke-CodeCli @('--user-data-dir', $profile, '--extensions-dir', $extensionDirV1, '--install-extension', $upgradeVsix, '--force')
  $started = Start-IsolatedCode $profile $extensionDirV1 $project
  $upgradeManifest = Wait-Launcher $launcherManifest $upgradeVersion $extensionDirV1
  $upgradeActivationLog = Wait-ActivationLog $profile $started
  $upgradeLauncherHash = (Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash
  $upgradeManifestHash = (Get-FileHash -LiteralPath $launcherManifest -Algorithm SHA256).Hash
  if ($firstLauncherHash -eq $upgradeLauncherHash -or $firstManifestHash -eq $upgradeManifestHash) { throw 'Upgrade did not atomically refresh both launcher files.' }
  Stop-IsolatedCode $profile
  $activationLogHashes += (Get-FileHash -LiteralPath $upgradeActivationLog.FullName -Algorithm SHA256).Hash.ToLowerInvariant()

  Invoke-CodeCli @('--user-data-dir', $profile, '--extensions-dir', $extensionDirV2, '--install-extension', $upgradeVsix, '--force')
  $started = Start-IsolatedCode $profile $extensionDirV2 $project
  $relocatedManifest = Wait-Launcher $launcherManifest $upgradeVersion $extensionDirV2
  $relocationActivationLog = Wait-ActivationLog $profile $started
  if ([string]$relocatedManifest.cliPath -eq [string]$upgradeManifest.cliPath) { throw 'Relocation did not refresh the extension path.' }
  Stop-IsolatedCode $profile
  $activationLogHashes += (Get-FileHash -LiteralPath $relocationActivationLog.FullName -Algorithm SHA256).Hash.ToLowerInvariant()

  Remove-Inspector $inspector $project $profile
  $started = Start-IsolatedCode $profile $extensionDirV2 $project $true
  $disabledLog = Wait-ExtensionHostLog $profile $started
  Start-Sleep -Seconds 5
  if (Test-Path -LiteralPath $inspector) { throw 'Disabled extension regenerated .yuanmeng-inspector.' }
  if (Select-String -LiteralPath $disabledLog.FullName -SimpleMatch "ExtensionService#_doActivateExtension $extensionId" -Quiet) { throw 'Disabled extension appears in the isolated activation log.' }
  Stop-IsolatedCode $profile

  $started = Start-IsolatedCode $profile $extensionDirV2 $project
  [void](Wait-Launcher $launcherManifest $upgradeVersion $extensionDirV2)
  $reenabledActivationLog = Wait-ActivationLog $profile $started
  $sessionPath = Join-Path $inspector 'runtime\session.json'
  if (-not (Test-Path -LiteralPath $sessionPath -PathType Leaf)) { throw 'Re-enabled extension did not create a new queue session.' }
  Stop-IsolatedCode $profile
  $activationLogHashes += (Get-FileHash -LiteralPath $reenabledActivationLog.FullName -Algorithm SHA256).Hash.ToLowerInvariant()

  Invoke-CodeCli @('--user-data-dir', $profile, '--extensions-dir', $extensionDirV2, '--uninstall-extension', $extensionId)
  $listed = @(& $cli '--user-data-dir' $profile '--extensions-dir' $extensionDirV2 '--list-extensions')
  if ($listed -contains $extensionId) { throw 'Extension remained listed after isolated uninstall.' }
  $uninstalledInvocation = Invoke-Launcher $launcher @('status', '--json')
  if ($uninstalledInvocation.ExitCode -ne 2 -or $uninstalledInvocation.Text -notlike "*$expectedMissingMessage*") { throw 'Retained launcher did not return the explicit safe failure after uninstall.' }
  if ($env:Path -ne $pathBefore) { throw 'Clean-profile lifecycle changed PATH.' }

  $result = [pscustomobject]@{
    SchemaVersion = 1
    VSCodeVersion = $vscodeVersion
    ProfileIsolation = 'PASS'
    WorkspaceTrust = 'DISABLED_ONLY_IN_DISPOSABLE_PROFILE'
    Install = 'PASS'
    Activation = 'PASS_DIRECT_EXTHOST_LOG'
    MissingOfficialExtension = 'PASS_OFFLINE_GUIDANCE'
    Upgrade = 'PASS'
    Relocation = 'PASS'
    DisableEnable = 'PASS_DIRECT_REGENERATION_ASSERTION'
    UninstallSafeFailure = 'PASS'
    PathUnchanged = $true
    InitialLauncherExit = $firstInvocation.ExitCode
    RemovedLauncherExit = $uninstalledInvocation.ExitCode
    ExtensionVersions = @([string]$firstManifest.extensionVersion, [string]$upgradeManifest.extensionVersion)
    ActivationLogSha256 = $activationLogHashes
  }
  $completed = $true
  $result | ConvertTo-Json -Compress
} finally {
  Stop-IsolatedCode $profile
  if ($completed -and (Test-Path -LiteralPath $profile)) {
    $resolvedCleanup = [IO.Path]::GetFullPath($profile)
    if (-not $resolvedCleanup.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing to clean unexpected path: $resolvedCleanup" }
    Remove-Item -LiteralPath $resolvedCleanup -Recurse -Force
  }
}
