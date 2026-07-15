$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$frontend = Join-Path $repo 'frontend'
$tauri = Join-Path $frontend 'src-tauri'

Push-Location $frontend
try {
    npm.cmd run tauri icon src-tauri/syzygy-icon.svg
} finally {
    Pop-Location
}

Add-Type -AssemblyName System.Drawing

$paper = [System.Drawing.ColorTranslator]::FromHtml('#F6F2E7')
$panel = [System.Drawing.ColorTranslator]::FromHtml('#FBF8F0')
$ink = [System.Drawing.ColorTranslator]::FromHtml('#0B1D2A')
$blue = [System.Drawing.ColorTranslator]::FromHtml('#2E5C8A')
$teal = [System.Drawing.ColorTranslator]::FromHtml('#4C7F7A')
$ochre = [System.Drawing.ColorTranslator]::FromHtml('#D6A24C')

function New-Canvas([int]$width, [int]$height) {
    $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $graphics.Clear($paper)
    return @($bitmap, $graphics)
}

function Draw-Mark($graphics, [float]$centerX, [float]$centerY, [float]$scale) {
    $axisPen = [System.Drawing.Pen]::new($teal, 2.4 * $scale)
    $axisPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $axisPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $inkBrush = [System.Drawing.SolidBrush]::new($ink)
    $blueBrush = [System.Drawing.SolidBrush]::new($blue)
    $ochreBrush = [System.Drawing.SolidBrush]::new($ochre)
    try {
        $graphics.DrawLine($axisPen, $centerX - 48 * $scale, $centerY, $centerX + 48 * $scale, $centerY)
        $graphics.FillEllipse($inkBrush, $centerX - 42 * $scale, $centerY - 8 * $scale, 16 * $scale, 16 * $scale)
        $graphics.FillEllipse($inkBrush, $centerX + 26 * $scale, $centerY - 8 * $scale, 16 * $scale, 16 * $scale)
        $graphics.FillEllipse($blueBrush, $centerX - 14 * $scale, $centerY - 14 * $scale, 28 * $scale, 28 * $scale)
        $graphics.FillEllipse($ochreBrush, $centerX + 14 * $scale, $centerY - 22 * $scale, 5 * $scale, 5 * $scale)
    } finally {
        $axisPen.Dispose()
        $inkBrush.Dispose()
        $blueBrush.Dispose()
        $ochreBrush.Dispose()
    }
}

$sidebarParts = New-Canvas 164 314
$sidebar = $sidebarParts[0]
$sidebarGraphics = $sidebarParts[1]
try {
    $borderPen = [System.Drawing.Pen]::new($ink, 2)
    $titleBrush = [System.Drawing.SolidBrush]::new($ink)
    $metaBrush = [System.Drawing.SolidBrush]::new($teal)
    $titleFont = [System.Drawing.Font]::new('Segoe UI', 21, [System.Drawing.FontStyle]::Bold)
    $metaFont = [System.Drawing.Font]::new('Consolas', 7.5, [System.Drawing.FontStyle]::Bold)
    try {
        $sidebarGraphics.DrawRectangle($borderPen, 11, 11, 141, 291)
        Draw-Mark $sidebarGraphics 82 102 1.15
        $titleFormat = [System.Drawing.StringFormat]::new()
        $titleFormat.Alignment = [System.Drawing.StringAlignment]::Center
        $sidebarGraphics.DrawString('SYZYGY', $titleFont, $titleBrush, [System.Drawing.RectangleF]::new(0, 155, 164, 40), $titleFormat)
        $sidebarGraphics.DrawString('LOCAL-FIRST RESEARCH', $metaFont, $metaBrush, [System.Drawing.RectangleF]::new(0, 207, 164, 18), $titleFormat)
        $sidebarGraphics.DrawString('BY PENUMBRA', $metaFont, $metaBrush, [System.Drawing.RectangleF]::new(0, 270, 164, 18), $titleFormat)
        $titleFormat.Dispose()
    } finally {
        $borderPen.Dispose()
        $titleBrush.Dispose()
        $metaBrush.Dispose()
        $titleFont.Dispose()
        $metaFont.Dispose()
    }
    $sidebar.Save((Join-Path $tauri 'installer/sidebar.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
} finally {
    $sidebarGraphics.Dispose()
    $sidebar.Dispose()
}

$headerParts = New-Canvas 150 57
$header = $headerParts[0]
$headerGraphics = $headerParts[1]
try {
    $titleBrush = [System.Drawing.SolidBrush]::new($ink)
    $titleFont = [System.Drawing.Font]::new('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
    try {
        Draw-Mark $headerGraphics 38 28 0.45
        $headerGraphics.DrawString('SYZYGY', $titleFont, $titleBrush, 65, 17)
    } finally {
        $titleBrush.Dispose()
        $titleFont.Dispose()
    }
    $header.Save((Join-Path $tauri 'installer/header.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
} finally {
    $headerGraphics.Dispose()
    $header.Dispose()
}

Write-Host 'Generated Syzygy platform icons and NSIS artwork.'
