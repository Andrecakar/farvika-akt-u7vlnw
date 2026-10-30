# Bygger spelsidan: krymper bilderna i "material" och skriver docs\data.json.
# Kor:  powershell -ExecutionPolicy Bypass -File .\bygg.ps1 -Kod "hemligkod" -Titel "Mordet pa ..."
# (Skriptet ar medvetet ASCII-only for att Windows PowerShell 5.1 inte ska forvanska tecken.)
param(
  [string]$Kod = "mordet",
  [string]$Titel = "Mordmysteriet",
  [int]$MaxSida = 2000,
  [int]$MaxOmslag = 480
)

Add-Type -AssemblyName System.Drawing

$root    = $PSScriptRoot
$src     = Join-Path $root "material"
$out     = Join-Path $root "docs"
$outImg  = Join-Path $out "bilder"
$exts    = @(".jpg", ".jpeg", ".png", ".bmp", ".gif")
$salt    = "mordspel:"

if (-not (Test-Path $src)) { New-Item -ItemType Directory -Path $src | Out-Null }
if (Test-Path $outImg) { Remove-Item $outImg -Recurse -Force }
New-Item -ItemType Directory -Path $outImg | Out-Null

$jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }

function Get-NaturalSorted($items) {
  $items | Sort-Object { [regex]::Replace($_.Name, '\d+', { param($m) $m.Value.PadLeft(10, '0') }) }
}

function Get-Title([string]$name) {
  $t = [System.IO.Path]::GetFileNameWithoutExtension($name)
  $t = $t -replace '^\d+[\s._-]+', ''
  $t = $t -replace '_', ' '
  if ([string]::IsNullOrWhiteSpace($t)) { $t = [System.IO.Path]::GetFileNameWithoutExtension($name) }
  return $t.Trim()
}

function Save-Resized([string]$file, [string]$dest, [int]$max, [int]$quality) {
  $img = [System.Drawing.Image]::FromFile($file)
  try {
    # Mobilfoton ar ofta sparade "liggande" med EXIF-rotation - tillampa den manuellt.
    if ($img.PropertyIdList -contains 0x0112) {
      $o = $img.GetPropertyItem(0x0112).Value[0]
      switch ($o) {
        3 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone) }
        6 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }
        8 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone) }
      }
    }
    $scale = [Math]::Min(1.0, $max / [double][Math]::Max($img.Width, $img.Height))
    $w = [int][Math]::Round($img.Width * $scale)
    $h = [int][Math]::Round($img.Height * $scale)
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.DrawImage($img, 0, 0, $w, $h)
      $p = New-Object System.Drawing.Imaging.EncoderParameters 1
      $p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$quality)
      $bmp.Save($dest, $jpeg, $p)
    } finally { $g.Dispose(); $bmp.Dispose() }
  } finally { $img.Dispose() }
}

function Get-ImageFiles($dir) {
  Get-NaturalSorted (Get-ChildItem -LiteralPath $dir -File | Where-Object { $exts -contains $_.Extension.ToLower() })
}

# Hitta ev. filer som vi inte kan lasa (t.ex. iPhone-HEIC) och varna.
Get-ChildItem -LiteralPath $src -File -Recurse | Where-Object { @(".heic", ".heif", ".webp") -contains $_.Extension.ToLower() } | ForEach-Object {
  Write-Warning ("Hoppar over {0}: formatet stods inte. Spara om som JPG (iPhone: Installningar > Kamera > Format > Mest kompatibel)." -f $_.FullName)
}

$cats = @()
$catNo = 0

# Kategorier = undermappar i material. Lösa bilder direkt i material hamnar i "Ovrigt".
$catDirs = @(Get-NaturalSorted (Get-ChildItem -LiteralPath $src -Directory))
$looseRoot = @(Get-ImageFiles $src)
$groups = @()
foreach ($d in $catDirs) { $groups += , @{ Name = (Get-Title $d.Name); Dir = $d.FullName } }
if ($looseRoot.Count -gt 0) { $groups += , @{ Name = ([string][char]0xD6 + "vrigt"); Dir = $src; OnlyLoose = $true } }

foreach ($grp in $groups) {
  $catNo++
  $docs = @()
  $docNo = 0

  # Varje undermapp i kategorin = ett dokument med flera sidor.
  if (-not $grp.OnlyLoose) {
    foreach ($dd in (Get-NaturalSorted (Get-ChildItem -LiteralPath $grp.Dir -Directory))) {
      $files = @(Get-ImageFiles $dd.FullName)
      if ($files.Count -eq 0) { continue }
      $docNo++
      $pages = @(); $pageNo = 0
      foreach ($f in $files) {
        $pageNo++
        $name = "{0}-{1}-{2}.jpg" -f $catNo, $docNo, $pageNo
        Save-Resized $f.FullName (Join-Path $outImg $name) $MaxSida 82
        $pages += ("bilder/" + $name)
      }
      $cover = "{0}-{1}-t.jpg" -f $catNo, $docNo
      Save-Resized $files[0].FullName (Join-Path $outImg $cover) $MaxOmslag 75
      $docs += [ordered]@{ id = "$catNo-$docNo"; titel = (Get-Title $dd.Name); omslag = ("bilder/" + $cover); sidor = $pages }
    }
  }

  # Losa bilder direkt i kategorin = ett dokument per bild.
  foreach ($f in (Get-ImageFiles $grp.Dir)) {
    $docNo++
    $name = "{0}-{1}-1.jpg" -f $catNo, $docNo
    $cover = "{0}-{1}-t.jpg" -f $catNo, $docNo
    Save-Resized $f.FullName (Join-Path $outImg $name) $MaxSida 82
    Save-Resized $f.FullName (Join-Path $outImg $cover) $MaxOmslag 75
    $docs += [ordered]@{ id = "$catNo-$docNo"; titel = (Get-Title $f.Name); omslag = ("bilder/" + $cover); sidor = @("bilder/" + $name) }
  }

  if ($docs.Count -gt 0) { $cats += [ordered]@{ namn = $grp.Name; dokument = $docs } }
}

# Koden lagras som SHA-256-hash (inte i klartext). Inte kryptografiskt skydd, men haller nyfikna ute.
$sha = [System.Security.Cryptography.SHA256]::Create()
$hashBytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($salt + $Kod.Trim().ToLower()))
$hash = ($hashBytes | ForEach-Object { $_.ToString("x2") }) -join ""

$manifest = [ordered]@{ titel = $Titel; salt = $salt; kodHash = $hash; kategorier = $cats }
$json = ConvertTo-Json -InputObject $manifest -Depth 8
[System.IO.File]::WriteAllText((Join-Path $out "data.json"), $json, (New-Object System.Text.UTF8Encoding $false))

$totalDocs = ($cats | ForEach-Object { $_.dokument.Count } | Measure-Object -Sum).Sum
$sizeMb = [Math]::Round(((Get-ChildItem $outImg -File | Measure-Object Length -Sum).Sum) / 1MB, 1)
Write-Host ("Klart: {0} kategorier, {1} dokument, {2} MB bilder. Kod: {3}" -f $cats.Count, $totalDocs, $sizeMb, $Kod)
