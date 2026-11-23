# BUG-HUNT · รายงานผลการพิสูจน์ชุดทดสอบด้วย `BUG_MODE` (B01–B12)

ทดสอบบน `devtools` ด้วย `TEST_MODE=1 BUG_MODE=... PORT=3100 node src/server.js` และรัน Playwright ชุดเต็ม 51 TC (`e2e/part1.spec.ts` + `e2e/part2.spec.ts`)

## 1. ตารางบันทึกผล (ตามรูปแบบ `BUGS.md` §4)

| บั๊ก | TC ที่คาดว่าล้ม (จากตาราง 2) | TC ที่ล้มจริง | TC ล้มเกินที่คาด | TC ที่ควรล้มแต่ผ่าน | ผล |
|---|---|---|---|---|---|
| (ปกติ) | – | – | – | – | ✅ 51/51 passed (รันซ้ำได้ผลเดิม 39.9s) |
| B01 | TC-FEE-01 | TC-FEE-01 | – | – | ✅ 1 failed / 50 passed |
| B02 | TC-UPLOAD-01 | TC-UPLOAD-01 | – | – | ✅ 1 failed / 50 passed |
| B03 | TC-SLA-01 · TC-SLA-02 (อาจล้มด้วย TC-SLA-03 · TC-RBAC-04) | TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-NOTI-02 · TC-RBAC-04 | TC-NOTI-02 (ผลข้างเคียงที่ยอมรับ: ใช้ฟังก์ชันวันทำการเดียวกันในการแจ้งเตือน `near`) | – | ✅ 5 failed / 46 passed |
| B04 | TC-SLA-02 | TC-SLA-02 | – | – | ✅ 1 failed / 50 passed |
| B05 | TC-PAY-01 | TC-PAY-01 | – | – | ✅ 1 failed / 50 passed |
| B06 | TC-RBAC-01 | TC-RBAC-01 · TC-DOC-01 · TC-RBAC-05 | TC-DOC-01 · TC-RBAC-05 (ผลข้างเคียง: ทั้งสองข้อตรวจ IDOR ของประชาชนบน PDF/ไฟล์แนบด้วย) | – | ✅ 3 failed / 48 passed |
| B07 | TC-RBAC-02 | TC-RBAC-02 | – | – | ✅ 1 failed / 50 passed |
| B08 | TC-QUEUE-02 (ส่วน 3 ต่อกัน ล้มแน่นอน) | TC-QUEUE-02 | – | – | ✅ 1 failed / 50 passed |
| B09 | TC-PDPA-02 | TC-PDPA-02 | – | – | ✅ 1 failed / 50 passed |
| B10 | TC-DASH-02 (อาจล้มด้วย TC-DASH-01 · TC-DASH-03) | TC-DASH-01 · TC-DASH-02 · TC-DASH-03 | – (อยู่ในรายการ "อาจล้มด้วย") | – | ✅ 3 failed / 48 passed |
| B11 | TC-PDPA-03 · TC-AUDIT-01 | TC-PDPA-03 · TC-AUDIT-01 | – | – | ✅ 2 failed / 49 passed |
| B12 | TC-WORKFLOW-04 | TC-WORKFLOW-04 | – | – | ✅ 1 failed / 50 passed |

**สรุป:** จับได้ **12/12 ตัว** (100%) — ไม่มีบั๊กตัวไหนหลุด (0 ข้อที่ควรล้มแต่ผ่าน)

## 2. ทดสอบเปิดหลายบั๊กร่วมกัน (`BUGS.md` §3 ขั้น 5)

| `BUG_MODE` | ผลรัน | TC ที่ล้มจริง | เทียบกับ union |
|---|---|---|---|
| `B03,B07` | 6 failed / 45 passed (1.2m) | `TC-SLA-01`, `TC-SLA-02`, `TC-SLA-03`, `TC-NOTI-02`, `TC-RBAC-02`, `TC-RBAC-04` | ตรงกับ union ของ B03 ∪ B07 |
| `B01,B05,B09` | 3 failed / 48 passed (49.6s) | `TC-FEE-01`, `TC-PAY-01`, `TC-PDPA-02` | ตรงกับ union ของ B01 ∪ B05 ∪ B09 |

## 3. Triage ข้อที่ล้มเกินที่คาด

- **B03 → `TC-NOTI-02` ล้มเพิ่ม:** `TC-NOTI-02` ตรวจ `bell-count` ที่ `2026-12-04T09:00:00+07:00` ซึ่ง `EG-2569-000016` ต้องเข้าเกณฑ์ `near` (เหลือ 1 วันทำการเพราะข้ามวันหยุด 7 ธ.ค.) เมื่อ `B03` ไม่ข้ามวันหยุดในตาราง คำขอจึงยังคงเป็น `normal` ทำให้ไม่มีแจ้งเตือน (9 แทน 10)
- **B06 → `TC-DOC-01` และ `TC-RBAC-05` ล้มเพิ่ม:** นอกจากหน้า `/citizen/cases/:caseNo` แล้ว `TC-DOC-01` ยังตรวจ IDOR ที่ `GET /api/documents/DOC-2569-000002/pdf` (คาด 404 ได้ 200) และ `TC-RBAC-05` ตรวจ IDOR ของไฟล์แนบ `GET /api/cases/:caseNo/files` และ `GET /api/files/:id` (คาด 404 ได้ 200) ซึ่งใช้กติกาสิทธิ์เจ้าของคำขอฝั่งประชาชนตัวเดียวกัน
