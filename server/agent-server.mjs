import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, readFile, stat, readdir } from 'node:fs/promises'
import { existsSync, createReadStream, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { publishToTikTok } from './publisherAgent.mjs'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const ROOT = path.resolve(__dirname, '..')
const WORK = path.join(ROOT, 'workspace')
const UPLOAD_DIR = path.join(WORK, 'uploads')
const MUSIC_DIR = path.join(ROOT, 'music')
const QUEUE_FILE = path.join(WORK, 'queue.json')
const HOME_FFMPEG = '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg'
const FFMPEG = existsSync(HOME_FFMPEG) ? HOME_FFMPEG : path.join(ROOT, 'node_modules/ffmpeg-static/ffmpeg')
const FONTS = [
  '/System/Library/Fonts/Supplemental/SukhumvitSet.ttc',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
]
const PORT = process.env.PORT || 8790

const PUBLISHER_MODE = process.env.PUBLISHER_MODE === 'true'
const PUBLISHER_SESSION_JSON = process.env.PUBLISHER_SESSION_JSON
const PUBLISHER_MIN_DELAY = Number(process.env.PUBLISHER_MIN_DELAY || 1500)
const PUBLISHER_MAX_DELAY = Number(process.env.PUBLISHER_MAX_DELAY || 4000)

try { process.loadEnvFile?.(path.join(ROOT, '.env')) } catch {}
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5'
const KLING_API = process.env.KLING_API_BASE || 'https://api.klingai.com'
const KLING_ACCESS_KEY = process.env.KLING_ACCESS_KEY
const KLING_SECRET_KEY = process.env.KLING_SECRET_KEY
const KLING_MODEL = process.env.KLING_MODEL || 'kling-v1'
const KLING_MODE = process.env.KLING_MODE || 'std'

const jobs = new Map()
/* Kling text2video tasks being polled in the background: taskId → {jobId, jobDir, product, script, busy, fails} */
const klingTasks = new Map()

/* ─── helpers ─── */
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
const readBody = req => new Promise((resolve, reject) => {
  let body = ''
  req.on('data', c => body += c)
  req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}) } catch (e) { reject(e) } })
})

async function loadQueue() {
  try { return JSON.parse(await readFile(QUEUE_FILE, 'utf8')) } catch { return [] }
}
async function saveQueue(items) {
  await mkdir(WORK, { recursive: true })
  await writeFile(QUEUE_FILE, JSON.stringify(items, null, 2))
}

/* ─── Phase 2: Kling AI Video Agent ─── */

/* Free-tier guard: count kling submissions per local day */
const KLING_DAILY_LIMIT = Number(process.env.KLING_DAILY_LIMIT || 5)
const USAGE_FILE = path.join(WORK, 'usage.json')

async function loadUsage() {
  try { return JSON.parse(await readFile(USAGE_FILE, 'utf8')) } catch { return {} }
}
async function saveUsage(u) {
  await mkdir(WORK, { recursive: true })
  await writeFile(USAGE_FILE, JSON.stringify(u, null, 2))
}
const todayKey = () => new Date().toISOString().slice(0, 10)

async function klingUsageToday() {
  const u = await loadUsage()
  return { date: todayKey(), used: u[todayKey()] || 0, limit: KLING_DAILY_LIMIT }
}

function friendlyKlingError(message) {
  const m = String(message).toLowerCase()
  if (m.includes('balance not enough') || m.includes('account balance'))
    return 'API Balance เป็น 0 — ต้องเติมเครดิตเข้า API (ต่างห่างจากเว็บ) ในเมนู API/Developer ของ Kling'
  if (m.includes('credit') || m.includes('quota') || m.includes('balance') || m.includes('insufficient') || m.includes('权限'))
    return 'Credits ฟรีวันนี้หมดแล้ว (หรือ quota API ไม่พอ)'
  if (m.includes('auth') || m.includes('signature') || m.includes('401')) return 'Key Kling ไม่ถูกต้อง'
  if (m.includes('model') || m.includes('not found') || m.includes('unsupported')) return 'โมเดล/Kling ไม่รองรับค่าที่ส่ง'
  if (m.includes('region') || m.includes('area') || m.includes('country')) return 'Region ไม่รองรับ (ลองเปลี่ยน KLING_API)'
  return null
}

function klingToken() {
  const now = Math.floor(Date.now() / 1000)
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url')
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: KLING_ACCESS_KEY, exp: now + 1800, nbf: now - 5 })}`
  const sig = crypto.createHmac('sha256', KLING_SECRET_KEY || '').update(data).digest('base64url')
  return `${data}.${sig}`
}

async function klingFetch(pathname, options = {}) {
  if (!KLING_ACCESS_KEY && !KLING_SECRET_KEY) throw new Error('KLING_ACCESS_KEY not set in .env')
  /* International platform: single api-key-kling-* key → plain Bearer.
     China platform: AccessKey + SecretKey → signed JWT. */
  const auth = KLING_SECRET_KEY
    ? `Bearer ${klingToken()}`
    : `Bearer ${KLING_ACCESS_KEY}`
  const resp = await fetch(`${KLING_API}${pathname}`, {
    ...options,
    headers: { Authorization: auth, 'Content-Type': 'application/json', ...options.headers },
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || (data.code != null && data.code !== 0)) throw new Error(data.message || `Kling API ${resp.status}`)
  return data.data ?? data
}

function imageMime(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
}

function safeUploadedImage(filePath, label) {
  const fileName = path.basename(String(filePath || ''))
  const resolved = path.join(UPLOAD_DIR, fileName)
  if (!fileName || fileName === '.' || !existsSync(resolved)) {
    throw new Error(`${label} ต้องเป็นรูปที่อัปโหลดผ่านระบบ`)
  }
  return resolved
}

async function generateMasterFrame({ productImagePath, backgroundImagePath, productName, direction = '' }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set in .env')
  const productRef = safeUploadedImage(productImagePath, 'รูปสินค้า')
  const sceneRef = safeUploadedImage(backgroundImagePath, 'รูปฉาก')
  const form = new FormData()
  form.append('model', OPENAI_IMAGE_MODEL)
  form.append('size', '1024x1536')
  form.append('quality', 'medium')
  form.append('input_fidelity', 'high')
  form.append('output_format', 'png')
  form.append('prompt', [
    'Create one photorealistic vertical TikTok product advertisement master frame.',
    'Image 1 is the product identity reference. Preserve the exact product shape, colors, materials, camera cutouts, decorations, printed details, proportions, and orientation. Do not redesign or replace it.',
    'Image 2 is the scene reference. Preserve its room layout, desk, lighting direction, color palette, and visual mood.',
    `Place "${productName || 'the product'}" naturally in the scene with correct scale, perspective, contact shadow, reflections, and matching light.`,
    'Show only one product. No hands, duplicate objects, new logos, added text, or watermark.',
    direction && `Creative direction: ${direction}`,
  ].filter(Boolean).join(' '))
  for (const filePath of [productRef, sceneRef]) {
    const bytes = await readFile(filePath)
    form.append('image[]', new Blob([bytes], { type: imageMime(filePath) }), path.basename(filePath))
  }
  const resp = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(data?.error?.message || `OpenAI Image API ${resp.status}`)
  const encoded = data?.data?.[0]?.b64_json
  if (!encoded) throw new Error('OpenAI returned no image')
  const name = `master-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  const output = path.join(UPLOAD_DIR, name)
  await writeFile(output, Buffer.from(encoded, 'base64'))
  return { path: output, url: `/api/files/${name}`, model: OPENAI_IMAGE_MODEL }
}

