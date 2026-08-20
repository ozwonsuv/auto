param(
  [string]$WorkbookPath = '',
  [string]$FormattingRulesPath = '',
  [string]$NazarMappingPath = '',
  [string]$OutputDir = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '..'))

if ([string]::IsNullOrWhiteSpace($WorkbookPath)) {
  $WorkbookPath = Join-Path $HOME 'Downloads\오늘의 도전.xlsx'
}
if ([string]::IsNullOrWhiteSpace($FormattingRulesPath)) {
  $FormattingRulesPath = Join-Path $workspaceRoot 'data\PostFormattingRules.psd1'
}
if ([string]::IsNullOrWhiteSpace($NazarMappingPath)) {
  $NazarMappingPath = Join-Path $workspaceRoot 'data\NazarImageMap.psd1'
}
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $projectRoot 'data'
}

foreach ($requiredPath in @($WorkbookPath, $FormattingRulesPath, $NazarMappingPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Required source file not found: $requiredPath"
  }
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem

$roleHeaderToKey = @{
  '[현상금 사냥꾼]' = 'bounty_hunter'
  '[상인]' = 'trader'
  '[수집가]' = 'collector'
  '[밀주업자]' = 'moonshiner'
  '[박물학자]' = 'naturalist'
}

function Read-ZipText {
  param(
    [System.IO.Compression.ZipArchive]$Zip,
    [string]$EntryName
  )

  $entry = $Zip.Entries | Where-Object { $_.FullName -eq $EntryName } | Select-Object -First 1
  if ($null -eq $entry) {
    return $null
  }

  $reader = New-Object System.IO.StreamReader($entry.Open())
  try {
    return $reader.ReadToEnd()
  }
  finally {
    $reader.Dispose()
  }
}

function Get-XlsxSheets {
  param([string]$Path)

  $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
  try {
    $sharedStrings = @()
    $sharedStringsXml = Read-ZipText -Zip $zip -EntryName 'xl/sharedStrings.xml'
    if ($sharedStringsXml) {
      $sharedStringsDoc = [xml]$sharedStringsXml
      foreach ($stringItem in $sharedStringsDoc.sst.si) {
        $sharedStrings += $stringItem.InnerText
      }
    }

    $workbookDoc = [xml](Read-ZipText -Zip $zip -EntryName 'xl/workbook.xml')
    $relsDoc = [xml](Read-ZipText -Zip $zip -EntryName 'xl/_rels/workbook.xml.rels')
    $relationMap = @{}
    foreach ($relation in $relsDoc.Relationships.Relationship) {
      $relationMap[[string]$relation.Id] = [string]$relation.Target
    }

    $sheets = @{}
    foreach ($sheet in $workbookDoc.workbook.sheets.sheet) {
      $relationId = $sheet.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
      $target = 'xl/' + $relationMap[$relationId]
      $sheetDoc = [xml](Read-ZipText -Zip $zip -EntryName $target)
      $cellMap = @{}

      foreach ($row in $sheetDoc.worksheet.sheetData.row) {
        foreach ($cell in $row.c) {
          $value = ''
          $cellType = [string]$cell.GetAttribute('t')
          $valueNode = $cell.ChildNodes | Where-Object { $_.LocalName -eq 'v' } | Select-Object -First 1
          $inlineNode = $cell.ChildNodes | Where-Object { $_.LocalName -eq 'is' } | Select-Object -First 1

          if ($cellType -eq 's' -and $valueNode) {
            $sharedIndex = [int]$valueNode.InnerText
            if ($sharedIndex -ge 0 -and $sharedIndex -lt $sharedStrings.Count) {
              $value = $sharedStrings[$sharedIndex]
            }
          }
          elseif ($cellType -eq 'inlineStr' -and $inlineNode) {
            $value = $inlineNode.InnerText
          }
          elseif ($valueNode) {
            $value = $valueNode.InnerText
          }

          if (-not [string]::IsNullOrWhiteSpace($value)) {
            $cellMap[[string]$cell.r] = $value.Trim()
          }
        }
      }

      $sheets[[string]$sheet.name] = $cellMap
    }

    return $sheets
  }
  finally {
    $zip.Dispose()
  }
}

function Convert-ColumnLettersToNumber {
  param([string]$Letters)

  $value = 0
  foreach ($character in $Letters.ToCharArray()) {
    $value = ($value * 26) + ([int][char]::ToUpperInvariant($character) - [int][char]'A' + 1)
  }
  return $value
}

function Normalize-Text {
  param([AllowNull()][string]$Text)

  if ($null -eq $Text) {
    return ''
  }

  $normalized = $Text.Replace([char]0x00A0, ' ')
  $normalized = $normalized -replace '\s+', ' '
  return $normalized.Trim().ToLowerInvariant()
}

function Get-BaseChallengeText {
  param([string]$Text)

  $trimmed = $Text.Trim()
  $separator = $trimmed.LastIndexOf(':')
  if ($separator -gt 0) {
    return $trimmed.Substring(0, $separator).Trim()
  }
  return $trimmed
}

function Get-GoalDisplay {
  param([string]$Text)

  $trimmed = $Text.Trim()
  $separator = $trimmed.LastIndexOf(':')
  if ($separator -lt 0 -or $separator -eq ($trimmed.Length - 1)) {
    return ''
  }
  return $trimmed.Substring($separator + 1).Trim()
}

function Add-WorkbookEntry {
  param(
    [hashtable]$Store,
    [string]$FullText
  )

  $normalizedBase = Normalize-Text -Text (Get-BaseChallengeText -Text $FullText)
  if ([string]::IsNullOrWhiteSpace($normalizedBase)) {
    return
  }

  $entry = [ordered]@{
    text = $FullText.Trim()
    goal = Get-GoalDisplay -Text $FullText
  }

  if ($Store.ContainsKey($normalizedBase)) {
    $Store[$normalizedBase] += $entry
  }
  else {
    $Store[$normalizedBase] = @($entry)
  }
}

function Convert-ToOrderedMap {
  param([hashtable]$Source)

  $result = [ordered]@{}
  foreach ($key in ($Source.Keys | Sort-Object)) {
    $result[[string]$key] = $Source[$key]
  }
  return $result
}

function Write-Utf8Json {
  param(
    [object]$Value,
    [string]$Path
  )

  $json = $Value | ConvertTo-Json -Depth 20 -Compress
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, $utf8NoBom)
}

