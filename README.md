# AI TikBat — TikTok Basket Agent Studio

ระบบ AI workflow ผลิตคลิป TikTok + จัดคิว **ปักตะกร้า (basket)** แบบกึ่งอัตโนมัติ
ใช้ **Hernest** เป็น orchestrator คุม agent ทั้งสาย: Research → Script → Video → คิว → อนุมัติ → (Agent โพสต์)

## สถานะ Integration (ดูแถบสีในหน้าเว็บ)
| ระบบ | เปิดเมื่อ | ใช้ทำอะไร |
|---|---|---|
| Script LLM | มี `OPENAI_API_KEY` | เขียนสคริปต์ขายด้วย GPT |
| Kling AI | มี `KLING_ACCESS_KEY` | ทำคลิปวิดีโอ AI (ฟรี 5 คลิป/วัน) |
| Telegram | มี `TELEGRAM_*` | รายงาน + กดอนุมัติจากมือถือ |
| Auto-publish | `PUBLISHER_MODE=true` | ⚠️ Agent โพสต์+ปักตะกร้าแทน (เสี่ยงแบน) |

## เริ่มใช้งาน (ขั้นต่ำ — ไม่ต้องมี key เลยก็รันได้)
```bash
npm install
npm run server      # terminal 1 — agent :8790
npm run dev         # terminal 2 — UI :5173
```
เปิด http://localhost:5173 → ใส่ชื่อสินค้า → **Research Script** → **Render ทันที (Template)** → คลิปโผล่ในคิว → กด ✓ อนุมัติ

## เปิดใช้งานทีละส่วน (แก้ไฟล์ `.env`)

คัดลอกจาก `.env.example` แล้วเติมค่า:

```env
# 1) สคริปต์ฉลาดขึ้น (ไม่บังคับ)
OPENAI_API_KEY=sk-xxx

# 2) วิดีโอ AI จาก Kling (สมัครที่ app.klingai.com → API → Create Key)
KLING_ACCESS_KEY=api-key-kling-xxx
KLING_MODEL=kling-v1
KLING_MODE=std
KLING_DAILY_LIMIT=5

# 3) รายงานเข้า Telegram (สร้างบอทกับ @BotFather, เอา chat id จาก @userinfobot)
TELEGRAM_BOT_TOKEN=xxxx
TELEGRAM_CHAT_ID=xxxx
TELEGRAM_POLL=true

# 4) Auto-publish (⚠️ ผิด ToS TikTok — ใช้ account รองเท่านั้น)
PUBLISHER_MODE=false
PUBLISHER_SESSION_JSON=/full/path/.tiktok-session
```

หลังแก้ `.env` รันใหม่: `kill <pid> && npm run server`

## Flow การทำงานจริง
```
1. ใส่สินค้า + จุดขาย
2. Research Script  → ได้สคริปต์ (LLM หรือ template)
3. Generate Video   → เลือก Kling AI หรือ Template
4. คลิปเข้าคิว       → ใส่ TikTok Product ID + เลือกเวลาโพสต์
5. อนุมัติ           → กดในเว็บ หรือกดปุ่มใน Telegram
6. โพสต์             → ถ้าเปิด PUBLISHER_MODE Agent โพสต์ให้
                      ถ้าไม่เปิด รอถึงเวลาแล้วบอทแจ้งเตือนให้โพสต์มือ
```

## เวลาโพสต์ (scheduleSlot)
เมื่อถึงชั่วโมงที่ตั้งไว้ (เช่น 20:00):
- เปิด `PUBLISHER_MODE` → Hermest เรียก Publisher Agent โพสต์ให้อัตโนมัติ
- ไม่เปิด → ส่งข้อความ Telegram "ถึงเวลาโพสต์" ให้คุณกดมือ

## โฟลเดอร์
- `server/agent-server.mjs` — agent runtime + REST API (research, video, queue, telegram, publisher)
- `server/publisherAgent.mjs` — Playwright ขับ TikTok (Risky Mode)
- `src/` — React dashboard
- `workspace/` — ไฟล์ที่ agent สร้าง (คลิป, audio, queue.json, usage.json)

## ข้อควรระวัง
- TikTok **ไม่มี API** ปักตะกร้าบนคลิป organic → โหมด Auto-publish ใช้ Playwright กดแอป (ผิด ToS)
- ใช้ account รองสำหรับ Auto-publish เสมอ
- Selector ใน `publisherAgent.mjs` อาจต้องปรับตาม UI TikTok จริง
- TikTok Shop API (`/api/tiktok/products`) เป็น scaffold — ต้องสมัคร developer + ได้ approval ก่อนถึงใช้งานจริง
