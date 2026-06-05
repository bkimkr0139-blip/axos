/**
 * Agent Memory (mock) — STEP9 4종 기억 (docs/05 §3).
 * live: Databricks Vector Search 인덱스 4종. mock: jsonl append + 키워드 회수 스텁.
 * 계약: memory/memory.schema.json. 인터페이스(remember/retrieve)는 live와 동일 → 드롭인 교체.
 *
 *   conversation_memory : Copilot/Agent 대화 (02 rag-chat)
 *   document_memory     : 문서/계약/메일 (01 ingest, 09 reindex)
 *   task_memory         : 과거 결정·행동·결과 (브리지 감사 → 적재) ← 자가향상 루프
 *   project_memory      : WBS·이슈·일정 (06 wbs-delay-check)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const now = () => new Date().toISOString();

const INDEXES = ['conversation_memory', 'document_memory', 'task_memory', 'project_memory'];
const fileFor = (index) => path.join(__dirname, index + '.jsonl');

// 적재 (Remember) — live: vector upsert
function remember(index, record) {
  if (!INDEXES.includes(index)) return { ok: false, error: 'unknown_index:' + index };
  const rec = { mem_id: 'mem-' + crypto.randomUUID().slice(0, 8), index, ts: now(), ...record };
  try { fs.appendFileSync(fileFor(index), JSON.stringify(rec) + '\n'); } catch (e) { /* best-effort */ }
  return { ok: true, mem_id: rec.mem_id };
}

// 회수 (Retrieve) — mock: 최근 + 키워드 부분일치. live: vector similarity top-k
function retrieve(index, query, k) {
  if (!INDEXES.includes(index)) return [];
  k = k || 3;
  let lines = [];
  try { lines = fs.readFileSync(fileFor(index), 'utf8').trim().split('\n').filter(Boolean); } catch (_) { return []; }
  const recs = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const q = String(query || '').toLowerCase();
  const scored = recs.map((r) => {
    const hay = JSON.stringify(r).toLowerCase();
    let score = 0; if (q) for (const t of q.split(/\s+/)) if (t && hay.includes(t)) score += 1;
    return { r, score };
  });
  // 키워드 매칭 우선, 동점이면 최신순
  return scored.sort((a, b) => b.score - a.score).slice(0, k)
    .filter((x) => x.score > 0 || !q).map((x) => x.r).reverse();
}

function stats() {
  const out = {};
  for (const idx of INDEXES) {
    let n = 0; try { n = fs.readFileSync(fileFor(idx), 'utf8').trim().split('\n').filter(Boolean).length; } catch (_) {}
    out[idx] = n;
  }
  return out;
}

module.exports = { remember, retrieve, stats, INDEXES };
