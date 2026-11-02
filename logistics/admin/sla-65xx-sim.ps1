# Simulate wave-4 admSlaApplyNative + badge-cell rendering for LOG-65xx payloads.
$TBLISI = 4 * 3600e3
function WhSpan([long]$from, [long]$to) {
  if ($from -le 0 -or $to -le $from) { return 0 }
  $DAY = 86400000; $START = 2 * 3600e3; $END = 10 * 3600e3
  $f = ($from + $TBLISI) % $DAY; $t = ($to + $TBLISI) % $DAY
  $fd = [math]::Floor(($from + $TBLISI) / $DAY); $td = [math]::Floor(($to + $TBLISI) / $DAY)
  $total = 0
  for ($d = $fd; $d -le $td; $d++) {
    $date = [DateTimeOffset]::FromUnixTimeMilliseconds($d * $DAY - $TBLISI).UtcDateTime
    $dw = [int]$date.DayOfWeek
    if ($dw -eq 0 -or $dw -eq 6) { continue }
    $s = if ($d -eq $fd) { $f } else { $START }
    $e = if ($d -eq $td) { $t } else { $END }
    $lo = [math]::Max($s, $START); $hi = [math]::Min($e, $END)
    if ($hi -gt $lo) { $total += ($hi - $lo) }
  }
  return [math]::Max(0, $total)
}
function Fmt([double]$ms) {
  if ($ms -le 0) { return [char]0x2014 }
  $h = $ms / 3600e3
  if ($h -ge 48) { return "$([math]::Round($ms / 864e5))d" }
  $hi = [math]::Floor($h); $mi = [math]::Round(($h - $hi) * 60)
  if ($mi -and $hi -lt 8) { return "${hi}h ${mi}m" }
  return "${hi}h"
}
$ARTIFACT = 60000
function Mk($a) {
  if (-not $a -or -not $a.completed) { return $null }
  $ms = 0
  if ($a.elapsedMs) { $ms = [long]$a.elapsedMs }
  if ($ms -lt $ARTIFACT -and $a.stopMs -and $a.startMs) {
    $w = WhSpan $a.startMs $a.stopMs
    if ($w -le 0) { $w = $a.stopMs - $a.startMs }
    if ($w -gt $ms) { $ms = $w }
  }
  $st = 'in'
  if ($a.breached) { $st = 'out' }
  return @{ ms = $ms; state = $st }
}
$RESP_GOAL = 2 * 3600e3
function ApplyNative($sla, $r) {
  $resp = Mk $sla.resp
  $res = Mk $sla.res
  $respIsArtifact = ($null -ne $resp) -and ($resp.ms -lt $ARTIFACT)
  $resSpan = 0
  if ($res) { $resSpan = $res.ms } elseif ($r.resMs) { $resSpan = $r.resMs }
  if ($resSpan -gt 0 -and ((-not $resp) -or $respIsArtifact -or ($resp.ms -gt $resSpan))) {
    $effStart = if ($sla.res -and $sla.res.startMs) { $sla.res.startMs } elseif ($sla.resp) { $sla.resp.startMs } else { 0 }
    $effStop = if ($sla.res -and $sla.res.stopMs) { $sla.res.stopMs } elseif ($sla.resp) { $sla.resp.stopMs } else { 0 }
    $state = if ($resSpan -le $RESP_GOAL) { 'in' } else { 'out' }
    $resp = @{ ms = $resSpan; state = $state }
    if ($sla.resp) {
      $sla.resp.completed = $true
      $sla.resp.breached = ($state -eq 'out')
      $sla.resp.elapsedMs = $resSpan
      $sla.resp.startMs = $effStart
      $sla.resp.stopMs = $effStop
    } else {
      $sla.resp = @{ completed = $true; breached = ($state -eq 'out'); elapsedMs = $resSpan; startMs = $effStart; stopMs = $effStop }
    }
  } elseif ($respIsArtifact -and $resSpan -eq 0) {
    $sla.resp.completed = $false
    $sla.resp.elapsedMs = 0
    $resp = $null
  }
  if ($resp) { $r.respMs = $resp.ms; $r.respState = $resp.state; $r.natResp = $true }
  if ($res) {
    $r.resMs = $res.ms; $r.resState = $res.state; $r.natRes = $true
    $raw = 0
    if ($sla.res.elapsedMs) { $raw = [long]$sla.res.elapsedMs }
    if ($raw -ne $res.ms) { $sla.res.elapsedMs = $res.ms }
  }
}
function Case($k, $sla) {
  $r = @{ respMs = 0; respState = 'pending'; resMs = 0; resState = 'pending'; natResp = $false; natRes = $false }
  ApplyNative $sla $r
  # badge-cell decision path (mirrors admSlaBadgeCell)
  $respChip = if ($sla.resp.completed) { Fmt $sla.resp.elapsedMs }
    elseif ($r.respState -eq 'pending' -or $r.respState -eq 'overdue') { "$(Fmt 9 * 3600e3)/" }
    elseif ($r.respState -eq 'nodata' -or $r.respMs -le 0) { '-' }
    else { Fmt $r.respMs }
  $resChip = if ($sla.res.completed) { Fmt $sla.res.elapsedMs }
    elseif ($r.resState -eq 'pending' -or $r.resState -eq 'overdue') { "$(Fmt 9 * 3600e3)/" }
    else { '-' }
  $same = if ($r.natResp -and $r.natRes -and $r.respMs -eq $r.resMs) { '  EXACT-MATCH' } else { '' }
  Write-Host ("{0}: resp={1} ({2}) | res={3} ({4}){5}" -f $k, $respChip, $r.respState, $resChip, $r.resState, $same)
}
Case 'LOG-6526' @{
  resp = @{ completed = $true; elapsedMs = 0; breached = $false; startMs = 1793613017000; stopMs = 1793613020181 }
  res  = @{ completed = $true; elapsedMs = 5579893; breached = $false; startMs = 1793613017000; stopMs = 1793619179893 }
}
Case 'LOG-6521' @{
  resp = @{ completed = $true; elapsedMs = 0; breached = $false; startMs = 1793611440786; stopMs = 1793611443662 }
  res  = @{ completed = $true; elapsedMs = 5181072; breached = $false; startMs = 1793611440786; stopMs = 1793618781072 }
}
Case 'LOG-6504' @{
  resp = @{ completed = $true; elapsedMs = 0; breached = $false; startMs = 1793606975412; stopMs = 1793606977921 }
  res  = @{ completed = $true; elapsedMs = 3948666; breached = $false; startMs = 1793606975412; stopMs = 1793617548666 }
}
Case 'LOG-6503' @{
  resp = @{ completed = $true; elapsedMs = 0; breached = $false; startMs = 1793606956982; stopMs = 1793606959451 }
  res  = @{ completed = $true; elapsedMs = 3875545; breached = $false; startMs = 1793606956982; stopMs = 1793617475545 }
}
Case 'LOG-6502' @{
  resp = @{ completed = $true; elapsedMs = 0; breached = $false; startMs = 1793606914085; stopMs = 1793606916334 }
  res  = @{ completed = $true; elapsedMs = 3812979; breached = $false; startMs = 1793606914085; stopMs = 1793617412979 }
}
# res with legitimate large elapsedMs unaffected
Case 'control: res 10h' @{
  resp = @{ completed = $true; elapsedMs = 3600000; breached = $false; startMs = 0; stopMs = 3600000 }
  res  = @{ completed = $true; elapsedMs = 36000000; breached = $false; startMs = 0; stopMs = 36000000 }
}
