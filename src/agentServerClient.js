const json = async res => {
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
  return res.json()
}

export const researchScript = product =>
  fetch('/api/agents/research/script', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product }),
  }).then(json)

export const runContentAgent = payload =>
  fetch('/api/agents/content/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(json)

export const runKlingAgent = payload =>
  fetch('/api/agents/video/kling/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(json)

export const generateMasterFrame = payload =>
  fetch('/api/agents/image/master-frame', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(json)

export const getAgentStatus = () => fetch('/api/agents/status').then(json)

export const getQueue = () => fetch('/api/queue').then(json)

export const decideQueueItem = (id, action) =>
  fetch(`/api/queue/${action}/${id}`, { method: 'POST' }).then(json)

export const getKlingUsage = () => fetch('/api/agents/video/kling/usage').then(json)

export const sendDailyReport = () =>
  fetch('/api/reports/daily/send', { method: 'POST' }).then(json)

export const notifyQueueItem = id =>
  fetch(`/api/queue/${id}/notify`, { method: 'POST' }).then(json)

export const publishQueueItem = id =>
  fetch(`/api/queue/${id}/publish`, { method: 'POST' }).then(json)

export const getFeatures = () => fetch('/api/features').then(json)

export const uploadImage = dataUrl =>
  fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl }) }).then(json)

export const updateQueueItem = (id, patch) =>
  fetch(`/api/queue/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then(json)

export const getAgentOutputUrl = jobId => `/api/agents/content/output/${encodeURIComponent(jobId)}`
