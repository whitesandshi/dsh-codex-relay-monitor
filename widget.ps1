$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$statusUri = 'http://127.0.0.1:7297/codex-relay/status'
$pidFile = Join-Path $env:TEMP 'codex-relay-widget.pid'
Set-Content -Path $pidFile -Value $PID -Encoding ascii

function Brush([string]$hex) {
  New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($hex))
}

function New-Line([double]$size, [string]$color) {
  $block = New-Object System.Windows.Controls.TextBlock
  $block.FontFamily = New-Object System.Windows.Media.FontFamily 'Microsoft YaHei UI'
  $block.FontSize = $size
  $block.Foreground = Brush $color
  $block.TextWrapping = 'Wrap'
  $block.Margin = New-Object System.Windows.Thickness 0, 1, 0, 1
  return $block
}

$window = New-Object System.Windows.Window
$window.WindowStyle = [System.Windows.WindowStyle]::None
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.Title = 'Codex 链路监控'
$window.SizeToContent = [System.Windows.SizeToContent]::WidthAndHeight
$window.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
$window.Add_Loaded({
  $area = [System.Windows.SystemParameters]::WorkArea
  $window.Left = $area.Right - $window.ActualWidth - 16
  $window.Top = $area.Bottom - $window.ActualHeight - 220
})

$root = New-Object System.Windows.Controls.Border
$root.Width = 330
$root.CornerRadius = New-Object System.Windows.CornerRadius 10
$root.Background = Brush '#FF1F2024'
$root.BorderBrush = Brush '#33FFFFFF'
$root.BorderThickness = New-Object System.Windows.Thickness 1
$root.Padding = New-Object System.Windows.Thickness 10, 8, 10, 8
$window.Content = $root

$panel = New-Object System.Windows.Controls.StackPanel
$root.Child = $panel

$header = New-Object System.Windows.Controls.DockPanel
$panel.Children.Add($header) | Out-Null

$close = New-Object System.Windows.Controls.Button
$close.Content = '×'
$close.Width = 18
$close.Height = 18
$close.Padding = New-Object System.Windows.Thickness 0
$close.FontSize = 12
$close.Background = [System.Windows.Media.Brushes]::Transparent
$close.Foreground = Brush '#9AA0A6'
$close.BorderThickness = New-Object System.Windows.Thickness 0
$close.Cursor = [System.Windows.Input.Cursors]::Hand
$close.Add_Click({ $window.Close() })
$close.Add_PreviewMouseLeftButtonDown({ param($s, $e) $e.Handled = $true })
[System.Windows.Controls.DockPanel]::SetDock($close, [System.Windows.Controls.Dock]::Right)
$header.Children.Add($close) | Out-Null

$titleRow = New-Object System.Windows.Controls.StackPanel
$titleRow.Orientation = [System.Windows.Controls.Orientation]::Horizontal
$header.Children.Add($titleRow) | Out-Null

$dot = New-Object System.Windows.Shapes.Ellipse
$dot.Width = 8
$dot.Height = 8
$dot.Fill = Brush '#8B949E'
$dot.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
$dot.Margin = New-Object System.Windows.Thickness 0, 0, 6, 0
$titleRow.Children.Add($dot) | Out-Null

$title = New-Line 12 '#E6E6E6'
$title.Text = 'Codex 链路'
$title.FontWeight = [System.Windows.FontWeights]::SemiBold
$title.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
$titleRow.Children.Add($title) | Out-Null

$status = New-Line 12 '#8B949E'
$status.Text = '连接中…'
$status.Margin = New-Object System.Windows.Thickness 6, 0, 0, 0
$status.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
$titleRow.Children.Add($status) | Out-Null

$relayLine = New-Line 11.5 '#9AA0A6'
$relayLine.Text = 'relay —'
$panel.Children.Add($relayLine) | Out-Null

$requestLine = New-Line 11.5 '#E6E6E6'
$requestLine.Text = ''
$panel.Children.Add($requestLine) | Out-Null

$countLine = New-Line 11.5 '#9AA0A6'
$countLine.Text = '过载 0 · 断流 0 · 恢复 0'
$panel.Children.Add($countLine) | Out-Null

$eventLine = New-Line 11.5 '#9AA0A6'
$eventLine.Text = ''
$panel.Children.Add($eventLine) | Out-Null

$footer = New-Line 10.5 '#6E7681'
$footer.Text = ''
$panel.Children.Add($footer) | Out-Null

