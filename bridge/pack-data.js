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
// 配置：数据起点
const KNOWLEDGE_MIN_TS = new Date('2024-01-01').getTime();   // 知识库：去掉2021-2023
const TODO_MIN_DUE = new Date('2026-09-30T00:00:00+08:00').getTime(); // 待办：2026-09-30起

function normKnowledge() {
  const j = tryRead(path.join(RAW, 'knowledge.json'));
  if (!j) return [];
  const spaces = ((j.data || {}).spaces) || [];
  return spaces
    .filter(s => !s.createTime || s.createTime >= KNOWLEDGE_MIN_TS) // 无时间保留，2021-2023剔除
    .map(s => ({
      name: s.name, workspaceId: s.workspaceId, url: s.url,
      description: s.description || '', createTime: s.createTime || null,
      creator: '' // 钉钉接口不提供知识库创建人
    }));
}
function normTodos() {
  const j = tryRead(path.join(RAW, 'todos.json'));
  if (!j) return [];
  const tasks = ((j.data || {}).tasks) || [];
  return tasks
    .filter(t => !t.planFinishDate || t.planFinishDate >= TODO_MIN_DUE) // 数据从2026-09-30起
    .map(t => ({
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
  // meetings.json = 历史全量（2026-05-01 起，固定基础）
  // meetings_recent.json = 每日增量（近2周+未来1周），与历史合并按 title+start 去重
  const collect = (file) => {
    const j = tryRead(path.join(RAW, file));
    if (!j) return [];
    return ((j.result || {}).events) || [];
  };
  const evs = collect('meetings.json').concat(collect('meetings_recent.json'));
  const dt = (v) => (v && typeof v === 'object') ? (v.dateTime || null) : (v || null);
  const seen = new Set();
  const out = [];
  for (const e of evs) {
    const start = dt(e.start);
    const key = (e.summary || e.title || '') + '|' + (start || '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: e.id || '', title: e.summary || e.title || '(无标题)',
      start, end: dt(e.end),
      organizer: (e.organizer && (typeof e.organizer === 'object' ? e.organizer.displayName : e.organizer)) || '',
      attendees: (e.attendees || []).filter(a => a && a !== true).map(a => typeof a === 'object' ? a.displayName : a),
      location: e.location || ''
    });
  }
  return out;
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
    name: i.name, nodeId: i.nodeId, type: i.type || '', createTime: i.createTime || null,
    creator: '', // 钉钉接口不提供收藏文档创建人
    url: 'https://alidocs.dingtalk.com/i/nodes/' + i.nodeId
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
