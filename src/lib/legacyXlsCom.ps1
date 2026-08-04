param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][string]$OutPath
)


$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$workbooks = $null
$wb = $null
$worksheets = $null
$ws = $null
$used = $null
$usedRows = $null
$cells = $null
try {
    $workbooks = $excel.Workbooks
    $wb = $workbooks.Open($Path, 0, $true)
    $worksheets = $wb.Worksheets
    $ws = $worksheets.Item(1)
    $used = $ws.UsedRange
    $cells = $ws.Cells
    $usedRows = $used.Rows
    $rows = $usedRows.Count
    $result = @()
    for ($r = 1; $r -le $rows; $r++) {
        $seqCell = $cells.Item($r, 1)
        $srcCell = $cells.Item($r, 2)
        $tgtCell = $cells.Item($r, 3)
        try {
            $seq = $seqCell.Text
            $src = $srcCell.Text
            $tgt = $tgtCell.Text
        } finally {
            [System.Runtime.Interopservices.Marshal]::ReleaseComObject($seqCell) | Out-Null
            [System.Runtime.Interopservices.Marshal]::ReleaseComObject($srcCell) | Out-Null
            [System.Runtime.Interopservices.Marshal]::ReleaseComObject($tgtCell) | Out-Null
        }
        $result += [PSCustomObject]@{ row = $r; seq = $seq; source = $src; target = $tgt }
    }
    $wb.Close($false)
} finally {
    if ($usedRows -ne $null) { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($usedRows) | Out-Null }
    if ($used -ne $null) { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($used) | Out-Null }
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

$result | ConvertTo-Json -Depth 3 | Out-File -FilePath $OutPath -Encoding utf8