function buildKlingPrompt(product, script) {
  const hookEn = script.slides?.[0]?.en || script.hook || ''
  const points = (product.sellingPoints || []).join(', ')
  return [
    hookEn && `Opening hook: ${hookEn}.`,
    `Vertical commercial showcase of "${product.name}"`,
    points && `Key features: ${points}.`,
    'Cinematic lighting, close-up product details, clean modern background, smooth camera movement, high quality advertisement.',
  ].filter(Boolean).join(' ')
}

async function startKlingJob(product, script) {
  const usage = await klingUsageToday()
  if (usage.used >= KLING_DAILY_LIMIT) {
    throw new Error(`โควต้าฟรีของวันนี้หมด (${KLING_DAILY_LIMIT} คลิป) — รอ reset พรุ่งนี้ หรือใช้ "Render ทันที (Template)"`)
  }
  const jobId = `kling-${Date.now()}`
  const jobDir = path.join(WORK, jobId)
  await mkdir(jobDir, { recursive: true })
  jobs.set(jobId, { id: jobId, agent: 'video-kling', status: 'queued', step: 'Submitting to Kling' })
  try {
    const data = await klingFetch('/v1/videos/text2video', {
      method: 'POST',
      body: JSON.stringify({
        model_name: KLING_MODEL,
        mode: KLING_MODE,
        aspect_ratio: '9:16',
        duration: '5',
        prompt: buildKlingPrompt(product, script),
        negative_prompt: 'blurry, low quality, watermark, text overlay, distorted product',
        cfg_scale: 0.5,
      }),
    })
    const u = await loadUsage()
    u[todayKey()] = (u[todayKey()] || 0) + 1
    await saveUsage(u)
    klingTasks.set(data.task_id, { jobId, jobDir, product, script, busy: false, fails: 0 })
    jobs.set(jobId, { ...jobs.get(jobId), status: 'working', step: `Kling ${data.task_status || 'submitted'}`, klingTaskId: data.task_id })
    return { jobId, klingTaskId: data.task_id }
  } catch (e) {
    const friendly = friendlyKlingError(e.message)
    const full = friendly ? `${friendly} | Kling: ${e.message}` : e.message
    jobs.set(jobId, { id: jobId, agent: 'video-kling', status: 'failed', step: full })
    throw new Error(full)
  }
}

function scheduleKlingPolling() {
  const timer = setInterval(async () => {
    for (const [taskId, t] of klingTasks) {
      if (t.busy) continue
      t.busy = true
      try {
        const info = await klingFetch(`/v1/videos/text2video/${taskId}`)
        const st = info.task_status
        if (st === 'succeed') {
          klingTasks.delete(taskId)
          await finishKlingJob(t, info.task_result?.videos?.[0]?.url)
        } else if (st === 'failed') {
          klingTasks.delete(taskId)
          jobs.set(t.jobId, { ...jobs.get(t.jobId), status: 'failed', step: info.task_status_msg || 'Kling render failed' })
        } else {
          jobs.set(t.jobId, { ...jobs.get(t.jobId), status: 'working', step: `Kling ${st}` })
          t.fails = 0
        }
      } catch (e) {
        t.fails += 1
        if (t.fails > 10) {
          klingTasks.delete(taskId)
          jobs.set(t.jobId, { ...jobs.get(t.jobId), status: 'failed', step: `Kling polling gave up: ${e.message}` })
        }
      } finally {
        t.busy = false
      }
    }
  }, 20000)
  timer.unref()
}
scheduleKlingPolling()

