param(
    [Parameter(Mandatory=$true)][string]$SourcePath,
    [Parameter(Mandatory=$true)][string]$OutPath,
    [Parameter(Mandatory=$true)][string]$TranslationsJsonPath
)


$json = Get-Content -Path $TranslationsJsonPath -Raw -Encoding UTF8
$translations = $json | ConvertFrom-Json

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$workbooks = $null
$wb = $null
$worksheets = $null
$ws = $null
$cells = $null
try {
    $workbooks = $excel.Workbooks
    $wb = $workbooks.Open($SourcePath, 0, $false)
    $worksheets = $wb.Worksheets
    $ws = $worksheets.Item(1)
    $cells = $ws.Cells
    foreach ($t in $translations) {
        $cell = $cells.Item([int]$t.row, 3)
        try {
            $cell.Value2 = $t.text
        } finally {
            [System.Runtime.Interopservices.Marshal]::ReleaseComObject($cell) | Out-Null
        }
    }
    $extension = [System.IO.Path]::GetExtension($OutPath).ToLowerInvariant()
    $fileFormat = if ($extension -eq ".xlsx") { 51 } else { 56 }
    $wb.SaveAs($OutPath, $fileFormat)
    $wb.Close($false)
} finally {
    if ($cells -ne $null) { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($cells) | Out-Null }
    if ($ws -ne $null) { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($ws) | Out-Null }
    if ($worksheets -ne $null) { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($worksheets) | Out-Null }
    if ($wb -ne $null) { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($wb) | Out-Null }
    if ($workbooks -ne $null) { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($workbooks) | Out-Null }
    $excel.Quit()
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
