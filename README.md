# e-Service กลาง — เทศบาลนครตัวอย่าง (Week 2)

ระบบ **e-Service กลาง** ของเทศบาลสมมติสำหรับยื่นคำขอ 3 บริการออนไลน์ (ขอหนังสือรับรอง, ขออนุญาตประกอบกิจการ, ขออนุญาตก่อสร้าง/ต่อเติมอาคาร) พร้อมระบบชำระเงิน PromptPay QR จำลอง, จัดการคิวและ SLA ตามวันทำการจริง, ออกเอกสารดิจิทัล PDF พร้อมลายเซ็น HMAC-SHA256, หน้าตรวจสอบเอกสารสาธารณะ, Dashboard ผู้บริหาร (ส่งออก Excel/PDF) และ Audit Trail แบบแก้ไข/ลบไม่ได้

> หน่วยงาน ข้อมูลบุคคล ThaiD, PromptPay QR และลายเซ็นดิจิทัลในระบบนี้เป็น **ตัวจำลองทั้งหมด** เพื่อการเรียนรู้และทดสอบเท่านั้น

---

## 1. โครงสร้างโปรเจกต์

| โฟลเดอร์ / ไฟล์ | รายละเอียด |
|---|---|
| `designs/` | ต้นแบบหน้าจอ 12 หน้า (`Main.html`, `CitizenHome.html`, `NewRequest.html`, `OfficerQueue.html`, `Dashboard.html` ฯลฯ) |
| `week2/egov-brief/` | ชุดโจทย์ สเปก สัญญา (`CONTRACT.md`), ข้อมูล seed (`TEST-DATA.md`), แผนทดสอบ (`TEST-PLAN.md` 51 ข้อ) และตารางบั๊ก (`BUGS.md` B01–B12) |
| `week2/egov-eservice/` | ผลงานที่สร้างและทดสอบครบตามขั้นตอน |
| `week2/egov-eservice/app/` | ซอร์สโค้ดเว็บ (`Node.js 20 + Express + better-sqlite3` SSR), `Dockerfile`, `docker-compose.yml`, Unit tests และ Playwright E2E suite |
| `week2/egov-eservice/PLAN.md` · `REPORT.md` | แผน DAG/Gantt (`blocks.json`, `dag.png`, `gantt-plan.png`) และผลรันจริงของทีมเอเจนต์ (`gantt-actual.png`, `compare.png`) |
| `week2/egov-eservice/test-report/` | รายงานผลรัน Playwright 51/51 (`index.html`, `results.json`) และ GIF บันทึกหน้าจอระดับ P1 (`gifs/`, 40 ไฟล์) |
| `week2/egov-eservice/BUG-HUNT.md` | ผลพิสูจน์การจับบั๊ก `BUG_MODE=B01..B12` (จับได้ 12/12 ตัว) |

---

## 2. สรุปสถาปัตยกรรมและฟีเจอร์

- **Stack:** Node.js 20, Express, `better-sqlite3`, `pdfkit`, `exceljs`, `qrcode`, `multer` (Server-Side Rendering)
- **พอร์ตเริ่มต้น:** `3005` (`PORT` ปรับผ่าน environment variable ได้)
- **การออกแบบ (UI):** ปรับปรุง `src/public/app.css`, `src/lib/layout.js` และหน้า `/login` ใน `src/modules/auth.js` ตามชุดต้นแบบใน `designs/` (ฟอนต์ `IBM Plex Sans Thai` / `IBM Plex Mono`, พาเลตสี `#F3F5F7` / `#0B5CAD`, Badge สถานะ/SLA มีจุดสี+ขอบ+ข้อความตาม WCAG 1.4.1, Responsive 375/768/1280)
- **กลไกทดสอบ (`TEST_MODE=1`):**
  - เปิด test hooks: `POST /api/test/reset`, `PUT /api/test/clock`, `POST /api/test/payments/<ref>/pay` (ปิดคืน `404` ในโหมดปกติ)
  - รองรับ `BUG_MODE=B01..B12` (ระบุหลายตัวคั่นด้วย `,` ได้) ผ่าน `src/lib/bugmode.js`
  - เวลาทั้งหมดอ้างอิง `Asia/Bangkok (+07:00)` ผ่าน `src/lib/clock.js`

