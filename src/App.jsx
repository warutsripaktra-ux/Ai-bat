import { useEffect, useState } from 'react'
import { Search, Play, Plus, CheckCircle2, Clock3, ArrowRight, Sparkles, ShoppingBasket, Film, Wand2 } from 'lucide-react'
import { getAgentStatus, runContentAgent, runKlingAgent, researchScript, getQueue, decideQueueItem, getKlingUsage, sendDailyReport, notifyQueueItem, publishQueueItem, updateQueueItem, getFeatures, getAgentOutputUrl, uploadImage, generateMasterFrame } from './agentServerClient'
import './App.css'

export default function App() {
  const [jobs, setJobs] = useState([])
  const [queue, setQueue] = useState([])
  const [script, setScript] = useState(null)
  const [scriptSource, setScriptSource] = useState(null)
  const [product, setProduct] = useState(null)
  const [productImg, setProductImg] = useState(null) // { path, url }
  const [bgImg, setBgImg] = useState(null) // { path, url }
  const [masterFrame, setMasterFrame] = useState(null)
  const [imageDirection, setImageDirection] = useState('วางสินค้าอย่างเป็นธรรมชาติบนโต๊ะ แสงและเงาตรงกับฉาก เน้นสินค้าเป็นจุดเด่น')
  const [imageGenerating, setImageGenerating] = useState(false)
  const [musicFile, setMusicFile] = useState(null) // { path, url }
  const [musicTracks, setMusicTracks] = useState([])
  const [imgUp, setImgUp] = useState(false)
  const [researchLoading, setResearchLoading] = useState(false)
  const [campaign, setCampaign] = useState(null)
  const [showProduct, setShowProduct] = useState(false)
  const [klingUsage, setKlingUsage] = useState(null)
  const [features, setFeatures] = useState(null)

  async function refreshQueue() {
    try { setQueue((await getQueue()).items || []) } catch {}
  }

  useEffect(() => {
    refreshQueue()
    getKlingUsage().then(setKlingUsage).catch(() => {})
    getFeatures().then(setFeatures).catch(() => {})
    fetch('/api/music').then(r => r.json()).then(d => setMusicTracks(d.tracks || [])).catch(() => {})
    const t = setInterval(() => getAgentStatus().then(x => setJobs(x.jobs || [])).catch(() => {}), 800)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!campaign?.jobId) return
    const job = jobs.find(j => j.id === campaign.jobId)
    if (!job) return
    if (job.status === 'working') setCampaign(c => ({ ...c, status: 'running' }))
    if (job.status === 'completed') { setCampaign(c => ({ ...c, status: 'completed', output: job.output })); refreshQueue() }
    if (job.status === 'failed') setCampaign(c => ({ ...c, status: 'failed', error: job.step }))
  }, [jobs]) // eslint-disable-line react-hooks/exhaustive-deps

  async function onResearch(e) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const selling = String(f.get('selling') || '').split(',').map(s => s.trim()).filter(Boolean)
    const product = {
      name: f.get('name'),
      sku: f.get('sku') || '',
      price: Number(f.get('price')) || 0,
      sellingPoints: selling,
      tiktokProductId: String(f.get('ttid') || '').trim(),
      imagePath: productImg?.path || '',
      bgPath: bgImg?.path || '',
      masterFramePath: masterFrame?.path || '',
      musicPath: musicFile?.path || '',
    }
    setResearchLoading(true)
    try {
      const result = await researchScript(product)
      setProduct(product)
      setScript(result.script)
      setScriptSource(result.source)
    } catch (err) {
      alert(err.message)
    } finally {
      setResearchLoading(false)
    }
  }

  async function onUpload(file, setter) {
    if (!file) return
    setImgUp(true)
    try {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader()
        r.onload = () => res(r.result)
        r.onerror = rej
        r.readAsDataURL(file)
      })
      const r = await uploadImage(dataUrl)
      if (r.error) throw new Error(r.error)
      setter({ path: r.path, url: r.url })
    } catch (e) {
      alert(`อัปโหลดรูปไม่สำเร็จ: ${e.message}`)
    } finally {
      setImgUp(false)
    }
  }

  async function onGenerateImage() {
    if (!productImg || !bgImg) return alert('กรุณาอัปโหลดรูปสินค้าและรูปฉากก่อน')
    const productName = document.getElementById('p-name')?.value?.trim()
    if (!productName) return alert('กรุณาใส่ชื่อสินค้าก่อน')
    setImageGenerating(true)
    try {
      const result = await generateMasterFrame({
        productImagePath: productImg.path,
        backgroundImagePath: bgImg.path,
        productName,
        direction: imageDirection,
      })
      setMasterFrame(result)
      setProduct(current => current ? { ...current, masterFramePath: result.path } : current)
    } catch (e) {
      alert(`Generate รูปไม่สำเร็จ: ${e.message}`)
    } finally {
      setImageGenerating(false)
    }
  }

  async function onStart(engine) {
    if (!script || !product) return alert('กด Research เพื่อสร้างสคริปต์ก่อน')
    setCampaign({ status: 'running', engine })
    try {
      const r = engine === 'kling'
        ? await runKlingAgent({ product, script })
        : await runContentAgent({ product, script })
      setCampaign(c => ({ ...c, jobId: r.jobId }))
      if (engine === 'kling') getKlingUsage().then(setKlingUsage).catch(() => {})
    } catch (e) {
      setCampaign({ status: 'failed', error: e.message })
      alert(`ไม่สามารถสร้างคลิปได้: ${e.message}`)
    }
  }

  const klingExhausted = klingUsage && klingUsage.used >= klingUsage.limit

  async function onDecide(id, action) {
    try {
      await decideQueueItem(id, action)
      refreshQueue()
    } catch (e) {
      alert(e.message)
    }
  }

  async function onPatch(id, patch) {
    try {
      await updateQueueItem(id, patch)
      refreshQueue()
    } catch (e) {
      alert(e.message)
      refreshQueue()
    }
  }

  async function onSendReport() {
    const r = await sendDailyReport()
    alert(r.sent ? 'ส่งรายงานเข้า Telegram แล้ว ✅' : `ส่งไม่สำเร็จ: ${r.error}`)
  }

  async function onNotify(id) {
    try {
      const r = await notifyQueueItem(id)
      if (!r.sent) throw new Error(r.error)
      alert('ส่งแจ้งเตือนเข้า Telegram แล้ว (มีปุ่มกดอนุมัติ) ✅')
    } catch (e) {
      alert(`ไม่สำเร็จ: ${e.message}`)
    }
  }

  async function onPublish(id) {
    try {
      const r = await publishQueueItem(id)
      if (r.publishing) alert('🚀 Publisher Agent กำลังโพสต์ให้... (ดูสถานะในตาราง)')
      else throw new Error(r.error || 'ไม่สำเร็จ')
    } catch (e) {
      alert(`ไม่สำเร็จ: ${e.message}`)
    }
  }

  const activeJob = campaign?.jobId ? jobs.find(j => j.id === campaign.jobId) : null
  const pendingCount = queue.filter(q => q.status === 'pending').length
  const approvedCount = queue.filter(q => q.status === 'approved').length

  return (
    <div className="app">
      <header className="header">
        <div className="logo">🛒</div>
        <div className="brand">
          <b>AI TikBat</b>
          <small>TikTok Basket Agent Studio</small>
        </div>
        <div className="status-pill">
          <span className="dot" />
          {campaign?.status === 'running' ? 'Agents working…' : campaign?.status === 'completed' ? 'Campaign completed' : 'System ready'}
        </div>
        <div className="avatar">WM</div>
      </header>

      <main>
        {/* Integration status strip — รู้สถานะระบบทันที */}
        {features && (
          <div className="feature-strip">
            <Feature label="Script LLM" on={features.scriptLlm} />
            <Feature label="OpenAI Image" on={features.imageLlm} />
            <Feature label="Kling AI" on={features.kling} />
            <Feature label="Telegram" on={features.telegram} />
            <Feature label="Auto-publish" on={features.autoPublish} warn={features.autoPublish} />
          </div>
        )}

        {/* KPI */}
        <section className="kpis">
          <div className="kpi"><small>คลิปในคิว</small><b>{queue.length}</b></div>
          <div className="kpi"><small>รออนุมัติ</small><b className="amber">{pendingCount}</b></div>
          <div className="kpi"><small>อนุมัติแล้ว</small><b className="green">{approvedCount}</b></div>
          <div className="kpi"><small>งานที่ทำทั้งหมด</small><b>{jobs.length}</b></div>
        </section>

        <div className="grid-2">
          {/* Script panel */}
          <section className="card">
            <div className="sec-head">
              <div>
                <span className="sec-label">RESEARCH AGENT</span>
                <h2><Sparkles size={16} /> สร้างสคริปต์ขาย</h2>
              </div>
              {script && (
                <span className={`tag ${scriptSource === 'llm' ? 'approved' : 'pending'}`}>
                  {scriptSource === 'llm' ? 'LLM' : 'Template fallback'}
                </span>
              )}
            </div>
            <form onSubmit={onResearch} className="stack">
              <label>ชื่อสินค้า<input id="p-name" name="name" required placeholder="เคส iPhone Anti-Shock" /></label>
              <div className="two">
                <label>SKU<input name="sku" placeholder="CASE-001" /></label>
                <label>ราคา (บาท)<input name="price" type="number" min="0" placeholder="199" /></label>
              </div>
              <label>TikTok Product ID<input name="ttid" placeholder="TT-xxxxxx (ดึงรูปสินค้าจาก TikTok Shop)" /></label>
              <div className="two">
                <label className="file-label">
                  รูปสินค้า (ใช้ PNG โปร่งใส จะเนียนกว่า เหมือนวางอยู่ในฉาก)
                  <input type="file" accept="image/*" disabled={imgUp}
                    onChange={e => onUpload(e.target.files[0], setProductImg)} />
                  {productImg && <img className="up-thumb" src={productImg.url} alt="" />}
                </label>
                <label className="file-label">
                  รูปพื้นหลังจริง (ฉากที่สินค้าจะยืนอยู่)
                  <input type="file" accept="image/*" disabled={imgUp}
                    onChange={e => onUpload(e.target.files[0], setBgImg)} />
                  {bgImg && <img className="up-thumb" src={bgImg.url} alt="" />}
                </label>
              </div>
              <div className="image-composer">
                <div className="image-composer-head">
                  <div>
                    <b>OpenAI Image Composer</b>
                    <small>รวมรูปสินค้าและรูปฉากเป็น Master Frame เดียว</small>
                  </div>
                  {masterFrame && <span className="tag approved">พร้อม Render</span>}
                </div>
                <label>
                  คำสั่งเพิ่มเติม
                  <textarea
                    rows={2}
                    value={imageDirection}
                    onChange={e => setImageDirection(e.target.value)}
                    placeholder="เช่น วางสินค้าไว้ด้านซ้าย แสงธรรมชาติ เน้นภาพพรีเมียม"
                  />
                </label>
                <button
                  type="button"
                  className="btn image-ai full"
                  disabled={imageGenerating || !productImg || !bgImg}
                  onClick={onGenerateImage}
                >
                  <Wand2 size={14} />
                  {imageGenerating ? 'OpenAI กำลัง Generate รูป…' : masterFrame ? 'Generate รูปใหม่' : 'Generate Master Frame'}
                </button>
                {masterFrame && (
                  <div className="master-preview">
                    <img src={masterFrame.url} alt="OpenAI generated master frame" />
                    <div>
                      <b>Master Frame</b>
                      <small>ระบบจะใช้รูปนี้เป็นฉากหลักตอน Render Template</small>
                    </div>
                  </div>
                )}
              </div>
              <label className="file-label">
                เพลงประกอบ (แทนเสียงพากย์)
                <select className="cell-input" value={musicFile?.url || ''} onChange={e => setMusicFile(e.target.value ? { path: e.target.value, url: e.target.value } : null)}>
                  <option value="">— เลือกเพลงในโฟลเดอร์ music/ —</option>
                  {musicTracks.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <input type="file" accept="audio/*" disabled={imgUp}
                  onChange={e => onUpload(e.target.files[0], setMusicFile)} />
                {musicFile && <span className="up-name">🎵 {musicFile.url.split('/').pop()}</span>}
              </label>
              <label>จุดขาย (คั่นด้วย ,)<textarea name="selling" rows={2} placeholder="กันกระแทก 95%, ดีไซน์บางเบา, ราคาถูก" /></label>
              <button className="btn secondary" disabled={researchLoading}>
                <Search size={14} /> {researchLoading ? 'กำลัง Research…' : 'Research Script'}
              </button>
            </form>

            {script && (
              <>
                <div className="script-preview">
                  <div className="script-head"><b>Selling Script · {script.slides.length} ช่วง</b></div>
                  {script.slides.map((s, i) => (
                    <div className="script-row" key={i}>
                      <span className="script-idx">{i + 1}</span>
                      <div><b>{s.thai}</b>{s.en && <small>{s.en}</small>}</div>
                    </div>
                  ))}
                </div>
                <div className="btn-row">
                  <button className="btn primary full" onClick={() => onStart('ffmpeg')}>
                    <Play size={14} /> Render ทันที (Template)
                  </button>
                  <button
                    className="btn kling full"
                    onClick={() => onStart('kling')}
                    disabled={klingExhausted}
                    title={klingExhausted ? 'โควต้าฟรีวันนี้หมดแล้ว' : ''}
                  >
                    <Wand2 size={14} />
                    {klingExhausted
                      ? 'โควต้าฟรีหมด (รอพรุ่งนี้)'
                      : `Generate with Kling AI${klingUsage ? ` (${klingUsage.limit - klingUsage.used} คลิปวันนี้)` : ''}`}
                  </button>
                </div>
              </>
            )}
          </section>

          {/* Pipeline + output */}
          <section className="card">
            <div className="sec-head">
              <div>
                <span className="sec-label">PIPELINE</span>
                <h2><Film size={16} /> สถานะการผลิต</h2>
              </div>
              {campaign?.engine && (
                <span className={`tag ${campaign.engine === 'kling' ? 'approved' : 'scheduled'}`}>
                  {campaign.engine === 'kling' ? 'Kling AI' : 'Template render'}
                </span>
              )}
            </div>
            <div className="steps">
              <Step title="Research" done={!!script} active={researchLoading} />
              <ArrowRight size={16} />
              <Step title="Render" active={campaign?.status === 'running'} done={campaign?.status === 'completed'} />
              <ArrowRight size={16} />
              <Step title="เข้าคิว" active={false} done={campaign?.status === 'completed'} />
            </div>

            {activeJob && (
              <div className="log"><Clock3 size={13} /><span>{activeJob.step}</span><b>{activeJob.status}</b></div>
            )}

            {campaign?.status === 'failed' && (
              <div className="error-banner">⚠️ {campaign.error}</div>
            )}

            {campaign?.output && (
              <video className="output-video" controls playsInline src={getAgentOutputUrl(campaign.jobId)} />
            )}

            {!campaign && !activeJob && (
              <div className="empty-hint">ใส่ข้อมูลสินค้า → Research → Generate<br />คลิปจะเข้าคิวปักตะกร้าให้อัตโนมัติ</div>
            )}
          </section>
        </div>

        {/* Basket queue */}
        <section className="card">
          <div className="sec-head">
            <div>
              <span className="sec-label">APPROVAL QUEUE</span>
              <h2><ShoppingBasket size={16} /> คิวปักตะกร้า</h2>
            </div>
            <div className="row-actions">
              <button className="btn secondary sm" onClick={() => setShowProduct(true)}><Plus size={13} /> เพิ่มในคิว</button>
              <button className="btn secondary sm" onClick={onSendReport}>📤 รายงาน Telegram</button>
            </div>
          </div>
          {queue.length === 0 ? (
            <div className="empty-hint">ยังไม่มีคลิปในคิว — generate คลิปแรกได้เลย</div>
          ) : (
            <table>
              <thead>
                <tr><th>สินค้า</th><th>Clip Job</th><th>TikTok Product ID</th><th>เวลาโพสต์</th><th>สถานะ</th><th></th></tr>
              </thead>
              <tbody>
                {queue.map(item => (
                  <tr key={item.id}>
                    <td>
                      <div className="prod-cell">
                        {item.imagePath && (
                          <img className="prod-thumb" src={`/api/queue/${item.id}/image`} alt="" />
                        )}
                        <div>
                          <b>{item.productName}</b>
                          <small>{item.sku && `SKU ${item.sku} · `}{item.price > 0 && `฿${item.price}`}</small>
                        </div>
                      </div>
                    </td>
                    <td className="mono">{item.clipJobId}</td>
                    <td>
                      <input
                        className="cell-input mono"
                        defaultValue={item.tiktokProductId}
                        placeholder="TT-xxxxxx"
                        onBlur={e => { if (e.target.value !== item.tiktokProductId) onPatch(item.id, { tiktokProductId: e.target.value.trim() }) }}
                      />
                    </td>
                    <td>
                      <select
                        className="cell-input"
                        value={item.scheduleSlot}
                        onChange={e => onPatch(item.id, { scheduleSlot: e.target.value })}
                      >
                        <option value="">—</option>
                        {['09:00', '12:00', '17:00', '20:00', '21:00'].map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </td>
                    <td>
                      <span className={`tag ${item.status}`}>
                        {{ pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว', postponed: 'เลื่อน', rejected: 'ปฏิเสธ', publishing: 'กำลังโพสต์…', published: 'โพสต์แล้ว ✅' }[item.status]}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        {item.status === 'pending' && (
                          <>
                            <button className="btn primary sm" onClick={() => onDecide(item.id, 'approve')}>✓ อนุมัติ</button>
                            <button className="btn secondary sm" onClick={() => onDecide(item.id, 'postpone')}>เลื่อน</button>
                          </>
                        )}
                        {item.status === 'approved' && item.clipJobId && (
                          <a className="btn primary sm" href={`/api/agents/output/${item.clipJobId}`} download>⬇ ดาวน์โหลดคลิป</a>
                        )}
                        {item.status === 'approved' && (
                          <button className="btn kling sm" onClick={() => onPublish(item.id)} title="เสี่ยงแบน — ผิด ToS">🤖 โพสต์อัตโนนมัติ</button>
                        )}
                        <button className="btn secondary sm" onClick={() => onNotify(item.id)}>📲 แจ้ง</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>

      {showProduct && (
        <div className="modal-backdrop" onClick={() => setShowProduct(false)}>
          <form className="modal" onSubmit={async e => {
            e.preventDefault()
            const f = new FormData(e.currentTarget)
            try {
              const r = await fetch('/api/queue/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  productName: f.get('name'),
                  sku: f.get('sku'),
                  price: Number(f.get('price')) || 0,
                  tiktokProductId: f.get('ttid'),
                }),
              })
              if (!r.ok) throw new Error('add failed')
              setShowProduct(false)
              refreshQueue()
            } catch (err) { alert(err.message) }
          }} onClick={e => e.stopPropagation()}>
            <h2>เพิ่มสินค้าเข้าคิว</h2>
            <label>ชื่อสินค้า<input name="name" required /></label>
            <label>SKU<input name="sku" /></label>
            <label>ราคา<input name="price" type="number" min="0" /></label>
            <label>TikTok Product ID<input name="ttid" placeholder="TT-xxxxxx" /></label>
            <button className="btn primary full">เพิ่ม</button>
          </form>
        </div>
      )}
    </div>
  )
}

function Feature({ label, on, warn }) {
  return (
    <span className={`feat ${on ? (warn ? 'feat-warn' : 'feat-on') : 'feat-off'}`}>
      <span className="feat-dot" /> {label} {on ? (warn ? 'เปิด(เสี่ยง)' : 'เปิด') : 'ปิด'}
    </span>
  )
}

function Step({ title, active, done }) {
  return (
    <div className={`step ${active ? 'active' : ''} ${done ? 'done' : ''}`}>
      <div>{done ? <CheckCircle2 size={22} /> : <span className="step-dot" />}</div>
      <b>{title}</b>
      <small>{done ? 'เสร็จ' : active ? 'กำลังทำ' : 'รอ'}</small>
    </div>
  )
}
