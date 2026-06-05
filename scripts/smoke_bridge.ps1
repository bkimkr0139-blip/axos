# AXOS bridge smoke test  (ASCII comments only - PS 5.1 BOM-less UTF-8 safe)
# Verifies: judge -> validate -> gate -> execute(n8n) -> audit, end to end, no Databricks.
# Pre: bridge_server.cjs running on :4100, n8n 08 notify active on :5678.

$ErrorActionPreference = 'Stop'
$bridge = 'http://localhost:4100'

function Show($title, $obj) {
  Write-Host ''
  Write-Host ("=== " + $title + " ===") -ForegroundColor Cyan
  $obj | ConvertTo-Json -Depth 12
}

# 0. bridge health
try { $h = Invoke-RestMethod "$bridge/health" -TimeoutSec 5; Show '0) bridge /health' $h }
catch { Write-Host "bridge not running. Start: node ..\mock\bridge_server.cjs" -ForegroundColor Red; exit 1 }

# 1. dry run (no live n8n call) - shows what WOULD be called
$r1 = Invoke-RestMethod "$bridge/insight?dry_run=1" -Method Post -ContentType 'application/json' `
  -Body (@{ intent='stock_risk'; context=@{ item='A'; project_id='PRJ-1'; user_id='U-1' } } | ConvertTo-Json)
Show '1) stock_risk DRY RUN (skipped_dry_run expected)' $r1

# 2. live: judge -> gate(auto) -> n8n 08 notify -> callback -> audit
$r2 = Invoke-RestMethod "$bridge/insight" -Method Post -ContentType 'application/json' `
  -Body (@{ intent='stock_risk'; context=@{ item='A'; project_id='PRJ-1'; user_id='U-1'; channel='telegram' } } | ConvertTo-Json)
Show '2) stock_risk LIVE (execute notify, status=succeeded expected)' $r2

# 3. approval gate: create_po should be HELD, not executed
$r3 = Invoke-RestMethod "$bridge/insight" -Method Post -ContentType 'application/json' `
  -Body (@{ intent='create_po_demo'; context=@{ item='A'; project_id='PRJ-1'; user_id='U-1' } } | ConvertTo-Json)
Show '3) create_po_demo (held_for_approval expected, NOT executed)' $r3

# 4. audit tail
$a = Invoke-RestMethod "$bridge/audit?n=10" -TimeoutSec 5
Show '4) audit tail' $a

Write-Host ''
Write-Host 'SMOKE DONE.' -ForegroundColor Green
Write-Host 'Check: (1) skipped_dry_run  (2) succeeded + n8n payload  (3) held_for_approval  (4) audit has decided/executed/held events'
