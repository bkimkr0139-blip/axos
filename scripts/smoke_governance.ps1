# AXOS governance hardening smoke (ASCII comments only - PS 5.1 BOM-less UTF-8 safe)
# End-to-end governance scenarios (docs/06): RBAC/SoD, dual-approval, kill-switch, compensation, metrics.
# Pre: bridge_server.cjs on :4100 (governance loaded). n8n :5678 UP for execution to fully succeed.
# Unit-level policy (guardrail/confidence/expiry) is covered by scripts/test_governance.cjs.

$ErrorActionPreference = 'Continue'
$bridge = 'http://localhost:4100'
function Show($t,$o){ Write-Host ''; Write-Host ("=== "+$t+" ===") -ForegroundColor Cyan; $o | ConvertTo-Json -Depth 8 }
function Post($p,$b){ try { Invoke-RestMethod "$bridge$p" -Method Post -ContentType 'application/json' -Body ($b|ConvertTo-Json) }
  catch { $r=$_.Exception.Response; if($r){ (New-Object System.IO.StreamReader($r.GetResponseStream())).ReadToEnd()|ConvertFrom-Json } else { throw } } }

try { Invoke-RestMethod "$bridge/health" -TimeoutSec 5 | Out-Null } catch { Write-Host "bridge down: node mock\bridge_server.cjs" -ForegroundColor Red; exit 1 }

# --- 1. RBAC + SoD: SCM held -> bad approver denied -> authorized approver executes ---
$h = Post '/insight' @{ intent='stock_risk'; context=@{ item='A'; project_id='PRJ-1'; user_id='U-1' } }
$dec = $h.decision_id
Show '1a) RBAC deny (user:hacker is not scm_approver)' (Post '/approve' @{ decision_id=$dec; approver='user:hacker' })
Show '1b) SoD deny (ai cannot approve)'                 (Post '/approve' @{ decision_id=$dec; approver='ai' })
Show '1c) RBAC allow (user:scm_lead) -> execute PO'     (Post '/approve' @{ decision_id=$dec; approver='user:scm_lead' })

# --- 2. Dual-approval: procurement item D (>10M) needs 2 distinct authorized approvers ---
$h2 = Post '/insight' @{ intent='reorder'; context=@{ item='D'; project_id='PRJ-1'; user_id='U-1' } }
$dec2 = $h2.decision_id
Show '2a) held dual_approval (level + requires=2)' @{ level=$h2.approval.level; requires=(($h2.trace.steps | Where-Object { $_.requires }) | Select-Object -First 1).requires }
Show '2b) approve #1 (user:proc_lead) -> pending_more' (Post '/approve' @{ decision_id=$dec2; approver='user:proc_lead' })
Show '2c) approve same person -> SoD deny'             (Post '/approve' @{ decision_id=$dec2; approver='user:proc_lead' })
Show '2d) approve #2 (user:fin_lead) -> execute'       (Post '/approve' @{ decision_id=$dec2; approver='user:fin_lead' })

# --- 3. Kill switch: kill scm -> SCM execution blocked -> unkill ---
Show '3a) kill scm'                              (Post '/kill' @{ agent='scm'; actor='ops' })
$h3 = Post '/insight' @{ intent='stock_risk'; context=@{ item='A'; project_id='PRJ-1'; user_id='U-1' } }
Show '3b) approve while killed -> failed(kill_switch_active)' (Post '/approve' @{ decision_id=$h3.decision_id; approver='user:scm_lead' })
Show '3c) unkill scm'                            (Post '/unkill' @{ agent='scm'; actor='ops' })

# --- 4. Compensation: approve SCM -> PO created -> compensate -> cancelled ---
$h4 = Post '/insight' @{ intent='stock_risk'; context=@{ item='A'; project_id='PRJ-1'; user_id='U-1' } }
$ap4 = Post '/approve' @{ decision_id=$h4.decision_id; approver='user:scm_lead' }
Show '4a) approve -> PO' @{ po=$ap4.result.result.erp.po_id; status=$ap4.result.status }
Show '4b) compensate -> cancel PO' (Post '/compensate' @{ decision_id=$h4.decision_id; actor='user:scm_lead'; reason='수요 급감 정정' })

# --- 5. Metrics (STEP10 dashboard source) ---
Show '5) /metrics (audit-derived KPI/ROI)' (Invoke-RestMethod "$bridge/metrics")

Write-Host ''; Write-Host 'GOVERNANCE SMOKE DONE.' -ForegroundColor Green
Write-Host 'Expect: 1a/1b deny, 1c execute | 2a dual/requires=2, 2b pending, 2c SoD deny, 2d execute | 3b kill_switch_active | 4b cancelled | 5 totals+roi'
