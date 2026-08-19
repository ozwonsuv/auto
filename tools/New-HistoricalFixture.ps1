param(
  [string]$Date = '2026-08-19',
  [string]$OutputRoot = '',
  [string]$FixturePath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '..'))
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $OutputRoot = Join-Path $workspaceRoot 'output'
}
if ([string]::IsNullOrWhiteSpace($FixturePath)) {
  $FixturePath = Join-Path $projectRoot "tests\fixtures\$Date.json"
}

$sourceDir = Join-Path $OutputRoot $Date
$postDataPath = Join-Path $sourceDir 'post_data.json'
$fragmentPath = Join-Path $sourceDir 'manual_copy_fragment.html'
$plainTextPath = Join-Path $sourceDir 'manual_copy_text.txt'
foreach ($requiredPath in @($postDataPath, $fragmentPath, $plainTextPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Historical source file not found: $requiredPath"
  }
}

$postData = Get-Content -LiteralPath $postDataPath -Raw -Encoding UTF8 | ConvertFrom-Json
$translations = [ordered]@{}
$generalChallenges = New-Object System.Collections.Generic.List[object]
$roleChallenges = [ordered]@{
  bounty_hunter = New-Object System.Collections.Generic.List[object]
  trader = New-Object System.Collections.Generic.List[object]
  collector = New-Object System.Collections.Generic.List[object]
  moonshiner = New-Object System.Collections.Generic.List[object]
  naturalist = New-Object System.Collections.Generic.List[object]
}

function New-FixtureChallenge {
  param($Line)

  $text = [string]$Line.text
  $separator = $text.LastIndexOf(':')
  $progress = if ($separator -ge 0) { $text.Substring($separator + 1).Trim() } else { '0/1' }
  $localizedLabel = [string]$Line.localizedLabel
  $challengeKey = [string]$Line.challengeKey
  $translations[$challengeKey.ToLowerInvariant()] = $localizedLabel

  return [ordered]@{
    description = [ordered]@{
      label = $challengeKey
      localized = $localizedLabel
      localizedFull = "$progress $localizedLabel"
    }
  }
}

foreach ($line in $postData.lines) {
  if ([string]$line.type -ne 'challenge') {
    continue
  }

  $challenge = New-FixtureChallenge -Line $line
  $section = [string]$line.section
  if ($section -eq 'general') {
    $generalChallenges.Add($challenge)
  }
  else {
    $roleChallenges[$section].Add($challenge)
  }
}

$hardRoles = New-Object System.Collections.Generic.List[object]
foreach ($section in $roleChallenges.Keys) {
  $hardRoles.Add([ordered]@{
    role = 'CHARACTER_RANK_' + $section.ToUpperInvariant()
    challenges = $roleChallenges[$section].ToArray()
  })
}

$expectedLines = @($postData.lines | ForEach-Object {
  $line = [ordered]@{
    type = [string]$_.type
    section = [string]$_.section
    text = [string]$_.text
  }
  if ([string]$_.type -eq 'challenge') {
    $line.source = [string]$_.source
    $line.challengeKey = [string]$_.challengeKey
    $line.localizedLabel = [string]$_.localizedLabel
  }
  elseif ([string]$_.type -eq 'nazar') {
    $line.nazarCode = [string]$_.nazarCode
    $line.nazarLocation = [string]$_.nazarLocation
  }
  $line
})

$generatedAtKst = [string]$postData.generatedAtKst
$fixtureNow = [DateTimeOffset]::ParseExact(
  $generatedAtKst + ' +09:00',
  'yyyy-MM-dd HH:mm:ss zzz',
  [System.Globalization.CultureInfo]::InvariantCulture
).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')

$fixture = [ordered]@{
  now = $fixtureNow
  dailyData = [ordered]@{
    date = [string]$postData.date
    data = [ordered]@{
      general = [ordered]@{ challenges = $generalChallenges.ToArray() }
      hard = $hardRoles.ToArray()
    }
  }
  nazarData = [ordered]@{
    date = [string]$postData.nazarApiDate
    nazar = [string]$postData.nazarCode
  }
  translations = $translations
  expected = [ordered]@{
    title = [string]$postData.title
    headText = [string]$postData.headText
    nazarCode = [string]$postData.nazarCode
    nazarLocation = [string]$postData.nazarLocation
    lines = $expectedLines
    fallbacks = @($postData.fallbacks)
    fragmentHtml = (Get-Content -LiteralPath $fragmentPath -Raw -Encoding UTF8).Trim()
    plainText = (Get-Content -LiteralPath $plainTextPath -Raw -Encoding UTF8).TrimEnd("`r", "`n")
  }
}

$parent = Split-Path -Parent $FixturePath
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$json = $fixture | ConvertTo-Json -Depth 20 -Compress
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($FixturePath, $json + [Environment]::NewLine, $utf8NoBom)

Get-Item -LiteralPath $FixturePath | Select-Object FullName, Length
