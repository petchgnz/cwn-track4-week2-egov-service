# e-Service กลาง — เว็บแอปพลิเคชัน (`เทศบาลนครตัวอย่าง`)

เว็บแอปพลิเคชันระบบ e-Service กลาง พัฒนาด้วย **Node.js 20 + Express + better-sqlite3** (Server-Side Rendered HTML + REST API)

---

## 1. เริ่มต้นใช้งานอย่างเร็ว

### รันด้วย Docker Compose

```bash
# โหมดใช้งานปกติ (ปิด /api/test/* -> 404)
docker compose up --build

# โหมดทดสอบ (เปิด /api/test/reset, /api/test/clock, /api/test/payments/:ref/pay)
TEST_MODE=1 docker compose up --build

# โหมดทดสอบจับบั๊ก (ตัวอย่างเปิด B03 และ B07)
TEST_MODE=1 BUG_MODE=B03,B07 docker compose up --build
```

เปิดเบราว์เซอร์ที่ `http://localhost:3005` (เช็กสถานะ: `GET /api/health`)

### รันด้วย Node.js โดยตรง (Local)

```bash
npm install
PORT=3005 TEST_MODE=1 npm start
```

---

## 2. ตัวแปรสภาพแวดล้อม (Environment Variables)

| ตัวแปร | ค่าเริ่มต้น | หน้าที่ |
|---|---|---|
| `PORT` | `3005` | พอร์ตของเซิร์ฟเวอร์ |
| `TZ` | `Asia/Bangkok` | เขตเวลาหลักของโปรเซส (+07:00) |
| `DB_PATH` | `data/egov.db` (`/data/egov.db` ใน Docker) | ที่เก็บฐานข้อมูล SQLite |
| `BODY_LIMIT` | `12mb` | ขนาด body สูงสุดสำหรับ Express (รองรับไฟล์แนบ ≥ 5 MB) |
| `TEST_MODE` | *(ว่าง)* | ตั้งเป็น `1` เพื่อเปิด endpoint `/api/test/*` และป้ายโหมดทดสอบ |
| `BUG_MODE` | *(ว่าง)* | รหัสบั๊ก `B01`–`B12` คั่นด้วย `,` สำหรับทดสอบชุด Playwright |

---

## 3. โครงสร้างซอร์สโค้ด

```text
app/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── playwright.config.ts
├── src/
│   ├── server.js                # Entry point,โหลด modules อัตโนมัติ, error handler
│   ├── seed.js                  # ข้อมูลตั้งต้น (ประชาชน, เจ้าหน้าที่, คำขอ, วันหยุด, บริการ)
│   ├── db/                      # SQLite schema / migration
│   ├── lib/
│   │   ├── audit.js             # บันทึก Audit Trail (append-only)
│   │   ├── bugmode.js           # อ่าน BUG_MODE / isBug('Bxx') / isTestMode()
│   │   ├── clock.js             # นาฬิกาจำลอง Asia/Bangkok (+07:00)
│   │   ├── crypto.js            # เข้ารหัสข้อมูลส่วนบุคคล (PII) + HMAC-SHA256 เอกสาร
│   │   ├── db.js                # การเชื่อมต่อ better-sqlite3
│   │   ├── format.js            # escape HTML, รูปแบบวันที่/เลขบัตร/เงิน
│   │   ├── hooks.js             # request hooks (ประเมิน SLA / auto-cancel)
│   │   ├── layout.js            # Page shell, Header/Nav, Footer, RBAC middleware, ข้อความ error
│   │   ├── password.js          # ตรวจรหัสผ่านเจ้าหน้าที่
│   │   ├── reset.js             # ล้างและ seed ข้อมูลใหม่
│   │   ├── rules.js             # กฎคำนวณค่าธรรมเนียม, SLA วันทำการ, เลขคำขอ, Dashboard
│   │   └── session.js           # จัดการ session คุกกี้
│   ├── modules/
│   │   ├── auth.js              # /login (ThaiD จำลอง + SSO เจ้าหน้าที่), /register, /logout
│   │   ├── citizen.js           # /citizen, /citizen/new/:serviceId, อัปโหลด, PromptPay QR
│   │   ├── workflow.js          # /officer/queue, /officer/cases/:caseNo, /head/approvals
│   │   ├── documents.js         # ออกเอกสาร PDF, ลายเซ็น HMAC, หน้า /verify
│   │   ├── notifications.js     # แจ้งเตือน SLA + ยกเลิกอัตโนมัติ NEED_FIX เกิน 168 ชม.
│   │   ├── dashboard.js         # /dashboard + ส่งออก .xlsx / .pdf
│   │   ├── audit-admin.js       # /audit, /admin/services, /admin/holidays, /admin/users
│   │   └── testhooks.js         # /api/test/reset, /api/test/clock, /api/test/payments/:ref/pay
│   └── public/
│       ├── app.css              # Stylesheet (ตาม designs/ + WCAG + Responsive)
│       └── app.js               # Client helpers (แสดงข้อความ error/success, interactions)
├── test/
│   └── rules.test.js            # Unit tests (29 tests)
└── e2e/
    ├── helpers.ts
    ├── part1.spec.ts            # Playwright ชุดที่ 1 (22 TC)
    └── part2.spec.ts            # Playwright ชุดที่ 2 (29 TC)
```

---

## 4. เส้นทางหลักของเว็บ (Routes)

- **สาธารณะ / เข้าสู่ระบบ:** `/login`, `/register`, `/verify`, `GET /api/health`
- **ประชาชน (`citizen`):** `/citizen`, `/citizen/new/:serviceId`, `/citizen/cases/:caseNo`
- **เจ้าหน้าที่ / หัวหน้า (`officer`, `head`):** `/officer/queue`, `/officer/cases/:caseNo`, `/head/approvals`, `/notifications`
- **ผู้บริหาร (`executive`):** `/dashboard`, `/api/dashboard`, `/api/dashboard/export?format=xlsx|pdf`
- **ผู้ตรวจสอบ (`auditor`):** `/audit`
- **ผู้ดูแลระบบ (`admin`):** `/admin/services`, `/admin/holidays`, `/admin/users`
- **Test Hooks (`TEST_MODE=1` เท่านั้น):** `POST /api/test/reset`, `PUT /api/test/clock`, `POST /api/test/payments/:ref/pay`

---

## 5. คำสั่งทดสอบ

```bash
# 1. Unit tests (29 ข้อ)
npm test

# 2. ดูรายชื่อ Playwright tests (51 ข้อ)
npm run e2e:list

# 3. รัน Playwright ทั้งชุด (ต้องเปิดเซิร์ฟเวอร์ด้วย TEST_MODE=1 ที่พอร์ต 3005 ก่อน)
npm run e2e

# 4. รันพร้อมบันทึกวิดีโอ
PW_VIDEO=1 npm run e2e
```