async function finishKlingJob({ jobId, jobDir, product, script }, url) {
  if (!url) {
    jobs.set(jobId, { id: jobId, agent: 'video-kling', status: 'failed', step: 'Kling returned no video URL' })
    return
  }
  jobs.set(jobId, { ...jobs.get(jobId), status: 'working', step: 'Downloading Kling clip' })
  const raw = path.join(jobDir, 'kling-raw.mp4')
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Download Kling clip failed: HTTP ${resp.status}`)
  await writeFile(raw, Buffer.from(await resp.arrayBuffer()))

  jobs.set(jobId, { ...jobs.get(jobId), status: 'working', step: 'Composing narration + captions' })
  const audio = path.join(jobDir, 'narration.aiff')
  await makeNarration(audio, script.narration)
  const font = findFont()
  if (!font) throw new Error('No Thai font available')
  const caption = wrapThai(script.hook || script.slides?.[0]?.thai || product.name)
  const lines = caption.split('\n').map((ln, li) =>
    `drawtext=expansion=none:fontfile='${escFF(font)}':text='${escFF(ln)}':fontcolor=white:fontsize=72:line_spacing=18:x=(w-text_w)/2:y=1450+${li}*110:box=1:boxcolor=black@0.45:boxborderw=24`
  ).join(',')
  const output = path.join(jobDir, 'tiktok-9x16.mp4')
  await runFF(jobId, [
    '-y', '-i', raw, '-i', audio,
    '-filter_complex', `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[v];[v]${lines}[out]`,
    '-map', '[out]', '-map', '1:a', '-shortest',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', output,
  ], 'Encoding final video')

  if (product.tiktokProductId && !product.imagePath) await attachTikTokImage(product)
  const item = await enqueueClip({ jobDir, productName: product.name, sku: product.sku, price: product.price, imagePath: product.imagePath })
  jobs.set(jobId, { id: jobId, agent: 'video-kling', status: 'completed', step: 'AI video ready', output, queueItemId: item.id })
}

/* ─── Phase 4: Telegram Report Agent ─── */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID
const TELEGRAM_POLL = process.env.TELEGRAM_POLL === 'true'

async function telegramApi(method, body) {
  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || !data.ok) throw new Error(data.description || `Telegram ${resp.status}`)
  return data.result
}

async function telegramSend(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set in .env')
  return telegramApi('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true })
}

async function sendApprovalMessage(item) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set in .env')
  const text = [
    `🛒 <b>ขออนุมัติปักตะกร้า</b>`,
    `สินค้า: ${item.productName}${item.sku ? ` (${item.sku})` : ''}`,
    item.price ? `ราคา: ฿${item.price}` : '',
    `สถานะ: รออนุมัติ`,
  ].filter(Boolean).join('\n')
  return telegramApi('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ อนุมัติ', callback_data: `approve:${item.id}` },
        { text: '⏸ เลื่อน', callback_data: `postpone:${item.id}` },
      ]],
    },
  })
}

/* Poll Telegram updates to receive inline-button presses (works without public webhook URL) */
async function handleCallback(callback) {
  const [action, id] = String(callback.data).split(':')
  await telegramApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'อัปเดตแล้ว ✅' })
  const queue = await loadQueue()
  const item = queue.find(q => q.id === id)
  if (!item) {
    await telegramApi('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text: `⚠️ ไม่เจอรายการ ${id}` })
    return
  }
  item.status = action === 'approve' ? 'approved' : action === 'postpone' ? 'postponed' : 'rejected'
  item.decidedAt = new Date().toISOString()
  await saveQueue(queue)
  await telegramApi('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text: `${action === 'approve' ? '✅' : '⏸'} ${item.productName} → ${item.status === 'approved' ? 'อนุมัติแล้ว' : 'เลื่อน'}`,
    parse_mode: 'HTML',
  })
}

let lastUpdateId = 0
function scheduleTelegramPolling() {
  let polling = false
  const poll = async () => {
    if (polling) return
    polling = true
    try {
      const updates = await telegramApi('getUpdates', { offset: lastUpdateId + 1, timeout: 20 })
      for (const u of updates) {
        lastUpdateId = Math.max(lastUpdateId, u.update_id)
        if (u.callback_query) await handleCallback(u.callback_query)
      }
    } catch (e) { console.error('Telegram poll error:', e.message) }
    polling = false
    setTimeout(poll, 1000)
  }
  poll()
}
if (TELEGRAM_POLL && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) scheduleTelegramPolling()

/* ─── Time-based publishing (respect scheduleSlot HH:MM) ───
   ถึงชั่วโมงที่ตั้งไว้:
   - ถ้าเปิด PUBLISHER_MODE → Hernest เรียก Publisher Agent โพสต์ให้
   - ไม่เปิด → ส่งแจ้งเตือน Telegram ให้คนโพสต์มือ */
let lastSlotMinute = ''
function schedulePublishing() {
  const pad = n => String(n).padStart(2, '0')
  const timer = setInterval(async () => {
    const now = new Date()
    const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`
    if (hhmm === lastSlotMinute) return
    lastSlotMinute = hhmm
    const queue = await loadQueue()
    const due = queue.filter(q => q.status === 'approved' && q.scheduleSlot === hhmm)
    for (const item of due) {
      if (PUBLISHER_MODE) {
        runPublisher(item).catch(e => console.error('Publisher failed:', e.message))
      } else if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        try {
          await telegramApi('sendMessage', {
            chat_id: TELEGRAM_CHAT_ID,
            text: `⏰ ถึงเวลาโพสต์: <b>${item.productName}</b>\nลิงก์สินค้า: ${item.tiktokProductId || '-'}\n📥 ดาวน์โหลดคลิปจากหน้าเว็บ แล้วโพสต์มือในแอป TikTok (ปักตะกร้าในแอป)`,
            parse_mode: 'HTML',
          })
        } catch (e) { console.error('Slot reminder failed:', e.message) }
      }
    }
  }, 30000)
  timer.unref()
}
schedulePublishing()

async function buildDailyReport() {
  const queue = await loadQueue()
  const usage = await klingUsageToday()
  const count = st => queue.filter(q => q.status === st).length
  const approved = queue.filter(q => q.status === 'approved')
  const lines = [
    '📊 <b>AI TikBat — รายงานประจำวัน</b>',
    '',
    `🛒 คิวทั้งหมด: ${queue.length}`,
    `⏳ รออนุมัติ: ${count('pending')}`,
    `✅ อนุมัติแล้ว: ${count('approved')}`,
    `🎬 Kling วันนี้: ${usage.used}/${usage.limit} คลิป`,
  ]
  if (approved.length) {
    lines.push('', '📌 <b>พร้อมโพสต์:</b>')
    for (const a of approved.slice(0, 8)) {
      lines.push(`• ${a.productName} @ ${a.scheduleSlot || 'ยังไม่ตั้งเวลา'}`)
    }
    if (approved.length > 8) lines.push(`… และอีก ${approved.length - 8} รายการ`)
  }
  return lines.join('\n')
}

let lastReportKey = ''
function scheduleReports() {
  const timer = setInterval(async () => {
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const key = `${todayKey()}-${hhmm}`
    if ((hhmm === '09:00' || hhmm === '21:00') && lastReportKey !== key) {
      lastReportKey = key
      try { await telegramSend(await buildDailyReport()) } catch (e) { console.error('Telegram report failed:', e.message) }
    }
  }, 30000)
  timer.unref()
}
scheduleReports()

/* ─── Phase 4: TikTok Shop Open API client (scaffold)
   รองรับ 2 โหมด:
   1) Access Token (ร้านตัวเอง / ได้ token จาก OAuth) — แนะนำ ใช้งานง่ายสุด
   2) Signed query (app_key + app_secret) — สำหรับ app ที่ขอ approval แบบเต็ม
   ต้องสมัคร developer + ได้ approval ก่อนถึงเรียกงานจริงได้ */

