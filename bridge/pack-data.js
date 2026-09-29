// pack-data.js — 汇总 data/raw/*.json → 加密 → data/latest.enc
// 用法: node pack-data.js   （在 push-platform/bridge 目录下运行）
// 密码来源: bridge/secret.txt（已 gitignore，仅本机）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const RAW = path.join(ROOT, 'data', 'raw');
const OUT_ENC = path.join(ROOT, 'data', 'latest.enc');
const SECRET = path.join(__dirname, 'secret.txt');

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function tryRead(p) { try { return readJSON(p); } catch (e) { return null; } }

// ---------- 解密工具（读取上一次快照历史） ----------
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
}
function decrypt(encText, password) {
  const [s64, i64, c64] = encText.trim().split('.');
  const salt = Buffer.from(s64, 'base64');
  const iv = Buffer.from(i64, 'base64');
  const cipher = Buffer.from(c64, 'base64');
  const key = deriveKey(password, salt);
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const plain = Buffer.concat([d.update(cipher), d.final()]);
  return JSON.parse(plain.toString('utf8'));
}
function encrypt(obj, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const key = deriveKey(password, salt);
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  const cipher = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return [salt, iv, cipher].map(b => b.toString('base64')).join('.');
}

// ---------- 归一化各模块 ----------
function normKnowledge() {
  const j = tryRead(path.join(RAW, 'knowledge.json'));
  if (!j) return [];
  const spaces = ((j.data || {}).spaces) || [];
  return spaces.map(s => ({
    name: s.name, workspaceId: s.workspaceId, url: s.url,
    description: s.description || '', createTime: s.createTime || null
  }));
}
function normTodos() {
  const j = tryRead(path.join(RAW, 'todos.json'));
  if (!j) return [];
  const tasks = ((j.data || {}).tasks) || [];
  return tasks.map(t => ({
    taskId: t.taskId, title: t.title,
    due: t.planFinishDate || null, priority: t.priority || 20,
    isDone: t.isDone === undefined ? false : !!t.isDone
  }));
}
function normMinutes() {
  const j = tryRead(path.join(RAW, 'minutes.json'));
  if (!j) return [];
  const arr = ((j.data || {}).minutes) || [];
  return arr.map(m => ({
    taskUuid: m.taskUuid, title: m.title,
    startTime: m.startTime || null, duration: m.duration || null, url: m.url || ''
  }));
}
function normMeetings() {
  const j = tryRead(path.join(RAW, 'meetings.json'));
  if (!j) return [];
  const evs = ((j.result || {}).events) || [];
  return evs.map(e => ({
    id: e.id, title: e.summary || '(无标题)',
    start: (e.start && e.start.dateTime) || null, end: (e.end && e.end.dateTime) || null,
    organizer: (e.organizer && e.organizer.displayName) || '',
    attendees: (e.attendees || []).filter(a => !a.self).map(a => a.displayName),
    location: e.location || ''
  }));
}
function normStars() {
  // 合并多页收藏（stars.json 为第一页，stars_p2/p3... 为续页）
  const items = [];
  const files = ['stars.json', 'stars_p2.json', 'stars_p3.json', 'stars_p4.json', 'stars_p5.json'];
  for (const f of files) {
    const j = tryRead(path.join(RAW, f));
    if (j && j.data && Array.isArray(j.data.items)) items.push(...j.data.items);
  }
  return items.map(i => ({
    name: i.name, nodeId: i.nodeId, type: i.type || '', createTime: i.createTime || null
  }));
}

// ---------- 主流程 ----------
const password = fs.readFileSync(SECRET, 'utf8').trim();
if (!password) { console.error('secret.txt 为空'); process.exit(1); }

const prev = tryRead(OUT_ENC) ? (() => { try { return decrypt(fs.readFileSync(OUT_ENC, 'utf8'), password); } catch (e) { return null; } })() : null;

const knowledge = normKnowledge();
const todos = normTodos();
const minutes = normMinutes();
const meetings = normMeetings();
const stars = normStars();

const today = new Date();
const dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');

const snapshot = {
  date: dateStr,
  counts: {
    knowledge: knowledge.length,
    todos: todos.length,
    todosOpen: todos.filter(t => !t.isDone).length,
    minutes: minutes.length,
    meetings: meetings.length,
    stars: stars.length
  }
};

// 保留历史快照（最多 180 天），同日覆盖
let days = (prev && Array.isArray(prev.days)) ? prev.days.filter(d => d.date !== dateStr) : [];
days.push(snapshot);
days = days.slice(-180);

const payload = {
  syncedAt: new Date().toISOString(),
  days,
  knowledge, todos, minutes, meetings, stars
};

fs.mkdirSync(path.dirname(OUT_ENC), { recursive: true });
fs.writeFileSync(OUT_ENC, encrypt(payload, password), 'utf8');

// 同时写一份明文快照统计（不含敏感明细），用于核对
console.log(JSON.stringify({ ok: true, date: dateStr, counts: snapshot.counts, historyDays: days.length }, null, 2));