$root.Add_MouseLeftButtonDown({ try { $window.DragMove() } catch { } })

function Format-When($value) {
  try { return [System.DateTimeOffset]::FromUnixTimeMilliseconds([int64]$value).LocalDateTime.ToString('HH:mm:ss') } catch { return '--:--:--' }
}

function Update-Widget {
  try {
    $snap = Invoke-RestMethod -Uri $statusUri -TimeoutSec 2
  } catch {
    $dot.Fill = Brush '#E5534B'
    $status.Text = '接口未连接'
    $status.Foreground = Brush '#E5534B'
    $relayLine.Text = 'Harness 未响应，稍后重试'
    $requestLine.Text = ''
    $countLine.Text = ''
    $eventLine.Text = ''
    $footer.Text = ''
    return
  }

  $relayUp = [bool]$snap.relay.up
  $running = [bool]$snap.running
  $active = $snap.active
  $retrying = $false
  $overloaded = $false
  if ($running -and $active -ne $null) {
    $retrying = ($active.status -eq 'retrying')
    if ($retrying -and $active.reason -match 'overload|capacity|429|50[0234]') { $overloaded = $true }
  }

  if (-not $relayUp) {
    $dot.Fill = Brush '#E5534B'
    $status.Text = 'relay 未运行'
    $status.Foreground = Brush '#E5534B'
  } elseif ($overloaded) {
    $dot.Fill = Brush '#E0A23A'
    $status.Text = '过载重试中'
    $status.Foreground = Brush '#E0A23A'
  } elseif ($retrying) {
    $dot.Fill = Brush '#E0A23A'
    $status.Text = '断流重连中'
    $status.Foreground = Brush '#E0A23A'
  } elseif ($running) {
    $dot.Fill = Brush '#4C9AFF'
    $status.Text = '任务运行中'
    $status.Foreground = Brush '#4C9AFF'
  } else {
    $dot.Fill = Brush '#8B949E'
    $status.Text = '空闲'
    $status.Foreground = Brush '#8B949E'
  }

  $relayLine.Text = 'relay ' + $(if ($relayUp) { '在线' } else { '未运行' }) + ' · ' + (Split-Path $snap.relay.logPath -Leaf)

  if ($running -and $active -ne $null) {
    $model = if ($active.model) { $active.model } else { '?' }
    $kb = [math]::Round([double]$active.bytes / 1024)
    $attempt = [math]::Max(1, [int]$active.attempt)
    $secs = [math]::Round([double]$active.ageMs / 1000)
    $served = $active.served
    if ($served) {
      $requestLine.Text = "$model → $served · ${kb} KB · 第 ${attempt} 次 · ${secs}s"
      if ($served -ne $model) { $requestLine.Foreground = Brush '#E5534B' } else { $requestLine.Foreground = Brush '#E6E6E6' }
    } else {
      $requestLine.Text = "$model · ${kb} KB · 第 ${attempt} 次 · ${secs}s"
      $requestLine.Foreground = Brush '#E6E6E6'
    }
    if ($retrying -and $active.reason) { $requestLine.Text = $requestLine.Text + "`n" + $active.reason }
  } else {
    $requestLine.Text = '当前没有进行中的请求'
  }

  $countLine.Text = '过载 ' + $snap.window.overload + ' · 断流 ' + $snap.window.reconnect + ' · 恢复 ' + $snap.window.recovered
  if ($snap.window.gaveUp -gt 0) { $countLine.Text = $countLine.Text + ' · 放弃 ' + $snap.window.gaveUp }
  if ($snap.window.reroute -gt 0) { $countLine.Text = $countLine.Text + ' · 换模型 ' + $snap.window.reroute }

  if ($snap.events -ne $null -and $snap.events.Count -gt 0) {
    $eventLine.Text = (Format-When $snap.events[0].at) + '  ' + $snap.events[0].text
  } else {
    $eventLine.Text = '最近 5 分钟没有事件'
  }
  if ($eventLine.Text.Length -gt 46) { $eventLine.Text = $eventLine.Text.Substring(0, 46) + '…' }

  $footer.Text = '更新于 ' + (Get-Date -Format 'HH:mm:ss')
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(2)
$timer.Add_Tick({ Update-Widget })
$timer.Start()

Update-Widget
$window.ShowDialog() | Out-Null
Remove-Item -Path $pidFile -ErrorAction SilentlyContinue