---

## 3. วิธีรันและทดสอบ

เข้าไปที่โฟลเดอร์แอป:

```bash
cd week2/egov-eservice/app
```

### รันด้วย Docker Compose

- **โหมดใช้งานปกติ** (ปิด `/api/test/*`):
  ```bash
  docker compose up --build
  ```
- **โหมดทดสอบ** (เปิด `/api/test/*` สำหรับ reset, clock, payment callback):
  ```bash
  TEST_MODE=1 docker compose up --build
  ```
- **โหมดจำลองบั๊ก:**
  ```bash
  TEST_MODE=1 BUG_MODE=B03,B07 docker compose up --build
  ```

เข้าใช้งานได้ที่ `http://localhost:3005` (เช็กสถานะได้ที่ `http://localhost:3005/api/health`)

### รันชุดทดสอบอัตโนมัติ

- **Unit Tests (29 ข้อ):**
  ```bash
  node --test test/rules.test.js
  ```
- **Playwright E2E (51 ข้อ — ต้องเปิดเว็บด้วย `TEST_MODE=1`):**
  ```bash
  npx playwright test --reporter=list
  ```
  - บันทึกวิดีโอระหว่างรันเพิ่มได้ด้วย `PW_VIDEO=1 npx playwright test`

### บัญชีทดสอบ (หลัง reset)

| บทบาท | วิธีเข้าสู่ระบบ (`/login`) | ข้อมูลล็อกอิน |
|---|---|---|
| ประชาชน | แท็บประชาชน (ThaiD จำลอง · OTP `123456`) | `1101700123456` (สมชาย ใจดี), `3100600987659` (สมหญิง รักไทย) |
| เจ้าหน้าที่ทะเบียน | แท็บเจ้าหน้าที่ (SSO จำลอง) | `off.reg1` / `Test@1234`, `off.reg2` / `Test@1234` |
| เจ้าหน้าที่โยธา | แท็บเจ้าหน้าที่ (SSO จำลอง) | `off.works1` / `Test@1234` |
| หัวหน้าฝ่าย | แท็บเจ้าหน้าที่ (SSO จำลอง) | `head1` / `Test@1234` |
| ผู้บริหาร | แท็บเจ้าหน้าที่ (SSO จำลอง) | `exec1` / `Test@1234` |
| ผู้ตรวจสอบภายใน | แท็บเจ้าหน้าที่ (SSO จำลอง) | `audit1` / `Test@1234` |
| ผู้ดูแลระบบ | แท็บเจ้าหน้าที่ (SSO จำลอง) | `admin1` / `Test@1234` |

---

## 4. สรุปผลการทดสอบ

| รายการตรวจ | ผลลัพธ์ | หลักฐาน |
|---|---|---|
| แผนและรันทีมเอเจนต์ (`dag-planner`) | สำเร็จอัตโนมัติ 12/13 บล็อก (4,779,944 tokens · 77.2 นาที) และรวมระบบทดสอบต่อจนจบ | [PLAN.md](week2/egov-eservice/PLAN.md) · [REPORT.md](week2/egov-eservice/REPORT.md) |
| Unit Tests (`test/rules.test.js`) | **29/29 ผ่าน** | `week2/egov-eservice/app/test/rules.test.js` |
| Playwright E2E (`TEST_MODE=1`) | **51/51 ผ่าน** (รันซ้ำหลังปรับดีไซน์ล่าสุดผ่านครบ รวมถึง `TC-NFR-01`, `TC-NFR-02`) | [index.html](week2/egov-eservice/test-report/index.html) · [results.json](week2/egov-eservice/test-report/results.json) |
| บันทึก GIF ระดับ P1 | **40 ไฟล์** (ครบทุก P1 ที่เปิดหน้าเว็บ; อีก 3 ข้อเป็น API-only test) | `week2/egov-eservice/test-report/gifs/` |
| ทดสอบจับบั๊ก (`BUG_MODE=B01..B12`) | **จับได้ 12/12 ตัว** + ทดสอบร่วม `B03,B07` และ `B01,B05,B09` ตรงตาม union | [BUG-HUNT.md](week2/egov-eservice/BUG-HUNT.md) |
