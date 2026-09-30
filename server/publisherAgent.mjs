/* ─── Phase 6: Publisher Agent (Risky Mode)
   ⚠️ ใช้ Playwright ขับ TikTok Web เพื่ออัปโหลด + ปักตะกร้าแทนผู้ใช้
   ผิด ToS ของ TikTok → เสี่ยงแบน account ให้ใช้ account รองเท่านั้น
   ต้องติดตั้งก่อนใช้:  npm i playwright && npx playwright install chromium */

const sleep = ms => new Promise(r => setTimeout(r, ms))
const randBetween = (min, max) => Math.floor(min + Math.random() * (max - min))

/* หยุดพักแบบคน (ลดโอกาสโดนจับ bot) */
async function humanDelay(min = 1500, max = 4000) {
  await sleep(randBetween(min, max))
}

export async function publishToTikTok({ clipPath, productLink, caption, opts = {} }) {
  const { chromium } = await import('playwright').catch(() => {
    throw new Error('ไม่พบ playwright — รัน: npm i playwright && npx playwright install chromium')
  })
  const sessionJson = opts.sessionJson
  if (!sessionJson) throw new Error('PUBLISHER_SESSION_JSON ไม่ถูกตั้ง (.env) — ต้องมี session login TikTok')

  const context = await chromium.launchPersistentContext(sessionJson, {
    headless: opts.headless !== false,
    args: ['--no-sandbox'],
  })
  const page = await context.newPage()
  try {
    // ── 1. เปิดหน้า upload ──
    await page.goto('https://www.tiktok.com/upload', { waitUntil: 'domcontentloaded' })
    await humanDelay()

    // ── 2. เลือกไฟล์คลิป ──
    const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 30000 })
    await fileInput.setInputFiles(clipPath)
    await humanDelay(4000, 9000) // รอประมวลผลคลิป

    // ── 3. พิมพ์แคปชัน ──
    const captionBox = await page.$('[contenteditable="true"]')
    if (captionBox && caption) {
      await captionBox.click()
      await page.keyboard.type(caption, { delay: 20 })
    }
    await humanDelay()

    // ── 4. ปักตะกร้าสินค้า ──
    if (productLink) {
      // TODO: selector อาจเปลี่ยนตาม UI TikTok — ปรับให้ตรงกับหน้าเว็บตอนใช้งานจริง
      const addProductBtn = await page.$('text=เพิ่มสินค้า, text=Add product, text=ตะกร้า')
      if (addProductBtn) {
        await addProductBtn.click()
        await humanDelay()
        const linkInput = await page.$('input[placeholder*="ลิงก์"], input[placeholder*="link"], input[placeholder*="URL"]')
        if (linkInput) {
          await linkInput.fill(productLink)
          await humanDelay(800, 2000)
          await page.keyboard.press('Enter')
          await humanDelay()
        }
      }
    }

    // ── 5. กดโพสต์ ──
    const postBtn = await page.$('text=โพสต์, text=Post, text=เผยแพร่')
    if (!postBtn) throw new Error('ไม่เจอปุ่มโพสต์ — UI อาจเปลี่ยน ตรวจ selector')
    await postBtn.click()
    await humanDelay(3000, 6000)

    return { ok: true, note: 'กดโพสต์แล้ว (รอ TikTok ประมวลผล)' }
  } finally {
    await context.close()
  }
}