const TT_APP_KEY = process.env.TIKTOK_SHOP_APP_KEY
const TT_APP_SECRET = process.env.TIKTOK_SHOP_APP_SECRET
const TT_SHOP_ID = process.env.TIKTOK_SHOP_SHOP_ID
const TT_ACCESS_TOKEN = process.env.TIKTOK_SHOP_ACCESS_TOKEN
const TT_REFRESH_TOKEN = process.env.TIKTOK_SHOP_REFRESH_TOKEN
const TT_API_VERSION = process.env.TIKTOK_SHOP_API_VERSION || '202309'
const TT_API_BASE = process.env.TIKTOK_SHOP_API_BASE || 'https://open-api.tiktokglobalshop.com'
/* Region ส่งไปใน path สำหรับบาง endpoint (TH/ID/UK/US ฯลฯ) */
const TT_REGION = process.env.TIKTOK_SHOP_REGION || 'TH'

/* TikTok Shop signature: HMAC-SHA256 over path + sorted params */
function ttSign(pathname, params, bodyObj) {
  const sorted = Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}${v}`).join('')
  let base = pathname + sorted
  if (bodyObj && typeof bodyObj === 'object' && Object.keys(bodyObj).length) {
    base += JSON.stringify(bodyObj)
  }
  return crypto.createHmac('sha256', TT_APP_SECRET || '').update(base).digest('hex')
}

/* รีเฟรช access_token ด้วย refresh_token (โหมด app) — เรียกอัตโนมัติเมื่อ token หมดอายุ */
let _ttAccessToken = TT_ACCESS_TOKEN
async function ensureAccessToken() {
  if (_ttAccessToken) return _ttAccessToken
  if (!TT_REFRESH_TOKEN || !TT_APP_KEY || !TT_APP_SECRET) return null
  const url = `${TT_API_BASE}/api/token/refresh?app_key=${TT_APP_KEY}&app_secret=${TT_APP_SECRET}&refresh_token=${TT_REFRESH_TOKEN}&grant_type=refresh_token`
  const resp = await fetch(url)
  const data = await resp.json().catch(() => ({}))
  if (data.code === 0 && data.data?.access_token) {
    _ttAccessToken = data.data.access_token
    return _ttAccessToken
  }
  throw new Error(data.message || 'รีเฟรช TikTok Shop token ไม่สำเร็จ')
}

async function tiktokShopRequest(pathname, { method = 'GET', params = {}, body, versioned = true } = {}) {
  const token = await ensureAccessToken()
  const headers = { 'Content-Type': 'application/json' }
  let url
  let qs = ''

  if (token) {
    /* โหมด access token: ส่งผ่าน header x-tts-access-token */
    headers['x-tts-access-token'] = token
    const fullPath = versioned ? `/api/${TT_API_VERSION}${pathname}` : pathname
    if (TT_SHOP_ID) params = { ...params, shop_id: TT_SHOP_ID }
    qs = new URLSearchParams(params).toString()
    url = `${TT_API_BASE}${fullPath}${qs ? `?${qs}` : ''}`
  } else {
    /* โหมด signed query (app_key/secret) */
    if (!TT_APP_KEY || !TT_APP_SECRET) throw new Error('ต้องตั้ง TIKTOK_SHOP_ACCESS_TOKEN (โหมดร้านตัวเอง) หรือ TIKTOK_SHOP_APP_KEY+SECRET ใน .env')
    const signedParams = { app_key: TT_APP_KEY, timestamp: Math.floor(Date.now() / 1000), ...params }
    const sign = ttSign(pathname, signedParams, body)
    const fullPath = versioned ? `/${TT_API_VERSION}${pathname}` : pathname
    if (TT_SHOP_ID) signedParams.shop_id = TT_SHOP_ID
    qs = new URLSearchParams({ ...signedParams, sign }).toString()
    url = `${TT_API_BASE}${fullPath}?${qs}`
  }

  const resp = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || (data.code != null && data.code !== 0 && data.code !== 10000)) {
    throw new Error(data.message || `TikTok Shop API ${resp.status}`)
  }
  return data.data ?? data
}

async function searchTikTokProducts(keyword) {
  return tiktokShopRequest('/products/search', {
    method: 'POST',
    body: { shop_region: TT_REGION, keyword: keyword || undefined, page_size: 10 },
  })
}

/* ดึงรายละเอียดสินค้าจาก TikTok Shop ตาม Product ID (ใช้รูป + ชื่อ + ราคา) */
async function fetchTikTokProductDetail(productId) {
  if (!productId) return null
  return tiktokShopRequest('/products/detail', {
    method: 'POST',
    body: { product_id: String(productId), shop_region: TT_REGION },
  })
}

async function downloadImage(url, dest) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`โหลดรูปไม่สำเร็จ ${r.status}`)
  await writeFile(dest, Buffer.from(await r.arrayBuffer()))
  return dest
}

/* แนบรูปสินค้า (และเติมชื่อ/ราคา) จาก TikTok Shop — ถ้าเรียก API ไม่ได้จะข้าม quietly */
async function attachTikTokImage(product) {
  const pid = product.tiktokProductId || product.ttid
  if (!pid) return product
  try {
    const detail = await fetchTikTokProductDetail(pid)
    const p = detail?.product || detail || {}
    const img = p.images?.[0]?.url
      || (Array.isArray(p.images) ? p.images[0] : null)
      || p.skus?.[0]?.sku_image
      || p.image
    if (img && !product.imagePath) {
      const ext = path.extname(new URL(img, 'http://x').pathname) || '.jpg'
      const dest = path.join(WORK, `ttimg-${pid}${ext}`)
      await downloadImage(img, dest)
      product.imagePath = dest
    }
    if (!product.name && p.name) product.name = p.name
    if (!product.price && p.price_info?.[0]?.min_price) product.price = p.price_info[0].min_price
  } catch (e) {
    console.error('TikTok product fetch failed (ข้ามได้):', e.message)
  }
  return product
}

/* ─── Phase 1: Research Script Agent ───
   LLM (OpenAI-compatible) → Thai selling script.
   Falls back to template when no key or API error. */

function templateScript(product) {
  const name = product?.name || 'this product'
  const price = product?.price ? `ราคาเพียง ${product.price} บาทเท่านั้น` : 'ราคาไม่แพง ห้ามพลาด'
  const selling = Array.isArray(product?.sellingPoints) && product.sellingPoints.length
    ? product.sellingPoints
    : ['คุณภาพดี ทนทาน ใช้งานได้จริง', 'ดีไซน์สวย เข้ากับทุกไลฟ์สไตล์', 'ของคุ้ม ในราคะสุดคุ้ม']
  const cta = product?.cta || 'สั่งซื้อเลยวันนี้ ก่อนหมดสต๊อก!'
  const slides = [
    { thai: `รู้จักกับ ${name}!`, en: `Discover ${name}!` },
    ...selling.map(s => ({ thai: s, en: '' })),
    { thai: price, en: product?.price ? `Only ${product.price} baht.` : 'Amazing value.' },
    { thai: `🔥 ${cta}`, en: 'Order now before it sells out!' },
  ]
  return { slides, narration: slides.map(s => s.en).filter(Boolean).join(' ') }
}

function parseLLMScript(raw, product) {
  let text = raw.trim()
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (m) text = m[1]
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end !== -1) text = text.slice(start, end + 1)
  const data = JSON.parse(text)
  if (!Array.isArray(data.slides) || !data.slides.length) throw new Error('no slides')
  const slides = data.slides.slice(0, 8).map((s, i) => ({
    thai: String(i === 0 ? `รู้จักกับ ${product?.name || data.product || 'สินค้านี้'}! ${s.thai ?? s}` : s.thai ?? s),
    en: String(s.en ?? ''),
  }))
  return {
    slides,
    narration: slides.map(s => s.en).filter(Boolean).join(' ') || slides.map(s => s.thai).join(' '),
    hook: String(data.hook ?? slides[0]?.thai ?? ''),
  }
}

async function llmScript(product) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set')
  const prompt = [
    'You are a Thai TikTok Shop copywriter.',
    'Write a short vertical-video selling script for this product:',
    JSON.stringify({
      name: product.name,
      price: product.price,
      sellingPoints: product.sellingPoints || [],
      audience: product.audience || 'คนไทยอายุ 18-35',
      tone: product.tone || 'สนุก เร้าใจ ขายเก่ง',
    }, null, 2),
    'Respond ONLY with minified JSON: {"hook":"ประโยคเปิด 3 วินาทีแรก","slides":[{"thai":"ข้อความบนจอภาษาไทย ไม่เกิน 20 ตัวอักษร","en":"English narration sentence"}],"cta":"ประโยชน์ปิดการขาย"}',
    'Rules: 5-7 slides. Slide 1 = hook. Last slide = CTA. Thai must be casual spoken Thai.',
  ].join('\n')

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9,
    }),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(data.error?.message || `OpenAI ${resp.status}`)
  return parseLLMScript(data.choices?.[0]?.message?.content ?? '', product)
}

/* ─── TTS via macOS say ─── */
async function makeNarration(output, text) {
  const voice = 'Eddy (อังกฤษ (สหรัฐฯ))'
  return execFileAsync('/usr/bin/say', ['-v', voice, '-o', output, text])
}

/* ─── Video renderer (slide-based, proven pipeline) ─── */
const findFont = () => FONTS.find(existsSync) || ''
const escFF = s => String(s)
  .replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/,/g, '\\,').replace(/\[/g, '\\[')
  .replace(/\]/g, '\\]').replace(/'/g, "\\'")

function wrapThai(text, maxLen = 20) {
  if (text.length <= 24) return text
  const words = text.split(/\s+/)
  const l1 = []
  let n = 0
  for (const w of words) {
    if (n + w.length + (l1.length ? 1 : 0) <= maxLen) { l1.push(w); n += w.length + 1 }
    else break
  }
  const rest = words.slice(l1.length).join(' ')
  return rest ? `${l1.join(' ')}\n${rest}` : text
}

function buildSegmentArgs({ DUR, W, H, audio, seg, font, fg, c0, c1, thai, productImage, bgImage, productName, price, hook }) {
  const useBg = bgImage && existsSync(bgImage)
  const useProduct = productImage && existsSync(productImage)
  const inputs = ['-y']
  if (useBg) {
    inputs.push('-loop', '1', '-t', String(DUR), '-i', bgImage)
  } else {
    inputs.push('-f', 'lavfi', '-t', String(DUR), '-i', `gradients=s=${W}x${H}:c0=${c0}:c1=${c1}:n=2:speed=0.01`)
  }
  if (useProduct) inputs.push('-loop', '1', '-i', productImage)
  inputs.push('-i', audio)
  const audioSrc = useProduct ? '2:a' : '1:a'

  let filter
  if (useBg) {
    filter = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[bg1]`
  } else {
    filter = `[0:v]setsar=1[bg0];[bg0]eq=brightness=-0.12:contrast=1.05[bg1]`
  }
  if (useProduct) {
    // Ken Burns: ช้าๆ ซูมเข้าบนรูปสินค้า
    // ตัดแบ็กกราวด์โปร่งใส (PNG alpha) -> คอมโพสิตทับพื้นหลังฉากจริง + เงาใต้สินค้า
    filter += `;[1:v]scale=520:520:force_original_aspect_ratio=decrease,pad=520:520:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba,zoompan=z='min(zoom+0.0016,1.18)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=520x520:fps=30,setsar=1[pi]`
    filter += `;[pi]split=2[piA][piB]`
    filter += `;[piA]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.45[piShadow]`
    filter += `;[piShadow]gblur=sigma=12[piShadowB]`
    filter += `;[bg1][piShadowB]overlay=(W-w)/2+14:678:shortest=1[bg2]`
    filter += `;[bg2][piB]overlay=(W-w)/2:640:shortest=1[base]`
  } else {
    filter += `;[bg1]null[base]`
  }

  const dt = (text, y, size, extra = '') =>
    `drawtext=expansion=none:fontfile='${escFF(font)}':text='${escFF(text)}':fontcolor=white:fontsize=${size}:line_spacing=18:x=(w-text_w)/2:y=${y}:borderw=7:bordercolor=black${extra}`

  const steps = []
  let chain = '[base]'
  if (hook) { steps.push(`${chain}${dt(hook, 175, 94)}[s1]`); chain = '[s1]' }

  const lines = thai.split('\n')
  const yBase = H / 2 + 250
  lines.forEach((ln, li) => {
    const yRow = Math.round(yBase + (li - (lines.length - 1) / 2) * 130)
    const label = `s${steps.length + 1}`
    steps.push(`${chain}${dt(ln, yRow, 80)}[${label}]`)
    chain = `[${label}]`
  })

  const cta = productName
    ? `สั่งเลย! ${productName}${price ? `  ฿${price}` : ''}`
    : 'สั่งเลยวันนี้!'
  steps.push(`${chain}drawbox=x=0:y=ih-270:w=iw:h=270:color=black@0.55:t=fill[sb]`)
  chain = '[sb]'
  steps.push(`${chain}${dt(cta, 'H-200', 74)}[out]`)

  filter += ';' + steps.join(';')
  const aIdx = useProduct ? 2 : 1
  filter += `;[${aIdx}:a]apad=whole_dur=${DUR}[aud]`
  return {
    args: [...inputs, '-filter_complex', filter, '-map', '[out]', '-map', '[aud]',
      '-t', String(DUR), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', seg],
  }
}

