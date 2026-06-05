# AXOS bridge smoke (ASCII comments only - PS 5.1 BOM-less UTF-8 safe)
# Full flow: SCM agent judge -> approval gate -> HELD -> /approve -> ERP createPO + n8n notify -> audit
# Pre: bridge_server.cjs on :4100, n8n 08 notify active on :5678, mock callback on :4000.

$ErrorActionPreference = 'Stop'
$bridge = 'http://localhost:4100'
function Show($t, $o) { Write-Host ''; Write-Host ("=== " + $t + " ===") -ForegroundColor Cyan; $o | ConvertTo-Json -Depth 12 }
function Post($p, $b) { Invoke-RestMethod "$bridge$p" -Method Post -ContentType 'application/json' -Body ($b | ConvertTo-Json) }

# 0. health
try { Show '0) /health' (Invoke-RestMethod "$bridge/health" -TimeoutSec 5) }
catch { Write-Host "bridge not running: node ..\mock\bridge_server.cjs" -ForegroundColor Red; exit 1 }

# 1. STEP2 SCM agent, DRY RUN item A -> create_po (erp would_create, no gate)
Show '1) stock_risk item=A DRY RUN (skipped_dry_run + erp.would_create)' `
  (Post '/insight?dry_run=1' @{ intent='stock_risk'; context=@{ item='A'; project_id='PRJ-1'; user_id='U-1' } })

# 2. LIVE item A -> amount over threshold -> HELD (NOT executed). capture decision_id
$r2 = Post '/insight' @{ intent='stock_risk'; context=@{ item='A'; project_id='PRJ-1'; user_id='U-1'; channel='telegram' } }
Show '2) stock_risk item=A LIVE (held_for_approval expected)' $r2
$decId = $r2.decision_id

# 3. pending list shows it
Show '3) /pending (should list the held PO)' (Invoke-RestMethod "$bridge/pending")

# 4. STEP3 approve -> ERP createPO + n8n notify
if ($decId) {
  Show '4) /approve -> ERP createPO + notify (succeeded expected)' (Post '/approve' @{ decision_id=$decId; approver='user:scm_lead' })
} else { Write-Host 'no decision_id captured' -ForegroundColor Red }

# 5. item B stable -> send_alert AUTO -> notify executed
Show '5) stock_check item=B (stable -> auto send_alert -> notify)' `
  (Post '/insight' @{ intent='stock_check'; context=@{ item='B'; project_id='PRJ-1'; user_id='U-1' } })

# 6. finance cost_anomaly -> auto send_alert
Show '6) cost_anomaly (finance auto send_alert)' `
  (Post '/insight' @{ intent='cost_anomaly'; context=@{ project_id='PRJ-1'; user_id='U-1' } })

# 7. audit tail
Show '7) /audit tail' (Invoke-RestMethod "$bridge/audit?n=14")

Write-Host ''; Write-Host 'SMOKE DONE.' -ForegroundColor Green
Write-Host 'Expect: (1)dry_run erp (2)held (3)pending=1 (4)approved+PO+notify (5)auto notify (6)auto notify (7)decided/held/approved/executed events'
