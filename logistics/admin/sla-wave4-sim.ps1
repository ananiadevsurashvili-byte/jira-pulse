# Wave-4 sim of admSlaApplyNative with the freshly probed payloads.
# Mirrors the fixed logic: artifact-robust mk, Resolution-Set substitution,
# pending-row artifact unset.
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
function Case($k, $sla, $rows) {
  $r = @{ respMs = 0; respState = 'pending'; resMs = 0; resState = 'pending'; natResp = $false; natRes = $false }
  if ($rows.resMs) { $r.resMs = $rows.resMs }
  ApplyNative $sla $r
  $respChip = if ($sla.resp.completed) { Fmt $sla.resp.elapsedMs }
    elseif ($r.respState -eq 'pending' -or $r.respState -eq 'overdue') { "$(Fmt $rows.elapsed)/" }
    else { [string][char]0x2013 }
  $resChip = if ($sla.res.completed) { Fmt $sla.res.elapsedMs }
    elseif ($r.resState -eq 'pending' -or $r.resState -eq 'overdue') { "$(Fmt $rows.elapsed)/" }
    else { [string][char]0x2013 }
  $same = if ($r.natResp -and $r.natRes -and $r.respMs -eq $r.resMs) { '  EXACT-MATCH' } else { '' }
  Write-Host ("{0}: resp={1} ({2}) | res={3} ({4}){5}" -f $k, $respChip, $r.respState, $resChip, $r.resState, $same)
}
$ELAPSED = 9 * 3600e3
Case 'LOG-6468' @{
  resp = @{ completed = $true; elapsedMs = 0;    breached = $false; startMs = 1793393985630; stopMs = 1793393987929 }
  res  = @{ completed = $true; elapsedMs = 0;    breached = $false; startMs = 1793393985630; stopMs = 1793395030009 }
} @{ elapsed = $ELAPSED; resMs = 0 }
Case 'LOG-6461' @{
  resp = @{ completed = $true; elapsedMs = 0;    breached = $false; startMs = 1793388086754; stopMs = 1793388093575 }
  res  = @{ completed = $true; elapsedMs = 0;    breached = $false; startMs = 1793388086754; stopMs = 1793388577259 }
} @{ elapsed = $ELAPSED; resMs = 0 }
Case 'LOG-6393' @{
  resp = @{ completed = $true; elapsedMs = 2100; breached = $false; startMs = 1793363655886; stopMs = 1793363657986 }
  res  = @{ completed = $true; elapsedMs = 18826713; breached = $false; startMs = 1793363655886; stopMs = 1793382482599 }
} @{ elapsed = $ELAPSED; resMs = 0 }
Case 'LOG-6386' @{
  resp = @{ completed = $true; elapsedMs = 2338; breached = $false; startMs = 1793361543300; stopMs = 1793361545638 }
  res  = @{ completed = $true; elapsedMs = 6654025;  breached = $false; startMs = 1793361543300; stopMs = 1793368197325 }
} @{ elapsed = $ELAPSED; resMs = 0 }
Case 'LOG-6388' @{
  resp = @{ completed = $true; elapsedMs = 2110; breached = $false; startMs = 1793361846754; stopMs = 1793361848864 }
  res  = @{ completed = $true; elapsedMs = 6344501;  breached = $false; startMs = 1793361846754; stopMs = 1793368191255 }
} @{ elapsed = $ELAPSED; resMs = 0 }
Case 'LOG-6396' @{
  resp = @{ completed = $true; elapsedMs = 2789; breached = $false; startMs = 1793364744384; stopMs = 1793364747173 }
  res  = @{ completed = $false; elapsedMs = 20859914; breached = $false; startMs = 1793364744384; stopMs = 0 }
} @{ elapsed = $ELAPSED; resMs = 0 }
Case 'LOG-6395' @{
  resp = @{ completed = $true; elapsedMs = 2091; breached = $false; startMs = 1793364661601; stopMs = 1793364663692 }
  res  = @{ completed = $false; elapsedMs = 20944388; breached = $false; startMs = 1793364661601; stopMs = 0 }
} @{ elapsed = $ELAPSED; resMs = 0 }
Case 'LOG-6390' @{
  resp = @{ completed = $true; elapsedMs = 2566; breached = $false; startMs = 1793362991802; stopMs = 1793362994368 }
  res  = @{ completed = $false; elapsedMs = 22615506; breached = $false; startMs = 1793362991802; stopMs = 0 }
} @{ elapsed = $ELAPSED; resMs = 0 }
# regression guards: earlier waves + genuine earlier replies stay untouched
Case 'LOG-6237' @{
  resp = @{ completed = $true; elapsedMs = 1886; breached = $false; startMs = 1793273758697; stopMs = 1793273760583 }
  res  = @{ completed = $true; elapsedMs = 36138336; breached = $false; startMs = 1793273758697; stopMs = 1793367497033 }
} @{ elapsed = $ELAPSED; resMs = 0 }
Case 'LOG-6344' @{
  resp = @{ completed = $true; elapsedMs = 0;    breached = $false; startMs = 1793348294730; stopMs = 1793348296904 }
  res  = @{ completed = $true; elapsedMs = 8493069;  breached = $false; startMs = 1793348294730; stopMs = 1793362893069 }
} @{ elapsed = $ELAPSED; resMs = 0 }
Case 'genuine 30m reply' @{
  resp = @{ completed = $true; elapsedMs = 1800000;  breached = $false; startMs = 0; stopMs = 1800000 }
  res  = @{ completed = $true; elapsedMs = 36000000; breached = $false; startMs = 0; stopMs = 36000000 }
} @{ elapsed = $ELAPSED; resMs = 0 }
Case 'genuine 1h reply' @{
  resp = @{ completed = $true; elapsedMs = 3600000;  breached = $false; startMs = 0; stopMs = 3600000 }
  res  = @{ completed = $true; elapsedMs = 72000000; breached = $false; startMs = 0; stopMs = 72000000 }
} @{ elapsed = $ELAPSED; resMs = 0 }