function runFF(jobId, args, step) {
  return new Promise((resolve, reject) => {
    if (!existsSync(FFMPEG)) return reject(new Error('ffmpeg binary is not available'))
    const child = spawn(FFMPEG, args)
    jobs.set(jobId, { ...jobs.get(jobId), status: 'working', step, pid: child.pid })
    let error = ''
    child.stderr.on('data', d => { error += d.toString().slice(-3000) })
    child.on('close', code => code === 0 ? resolve() : reject(new Error(error || `ffmpeg exited ${code}`)))
  })
}

async function runCommercial(jobId, product, script, jobDir) {
  let audio
  if (product.musicPath && existsSync(product.musicPath)) {
    audio = product.musicPath
  } else {
    audio = path.join(jobDir, 'narration.aiff')
    await makeNarration(audio, script.narration)
    if (!existsSync(audio)) throw new Error('TTS narration not produced')
  }
  const font = findFont()
  if (!font) throw new Error('No Thai font available')

  const DUR = 4, W = 1080, H = 1920
  const palettes = [
    ['0x1e3a8a', '0x3b82f6'], ['0x7c2d12', '0xea580c'], ['0x14532d', '0x22c55e'],
    ['0x4c1d95', '0xa855f7'], ['0x831843', '0xec4899'], ['0x172554', '0x0ea5e9'],
  ]
  const lines = []
  const segFiles = []
  for (let i = 0; i < script.slides.length; i++) {
    const [c0, c1] = palettes[i % palettes.length]
    const idx = String(i).padStart(2, '0')
    const seg = path.join(jobDir, `seg-${idx}.mp4`)
    segFiles.push(seg)
    lines.push(`file '${seg.replace(/'/g, "\\'")}'`)
    const thai = wrapThai(script.slides[i].thai)
    const { args } = buildSegmentArgs({ DUR, W, H, audio, seg, font, fg: '#ffffff', c0, c1, thai, productImage: product.masterFramePath ? '' : product.imagePath, bgImage: product.masterFramePath || product.bgPath, productName: product.name, price: product.price, hook: script.hook })
    await runFF(jobId, args, `Rendering slide ${i + 1}/${script.slides.length}`)
  }

  const listFile = path.join(jobDir, 'concat.txt')
  await writeFile(listFile, lines.join('\n'))
  const output = path.join(jobDir, 'tiktok-9x16.mp4')
  await runFF(jobId, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', output], 'Concatenating final video')
  return output
}

/* auto-add finished clips into the basket queue */
async function enqueueClip({ jobDir, productName, sku, price, imagePath, bgPath }) {
  const queue = await loadQueue()
  const item = {
    id: `bq-${Date.now()}`,
    createdAt: new Date().toISOString(),
    productName: productName || 'Unnamed product',
    sku: sku || '',
    price: price || 0,
    imagePath: imagePath || '',
    bgPath: bgPath || '',
    clipJobId: jobDir ? path.basename(jobDir) : '',
    tiktokProductId: '',
    scheduleSlot: '',
    status: 'pending',
  }
  queue.unshift(item)
  await saveQueue(queue)
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    try { await sendApprovalMessage(item) } catch (e) { console.error('Send approval msg failed:', e.message) }
  }
  return item
}

