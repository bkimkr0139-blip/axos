/**
 * ERP mock 어댑터 — 발주(PO) 쓰기. docs/02 §5 안전장치(멱등·드라이런·보상) 준수.
 * live 전환: createPO를 ERP 표준 API/BAPI 호출로 교체. 멱등키(decision_id)를 ERP 참조필드에 기록.
 */
'use strict';
const crypto = require('crypto');
const now = () => new Date().toISOString();
const POS = new Map(); // po_id -> record (mock 영속 대체)

function createPO(payload, opts) {
  opts = opts || {};
  const idemKey = opts.idempotency_key || payload.request_id;
  // 멱등성: 같은 키 재요청 시 기존 PO 반환
  for (const rec of POS.values()) { if (rec.idempotency_key === idemKey && rec.status !== 'cancelled') return { ...rec, idempotent: true }; }
  if (opts.dry_run) {
    return { dry_run: true, would_create: { item: payload.item, qty: payload.qty, supplier_id: payload.supplier_id, amount: payload.amount } };
  }
  const po_id = 'PO-' + crypto.randomUUID().slice(0, 8).toUpperCase();
  const rec = { po_id, status: 'created', idempotency_key: idemKey,
    item: payload.item, qty: payload.qty, supplier_id: payload.supplier_id,
    supplier_name: payload.supplier_name, amount: payload.amount, created_at: now() };
  POS.set(po_id, rec);
  return rec;
}

function cancelPO(po_id) { // 보상 트랜잭션
  const rec = POS.get(po_id);
  if (!rec) return { error: 'po_not_found', po_id };
  rec.status = 'cancelled'; rec.cancelled_at = now();
  return { po_id, status: 'cancelled' };
}

function listPOs() { return Array.from(POS.values()); }

module.exports = { createPO, cancelPO, listPOs };
