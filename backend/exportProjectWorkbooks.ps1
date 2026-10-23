param(
  [string]$OutputPath = (Join-Path $env:TEMP 'csr_project_workbooks.json')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$files = @(
  'Hinjewadi CSR data.xlsx',
  'CSR_Delhi_NCR_Companies_50_Completed Work.xlsx',
  'Akshar_Bharati_Chennai_CSR_Companies.xlsx'
)
$books = @()
foreach ($file in $files) {
  $path = Join-Path (Split-Path $PSScriptRoot -Parent) $file
  if (-not (Test-Path -LiteralPath $path)) { throw "Workbook not found: $path" }
  $zip = [IO.Compression.ZipFile]::OpenRead($path)
  try {
    $shared = @()
    $stringsEntry = $zip.GetEntry('xl/sharedStrings.xml')
    if ($stringsEntry) {
      $reader = [IO.StreamReader]::new($stringsEntry.Open())
      try { $strings = [xml]$reader.ReadToEnd() } finally { $reader.Dispose() }
      foreach ($item in $strings.SelectNodes('//*[local-name()="si"]')) {
        $shared += (($item.SelectNodes('.//*[local-name()="t"]') | ForEach-Object InnerText) -join '')
      }
    }
    $readXml = {
      param($entryName)
      $entry = $zip.GetEntry($entryName)
      if (-not $entry) { throw "Workbook entry not found: $entryName" }
      $reader = [IO.StreamReader]::new($entry.Open())
      try { return [xml]$reader.ReadToEnd() } finally { $reader.Dispose() }
    }
    $workbook = & $readXml 'xl/workbook.xml'
    $relationships = & $readXml 'xl/_rels/workbook.xml.rels'
    $sheets = @()
    foreach ($sheet in $workbook.SelectNodes('//*[local-name()="sheets"]/*[local-name()="sheet"]')) {
      $relId = $sheet.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
      $relationship = $relationships.SelectNodes('//*[local-name()="Relationship"]') |
        Where-Object { $_.GetAttribute('Id') -eq $relId }
      $target = $relationship.GetAttribute('Target').TrimStart('/')
      $entry = $zip.GetEntry($target)
      if (-not $entry) { $entry = $zip.GetEntry("xl/$target") }
      if (-not $entry) { throw "Worksheet XML not found for $($sheet.GetAttribute('name'))" }
      $reader = [IO.StreamReader]::new($entry.Open())
      try { $xml = [xml]$reader.ReadToEnd() } finally { $reader.Dispose() }
      $rows = @()
      foreach ($row in $xml.SelectNodes('//*[local-name()="sheetData"]/*[local-name()="row"]')) {
        $values = [ordered]@{}
        foreach ($cell in $row.SelectNodes('./*[local-name()="c"]')) {
          $letters = ([regex]::Match($cell.GetAttribute('r'), '^[A-Z]+')).Value
          $column = 0
          foreach ($letter in $letters.ToCharArray()) { $column = $column * 26 + ([int]$letter - [int][char]'A' + 1) }
          $valueNode = $cell.SelectSingleNode('./*[local-name()="v"]')
          $value = if ($valueNode) { $valueNode.InnerText } else { '' }
          if ($cell.GetAttribute('t') -eq 's' -and $value) { $value = $shared[[int]$value] }
          elseif ($cell.GetAttribute('t') -eq 'inlineStr') {
            $value = (($cell.SelectNodes('.//*[local-name()="t"]') | ForEach-Object InnerText) -join '')
          }
          $values[[string]$column] = $value
        }
        $rows += ,$values
      }
      $sheets += @{ name = $sheet.GetAttribute('name'); rows = $rows }
    }
    $books += @{ file = $file; sheets = $sheets }
  }
  finally { $zip.Dispose() }
}

$json = ConvertTo-Json -InputObject $books -Depth 20 -Compress
[IO.File]::WriteAllText($OutputPath, $json, [Text.UTF8Encoding]::new($false))
foreach ($book in $books) {
  foreach ($sheet in $book.sheets) {
    $dataRows = @($sheet.rows | Where-Object { $_.Values | Where-Object { $_ -ne '' } })
    if ($dataRows.Count -gt 0) { $dataRows = $dataRows | Select-Object -Skip 1 }
    Write-Output "$($book.file) | $($sheet.name) | $($dataRows.Count) non-header rows"
  }
}
Write-Output "Workbook data exported to $OutputPath"