/* ─── Phase 6: Publisher Agent (Risky Mode) ─── */
async function runPublisher(item) {
  const jobId = `publish-${item.id}`
  const queue = await loadQueue()
  const target = queue.find(q => q.id === item.id)
  if (!target) return
  target.status = 'publishing'
  await saveQueue(queue)
  jobs.set(jobId, { id: jobId, agent: 'publisher', status: 'working', step: 'พิมพ์คลิปเข้า TikTok' })

  const clipJobDir = target.clipJobId ? path.join(WORK, target.clipJobId) : null
  const clipPath = clipJobDir ? path.join(clipJobDir, 'tiktok-9x16.mp4') : null
  if (!clipPath || !existsSync(clipPath)) {
    target.status = 'approved'
    await saveQueue(queue)
    jobs.set(jobId, { id: jobId, agent: 'publisher', status: 'failed', step: 'ไม่เจอไฟล์คลิป' })
    return
  }
  try {
    const result = await publishToTikTok({
      clipPath,
      productLink: target.tiktokProductId,
      caption: target.productName,
      opts: { sessionJson: PUBLISHER_SESSION_JSON, minDelay: PUBLISHER_MIN_DELAY, maxDelay: PUBLISHER_MAX_DELAY },
    })
    target.status = 'published'
    target.publishedAt = new Date().toISOString()
    target.publishNote = result.note
    await saveQueue(queue)
    jobs.set(jobId, { id: jobId, agent: 'publisher', status: 'completed', step: 'โพสต์แล้ว' })
  } catch (e) {
    target.status = 'approved' // คืนสถานะให้คนกดมือได้
    await saveQueue(queue)
    jobs.set(jobId, { id: jobId, agent: 'publisher', status: 'failed', step: e.message })
  }
}

