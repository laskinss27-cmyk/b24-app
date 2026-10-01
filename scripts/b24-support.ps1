param(
    [ValidateSet('inbox','get','claim','renew','reply','attachment','confirm-delivery','deliver')]
    [string]$Command = 'inbox',
    [string]$InputFile,
    [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$supportRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$supportSshConfig = Join-Path $supportRepo '.secrets/model-server-access/ssh_config'
if (-not (Test-Path -LiteralPath $supportSshConfig)) { throw 'Private production SSH configuration is missing' }
$supportPayload = if ($InputFile) { Get-Content -LiteralPath $InputFile -Raw } else { '{}' }
# The command is allowlisted. All ticket text and identifiers travel as JSON on stdin, never as shell code.
$supportResult = $supportPayload | ssh -F $supportSshConfig b24-production-model "sudo -n docker exec -i -w /app b24-backend node packages/backend/dist/support/cli.js $Command --stdin"
if ($LASTEXITCODE -ne 0) { throw "Support CLI failed ($LASTEXITCODE)" }
$supportText = $supportResult -join "`n"
if ($OutputPath) {
    $supportOutput = [IO.Path]::GetFullPath((Join-Path $supportRepo $OutputPath))
    $supportAllowed = [IO.Path]::GetFullPath((Join-Path $supportRepo 'outputs')) + [IO.Path]::DirectorySeparatorChar
    if (-not $supportOutput.StartsWith($supportAllowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Save private ticket data only under repository outputs/' }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($supportOutput)) | Out-Null
    if ($Command -eq 'attachment') {
        $supportAttachment = $supportText | ConvertFrom-Json
        [IO.File]::WriteAllBytes($supportOutput, [Convert]::FromBase64String($supportAttachment.base64))
        Write-Output ([ordered]@{ path=$supportOutput; name=$supportAttachment.name; bytes=$supportAttachment.bytes } | ConvertTo-Json -Compress)
    } else { [IO.File]::WriteAllText($supportOutput, $supportText, [Text.UTF8Encoding]::new($false)); Write-Output $supportOutput }
} else { Write-Output $supportText }
