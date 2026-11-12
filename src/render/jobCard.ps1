# Renders one 1080x1350 PNG card per job spec. Called by src/jobCard.js.
# Input: a UTF-8 JSON file holding an array of card specs (see buildCardSpec).
param(
  [Parameter(Mandatory = $true)][string]$SpecPath,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$Handle = ""
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$CardW = 1080; $CardH = 1350; $Pad = 84
$FontName = "Segoe UI"
$specs = Get-Content -Raw -Encoding UTF8 $SpecPath | ConvertFrom-Json

function Color([string]$hex, [int]$alpha = 255) {
  $c = [System.Drawing.ColorTranslator]::FromHtml($hex)
  return [System.Drawing.Color]::FromArgb($alpha, $c.R, $c.G, $c.B)
}

function Rect([float]$x, [float]$y, [float]$w, [float]$h) {
  return New-Object System.Drawing.RectangleF($x, $y, $w, $h)
}

function RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# Largest size from $sizes at which $text fits in $maxLines lines of $width.
function FitFont($g, [string]$text, [float]$width, [int]$maxLines, [int[]]$sizes) {
  foreach ($size in $sizes) {
    $font = New-Object System.Drawing.Font($FontName, $size, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $measured = $g.MeasureString($text, $font, [int]$width)
    if ($measured.Height -le ($font.GetHeight($g) * $maxLines + 2)) { return $font }
    $font.Dispose()
  }
  return New-Object System.Drawing.Font($FontName, $sizes[-1], [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
}

function DrawPill($g, [string]$text, [float]$x, [float]$y, $font, $fill, $border, $textBrush) {
  $size = $g.MeasureString($text, $font)
  $w = $size.Width + 44; $h = $size.Height + 18
  $path = RoundRect $x $y $w $h ($h / 2)
  if ($fill) { $g.FillPath($fill, $path) }
  if ($border) { $g.DrawPath($border, $path) }
  $g.DrawString($text, $font, $textBrush, $x + 22, $y + 9)
  $path.Dispose()
  return $w
}

function RenderCard($spec) {
  $bmp = New-Object System.Drawing.Bitmap($CardW, $CardH)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"
  $g.TextRenderingHint = "AntiAliasGridFit"
  $accent = Color $spec.accent

  # Background: deep navy gradient, a soft glow in the accent colour and a dot grid.
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.Point(0, 0)), (New-Object System.Drawing.Point($CardW, $CardH)), (Color "#0B1026"), (Color "#1E1B4B"))
  $g.FillRectangle($bg, 0, 0, $CardW, $CardH)
  foreach ($ring in 0..7) {
    $r = 520 - $ring * 55
    $glow = New-Object System.Drawing.SolidBrush((Color $spec.accent (10 + $ring * 4)))
    $g.FillEllipse($glow, $CardW - $r * 0.9, -$r * 0.55, $r * 1.6, $r * 1.6)
    $glow.Dispose()
  }
  $dot = New-Object System.Drawing.SolidBrush((Color "#FFFFFF" 18))
  for ($x = 40; $x -lt $CardW; $x += 44) { for ($y = 40; $y -lt $CardH; $y += 44) { $g.FillEllipse($dot, $x, $y, 3, 3) } }

  $white = New-Object System.Drawing.SolidBrush((Color "#FFFFFF"))
  $muted = New-Object System.Drawing.SolidBrush((Color "#C7D2FE"))
  $dim = New-Object System.Drawing.SolidBrush((Color "#94A3B8"))
  $ink = New-Object System.Drawing.SolidBrush((Color "#0B1026"))
  $accentBrush = New-Object System.Drawing.SolidBrush($accent)
  $px = [System.Drawing.GraphicsUnit]::Pixel
  $bold = [System.Drawing.FontStyle]::Bold

  # Badge
  $badgeFont = New-Object System.Drawing.Font($FontName, 30, $bold, $px)
  $y = 96
  [void](DrawPill $g "ĐANG TUYỂN  ·  WE'RE HIRING" $Pad $y $badgeFont $accentBrush $null $ink)

  # Company
  $y += 118
  $companyFont = New-Object System.Drawing.Font("$FontName Semibold", 40, [System.Drawing.FontStyle]::Regular, $px)
  $g.DrawString($spec.company.ToUpper(), $companyFont, $muted, (Rect ($Pad) ($y) (($CardW - 2 * $Pad)) (60)))

  # Title, as large as fits in four lines
  $y += 74
  $titleWidth = $CardW - 2 * $Pad
  $titleFont = FitFont $g $spec.title $titleWidth 4 @(104, 96, 88, 80, 72, 64, 58)
  $titleSize = $g.MeasureString($spec.title, $titleFont, [int]$titleWidth)
  $g.DrawString($spec.title, $titleFont, $white, (Rect ($Pad) ($y) ($titleWidth) ($titleSize.Height + 8)))
  $y += $titleSize.Height + 20
  $g.FillRectangle($accentBrush, $Pad, $y, 120, 10)
  $y += 52

  # Location and level
  $labelFont = New-Object System.Drawing.Font($FontName, 26, $bold, $px)
  $valueFont = New-Object System.Drawing.Font("$FontName Semibold", 38, [System.Drawing.FontStyle]::Regular, $px)
  $rows = @(, @("ĐỊA ĐIỂM", $spec.location))
  if ($spec.level) { $rows += , @("CẤP BẬC", $spec.level) }
  foreach ($row in $rows) {
    $g.DrawString($row[0], $labelFont, $accentBrush, $Pad, $y + 10)
    $g.DrawString($row[1], $valueFont, $white, (Rect (($Pad + 190)) ($y) (($CardW - 2 * $Pad - 190)) (56)))
    $y += 70
  }

  # Skill chips, wrapped across lines
  if ($spec.skills.Count -gt 0) {
    $y += 22
    $chipFont = New-Object System.Drawing.Font("$FontName Semibold", 30, [System.Drawing.FontStyle]::Regular, $px)
    $chipBorder = New-Object System.Drawing.Pen((Color $spec.accent 200), 3)
    $chipFill = New-Object System.Drawing.SolidBrush((Color "#FFFFFF" 14))
    $x = $Pad; $chipH = $g.MeasureString("Ag", $chipFont).Height + 18
    $lines = 0
    foreach ($skill in $spec.skills) {
      $w = $g.MeasureString($skill, $chipFont).Width + 44
      if ($x + $w -gt $CardW - $Pad) { $x = $Pad; $y += $chipH + 16; $lines++ }
      if ($lines -ge 2) { break }
      $x += (DrawPill $g $skill $x $y $chipFont $chipFill $chipBorder $white) + 14
    }
    $y += $chipH + 40
  }

  # Perks
  $perkFont = New-Object System.Drawing.Font("$FontName Semibold", 36, [System.Drawing.FontStyle]::Regular, $px)
  $checkFont = New-Object System.Drawing.Font($FontName, 26, $bold, $px)
  $perks = @($spec.perks) + @("Lương thỏa thuận, cạnh tranh")
  foreach ($perk in ($perks | Select-Object -First 4)) {
    if ($y -gt $CardH - 250) { break }
    $g.FillEllipse($accentBrush, $Pad, $y + 6, 40, 40)
    $g.DrawString([string][char]0x2713, $checkFont, $ink, $Pad + 7, $y + 7)
    $g.DrawString($perk, $perkFont, $white, $Pad + 64, $y)
    $y += 62
  }

  # Footer call to action
  $footerY = $CardH - 168
  $footerPath = RoundRect $Pad $footerY ($CardW - 2 * $Pad) 104 52
  $g.FillPath($white, $footerPath)
  $ctaFont = New-Object System.Drawing.Font($FontName, 38, $bold, $px)
  $cta = "Ứng tuyển ngay  →  aretalents.com"
  $ctaSize = $g.MeasureString($cta, $ctaFont)
  $g.DrawString($cta, $ctaFont, $ink, ($CardW - $ctaSize.Width) / 2, $footerY + (104 - $ctaSize.Height) / 2)
  if ($Handle) {
    $handleFont = New-Object System.Drawing.Font($FontName, 26, [System.Drawing.FontStyle]::Regular, $px)
    $handleSize = $g.MeasureString("@$Handle", $handleFont)
    $g.DrawString("@$Handle", $handleFont, $dim, ($CardW - $handleSize.Width) / 2, $CardH - 54)
  }

  $out = Join-Path $OutDir ("job-{0}.png" -f $spec.id)
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output $out
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
foreach ($spec in $specs) { RenderCard $spec }