const server = http.createServer(async (req, res) => {
  try {
    /* ── Research Script Agent ── */
    if (req.method === 'POST' && req.url === '/api/agents/research/script') {
      const body = await readBody(req)
      const product = body?.product
      if (!product?.name) return json(res, 400, { error: 'product.name is required' })
      try {
        const script = await llmScript(product)
        return json(res, 200, { source: 'llm', model: OPENAI_MODEL, script })
      } catch (e) {
        if (!OPENAI_API_KEY) return json(res, 200, { source: 'template', note: e.message, script: templateScript(product) })
        return json(res, 200, { source: 'template', note: `LLM failed (${e.message}), used template`, script: templateScript(product) })
      }
    }

    /* ── OpenAI Image Agent: compose a consistent master frame ── */
    if (req.method === 'POST' && req.url === '/api/agents/image/master-frame') {
      const body = await readBody(req)
      try {
        const result = await generateMasterFrame({
          productImagePath: body.productImagePath,
          backgroundImagePath: body.backgroundImagePath,
          productName: body.productName,
          direction: body.direction,
        })
        return json(res, 200, result)
      } catch (e) {
        const billingError = /billing|hard limit|insufficient_quota/i.test(e.message)
        return json(res, billingError ? 402 : 502, {
          error: billingError
            ? 'OpenAI API ไม่มีเครดิตหรือถึงวงเงินที่กำหนด กรุณาเพิ่ม Billing/Credits ที่ platform.openai.com'
            : e.message,
        })
      }
    }

    /* ── Video Agent: Kling text2video ── */
    if (req.method === 'POST' && req.url === '/api/agents/video/kling/run') {
      const body = await readBody(req)
      const product = body.product || {}
      if (!product.name || !body.script?.slides?.length) return json(res, 400, { error: 'product.name and script.slides are required' })
      try {
        const r = await startKlingJob(product, body.script)
        return json(res, 202, { ...r, status: 'submitted' })
      } catch (e) {
        return json(res, 502, { error: e.message })
      }
    }
    if (req.method === 'GET' && /^\/api\/agents\/video\/kling\/task\/[\w-]+$/.test(req.url)) {
      const taskId = req.url.split('/').pop()
      return json(res, 200, await klingFetch(`/v1/videos/text2video/${taskId}`))
    }
    if (req.method === 'GET' && req.url === '/api/agents/video/kling/usage') {
      return json(res, 200, await klingUsageToday())
    }

    /* ── Content Agent: render commercial ── */
    if (req.method === 'POST' && req.url === '/api/agents/content/run') {
      const body = await readBody(req)
      const product = body.product || {}
      if (!product.name) return json(res, 400, { error: 'product.name is required' })
      const script = body.script || templateScript(product)
      const jobId = `content-${Date.now()}`
      const jobDir = path.join(WORK, jobId)
      await mkdir(jobDir, { recursive: true })
      const srcProduct = body.product.imagePath
      if (product.imagePath && existsSync(srcProduct)) {
        const ext = path.extname(srcProduct) || '.jpg'
        product.imagePath = path.join(jobDir, `product${ext}`)
        await writeFile(product.imagePath, await readFile(srcProduct))
      }
      const srcBg = body.product.bgPath
      if (product.bgPath && existsSync(srcBg)) {
        const ext = path.extname(srcBg) || '.jpg'
        product.bgPath = path.join(jobDir, `bg${ext}`)
        await writeFile(product.bgPath, await readFile(srcBg))
      }
      const srcMusic = body.product.musicPath
      let musicResolved = null
      if (srcMusic) {
        if (existsSync(srcMusic)) musicResolved = srcMusic
        else if (existsSync(path.join(MUSIC_DIR, srcMusic))) musicResolved = path.join(MUSIC_DIR, srcMusic)
      }
      if (musicResolved) {
        const ext = path.extname(musicResolved) || '.mp3'
        product.musicPath = path.join(jobDir, `music${ext}`)
        await writeFile(product.musicPath, await readFile(musicResolved))
      }
      jobs.set(jobId, { id: jobId, agent: 'content', status: 'queued', step: 'Producing commercial' })
      if (product.tiktokProductId && !product.imagePath) await attachTikTokImage(product)
      runCommercial(jobId, product, script, jobDir)
        .then(async output => {
          jobs.set(jobId, { id: jobId, agent: 'content', status: 'completed', step: 'Commercial video ready', output })
          const item = await enqueueClip({ jobDir, productName: product.name, sku: product.sku, price: product.price, imagePath: product.imagePath, bgPath: product.bgPath })
          jobs.set(jobId, { ...jobs.get(jobId), queueItemId: item.id })
        })
        .catch(error => jobs.set(jobId, { id: jobId, agent: 'content', status: 'failed', step: error.message }))
      return json(res, 202, { jobId, status: 'queued' })
    }

    /* ── Jobs status ── */
    if (req.method === 'GET' && req.url === '/api/agents/status') {
      return json(res, 200, { jobs: [...jobs.values()] })
    }

    /* ── Stream rendered video ── */
    if (req.method === 'GET' && req.url.startsWith('/api/agents/content/output/')) {
      const jobId = decodeURIComponent(req.url.split('/').pop())
      const job = jobs.get(jobId)
      if (!job?.output || !existsSync(job.output)) return json(res, 404, { error: 'Output video not found' })
      const size = statSync(job.output).size
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' })
      return createReadStream(job.output).pipe(res)
    }

    /* ── Basket Queue ── */
    if (req.method === 'GET' && req.url === '/api/queue') {
      return json(res, 200, { items: await loadQueue() })
    }
    if (req.method === 'POST' && req.url === '/api/queue/add') {
      const body = await readBody(req)
      if (!body?.productName) return json(res, 400, { error: 'productName is required' })
      await attachTikTokImage(body)
      body.imagePath = body.imagePath || ''
      const item = await enqueueClip(body)
      return json(res, 201, { item })
    }
    if (req.method === 'POST' && req.url.match(/^\/api\/queue\/(approve|postpone|reject)\/[\w-]+$/)) {
      const [, , , action, id] = req.url.split('/')
      const queue = await loadQueue()
      const item = queue.find(q => q.id === id)
      if (!item) return json(res, 404, { error: 'Queue item not found' })
      item.status = action === 'approve' ? 'approved' : action === 'postpone' ? 'postponed' : 'rejected'
      item.decidedAt = new Date().toISOString()
      await saveQueue(queue)
      if (action === 'approve' && PUBLISHER_MODE) {
        runPublisher(item).catch(e => console.error('Publisher failed:', e.message))
        return json(res, 202, { item, publishing: true })
      }
      return json(res, 200, { item })
    }
    if (req.method === 'PATCH' && req.url.match(/^\/api\/queue\/[\w-]+$/)) {
      const id = req.url.split('/').pop()
      const body = await readBody(req)
      const queue = await loadQueue()
      const item = queue.find(q => q.id === id)
      if (!item) return json(res, 404, { error: 'Queue item not found' })
      if ('tiktokProductId' in body) item.tiktokProductId = String(body.tiktokProductId).slice(0, 64)
      if ('scheduleSlot' in body) item.scheduleSlot = String(body.scheduleSlot).slice(0, 16)
      await saveQueue(queue)
      return json(res, 200, { item })
    }

    /* ── Serve product image (pulled from TikTok Shop) ── */
    if (req.method === 'GET' && req.url.match(/^\/api\/queue\/[\w-]+\/image$/)) {
      const id = req.url.split('/')[3]
      const item = (await loadQueue()).find(q => q.id === id)
      if (!item?.imagePath || !existsSync(item.imagePath)) return json(res, 404, { error: 'no image' })
      const buf = await readFile(item.imagePath)
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' })
      return res.end(buf)
    }

    /* ── Music library (local folder) ── */
    if (req.method === 'GET' && req.url === '/api/music') {
      try {
        const files = (await readdir(MUSIC_DIR)).filter(f => /\.(mp3|m4a|wav|aac|ogg|flac)$/i.test(f))
        return json(res, 200, { tracks: files })
      } catch { return json(res, 200, { tracks: [] }) }
    }

    /* ── Upload image (product / background) ── */
    if (req.method === 'POST' && req.url === '/api/upload') {
      try {
        const { dataUrl } = await readBody(req)
        const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '')
        if (!m) return json(res, 400, { error: 'ต้องส่ง data URL ของรูป' })
        const ext = (m[1].split('/')[1] || 'png').replace('+xml', '')
        const buf = Buffer.from(m[2], 'base64')
        const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
        await writeFile(path.join(UPLOAD_DIR, name), buf)
        return json(res, 200, { path: path.join(UPLOAD_DIR, name), url: `/api/files/${name}` })
      } catch (e) {
        return json(res, 400, { error: e.message })
      }
    }
    if (req.method === 'GET' && req.url.startsWith('/api/files/')) {
      const name = path.basename(decodeURIComponent(req.url.split('/').pop()))
      const full = path.join(UPLOAD_DIR, name)
      if (!existsSync(full)) return json(res, 404, { error: 'no file' })
      const buf = await readFile(full)
      const ext = (path.extname(name).slice(1) || 'png').replace('jpg', 'jpeg')
      res.writeHead(200, { 'Content-Type': `image/${ext}`, 'Cache-Control': 'no-store' })
      return res.end(buf)
    }

    /* ── Telegram report ── */
    if (req.method === 'POST' && req.url === '/api/reports/daily/send') {
      const preview = await buildDailyReport()
      try {
        await telegramSend(preview)
        return json(res, 200, { sent: true, preview })
      } catch (e) {
        return json(res, 502, { error: e.message, preview })
      }
    }
    if (req.method === 'GET' && req.url === '/api/reports/daily/preview') {
      return json(res, 200, { preview: await buildDailyReport() })
    }
    if (req.method === 'POST' && /^\/api\/queue\/[\w-]+\/notify$/.test(req.url)) {
      const id = req.url.split('/')[3]
      const queue = await loadQueue()
      const item = queue.find(q => q.id === id)
      if (!item) return json(res, 404, { error: 'Queue item not found' })
      try {
        await sendApprovalMessage(item)
        return json(res, 200, { sent: true })
      } catch (e) {
        return json(res, 502, { error: e.message })
      }
    }
    if (req.method === 'POST' && /^\/api\/queue\/[\w-]+\/publish$/.test(req.url)) {
      const id = req.url.split('/')[3]
      const queue = await loadQueue()
      const item = queue.find(q => q.id === id)
      if (!item) return json(res, 404, { error: 'Queue item not found' })
      if (item.status !== 'approved') return json(res, 400, { error: `สถานะต้องเป็น approved (ตอนนี้: ${item.status})` })
      runPublisher(item).catch(e => console.error('Publisher failed:', e.message))
      return json(res, 202, { publishing: true, item })
    }

    /* ── TikTok Shop scaffold ── */
    if (req.method === 'GET' && req.url.startsWith('/api/tiktok/products')) {
      const q = new URL(req.url, 'http://127.0.0.1').searchParams.get('q') || ''
      try {
        return json(res, 200, await searchTikTokProducts(q))
      } catch (e) {
        return json(res, 502, { error: e.message })
      }
    }
    if (req.method === 'GET' && req.url.startsWith('/api/tiktok/orders')) {
      try {
        return json(res, 200, await tiktokShopRequest('/orders/search', {
          method: 'POST',
          body: { shop_region: TT_REGION, page_size: 10, order_status: 'ALL' },
        }))
      } catch (e) {
        return json(res, 502, { error: e.message })
      }
    }

    /* ── Feature flags (for UI status strip) ── */
    if (req.method === 'GET' && req.url === '/api/features') {
      return json(res, 200, {
        kling: !!KLING_ACCESS_KEY,
        telegram: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
        autoPublish: PUBLISHER_MODE,
        scriptLlm: !!OPENAI_API_KEY,
        imageLlm: !!OPENAI_API_KEY,
      })
    }

    return json(res, 404, { error: 'Not found' })
  } catch (error) {
    json(res, 500, { error: error.message })
  }
})

stat(WORK).catch(() => mkdir(WORK, { recursive: true }))
mkdir(UPLOAD_DIR, { recursive: true }).catch(() => {})
mkdir(MUSIC_DIR, { recursive: true }).catch(() => {})
server.listen(PORT, '127.0.0.1', () => {
  const on = s => (s ? '✅' : '⛔')
  console.log(`AI TikBat Agent Server → http://127.0.0.1:${PORT}`)
  console.log(`  Script LLM : ${on(OPENAI_API_KEY)}`)
  console.log(`  Kling AI   : ${on(KLING_ACCESS_KEY)}`)
  console.log(`  Telegram   : ${on(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)}`)
  console.log(`  AutoPublish: ${PUBLISHER_MODE ? '✅ (Risky Mode)' : '⛔ (กดมือ)'}`)
})
