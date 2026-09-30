/* ลงชื่อเข้า TikTok ครั้งเดียว เพื่อเซฟ session ลงโฟลเดอร์ PUBLISHER_SESSION_JSON
   รัน: node scripts/login-tiktok.mjs
   เปิดเบราว์เซอร์ → ล็อกอิน (สแกน QR / ใส่รหัส) → สคริปต์ตรวจพบแล้วจะปิดให้อัตโนมัติ
   ⚠️ ใช้ account รองเท่านั้น (เสี่ยงแบน) */
import { chromium } from 'playwright'
import path from 'path'
import { mkdir } from 'fs/promises'

const sessionDir = process.env.PUBLISHER_SESSION_JSON
  || path.join(process.cwd(), '.tiktok-session')
await mkdir(sessionDir, { recursive: true })

const context = await chromium.launchPersistentContext(sessionDir, {
  headless: false,
  args: ['--no-sandbox'],
})
const page = await context.newPage()
console.log('🌐 กำลังเปิด TikTok — กรุณาล็อกอินในหน้าต่างที่โผล่มาด้วย account รอง')
await page.goto('https://www.tiktok.com/login', { waitUntil: 'domcontentloaded' })

const deadline = Date.now() + 5 * 60 * 1000
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 3000))
  const cookies = await context.cookies()
  const loggedIn = cookies.some(c => c.name === 'sessionid' || c.name === 'sid_tt')
  if (loggedIn) {
    console.log('✅ ล็อกอินสำเร็จ — เซฟ session ลง', sessionDir)
    break
  }
  console.log('⏳ รอการล็อกอิน... (เปิดหน้าต่างเบราว์เซอร์ด้านหลัง)')
}
await context.close()
console.log('👋 ปิดเบราว์เซอร์แล้ว สามารถทดสอบ Publish ได้เลย')
