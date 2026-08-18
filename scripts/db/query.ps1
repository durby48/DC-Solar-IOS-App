<#
.SYNOPSIS
  Run SQL against the DC Solar Supabase project through the Management API.

.DESCRIPTION
  Reads the personal access token from the secrets folder (never from the repo),
  posts the SQL to /v1/projects/<ref>/database/query and prints the rows as a
  table (or JSON with -Json). This is how migrations are applied and how RLS is
  probed — see CLAUDE.md.

  Use -Rollback to wrap the statement(s) in `begin; ... rollback;` so nothing
  persists: that is how a migration or a policy change is TESTED before it is
  applied for real. Do not combine -Rollback with a file that already contains
  its own begin/commit unless you strip them (this script does that for you
  with -StripTransaction).

.EXAMPLE
  .\scripts\db\query.ps1 -Sql "select count(*) from public.jobs"
  .\scripts\db\query.ps1 -File supabase\migrations\2026-08-18_employee_of_month.sql -Rollback -StripTransaction
  .\scripts\db\query.ps1 -File probe.sql -Json
#>
param(
  [string]$Sql,
  [string]$File,
  [switch]$Rollback,
  [switch]$StripTransaction,
  [switch]$Json,
  [string]$ProjectRef = 'kjamxfezsathrsbztiln',
  [string]$TokenFile = (Join-Path $env:USERPROFILE 'Desktop\DC Solar LLC\secrets\supabase-access-token.txt')
)

$ErrorActionPreference = 'Stop'

if (-not $Sql -and -not $File) { throw 'Pass -Sql or -File.' }
if ($File) { $Sql = Get-Content -Raw -Path $File }

if ($StripTransaction) {
  # Remove standalone begin;/commit; lines so the whole file can be wrapped.
  $Sql = ($Sql -split "`r?`n" | Where-Object { $_ -notmatch '^\s*(begin|commit)\s*;\s*$' }) -join "`n"
}
if ($Rollback) { $Sql = "begin;`n$Sql`nrollback;" }

$line = Get-Content $TokenFile | Where-Object { $_ -match '^\s*(SUPABASE_ACCESS_TOKEN\s*=\s*)?sbp_' } | Select-Object -First 1
if (-not $line) { throw "No sbp_ token found in $TokenFile" }
$token = ($line -replace '^\s*SUPABASE_ACCESS_TOKEN\s*=\s*', '').Trim()

$body = @{ query = $Sql } | ConvertTo-Json -Depth 3 -Compress
$uri = "https://api.supabase.com/v1/projects/$ProjectRef/database/query"
try {
  $resp = Invoke-RestMethod -Uri $uri -Method Post -TimeoutSec 120 `
    -Headers @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' } `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
} catch {
  # PowerShell 5.1 keeps the response body in ErrorDetails; fall back to the stream.
  $detail = $_.ErrorDetails.Message
  $r = $_.Exception.Response
  if (-not $detail -and $r) {
    try { $sr = New-Object System.IO.StreamReader($r.GetResponseStream()); $detail = $sr.ReadToEnd() } catch {}
  }
  $code = if ($r) { [int]$r.StatusCode } else { '?' }
  # Print (not throw) so callers running several probes keep going; non-zero exit for scripts.
  Write-Output ("HTTP {0}: {1}" -f $code, $detail)
  $global:LASTEXITCODE = 1
  return
}

if ($Json) { $resp | ConvertTo-Json -Depth 8 }
elseif ($resp -is [System.Array] -and $resp.Count -gt 0) { $resp | Format-Table -AutoSize | Out-String -Width 220 }
else { $resp | ConvertTo-Json -Depth 8 -Compress }
