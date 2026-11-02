# Probe START/STOP windows for LOG-65xx Done rows missing first response.
$h = @{ 'x-jp-admin' = 'jp_k9R2vTq7Lm4wXy8Zp3nB6dF1sH5jC' }
foreach ($k in @('LOG-6526','LOG-6521','LOG-6504','LOG-6503','LOG-6502')) {
  $u = "https://gensweaty--65df49bca6d911f19f231607ee4eb77e.web.val.run/?cmd=deskSla&key=$k&domain=caucasusauto.atlassian.net"
  try {
    $raw = (Invoke-WebRequest -Uri $u -Headers $h -UseBasicParsing).Content
    $j = $raw | ConvertFrom-Json
    $sla = $j.sla
    Write-Host "== $k =="
    if ($sla.resp) {
      Write-Host ("  resp: completed=" + $sla.resp.completed + " elapsedMs=" + $sla.resp.elapsedMs + " startMs=" + $sla.resp.startMs + " stopMs=" + $sla.resp.stopMs)
    } else { Write-Host "  resp: NULL" }
    if ($sla.res) {
      Write-Host ("  res : completed=" + $sla.res.completed + " elapsedMs=" + $sla.res.elapsedMs + " startMs=" + $sla.res.startMs + " stopMs=" + $sla.res.stopMs)
    } else { Write-Host "  res : NULL" }
  } catch { Write-Host ("$k ERROR: " + $_.Exception.Message) }
  Start-Sleep -Milliseconds 200
}