$sheets = Get-XlsxSheets -Path $WorkbookPath
$sections = @{
  general = @{}
  bounty_hunter = @{}
  trader = @{}
  collector = @{}
  moonshiner = @{}
  naturalist = @{}
}

$generalSheet = $sheets['오늘의 도전']
foreach ($cellRef in ($generalSheet.Keys | Sort-Object)) {
  if ($cellRef -notmatch '^([A-Z]+)(\d+)$') {
    continue
  }

  $columnNumber = Convert-ColumnLettersToNumber -Letters $matches[1]
  $rowNumber = [int]$matches[2]
  if ($rowNumber -ge 14 -and $columnNumber -ge 1 -and $columnNumber -le 14) {
    Add-WorkbookEntry -Store $sections.general -FullText ([string]$generalSheet[$cellRef])
  }
}

$roleSheet = $sheets['직업']
foreach ($cellRef in ($roleSheet.Keys | Sort-Object)) {
  if ($cellRef -notmatch '^([A-Z]+)(\d+)$') {
    continue
  }

  $columnLetters = $matches[1]
  $columnNumber = Convert-ColumnLettersToNumber -Letters $columnLetters
  $rowNumber = [int]$matches[2]
  if ($rowNumber -lt 2 -or $columnNumber -lt 1 -or $columnNumber -gt 5) {
    continue
  }

  $header = [string]$roleSheet["$columnLetters`1"]
  if ($roleHeaderToKey.ContainsKey($header)) {
    Add-WorkbookEntry -Store $sections[$roleHeaderToKey[$header]] -FullText ([string]$roleSheet[$cellRef])
  }
}

$orderedSections = [ordered]@{}
foreach ($sectionName in @('general', 'bounty_hunter', 'trader', 'collector', 'moonshiner', 'naturalist')) {
  $orderedSections[$sectionName] = Convert-ToOrderedMap -Source $sections[$sectionName]
}

$challengeData = [ordered]@{
  schemaVersion = 1
  source = [System.IO.Path]::GetFileName($WorkbookPath)
  sections = $orderedSections
}

$formattingRules = Import-PowerShellDataFile -Path $FormattingRulesPath
$nazarData = Import-PowerShellDataFile -Path $NazarMappingPath
$nazarMappings = [ordered]@{}
foreach ($code in ($nazarData.VerifiedMappings.Keys | Sort-Object)) {
  $mapping = $nazarData.VerifiedMappings[$code]
  $nazarMappings[[string]$code] = [ordered]@{
    location = [string]$mapping.Location
    imageUrl = [string]$mapping.SourceUrl
  }
}

$rulesData = [ordered]@{
  schemaVersion = 1
  headText = '오늘의도전'
  title = '한눈에 보는 오늘의 도전 + 마담 위치'
  roleDifficulty = 'hard'
  roleHeadings = [ordered]@{
    general = '[일반]'
    bounty_hunter = '[현상금 사냥꾼]'
    trader = '[상인]'
    collector = '[수집가]'
    moonshiner = '[밀주업자]'
    naturalist = '[박물학자]'
  }
  labelOverrides = [ordered]@{
    mpgc_roosters_skinned = '털 뽑은 수탉'
  }
  fallbackTextOverrides = Convert-ToOrderedMap -Source $formattingRules.FallbackTextOverrides
  challengeLineLinks = Convert-ToOrderedMap -Source $formattingRules.ChallengeLineLinks
  challengeKeyLinks = Convert-ToOrderedMap -Source $formattingRules.ChallengeKeyLinks
  timetable = [ordered]@{
    linkText = [string]$formattingRules.Timetable.LinkText
    url = [string]$formattingRules.Timetable.Url
    triggerPatterns = @($formattingRules.Timetable.TriggerPatterns | ForEach-Object { [string]$_ })
  }
  titleImageUrl = [string]$nazarData.TitleCard.SourceUrl
  nazarMappings = $nazarMappings
}

$challengePath = Join-Path $OutputDir 'challenges.json'
$rulesPath = Join-Path $OutputDir 'rules.json'
Write-Utf8Json -Value $challengeData -Path $challengePath
Write-Utf8Json -Value $rulesData -Path $rulesPath

$sectionCounts = [ordered]@{}
foreach ($sectionName in $orderedSections.Keys) {
  $count = 0
  foreach ($candidateList in $orderedSections[$sectionName].Values) {
    $count += @($candidateList).Count
  }
  $sectionCounts[$sectionName] = $count
}

[pscustomobject]@{
  ChallengeData = $challengePath
  RulesData = $rulesPath
  SectionCounts = $sectionCounts
  NazarMappings = $nazarMappings.Count
}
