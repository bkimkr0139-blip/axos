# AXOS 6-Agent sweep smoke (ASCII comments only - PS 5.1 BOM-less UTF-8 safe)
# Sweeps all 6 agents + copilot through the bridge judge/gate, then memory + audit.
# Pre: bridge_server.cjs on :4100. (n8n on :5678 only needed for auto-exec to fully succeed.)
# Companion to smoke_bridge.ps1 (which deep-tests the SCM approval loop end-to-end).

$ErrorActionPreference = 'Stop'
$bridge = 'http://localhost:4100'
function Show($t, $o) { Write-Host ''; Write-Host ("=== " + $t + " ===") -ForegroundColor Cyan; $o | ConvertTo-Json -Depth 10 }
function Insight($intent, $ctx) {
  $body = @{ intent=$intent; context=$ctx } | ConvertTo-Json
  try { return Invoke-RestMethod "$bridge/insight" -Method Post -ContentType 'application/json' -Body $body }
  catch {
    # 422(실행 실패 — 예: n8n 다운)일 때도 본문(판단/게이트 추적)을 읽어서 반환
    $r = $_.Exception.Response
    if ($r) { $sr = New-Object System.IO.StreamReader($r.GetResponseStream()); return ($sr.ReadToEnd() | ConvertFrom-Json) }
    throw
  }
}

try { Invoke-RestMethod "$bridge/health" -TimeoutSec 5 | Out-Null }
catch { Write-Host "bridge not running: node ..\mock\bridge_server.cjs" -ForegroundColor Red; exit 1 }

# Each agent: one representative intent. Held (create_po) vs auto (alert/report).
Show '1) SCM stock_risk (held: create_po)'        (Insight 'stock_risk'      @{ item='A'; project_id='PRJ-1'; user_id='U-1' })
Show '2) Procurement reorder (held: create_po + supplier)' (Insight 'reorder' @{ item='A'; project_id='PRJ-1'; user_id='U-1' })
Show '3) Sales sales_risk (auto: alert/report)'    (Insight 'sales_risk'      @{ project_id='PRJ-1'; user_id='U-1' })
Show '4) Finance cost_anomaly (auto: alert)'       (Insight 'cost_anomaly'    @{ project_id='PRJ-1'; user_id='U-1' })
Show '5) HR hr_insight (auto: report, no write)'   (Insight 'hr_insight'      @{ project_id='PRJ-1'; user_id='U-1' })
Show '6) Quality quality_anomaly (auto: alert+sim)'(Insight 'quality_anomaly' @{ project_id='PRJ-1'; user_id='U-1' })
Show '7) Copilot doc_summary (auto: route_llm)'    (Insight 'doc_summary'     @{ project_id='PRJ-1'; user_id='U-1' })

# Registry + memory + audit
Show '8) /agents (registry alias inventory->scm, purchasing->procurement)' (Invoke-RestMethod "$bridge/agents")
Show '9) /memory (task_memory should accumulate from auto-exec)'           (Invoke-RestMethod "$bridge/memory")
Show '10) /audit tail'                                                       (Invoke-RestMethod "$bridge/audit?n=12")

Write-Host ''; Write-Host 'AGENT SWEEP DONE.' -ForegroundColor Green
Write-Host 'Expect: 1-2 held(create_po), 3-7 auto(send_alert/generate_report/route_llm), 8 registry=6/intents=12, 9 task_memory>0'
Write-Host 'Note: auto-exec status=failed if n8n :5678 is down (judgment/gate still verified).'
