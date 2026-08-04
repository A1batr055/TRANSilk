param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][string]$OutPath
)

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
    $document = $word.Documents.Open($Path, $false, $true, $false)
    try {
        $document.SaveAs2($OutPath, 16)
    } finally {
        $document.Close(0)
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($document) | Out-Null
    }
} finally {
    $word.Quit()
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null
}
