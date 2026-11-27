// ==UserScript==
// @name         超星学习通 · 本地模型自动刷课
// @namespace    cx-local-ai
// @version      1.6.8
// @description  超星/学习通：自动播放、防暂停、自动下一节；自动解超星字体混淆、章节测验/作业/视频弹窗题交给 AI 作答（本地 Ollama 或 DeepSeek/Kimi/硅基流动/OpenAI），并统计 token 用量
// @author       洄
// @license      MIT
// @match        *://*.chaoxing.com/*
// @match        *://*.xueyinonline.com/*
// @match        *://*.edu.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @connect      api.deepseek.com
// @connect      api.moonshot.cn
// @connect      api.siliconflow.cn
// @connect      api.openai.com
// @run-at       document-idle
// ==/UserScript==

/*
 * 用法
 * 1. Ollama 先跑起来：ollama serve（模型 qwen2.5-3b-local 需已 pull）
 * 2. 打开超星课程学习页（.../mycourse/studentstudy?...），右下角会出现面板
 * 3. 点「自检模型」确认能连通并答对一题，再点「开始」
 * 4. 脚本在每个 iframe 里各跑一份，用 postMessage 回报给顶层；顶层负责跳下一节
 *
 * 注意
 * - 只做「自动播放 + 自动答客观题」，不破解、不改后台数据、不伪造学习时长
 * - 倍速建议 1~2，超星对高倍速有风控（进度可能被清空）
 * - 检测到人脸识别会停下等人，不替你过
 * - 作业：默认只填不交，交不交由你；考试页（URL 带 exam）只作答、绝不自动交卷
 * - 学习页已经在跑时，另开的作业/答题页会自动接手
 * - 卡住时先点「诊断」，日志里会打出这一页真实的目录节点 / 提交按钮 / 页面接口
 */

(function () {
  'use strict';

  const MSG = '__cx_local_ai__';
  const CFG_KEY = 'cx-local-ai-cfg';
  const RUN_KEY = 'cx-local-ai-running';
  const IS_TOP = (function () {
    try { return window.top === window.self; } catch (e) { return false; }
  })();

  /* ======================================================================
   * 配置
   * ==================================================================== */
  const DEFAULTS = {
    provider: 'ollama',
    endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
    model: 'qwen2.5-3b-local',
    apiKey: '',
    keys: {},            // 每个接口的 key 分开存，切换不丢
    timeout: 120000,
    rate: 2,
    mute: true,
    autoNext: true,
    answerVideoQuiz: true,
    answerChapterTest: true,
    answerWork: true,
    autoSubmit: false,
    unknownStrategy: 'random', // random | skip
    retries: 1,
    gapMs: 500
  };

  // 内置接口预设：都是 OpenAI 兼容格式，只换地址/模型/Key
  const PROVIDERS = [
    {
      id: 'ollama', name: '本地 Ollama',
      endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
      model: 'qwen2.5-3b-local', local: true
    },
    {
      id: 'deepseek', name: 'DeepSeek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      model: 'deepseek-chat'
    },
    {
      id: 'kimi', name: 'Kimi 月之暗面',
      endpoint: 'https://api.moonshot.cn/v1/chat/completions',
      model: 'moonshot-v1-8k'
    },
    {
      id: 'siliconflow', name: '硅基流动',
      endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
      model: 'Qwen/Qwen2.5-7B-Instruct'
    },
    {
      id: 'openai', name: 'OpenAI',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini'
    },
    {
      id: 'custom', name: '自定义（OpenAI 兼容）',
      endpoint: '', model: ''
    }
  ];

  function getProvider(id) {
    return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
  }

  function readCfg() {
    try {
      const raw = (typeof GM_getValue === 'function')
        ? GM_getValue(CFG_KEY, '')
        : window.localStorage.getItem(CFG_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  const CFG = Object.assign({}, DEFAULTS, readCfg());

  function saveCfg() {
    try {
      const raw = JSON.stringify(CFG);
      if (typeof GM_setValue === 'function') GM_setValue(CFG_KEY, raw);
      else window.localStorage.setItem(CFG_KEY, raw);
    } catch (e) { /* 忽略 */ }
  }

  function setRunning(v) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(RUN_KEY, v ? 1 : 0);
      else window.localStorage.setItem(RUN_KEY, v ? '1' : '0');
    } catch (e) { /* 忽略 */ }
  }

  function isRunning() {
    try {
      const v = (typeof GM_getValue === 'function')
        ? GM_getValue(RUN_KEY, 0)
        : window.localStorage.getItem(RUN_KEY);
      return v === 1 || v === '1';
    } catch (e) { return false; }
  }

  // 运行状态是跨标签页共享的：谁先开的谁负责收尾，别把别的标签页关掉
  function claimRunning() {
    if (!isRunning()) STATE.ownedGlobal = true;
    setRunning(true);
  }

  function releaseRunning() {
    if (STATE.ownedGlobal) {
      setRunning(false);
      STATE.ownedGlobal = false;
    }
  }

  /* ======================================================================
   * 小模型 token 用量统计
   * Ollama 的 /v1/chat/completions 会返回 usage.prompt_tokens / completion_tokens
   * ==================================================================== */
  const TOK_KEY = 'cx-local-ai-tokens';

  const TOK = (function () {
    const empty = { prompt: 0, completion: 0, calls: 0, ms: 0, estimated: 0 };
    try {
      const raw = (typeof GM_getValue === 'function')
        ? GM_getValue(TOK_KEY, '')
        : window.localStorage.getItem(TOK_KEY);
      if (!raw) return empty;
      const o = JSON.parse(raw) || {};
      return {
        prompt: o.prompt || 0,
        completion: o.completion || 0,
        calls: o.calls || 0,
        ms: o.ms || 0,
        estimated: o.estimated || 0
      };
    } catch (e) { return empty; }
  })();

  function saveTokens() {
    try {
      const raw = JSON.stringify(TOK);
      if (typeof GM_setValue === 'function') GM_setValue(TOK_KEY, raw);
      else window.localStorage.setItem(TOK_KEY, raw);
    } catch (e) { /* 忽略 */ }
  }

  // usage 缺失时按字符数粗估（中文约 1.6 字/token，英文约 4 字/token）
  function estTokens(str) {
    const s = String(str || '');
    const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
    return Math.max(1, Math.round(cjk / 1.6 + (s.length - cjk) / 4));
  }

  function addTokens(usage, ms, fallbackText) {
    if (usage && (typeof usage.prompt_tokens === 'number' || typeof usage.completion_tokens === 'number')) {
      TOK.prompt += usage.prompt_tokens || 0;
      TOK.completion += usage.completion_tokens || 0;
    } else {
      TOK.estimated += 1;
      TOK.completion += estTokens(fallbackText);
    }
    TOK.calls += 1;
    TOK.ms += ms || 0;
    saveTokens();
    if (UI) UI.renderUsage();
  }

  function tokTotal() {
    return TOK.prompt + TOK.completion;
  }

  function fmtNum(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function usageLine() {
    const total = tokTotal();
    if (!TOK.calls) return '模型用量：还没请求过';
    const avg = Math.round(total / TOK.calls);
    const speed = TOK.ms > 0 ? (TOK.completion / (TOK.ms / 1000)) : 0;
    const est = TOK.estimated ? '（含 ' + TOK.estimated + ' 次估算）' : '';
    return '模型用量：' + fmtNum(total) + ' tok · ' + TOK.calls + ' 次 · 均 ' + avg +
      ' tok/次 · ' + speed.toFixed(1) + ' tok/s' + est;
  }

  function resetTokens() {
    TOK.prompt = 0;
    TOK.completion = 0;
    TOK.calls = 0;
    TOK.ms = 0;
    TOK.estimated = 0;
    saveTokens();
    if (UI) UI.renderUsage();
  }

  /* ======================================================================
   * 小工具
   * ==================================================================== */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function waitFor(fn, timeout, step) {
    timeout = timeout || 20000;
    step = step || 400;
    return new Promise((resolve) => {
      const t0 = Date.now();
      (function tick() {
        let val = null;
        try { val = fn(); } catch (e) { val = null; }
        if (val) return resolve(val);
        if (Date.now() - t0 >= timeout) return resolve(null);
        setTimeout(tick, step);
      })();
    });
  }

  function visible(el) {
    if (!el || !el.getClientRects || el.getClientRects().length === 0) return false;
    const st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  }

  function txt(el) {
    if (!el) return '';
    return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function squash(s) {
    return String(s || '').replace(/[\s\u3000]+/g, '');
  }

  function normForMatch(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '')
      .replace(/["'“”‘’`]/g, '')
      .replace(/[，。、；：！？,.;:!?（）()【】\[\]《》<>…—\-_~·]/g, '');
  }

  function bigram(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const grams = (s) => {
      const set = new Set();
      for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
      if (s.length === 1) set.add(s);
      return set;
    };
    const ga = grams(a);
    const gb = grams(b);
    let hit = 0;
    ga.forEach((g) => { if (gb.has(g)) hit++; });
    const union = ga.size + gb.size - hit;
    return union === 0 ? 0 : hit / union;
  }

  function randInt(n) {
    return n > 0 ? Math.floor(Math.random() * n) : 0;
  }

  function post(type, data) {
    try {
      window.top.postMessage({ [MSG]: true, type: type, data: data }, '*');
    } catch (e) { /* 忽略 */ }
  }

  // 页面自己的函数（swiperNext / btnBlueSubmit / finishJob）都挂在页面 window 上
  function pageWin() {
    try {
      return (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    } catch (e) { return window; }
  }

  function callPage(name, args) {
    const w = pageWin();
    if (typeof w[name] !== 'function') return false;
    try {
      w[name].apply(w, args || []);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ======================================================================
   * 日志
   * ==================================================================== */
  let UI = null;
  const LOGS = [];

  function log(msg, level) {
    level = level || 'info';
    const item = {
      t: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      m: String(msg),
      lv: level
    };
    LOGS.push(item);
    if (LOGS.length > 200) LOGS.shift();

    const prefix = { warn: '⚠', err: '✖', ai: '🤖', ok: '✔' }[level] || '';
    if (level === 'err') console.error('[CX-LAI]', msg);
    else console.log('[CX-LAI]', msg);

    if (!IS_TOP) post('log', item);
    else if (UI) UI.renderLog();
  }

  /* ======================================================================
   * 题型
   * ==================================================================== */
  const LETTERS = 'ABCDEFGH';

  function typeLabel(t) {
    return {
      single: '单选', multiple: '多选', judgement: '判断',
      completion: '填空', line: '连线', unknown: '未知'
    }[t] || '未知';
  }

  function mapTypeValue(v) {
    const n = parseInt(v, 10);
    if (n === 0) return 'single';
    if (n === 1) return 'multiple';
    if (n === 3) return 'judgement';
    if (n === 11) return 'line';
    if ([2, 4, 5, 6, 7, 8, 9, 10].indexOf(n) >= 0) return 'completion';
    return 'unknown';
  }

  function guessType(options) {
    if (options.length === 2) {
      const t = options.map((o) => o.text).join('|');
      if (/^(对|正确|是|√)\|(错|错误|否|×)$/.test(t) || /^(错|错误|否|×)\|(对|正确|是|√)$/.test(t)) {
        return 'judgement';
      }
    }
    return options.length > 1 ? 'single' : 'unknown';
  }

  function cleanTitle(s) {
    return String(s || '')
      .replace(/^\s*\d+\s*[。、.．)）]/, '')
      .replace(/[（(]\s*\d+(\.\d+)?\s*分\s*[)）]/g, '')
      .replace(/[（(\[【]\s*(单选题|多选题|判断题|填空题|简答题|论述题|名词解释|完形填空|阅读理解)[^)）\]】]{0,10}[)）\]】]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ======================================================================
   * 模型调用
   * ==================================================================== */
  const SYS_PROMPT = [
    '你是答题机器人。只输出一行 JSON，不要解释，不要用代码块。',
    '格式：{"answers":["A"]}',
    '用选项字母回答。多选题给出全部正确字母，例如 {"answers":["A","C"]}。',
    '判断题：选项 A 表示「对/正确」，选项 B 表示「错/错误」，只回一个字母。',
    '填空题：answers 里放要填进去的文字。',
    '拿不准也选一个最可能的，不要输出空数组。'
  ].join('\n');

  const RETRY_PROMPT = '只输出一行 JSON，例如 {"answers":["A"]}。不要任何其它文字。';

  function httpPost(url, headers, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const handle = {
        method: 'POST',
        url: url,
        headers: headers,
        data: body,
        timeout: timeoutMs,
        onload: (r) => resolve(r),
        onerror: () => reject(new Error('连不上模型服务（Ollama 没启动？地址写错？）')),
        ontimeout: () => reject(new Error('模型响应超时（' + Math.round(timeoutMs / 1000) + ' 秒）'))
      };

      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest(handle);
        return;
      }

      // 没有 GM_xmlhttpRequest 时退回 fetch（会被 CORS 拦，需要给 Ollama 设 OLLAMA_ORIGINS）
      fetch(url, { method: 'POST', headers: headers, body: body })
        .then((r) => r.text().then((t) => resolve({ status: r.status, responseText: t })))
        .catch(() => reject(new Error('跨域被拦：给 Ollama 设 OLLAMA_ORIGINS=* 后重启')));
    });
  }

  async function callModel(messages, opts) {
    opts = opts || {};
    const payload = {
      model: CFG.model,
      messages: messages,
      stream: false,
      temperature: 0,
      max_tokens: opts.maxTokens || 200
    };

    const headers = { 'Content-Type': 'application/json' };
    if (CFG.apiKey) headers['Authorization'] = 'Bearer ' + CFG.apiKey;

    const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(CFG.endpoint || '');
    if (!isLocal && !CFG.apiKey) {
      throw new Error('这个接口要 API Key，先在「模型设置」里填上');
    }
    if (!CFG.endpoint) {
      throw new Error('接口地址是空的，先选一个服务或自己填');
    }

    const t0 = Date.now();
    const r = await httpPost(CFG.endpoint, headers, JSON.stringify(payload), CFG.timeout);
    const ms = Date.now() - t0;

    if (r.status && r.status >= 400) {
      throw new Error('模型接口返回 ' + r.status + '：' + String(r.responseText || '').slice(0, 160));
    }

    let data;
    try {
      data = JSON.parse(r.responseText);
    } catch (e) {
      throw new Error('模型返回的不是 JSON，检查接口地址是否为 /v1/chat/completions');
    }

    const choice = data && data.choices && data.choices[0];
    const content = choice && choice.message && choice.message.content;
    if (!content) throw new Error('模型返回内容为空');

    const usage = (data && data.usage) || null;
    addTokens(usage, ms, String(content));

    return { text: String(content), usage: usage, ms: ms };
  }

  /* ======================================================================
   * 答案解析
   * ==================================================================== */
  function extractJson(text) {
    if (!text) return null;
    const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
    const tryParse = (s) => {
      try { return JSON.parse(s); } catch (e) { return null; }
    };
    const direct = tryParse(cleaned);
    if (direct) return direct;
    const objs = cleaned.match(/\{[\s\S]*?\}/g) || [];
    for (let i = objs.length - 1; i >= 0; i--) {
      const p = tryParse(objs[i]);
      if (p) return p;
    }
    const greedy = cleaned.match(/\{[\s\S]*\}/);
    return greedy ? tryParse(greedy[0]) : null;
  }

  function extractAnswerItems(raw) {
    const json = extractJson(raw);
    if (!json) return [];
    const v = json.answers || json.answer || json['答案'] || json.result;
    if (Array.isArray(v)) return v.map((x) => String(x == null ? '' : x));
    if (typeof v === 'string') {
      return v.split(/[，,、;；\n]+/).map((s) => s.trim()).filter(Boolean);
    }
    return [];
  }

  function matchByText(ans, options) {
    const na = normForMatch(ans);
    if (!na) return -1;
    let best = -1;
    let bestScore = 0;
    options.forEach((o, i) => {
      const no = normForMatch(o.text);
      if (!no) return;
      let score;
      if (no === na) score = 1;
      else if (no.indexOf(na) >= 0 || na.indexOf(no) >= 0) {
        score = Math.min(na.length, no.length) >= 2 ? 0.85 : 0.3;
      } else {
        score = bigram(no, na);
      }
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return bestScore >= 0.6 ? best : -1;
  }

  function judgeIndex(options, positive) {
    const hit = options.findIndex((o) =>
      positive
        ? /^(对|正确|是|√|T|true|right)$/i.test(o.text.trim())
        : /^(错|错误|否|×|F|false|wrong)$/i.test(o.text.trim())
    );
    return hit;
  }

  function mapToOptions(raw, q) {
    const options = q.options;
    const out = [];
    const pushIdx = (i) => {
      if (i >= 0 && i < options.length && out.indexOf(i) === -1) out.push(i);
    };

    let items = extractAnswerItems(raw);

    if (!items.length) {
      const text = String(raw || '');
      const m = text.match(/(?:答案|回答|选择|选)\s*[:：是为]?\s*([A-Ha-h])/);
      if (m) items = [m[1]];
      else {
        const all = text.match(/[A-Ha-h]/g);
        if (all && all.length && all.length <= options.length) items = [all[all.length - 1]];
      }
    }

    for (const item of items) {
      const a = String(item).trim();
      if (!a) continue;

      // 多选里写成 "B、D" / "A,C" / "BD" 的情况
      if (q.type === 'multiple') {
        const lettersOnly = a.replace(/[\s、,，;；/|\\.．:：()（）\[\]【】]/g, '');
        if (/^[A-Ha-h]{2,8}$/.test(lettersOnly)) {
          for (const ch of lettersOnly) pushIdx(ch.toUpperCase().charCodeAt(0) - 65);
          continue;
        }
      }

      // "A" / "A." / "（A）" / "A、xxx"
      const m1 = a.match(/^[（(\[]*\s*([A-Ha-h])\s*(?:[)）\]、.．:：,，]\s*[\s\S]*)?$/);
      if (m1 && (a.length <= 2 || /^[（(\[]*\s*[A-Ha-h]\s*[)）\]、.．:：,，]/.test(a))) {
        pushIdx(m1[1].toUpperCase().charCodeAt(0) - 65);
        continue;
      }

      // "1" / "（2）"
      const m2 = a.match(/^[（(\[]*\s*(\d{1,2})\s*[)）\]、.．]?$/);
      if (m2) { pushIdx(parseInt(m2[1], 10) - 1); continue; }

      if (q.type === 'judgement') {
        if (/^(对|正确|是|√|T|true|yes|right)$/i.test(a)) { pushIdx(judgeIndex(options, true)); continue; }
        if (/^(错|错误|否|×|F|false|no|wrong)$/i.test(a)) { pushIdx(judgeIndex(options, false)); continue; }
      }

      const idx = matchByText(a, options);
      if (idx >= 0) pushIdx(idx);
    }

    // 按题型约束数量
    let picked = out;
    if (q.type === 'single' || q.type === 'judgement') picked = out.slice(0, 1);
    if (q.type === 'multiple') picked = out;

    return { indices: picked, items: items };
  }

  function buildUserPrompt(q) {
    const lines = [];
    lines.push('题型：' + typeLabel(q.type));
    lines.push('题目：' + q.title);
    if (q.options.length) {
      lines.push('选项：');
      q.options.forEach((o) => lines.push(o.letter + '. ' + o.text));
    } else {
      lines.push('选项：无（填空题）');
    }
    lines.push('只输出 JSON。');
    return lines.join('\n');
  }

  async function solveQuestion(q) {
    const messages = [
      { role: 'system', content: SYS_PROMPT },
      { role: 'user', content: buildUserPrompt(q) }
    ];

    let lastRaw = '';
    let lastErr = null;

    for (let attempt = 0; attempt <= CFG.retries; attempt++) {
      if (STATE.stopRequested) break;
      try {
        const reply = await callModel(messages);
        const raw = reply.text;
        lastRaw = raw;
        const res = mapToOptions(raw, q);
        if (res.indices.length) {
          return { ok: true, indices: res.indices, raw: raw, tokens: reply.usage, ms: reply.ms };
        }
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: RETRY_PROMPT });
      } catch (e) {
        lastErr = e;
        log('模型出错：' + e.message, 'err');
        await sleep(800);
      }
    }

    return { ok: false, indices: [], raw: lastRaw, error: lastErr };
  }

  async function solveCompletion(q) {
    const messages = [
      { role: 'system', content: SYS_PROMPT },
      { role: 'user', content: buildUserPrompt(q) }
    ];
    for (let attempt = 0; attempt <= CFG.retries; attempt++) {
      try {
        const reply = await callModel(messages, { maxTokens: 120 });
        const raw = reply.text;
        const items = extractAnswerItems(raw);
        if (items.length && items[0].trim()) return items[0].trim();
        const m = String(raw).match(/["“]?\s*([^"”\n{}]{1,60}?)\s*["”]?\s*[}\]]/);
        if (m && m[1].trim()) return m[1].trim();
      } catch (e) {
        log('模型出错：' + e.message, 'err');
        await sleep(800);
      }
    }
    return '';
  }

// ==== 超星字体混淆（font-cxsecret）解密模块，插入到 userscript 里 ====

  /* ======================================================================
   * 超星字体混淆解密
   * 页面把题面换成了一套子集字体：字形是对的，码位是乱的。
   * 两条路：① 字体里保留字形名（post 表）就直接读；② 没有名字就做字形比对。
   * ==================================================================== */

  const CX_COMMON = '啊阿埃挨哎唉哀皑癌蔼矮艾碍爱隘鞍氨安俺按暗岸胺案肮昂盎凹敖熬翱袄傲奥懊澳芭捌扒叭吧笆八疤巴拔跋靶把耙坝霸罢爸白柏百摆佰败拜稗斑班搬扳般颁板版扮拌伴瓣半办绊邦帮梆榜膀绑棒磅蚌镑傍谤苞胞包褒剥薄雹保堡饱宝抱报暴豹鲍爆杯碑悲卑北辈背贝钡倍狈备惫焙被奔苯本笨崩绷甭泵蹦迸逼鼻比鄙笔彼碧蓖蔽毕毙毖币庇痹闭敝弊必辟壁臂避陛鞭边编贬扁便变卞辨辩辫遍标彪膘表鳖憋别瘪彬斌濒滨宾摈兵冰柄丙秉饼炳病并玻菠播拨钵波博勃搏铂箔伯帛舶脖膊渤泊驳捕卜哺补埠不布步簿部怖擦猜裁材才财睬踩采彩菜蔡餐参蚕残惭惨灿苍舱仓沧藏操糙槽曹草厕策侧册测层蹭插叉茬茶查碴搽察岔差诧拆柴豺搀掺蝉馋谗缠铲产阐颤昌猖场尝常长偿肠厂敞畅唱倡超抄钞朝嘲潮巢吵炒车扯撤掣彻澈郴臣辰尘晨忱沉陈趁衬撑称城橙成呈乘程惩澄诚承逞骋秤吃痴持匙池迟弛驰耻齿侈尺赤翅斥炽充冲虫崇宠抽酬畴踌稠愁筹仇绸瞅丑臭初出橱厨躇锄雏滁除楚础储矗搐触处揣川穿椽传船喘串疮窗幢床闯创吹炊捶锤垂春椿醇唇淳纯蠢戳绰疵茨磁雌辞慈瓷词此刺赐次聪葱囱匆从丛凑粗醋簇促蹿篡窜摧崔催脆瘁粹淬翠村存寸磋撮搓措挫错搭达答瘩打大呆歹傣戴带殆代贷袋待逮怠耽担丹单郸掸胆旦氮但惮淡诞弹蛋当挡党荡档刀捣蹈倒岛祷导到稻悼道盗德得的蹬灯登等瞪凳邓堤低滴迪敌笛狄涤翟嫡抵底地蒂第帝弟递缔颠掂滇碘点典靛垫电佃甸店惦奠淀殿碉叼雕凋刁掉吊钓调跌爹碟蝶迭谍叠丁盯叮钉顶鼎锭定订丢东冬董懂动栋侗恫冻洞兜抖斗陡豆逗痘都督毒犊独读堵睹赌杜镀肚度渡妒端短锻段断缎堆兑队对墩吨蹲敦顿囤钝盾遁掇哆多夺垛躲朵跺舵剁惰堕蛾峨鹅俄额讹娥恶厄扼遏鄂饿恩而儿耳尔饵洱二贰发罚筏伐乏阀法珐藩帆番翻樊矾钒繁凡烦反返范贩犯饭泛坊芳方肪房防妨仿访纺放菲非啡飞肥匪诽吠肺废沸费芬酚吩氛分纷坟焚汾粉奋份忿愤粪丰封枫蜂峰锋风疯烽逢冯缝讽奉凤佛否夫敷肤孵扶拂辐幅氟符伏俘服浮涪福袱弗甫抚辅俯釜斧脯腑府腐赴副覆赋复傅付阜父腹负富讣附妇缚咐噶嘎该改概钙盖溉干甘杆柑竿肝赶感秆敢赣冈刚钢缸肛纲岗港杠篙皋高膏羔糕搞镐稿告哥歌搁戈鸽胳疙割革葛格蛤阁隔铬个各给根跟耕更庚羹埂耿梗工攻功恭龚供躬公宫弓巩汞拱贡共钩勾沟苟狗垢构购够辜菇咕箍估沽孤姑鼓古蛊骨谷股故顾固雇刮瓜剐寡挂褂乖拐怪棺关官冠观管馆罐惯灌贯光广逛瑰规圭硅归龟闺轨鬼诡癸桂柜跪贵刽辊滚棍锅郭国果裹过哈骸孩海氦亥害骇酣憨邯韩含涵寒函喊罕翰撼捍旱憾悍焊汗汉夯杭航壕嚎豪毫郝好耗号浩呵喝荷菏核禾和何合盒貉阂河涸赫褐鹤贺嘿黑痕很狠恨哼亨横衡恒轰哄烘虹鸿洪宏弘红喉侯猴吼厚候后呼乎忽瑚壶葫胡蝴狐糊湖弧虎唬护互沪户花哗华猾滑画划化话槐徊怀淮坏欢环桓还缓换患唤痪豢焕涣宦幻荒慌黄磺蝗簧皇凰惶煌晃幌恍谎灰挥辉徽恢蛔回毁悔慧卉惠晦贿秽会烩汇讳诲绘荤昏婚魂浑混豁活伙火获或惑霍货祸击圾基机畸稽积箕肌饥迹激讥鸡姬绩缉吉极棘辑籍集及急疾汲即嫉级挤几脊己蓟技冀季伎祭剂悸济寄寂计记既忌际妓继纪嘉枷夹佳家加荚颊贾甲钾假稼价架驾嫁歼监坚尖笺间煎兼肩艰奸缄茧检柬碱硷拣捡简俭剪减荐槛鉴践贱见键箭件健舰剑饯渐溅涧建僵姜将浆江疆蒋桨奖讲匠酱降蕉椒礁焦胶交郊浇骄娇嚼搅铰矫侥脚狡角饺缴绞剿教酵轿较叫窖揭接皆秸街阶截劫节桔杰捷睫竭洁结解姐戒藉芥界借介疥诫届巾筋斤金今津襟紧锦仅谨进靳晋禁近烬浸尽劲荆兢茎睛晶鲸京惊精粳经井警景颈静境敬镜径痉靖竟竞净炯窘揪究纠玖韭久灸九酒厩救旧臼舅咎就疚鞠拘狙疽居驹菊局咀矩举沮聚拒据巨具距踞锯俱句惧炬剧捐鹃娟倦眷卷绢撅攫抉掘倔爵觉决诀绝均菌钧军君峻俊竣浚郡骏喀咖卡咯开揩楷凯慨刊堪勘坎砍看康慷糠扛抗亢炕考拷烤靠坷苛柯棵磕颗科壳咳可渴克刻客课肯啃垦恳坑吭空恐孔控抠口扣寇枯哭窟苦酷库裤夸垮挎跨胯块筷侩快宽款匡筐狂框矿眶旷况亏盔岿窥葵奎魁傀馈愧溃坤昆捆困括扩廓阔垃拉喇蜡腊辣啦莱来赖蓝婪栏拦篮阑兰澜谰揽览懒缆烂滥琅榔狼廊郎朗浪捞劳牢老佬姥酪烙涝勒乐雷镭蕾磊累儡垒擂肋类泪棱楞冷厘梨犁黎篱狸离漓理李里鲤礼莉荔吏栗丽厉励砾历利傈例俐痢立粒沥隶力璃哩俩联莲连镰廉怜涟帘敛脸链恋炼练粮凉梁粱良两辆量晾亮谅撩聊僚疗燎寥辽潦了撂镣廖料列裂烈劣猎琳林磷霖临邻鳞淋凛赁吝拎玲菱零龄铃伶羚凌灵陵岭领另令溜琉榴硫馏留刘瘤流柳六龙聋咙笼窿隆垄拢陇楼娄搂篓漏陋芦卢颅庐炉掳卤虏鲁麓碌露路赂鹿潞禄录陆戮驴吕铝侣旅履屡缕虑氯律率滤绿峦挛孪滦卵乱掠略抡轮伦仑沦纶论萝螺罗逻锣箩骡裸落洛骆络妈麻玛码蚂马骂嘛吗埋买麦卖迈脉瞒馒蛮满蔓曼慢漫谩芒茫盲氓忙莽猫茅锚毛矛铆卯茂冒帽貌贸么玫枚梅酶霉煤没眉媒镁每美昧寐妹媚门闷们萌蒙檬盟锰猛梦孟眯醚靡糜迷谜弥米秘觅泌蜜密幂棉眠绵冕免勉娩缅面苗描瞄藐秒渺庙妙蔑灭民抿皿敏悯闽明螟鸣铭名命谬摸摹蘑模膜磨摩魔抹末莫墨默沫漠寞陌谋牟某拇牡亩姆母墓暮幕募慕木目睦牧穆拿哪呐钠那娜纳氖乃奶耐奈南男难囊挠脑恼闹淖呢馁内嫩能妮霓倪泥尼拟你匿腻逆溺蔫拈年碾撵捻念娘酿鸟尿捏聂孽啮镊镍涅您柠狞凝宁拧泞牛扭钮纽脓浓农弄奴努怒女暖虐疟挪懦糯诺哦欧鸥殴藕呕偶沤啪趴爬帕怕琶拍排牌徘湃派攀潘盘磐盼畔判叛乓庞旁耪胖抛咆刨炮袍跑泡呸胚培裴赔陪配佩沛喷盆砰抨烹澎彭蓬棚硼篷膨朋鹏捧碰坯砒霹批披劈琵毗啤脾疲皮匹痞僻屁譬篇偏片骗飘漂瓢票撇瞥拼频贫品聘乒坪苹萍平凭瓶评屏坡泼颇婆破魄迫粕剖扑铺仆莆葡菩蒲埔朴圃普浦谱曝瀑期欺栖戚妻七凄漆柒沏其棋奇歧畦崎脐齐旗祈祁骑起岂乞企启契砌器气迄弃汽泣讫掐恰洽牵扦钎铅千迁签仟谦乾黔钱钳前潜遣浅谴堑嵌欠歉枪呛腔羌墙蔷强抢橇锹敲悄桥瞧乔侨巧鞘撬翘峭俏窍切茄且怯窃钦侵亲秦琴勤芹擒禽寝沁青轻氢倾卿清擎晴氰情顷请庆琼穷秋丘邱球求囚酋泅趋区蛆曲躯屈驱渠取娶龋趣去圈颧权醛泉全痊拳犬券劝缺炔瘸却鹊榷确雀裙群然燃冉染瓤壤攘嚷让饶扰绕惹热壬仁人忍韧任认刃妊纫扔仍日戎茸蓉荣融熔溶容绒冗揉柔肉茹蠕儒孺如辱乳汝入褥软阮蕊瑞锐闰润若弱撒洒萨腮鳃塞赛三叁伞散桑嗓丧搔骚扫嫂瑟色涩森僧莎砂杀刹沙纱傻啥煞筛晒珊苫杉山删煽衫闪陕擅赡膳善汕扇缮墒伤商赏晌上尚裳梢捎稍烧芍勺韶少哨邵绍奢赊蛇舌舍赦摄射慑涉社设砷申呻伸身深娠绅神沈审婶甚肾慎渗声生甥牲升绳省盛剩胜圣师失狮施湿诗尸虱十石拾时什食蚀实识史矢使屎驶始式示士世柿事拭誓逝势是嗜噬适仕侍释饰氏市恃室视试收手首守寿授售受瘦兽蔬枢梳殊抒输叔舒淑疏书赎孰熟薯暑曙署蜀黍鼠属术述树束戍竖墅庶数漱恕刷耍摔衰甩帅栓拴霜双爽谁水睡税吮瞬顺舜说硕朔烁斯撕嘶思私司丝死肆寺嗣四伺似饲巳松耸怂颂送宋讼诵搜艘擞嗽苏酥俗素速粟僳塑溯宿诉肃酸蒜算虽隋随绥髓碎岁穗遂隧祟孙损笋蓑梭唆缩琐索锁所塌他它她塔獭挞蹋踏胎苔抬台泰酞太态汰坍摊贪瘫滩坛檀痰潭谭谈坦毯袒碳探叹炭汤塘搪堂棠膛唐糖倘躺淌趟烫掏涛滔绦萄桃逃淘陶讨套特藤腾疼誊梯剔踢锑提题蹄啼体替嚏惕涕剃屉天添填田甜恬舔腆挑条迢眺跳贴铁帖厅听烃汀廷停亭庭挺艇通桐酮瞳同铜彤童桶捅筒统痛偷投头透凸秃突图徒途涂屠土吐兔湍团推颓腿蜕褪退吞屯臀拖托脱鸵陀驮驼椭妥拓唾挖哇蛙洼娃瓦袜歪外豌弯湾玩顽丸烷完碗挽晚皖惋宛婉万腕汪王亡枉网往旺望忘妄威巍微危韦违桅围唯惟为潍维苇萎委伟伪尾纬未蔚味畏胃喂魏位渭谓尉慰卫瘟温蚊文闻纹吻稳紊问嗡翁瓮挝蜗涡窝我斡卧握沃巫呜钨乌污诬屋无芜梧吾吴毋武五捂午舞伍侮坞戊雾晤物勿务悟误昔熙析西硒矽晰嘻吸锡牺稀息希悉膝夕惜熄烯溪汐犀檄袭席习媳喜铣洗系隙戏细瞎虾匣霞辖暇峡侠狭下厦夏吓掀锨先仙鲜纤咸贤衔舷闲涎弦嫌显险现献县腺馅羡宪陷限线相厢镶香箱襄湘乡翔祥详想响享项巷橡像向象萧硝霄削哮嚣销消宵淆晓小孝校肖啸笑效楔些歇蝎鞋协挟携邪斜胁谐写械卸蟹懈泄泻谢屑薪芯锌欣辛新忻心信衅星腥猩惺兴刑型形邢行醒幸杏性姓兄凶胸匈汹雄熊休修羞朽嗅锈秀袖绣墟戌需虚嘘须徐许蓄酗叙旭序畜恤絮婿绪续轩喧宣悬旋玄选癣眩绚靴薛学穴雪血勋熏循旬询寻驯巡殉汛训讯逊迅压押鸦鸭呀丫芽牙蚜崖衙涯雅哑亚讶焉咽阉烟淹盐严研蜒岩延言颜阎炎沿奄掩眼衍演艳堰燕厌砚雁唁彦焰宴谚验殃央鸯秧杨扬佯疡羊洋阳氧仰痒养样漾邀腰妖瑶摇尧遥窑谣姚咬舀药要耀椰噎耶爷野冶也页掖业叶曳腋夜液一壹医揖铱依伊衣颐夷遗移仪胰疑沂宜姨彝椅蚁倚已乙矣以艺抑易邑屹亿役臆逸肄疫亦裔意毅忆义益溢诣议谊译异翼翌绎茵荫因殷音阴姻吟银淫寅饮尹引隐印英樱婴鹰应缨莹萤营荧蝇迎赢盈影颖硬映哟拥佣臃痈庸雍踊蛹咏泳涌永恿勇用幽优悠忧尤由邮铀犹油游酉有友右佑釉诱又幼迂淤于盂榆虞愚舆余俞逾鱼愉渝渔隅予娱雨与屿禹宇语羽玉域芋郁吁遇喻峪御愈欲狱育誉浴寓裕预豫驭鸳渊冤元垣袁原援辕园员圆猿源缘远苑愿怨院曰约越跃钥岳粤月悦阅耘云郧匀陨允运蕴酝晕韵孕匝砸杂栽哉灾宰载再在咱攒暂赞赃脏葬遭糟凿藻枣早澡蚤躁噪造皂灶燥责择则泽贼怎增憎曾赠扎喳渣札轧铡闸眨栅榨咋乍炸诈摘斋宅窄债寨瞻毡詹粘沾盏斩辗崭展蘸栈占战站湛绽樟章彰漳张掌涨杖丈帐账仗胀瘴障招昭找沼赵照罩兆肇召遮折哲蛰辙者锗蔗这浙珍斟真甄砧臻贞针侦枕疹诊震振镇阵蒸挣睁征狰争怔整拯正政帧症郑证芝枝支吱蜘知肢脂汁之织职直植殖执值侄址指止趾只旨纸志挚掷至致置帜峙制智秩稚质炙痔滞治窒中盅忠钟衷终种肿重仲众舟周州洲诌粥轴肘帚咒皱宙昼骤珠株蛛朱猪诸诛逐竹烛煮拄瞩嘱主著柱助蛀贮铸筑住注祝驻抓爪拽专砖转撰赚篆桩庄装妆撞壮状椎锥追赘坠缀谆准捉拙卓桌琢茁酌啄着灼浊兹咨资姿滋淄孜紫仔籽滓子自渍字鬃棕踪宗综总纵邹走奏揍租足卒族祖诅阻组钻纂嘴醉最罪尊遵昨左佐柞做作坐座';

  const CX_FONT_CACHE_KEY = 'cx-local-ai-fontmap';

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function ttfTables(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0) !== 0x00010000) return null;   // 只认 TrueType
    const numTables = dv.getUint16(4);
    const tables = {};
    for (let i = 0; i < numTables; i++) {
      const o = 12 + i * 16;
      const tag = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
      tables[tag] = { offset: dv.getUint32(o + 8), length: dv.getUint32(o + 12) };
    }
    return { dv: dv, tables: tables };
  }

  function ttfCmap(dv, offset) {
    const n = dv.getUint16(offset + 2);
    let best = null;
    for (let i = 0; i < n; i++) {
      const p = offset + 4 + i * 8;
      const pid = dv.getUint16(p);
      const eid = dv.getUint16(p + 2);
      const sub = offset + dv.getUint32(p + 4);
      const fmt = dv.getUint16(sub);
      if ((pid === 3 && (eid === 1 || eid === 10)) || (pid === 0)) {
        if (fmt === 4) best = { offset: sub, format: 4 };
        else if (fmt === 12 && !best) best = { offset: sub, format: 12 };
      }
    }
    if (!best) return new Map();

    const map = new Map();

    if (best.format === 4) {
      const o = best.offset;
      const segX2 = dv.getUint16(o + 6);
      const seg = segX2 / 2;
      const endO = o + 14;
      const startO = endO + segX2 + 2;
      const deltaO = startO + segX2;
      const rangeO = deltaO + segX2;
      for (let s = 0; s < seg; s++) {
        const end = dv.getUint16(endO + s * 2);
        const start = dv.getUint16(startO + s * 2);
        const delta = dv.getInt16(deltaO + s * 2);
        const ro = dv.getUint16(rangeO + s * 2);
        if (start === 0xffff) continue;
        for (let c = start; c <= end; c++) {
          let gid;
          if (ro === 0) {
            gid = (c + delta) & 0xffff;
          } else {
            const gi = rangeO + s * 2 + ro + (c - start) * 2;
            if (gi + 1 >= dv.byteLength) continue;
            gid = dv.getUint16(gi);
            if (gid) gid = (gid + delta) & 0xffff;
          }
          if (gid) map.set(c, gid);
        }
      }
      return map;
    }

    // format 12
    const o = best.offset;
    const groups = dv.getUint32(o + 12);
    for (let g = 0; g < groups; g++) {
      const p = o + 16 + g * 12;
      const start = dv.getUint32(p);
      const end = dv.getUint32(p + 4);
      const gid0 = dv.getUint32(p + 8);
      for (let c = start; c <= end; c++) map.set(c, gid0 + (c - start));
    }
    return map;
  }

  function ttfPostNames(dv, offset) {
    if (dv.getUint32(offset) !== 0x00020000) return null;  // 只有 2.0 带名字
    const numGlyphs = dv.getUint16(offset + 32);
    const idxO = offset + 34;
    let p = idxO + numGlyphs * 2;
    if (p + 2 > dv.byteLength) return null;
    const count = dv.getUint16(p);
    p += 2;
    const names = [];
    for (let i = 0; i < count; i++) {
      if (p >= dv.byteLength) break;
      const len = dv.getUint8(p++);
      let s = '';
      for (let j = 0; j < len && p < dv.byteLength; j++) s += String.fromCharCode(dv.getUint8(p++));
      names.push(s);
    }
    const gid2name = [];
    for (let g = 0; g < numGlyphs; g++) {
      const idx = dv.getUint16(idxO + g * 2);
      gid2name[g] = idx >= 258 ? names[idx - 258] : null;
    }
    return gid2name;
  }

  function nameToChar(name) {
    if (!name) return '';
    let m = name.match(/^uni([0-9A-Fa-f]{4})$/);
    if (m) return String.fromCharCode(parseInt(m[1], 16));
    m = name.match(/^u([0-9A-Fa-f]{4,6})$/);
    if (m) return String.fromCharCode(parseInt(m[1], 16));
    return '';
  }

  // 读字体的名字表：能看出这套密码字体是用哪种字型做的
  function ttfFamily(dv, offset) {
    try {
      const count = dv.getUint16(offset + 2);
      const strOff = offset + dv.getUint16(offset + 4);
      for (let i = 0; i < count; i++) {
        const p = offset + 6 + i * 12;
        const pid = dv.getUint16(p);
        const nid = dv.getUint16(p + 6);
        const len = dv.getUint16(p + 8);
        const off = dv.getUint16(p + 10);
        if (nid !== 1 && nid !== 4 && nid !== 6) continue;
        if (pid !== 3 && pid !== 0) continue;
        let s = '';
        for (let j = 0; j < len; j += 2) {
          const c = dv.getUint16(strOff + off + j);
          if (c) s += String.fromCharCode(c);
        }
        if (s.trim()) return s.trim();
      }
    } catch (e) { /* 忽略 */ }
    return '';
  }

  function findSecretFontSrc() {
    const found = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      if (!rules) continue;
      for (const r of Array.from(rules)) {
        const name = r.constructor && r.constructor.name;
        if (name !== 'CSSFontFaceRule') continue;
        const fam = String(r.style.fontFamily || '').replace(/["']/g, '');
        const src = String(r.style.src || '');
        if (/cxsecret/i.test(fam) || /font-cxsecret/i.test(src)) found.push(src);
      }
    }
    for (const src of found) {
      const m = src.match(/url\(["']?(data:[^"')]*)["']?\)/);
      if (m) return m[1];
    }
    return null;
  }

  function glyphSig(ctx, ch, family) {
    ctx.clearRect(0, 0, 64, 64);
    ctx.font = '48px ' + family;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#000';
    ctx.fillText(ch, 4, 4);
    const data = ctx.getImageData(0, 0, 64, 64).data;

    let minX = 64, minY = 64, maxX = -1, maxY = -1;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (data[(y * 64 + x) * 4 + 3] > 120) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;

    const bits = new Uint8Array(256); // 16x16
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    for (let gy = 0; gy < 16; gy++) {
      for (let gx = 0; gx < 16; gx++) {
        const sx = minX + Math.floor((gx + 0.5) * w / 16);
        const sy = minY + Math.floor((gy + 0.5) * h / 16);
        const a = data[(sy * 64 + sx) * 4 + 3];
        bits[gy * 16 + gx] = a > 120 ? 1 : 0;
      }
    }
    return bits;
  }

  function sigDistance(a, b) {
    let d = 0;
    for (let i = 0; i < 256; i++) if (a[i] !== b[i]) d++;
    return d;
  }

  async function buildMapByShape(fontSrc, chars, preferredFamily) {
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 64;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    const fam = 'cxsec-' + Math.random().toString(36).slice(2);
    const face = new FontFace(fam, 'url("' + fontSrc + '")');
    await face.load();
    document.fonts.add(face);

    // 参考字体：字体自报的名称优先，其次页面正文字体，再退到常见中文字体
    const sample = document.querySelector('.TiMu .Zy_TItle, .questionLi .mark_name, body');
    let bodyFam = '';
    try {
      if (sample) bodyFam = getComputedStyle(sample).fontFamily || '';
    } catch (e) { /* 忽略 */ }
    const families = [];
    if (preferredFamily) families.push(preferredFamily);
    bodyFam.split(',').forEach((f) => {
      const t = f.replace(/["']/g, '').trim();
      if (t && !/cxsecret/i.test(t) && families.indexOf(t) === -1) families.push(t);
    });
    ['SimSun', 'Microsoft YaHei', 'SimHei', 'KaiTi', 'DengXian', 'FangSong'].forEach((f) => {
      if (families.indexOf(f) === -1) families.push(f);
    });

    const uniq = Array.from(new Set(chars)).filter((c) => c.trim());
    if (!uniq.length) return null;

    const refSigs = new Map(); // char -> sig
    const refList = [];

    for (const family of families.slice(0, 3)) {
      let ok = 0;
      const mine = [];
      for (let i = 0; i < CX_COMMON.length; i++) {
        const ch = CX_COMMON[i];
        const s = glyphSig(ctx, ch, '"' + family + '"');
        if (s) { mine.push([ch, s]); ok++; }
      }
      if (ok < 500) continue;

      // 先拿几个字自检：这套字体能不能和密码字体对上
      let score = 0;
      let testN = 0;
      for (const ch of uniq.slice(0, 8)) {
        const target = glyphSig(ctx, ch, '"' + fam + '"');
        if (!target) continue;
        let best = 999;
        for (const [rc, rs] of mine) {
          const d = sigDistance(target, rs);
          if (d < best) best = d;
        }
        score += best;
        testN++;
      }
      if (!testN) continue;
      const avg = score / testN;

      if (avg < 28) {   // 对得上
        refSigs.clear();
        mine.forEach(([c, s]) => refSigs.set(c, s));
        refList.length = 0;
        refList.push(...mine);
        break;
      }
    }

    if (!refList.length) return null;

    const map = {};
    for (const ch of uniq) {
      const target = glyphSig(ctx, ch, '"' + fam + '"');
      if (!target) continue;
      let best = null;
      let bestD = 999;
      for (const [rc, rs] of refList) {
        const d = sigDistance(target, rs);
        if (d < bestD) { bestD = d; best = rc; }
      }
      if (best && bestD <= 40) map[ch] = best;
    }
    return Object.keys(map).length ? map : null;
  }

  let CX_MAP_CACHE = null;

  async function decodeCxFont(force) {
    const nodes = Array.from(document.querySelectorAll('.font-cxsecret'));
    if (!nodes.length) return false;

    const src = findSecretFontSrc();
    if (!src) return false;

    let map = null;
    const key = CX_FONT_CACHE_KEY + ':' + src.length + ':' + src.slice(-24);

    if (!force) {
      if (CX_MAP_CACHE) map = CX_MAP_CACHE;
      else {
        try {
          const cached = (typeof GM_getValue === 'function') ? GM_getValue(key, '') : '';
          if (cached) map = JSON.parse(cached);
        } catch (e) { /* 忽略 */ }
      }
    }

    let preferredFamily = '';

    if (!map) {
      const b64 = (src.match(/base64,([^"')]+)/) || [])[1];
      if (b64) {
        try {
          const bytes = b64ToBytes(b64);
          const t = ttfTables(bytes);
          if (t && t.tables.name) {
            preferredFamily = ttfFamily(t.dv, t.tables.name.offset);
            if (preferredFamily) log('密码字体自报名称：' + preferredFamily, 'info');
          }
          if (t && t.tables.cmap) {
            const cmap = ttfCmap(t.dv, t.tables.cmap.offset);
            const post = t.tables.post ? ttfPostNames(t.dv, t.tables.post.offset) : null;
            if (post) {
              const byName = {};
              let hit = 0;
              cmap.forEach((gid, cp) => {
                const ch = nameToChar(post[gid]);
                if (ch) { byName[String.fromCharCode(cp)] = ch; hit++; }
              });
              if (hit > 10) {
                map = byName;
                log('字体解密：从字形名读到 ' + hit + ' 个字', 'ok');
              }
            }
          }
        } catch (e) {
          log('字体表解析失败：' + e.message, 'warn');
        }
      }

      if (!map) {
        log('字体没有字形名，改用字形比对（首次约 5~20 秒）', 'info');
        const chars = [];
        nodes.forEach((n) => { chars.push(...Array.from(n.textContent || '')); });
        map = await buildMapByShape(src, chars, preferredFamily);
      }

      if (map) {
        CX_MAP_CACHE = map;
        try {
          if (typeof GM_setValue === 'function') GM_setValue(key, JSON.stringify(map));
        } catch (e) { /* 忽略 */ }
      }
    }

    if (!map || !Object.keys(map).length) {
      log('字体解密失败：这道题的文字仍然是乱码', 'err');
      return false;
    }

    let changed = 0;
    for (const node of nodes) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const texts = [];
      while (walker.nextNode()) texts.push(walker.currentNode);
      for (const t of texts) {
        const v = t.nodeValue || '';
        let out = '';
        for (const ch of v) out += (map[ch] != null ? map[ch] : ch);
        if (out !== v) { t.nodeValue = out; changed++; }
      }
      node.classList.remove('font-cxsecret');
    }

    log('字体解密完成：还原 ' + changed + ' 段文字', 'ok');
    return changed > 0;
  }

  /* ======================================================================
   * 题目抽取
   * ==================================================================== */
  function collectTimuOptions(root) {
    const selectors = ['ul li .after', 'ul li label:not(.before)', 'ul li .textDIV', 'ul li .eidtDiv'];
    for (const sel of selectors) {
      const found = Array.from(root.querySelectorAll(sel)).filter((el) => txt(el));
      if (found.length) return found;
    }
    return [];
  }

  // 超星的选项 li 上带 qtype：0 单选、1 多选、3 判断
  function mapQtype(v) {
    const s = String(v == null ? '' : v).trim();
    if (s === '0') return 'single';
    if (s === '1') return 'multiple';
    if (s === '3') return 'judgement';
    if (s === '2') return 'completion';
    return 'unknown';
  }

  function typeFromRoot(root, inputSel) {
    const typeInput = root.querySelector(inputSel);
    let t = typeInput ? mapTypeValue(typeInput.value) : 'unknown';
    if (t === 'unknown') {
      const li = root.querySelector('ul li[qtype]') || root.querySelector('li[qtype]');
      if (li) t = mapQtype(li.getAttribute('qtype'));
    }
    return t;
  }

  function extractTimuQuestions() {
    // 不按可见性过滤：mooc2 的题目常常先渲染在隐藏容器里，过滤掉就一题都抓不到
    return Array.from(document.querySelectorAll('.TiMu'))
      .map((root, i) => {
        const type = typeFromRoot(root, 'input[id^="answertype"]');
        const titleEl = root.querySelector('.Zy_TItle .clearfix') || root.querySelector('.Zy_TItle');
        const optNodes = collectTimuOptions(root);
        const options = optNodes.map((el, idx) => ({
          el: el, letter: LETTERS[idx] || String(idx + 1), text: txt(el)
        }));
        const realType = type === 'unknown' ? guessType(options) : type;
        return {
          kind: 'timu', root: root, index: i, type: realType,
          title: cleanTitle(txt(titleEl)), options: options
        };
      })
      .filter((q) => q.title);
  }

  function extractWorkQuestions() {
    const roots = Array.from(document.querySelectorAll('.questionLi'));

    return roots.map((root, i) => {
      const rawType = typeFromRoot(root, 'input[name^="type"], input[id^="answertype"]');

      // 题干：超星作业里是 .mark_name，材料题会有多个
      const titleNodes = Array.from(root.querySelectorAll('.mark_name'))
        .filter((n) => !n.closest('.answerBg') && txt(n));
      let titleNode = titleNodes[0] || root.querySelector('.Zy_TItle');
      let titleText = titleNodes.length
        ? titleNodes.map(txt).join(' ')
        : txt(titleNode);

      // 都没有就退到整块文字的前一段，别让题目整条丢掉
      if (!titleText.trim()) titleText = txt(root).slice(0, 200);

      const optNodes = Array.from(root.querySelectorAll(
        '.answerBg .answer_p, .answerBg .textDIV, .answerBg .eidtDiv'
      )).filter((el) => txt(el));

      const options = optNodes.map((el, idx) => ({
        el: el, letter: LETTERS[idx] || String(idx + 1), text: txt(el)
      }));

      const realType = rawType === 'unknown' ? guessType(options) : rawType;

      return {
        kind: 'work',
        root: root,
        index: i,
        type: realType,
        title: cleanTitle(titleText),
        options: options
      };
    }).filter((q) => q.title);
  }

  function isOptionSelected(el) {
    // 选中标记的位置各版本不同：可能在 li、在 .answerBg、在 .num_option，
    // 也可能只反映到隐藏 input。少认一种就会重复点，把已选中的选项又取消掉。
    const bg = el.closest('.answerBg') || el.parentElement;
    const box = el.closest('li') || bg || el;

    if (box && /\b(cur|selected|checked|active)\b/.test(box.className || '')) return true;
    if (bg && /check_answer/.test(bg.className || '')) return true;
    if (box && box.querySelector('.check_answer')) return true;
    if (bg && bg.querySelector('.check_answer')) return true;

    const input = box && box.querySelector('input[type="radio"],input[type="checkbox"]');
    if (input) return !!input.checked;

    return false;
  }

  async function clickOption(el) {
    if (isOptionSelected(el)) return true;

    // 各版本绑定事件的元素不一样：有的在外层 .answerBg，有的在选项本身，有的在 label/li。
    // 每个候选只点一次（超星是 toggle，重复点会把已选中的取消掉），点到生效为止。
    const bg = el.closest('.answerBg');
    const li = el.closest('li');
    const label = el.closest('label') || (li && li.querySelector('label'));

    const candidates = [bg, el, label, li].filter(function (x, i, arr) {
      return x && arr.indexOf(x) === i;
    });

    for (const target of candidates) {
      try { target.click(); } catch (e) { /* 忽略 */ }
      await sleep(220);
      if (isOptionSelected(el)) return true;
    }

    return false;
  }

  async function applyAnswer(q, indices) {
    if (q.type === 'completion') return false;
    for (const i of indices) {
      const opt = q.options[i];
      if (!opt) continue;
      await clickOption(opt.el);
      await sleep(120);
    }
    return true;
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fillInput(el, value) {
    setNativeValue(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // 多个空时按分隔符拆答案
  function splitBlanks(value, n) {
    if (n <= 1) return [value];
    const parts = String(value).split(/[;；,，、\s]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= n) return parts.slice(0, n);
    return [value];
  }

  function fillBlank(q, value) {
    const root = q.root;

    // 1) 富文本/多行：textarea
    const ta = root.querySelector('textarea');
    if (ta) {
      fillInput(ta, value);
      return true;
    }

    // 2) 富文本 iframe（超星老版编辑器）
    const frame = root.querySelector('iframe');
    if (frame && frame.contentDocument && frame.contentDocument.body) {
      frame.contentDocument.body.innerHTML = value;
      return true;
    }

    // 3) 作业里的填空 input[name^="answer"]，可能有多个空
    const inputs = Array.from(root.querySelectorAll('input[name^="answer"]'))
      .filter((el) => !/^(hidden|radio|checkbox|button|submit)$/i.test(el.type || 'text'));
    if (inputs.length) {
      const parts = splitBlanks(value, inputs.length);
      inputs.forEach((el, i) => fillInput(el, parts[i] || ''));
      return true;
    }

    return false;
  }

  async function clickByText(pattern) {
    // 不再要求元素带 onclick：超星很多按钮是 jQuery 绑的，<a>/<div> 上没有 onclick 属性
    const sel = 'a,button,input[type="submit"],input[type="button"],div,span,li,p';
    const nodes = Array.from(document.querySelectorAll(sel)).filter(visible);
    const hits = [];
    for (const el of nodes) {
      const t = (el.value || txt(el) || '').trim();
      if (t && t.length <= 10 && pattern.test(t)) hits.push({ el: el, len: t.length });
    }
    // 文字最短的优先：别点到把整块文字都包住的容器
    hits.sort((a, b) => a.len - b.len);
    for (const h of hits) {
      try { h.el.click(); return true; } catch (e) { /* 忽略 */ }
    }
    return false;
  }

  const CONFIRM_SELECTORS = [
    '#jb_btn',            // mooc2 弹窗的「确定」
    '.popDiv .btn',
    '.layui-layer-btn0',
    '.btn_ok',
    '.confirmBtn',
    '#popok',
    'a[onclick*="submitCheckTimes"]'
  ];

  async function confirmDialog() {
    await sleep(1000);

    // 先按已知结构点，再按文字兜底
    for (let round = 0; round < 3; round++) {
      for (const sel of CONFIRM_SELECTORS) {
        const el = document.querySelector(sel);
        if (el && visible(el)) {
          try { el.click(); await sleep(900); return true; } catch (e) { /* 忽略 */ }
        }
      }
      const ok = await clickByText(/^(确定|确认|是|好的|确认提交|确定提交|继续提交)$/);
      if (ok) { await sleep(900); return true; }
      await sleep(700);
    }
    return false;
  }

  // 出现验证码 / 人脸 / 二次确认之类的拦截时，不要硬撞
  function blockingDialog() {
    const tips = ['#workVerify', '.workVerify', '#captcha', '.verifyCode', '.yzm'];
    for (const sel of tips) {
      const el = document.querySelector(sel);
      if (el && visible(el)) return '验证码';
    }
    const text = txt(document.body).slice(0, 4000);
    if (/请输入验证码|拖动滑块|点击完成验证/.test(text)) return '验证码';
    return '';
  }

  const SUBMIT_SELECTORS = [
    '.btnBlueSubmit',
    'input.btnBlueSubmit',
    '#btnBlueSubmit',
    '#completeBtn',          // mooc2 作业页的「提交」就是这个 id
    '.completeBtn',
    '#submitBtn',
    '.submitBtn',
    '.sub_btn',
    '#saveBtn',
    'a[onclick*="btnBlueSubmit"]',
    'a[onclick*="submitCheckTimes"]',
    'input[onclick*="btnBlueSubmit"]'
  ];

  async function submitQuiz() {
    const w = pageWin();

    // 1) 页面自带的提交入口（最可靠；OCSP 也是走这个）
    if (typeof w.btnBlueSubmit === 'function') {
      try {
        const oldConfirm = w.confirm;
        w.confirm = () => true;            // 原生确认框直接放行
        w.btnBlueSubmit();
        await sleep(1200);
        if (typeof w.submitCheckTimes === 'function') {
          try { w.submitCheckTimes(); } catch (e) { /* 忽略 */ }
        }
        await sleep(600);
        w.confirm = oldConfirm;
        log('已调用页面提交接口 btnBlueSubmit', 'ok');
        await confirmDialog();
        return true;
      } catch (e) {
        log('btnBlueSubmit 调用失败：' + e.message, 'warn');
      }
    }

    // 2) 已知的提交按钮选择器
    for (const sel of SUBMIT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && visible(el)) {
        try { el.click(); } catch (e) { /* 忽略 */ }
        await sleep(1200);

        const block = blockingDialog();
        if (block) {
          log('提交被拦住了：出现' + block + '，需要你手动过一次', 'err');
          return false;
        }

        log('已点提交按钮 ' + sel, 'ok');
        await confirmDialog();

        // 3) 有的版本点完确认才真正走提交函数
        if (typeof w.submitCheckTimes === 'function' && !/提交成功|已提交/.test(txt(document.body))) {
          try { w.submitCheckTimes(); await sleep(800); } catch (e) { /* 忽略 */ }
        }
        return true;
      }
    }

    // 4) 页面自己的确认提交接口
    if (typeof w.confirmSubmitWork === 'function') {
      try {
        w.confirmSubmitWork();
        await sleep(1200);
        log('已调用页面接口 confirmSubmitWork', 'ok');
        await confirmDialog();
        return true;
      } catch (e) { /* 继续兜底 */ }
    }

    // 3) 按文字兜底（范围放宽到 div/span，只认带 onclick 的）
    const byText = await clickByText(/^(提交|交卷|提交作业|提交答案|保存并提交|交卷并查看结果)$/);
    if (byText) {
      log('已点提交（按文字匹配）', 'ok');
      await confirmDialog();
      return true;
    }

    if (typeof w.noSubmit === 'function') {
      try { w.noSubmit(); log('没找到提交按钮，已调用保存接口 noSubmit', 'warn'); return true; } catch (e) { /* 忽略 */ }
    }

    log('没找到提交按钮，请手动提交', 'warn');
    return false;
  }

  /* ======================================================================
   * 运行状态
   * ==================================================================== */
  const STATE = {
    stopRequested: false,
    running: false,
    job: null,
    since: 0,
    lastDoneAt: 0,
    emptyJumps: 0,
    ownedGlobal: false,
    answeredQuizKeys: new Set()
  };

  function stopAll() {
    STATE.stopRequested = true;
    STATE.running = false;
  }

  /* ======================================================================
   * 视频
   * ==================================================================== */
  function faceRecognitionActive() {
    const qr = document.querySelectorAll('#fcqrimg');
    for (const el of qr) {
      if (el.getAttribute('src')) return true;
    }
    const masks = document.querySelectorAll('.chapterVideoFaceMaskDiv');
    for (const el of masks) {
      if (el.style.display !== 'none' && visible(el)) return true;
    }
    return false;
  }

  function applyRate(media) {
    try {
      if (Math.abs((media.playbackRate || 1) - CFG.rate) > 0.01) media.playbackRate = CFG.rate;
    } catch (e) { /* 忽略 */ }
  }

  async function handleVideoQuiz() {
    const box = document.querySelector('.ans-videoquiz');
    if (!box || !visible(box)) return false;

    const key = squash(txt(box)).slice(0, 120);
    if (STATE.answeredQuizKeys.has(key)) return false;

    let labels = Array.from(box.querySelectorAll('.ans-videoquiz-opt label'));
    if (!labels.length) {
      labels = Array.from(box.querySelectorAll('.ans-videoquiz-opt li'));
    }
    if (!labels.length) return false;

    const options = labels.map((el, idx) => ({
      el: el, letter: LETTERS[idx] || String(idx + 1), text: txt(el)
    }));

    const titleNode = box.querySelector('.ans-videoquiz-title, .ans-videoquiz-tit, .title');
    const rawTitle = txt(titleNode || box);
    const title = cleanTitle(rawTitle);

    let indices = [];
    if (title && title.length >= 4 && CFG.answerVideoQuiz) {
      const q = { type: options.length === 2 ? guessType(options) : 'single', title: title, options: options };
      const res = await solveQuestion(q);
      if (res.ok) indices = res.indices;
    }
    if (!indices.length) {
      indices = [randInt(options.length)];
      log('视频弹窗题没解出，随机点一个', 'warn');
    }

    for (const i of indices) {
      const opt = options[i];
      if (!opt) continue;
      try { opt.el.click(); } catch (e) { /* 忽略 */ }
      await sleep(150);
    }

    const submit = box.querySelector('#videoquiz-submit')
      || box.querySelector('.ans-videoquiz-btn')
      || box.querySelector('a,button,div[class*="submit"]');
    if (submit) {
      try { submit.click(); } catch (e) { /* 忽略 */ }
    }

    STATE.answeredQuizKeys.add(key);
    log('视频弹窗题已作答：' + indices.map((i) => options[i].letter).join(''), 'ai');

    await waitFor(() => !document.querySelector('.ans-videoquiz'), 6000, 500);
    return true;
  }

  async function runVideo() {
    const media = await waitFor(() => document.querySelector('video, audio'), 30000, 500);
    if (!media) {
      log('没找到视频元素，本节跳过', 'warn');
      return;
    }

    log('开始播放：' + (document.title || '视频'));
    try {
      media.muted = !!CFG.mute;
      media.volume = CFG.mute ? 0 : 0.8;
    } catch (e) { /* 忽略 */ }

    applyRate(media);
    try { await media.play(); } catch (e) { /* 浏览器可能拦截自动播放 */ }

    let lastTime = -1;
    let stuckSince = Date.now();
    let faceWarned = false;

    while (!STATE.stopRequested) {
      await sleep(2000);

      if (media.ended) break;

      if (faceRecognitionActive()) {
        if (!faceWarned) {
          log('检测到人脸识别，已暂停脚本，请手动完成后再继续', 'warn');
          faceWarned = true;
        }
        await waitFor(() => !faceRecognitionActive(), 600000, 2000);
        log('人脸识别结束，继续', 'ok');
        faceWarned = false;
        continue;
      }

      const errBox = document.querySelector('.vjs-modal-dialog-content');
      if (errBox && /网络|损坏|不支持|无法加载|格式/.test(txt(errBox))) {
        log('视频加载失败，本节跳过', 'warn');
        break;
      }

      if (media.paused) {
        try { await media.play(); } catch (e) { /* 忽略 */ }
      }
      applyRate(media);
      try { media.muted = !!CFG.mute; } catch (e) { /* 忽略 */ }

      if (CFG.answerVideoQuiz) await handleVideoQuiz();

      // 无进度看门狗
      if (Math.abs(media.currentTime - lastTime) > 0.5) {
        lastTime = media.currentTime;
        stuckSince = Date.now();
      } else if (!media.paused && Date.now() - stuckSince > 180000) {
        log('视频长时间无进度，本节跳过', 'warn');
        break;
      }
    }

    try { media.pause(); } catch (e) { /* 忽略 */ }
    log('本节视频结束');
  }

  /* ======================================================================
   * 章节测验 / 作业
   * ==================================================================== */
  async function runQuizInPage(questions, label) {
    const secret = document.querySelectorAll('.font-cxsecret').length;
    if (secret) {
      log('注意：这页有 ' + secret + ' 处题面被超星字体混淆（font-cxsecret），模型读到的是乱码，答案不可靠', 'warn');
    }

    if (!questions.length) {
      const qli = document.querySelectorAll('.questionLi').length;
      const tiMu = document.querySelectorAll('.TiMu').length;
      const withName = document.querySelectorAll('.questionLi .mark_name, .TiMu .Zy_TItle').length;
      const withOpts = document.querySelectorAll('.answerBg, .Zy_ulTop li').length;
      const secretNow = document.querySelectorAll('.font-cxsecret').length;
      log(label + '：这一页没抓到题目（questionLi=' + qli + '，TiMu=' + tiMu +
        '，带题干=' + withName + '，带选项=' + withOpts + '，字体混淆=' + secretNow + '）', 'warn');
      return;
    }

    log(label + '：共 ' + questions.length + ' 题');

    for (let i = 0; i < questions.length; i++) {
      if (STATE.stopRequested) return;
      const q = questions[i];
      const tokBefore = tokTotal();
      log('第 ' + (i + 1) + ' 题［' + typeLabel(q.type) + '］' + q.title.slice(0, 36));

      if (q.type === 'completion') {
        const ans = await solveCompletion(q);
        if (ans) {
          const ok = fillBlank(q, ans);
          log('填空：' + ans + (ok ? '' : '（没找到输入框）'), ok ? 'ai' : 'warn');
        } else {
          log('填空题没解出，留空', 'warn');
        }
      } else if (q.type === 'line') {
        log('连线题不支持，跳过', 'warn');
      } else {
        const res = await solveQuestion(q);
        if (res.ok) {
          await applyAnswer(q, res.indices);
          log('选：' + res.indices.map((k) => q.options[k].letter).join(''), 'ai');
        } else if (CFG.unknownStrategy === 'random') {
          const pick = randInt(q.options.length);
          await applyAnswer(q, [pick]);
          log('没解出，随机选：' + (q.options[pick] ? q.options[pick].letter : '?'), 'warn');
        } else {
          log('没解出，留空', 'warn');
        }
      }

      const used = tokTotal() - tokBefore;
      if (used > 0) log('　本题用了 ' + fmtNum(used) + ' tok（累计 ' + fmtNum(tokTotal()) + '）', 'info');

      await sleep(CFG.gapMs);
    }

    log(label + '：这一页答完了', 'ok');
  }

  async function runChapterTest() {
    await decodeCxFont();                 // 题面被字体混淆时先还原，否则模型读到的是乱码
    let questions = extractTimuQuestions();

    // 兜底：有时候判定成「章节测验」，实际题目在 .questionLi 里
    let label = '章节测验';
    if (!questions.length) {
      questions = extractWorkQuestions();
      label = '作业';
    }

    await runQuizInPage(questions, label);

    if (CFG.autoSubmit) await submitQuiz();
    else log('答完了，请检查后自己点提交（设置里可开自动提交）', 'ok');
  }

  function workSig(q) {
    return q.type + '|' + squash(q.title).slice(0, 60);
  }

  // 作业：可能一页多题，也可能一题一页（考试样式）
  async function runWork() {
    const isExam = /exam/i.test(location.pathname + location.search);
    if (isExam) log('这一页看起来是考试：只作答，绝不自动交卷', 'warn');

    await decodeCxFont();                 // 同上：先把混淆字体还原

    const seen = new Set();
    let page = 0;
    let answered = 0;

    while (!STATE.stopRequested && page < 40) {
      const questions = extractWorkQuestions().filter((q) => !seen.has(workSig(q)));
      if (!questions.length) break;
      questions.forEach((q) => seen.add(workSig(q)));
      answered += questions.length;

      await runQuizInPage(questions, page === 0 ? '作业' : '作业 · 第 ' + (page + 1) + ' 页');

      const nextBtn = document.querySelector('[onclick="getTheNextQuestion(1)"]')
        || document.querySelector('#nextQuestion')
        || document.querySelector('a[id*="nextQuestion"]');
      if (!nextBtn || !visible(nextBtn)) break;

      log('还有下一题，继续', 'info');
      try { nextBtn.click(); } catch (e) { break; }
      await sleep(2500);
      page++;
    }

    if (!answered) {
      log('作业：没抓到题目，可能是作答时间已过或页面结构变了', 'warn');
      return;
    }

    if (CFG.autoSubmit && !isExam) await submitQuiz();
    else if (isExam) log('考试页作答完毕，交卷请你自己点', 'ok');
    else log('作业答完了（共 ' + answered + ' 题），请检查后自己点提交', 'ok');
  }

  /* ======================================================================
   * 阅读 / PPT
   * ==================================================================== */
  function finishJobOfPage() {
    const w = pageWin();
    if (typeof w.finishJob === 'function') {
      try { w.finishJob(); return true; } catch (e) { /* 忽略 */ }
    }
    return false;
  }

  // PPT 任务点的完成方式是「翻到最后一页」，不是等时间
  async function runRead() {
    const slides = document.querySelectorAll('.swiper-container .swiper-slide');
    if (slides.length) {
      log('PPT 共 ' + slides.length + ' 页，开始翻页', 'info');

      const hasSwiperNext = typeof pageWin().swiperNext === 'function';
      const nextBtnSel = '.swiper-button-next, .swiper-next, .next-btn';

      for (let i = 0; i < slides.length - 1; i++) {
        if (STATE.stopRequested) return;

        let ok = false;
        if (hasSwiperNext) ok = callPage('swiperNext');
        if (!ok) {
          const btn = document.querySelector(nextBtnSel);
          if (btn) { try { btn.click(); ok = true; } catch (e) { /* 忽略 */ } }
        }
        if (!ok) {
          // 最后一招：直接点下一张幻灯片
          const cur = document.querySelector('.swiper-slide-active');
          const sib = cur && cur.nextElementSibling;
          if (sib) { try { sib.click(); ok = true; } catch (e) { /* 忽略 */ } }
        }

        if (!ok) { log('翻页找不到入口，停止翻页', 'warn'); break; }
        if (i % 5 === 0) log('PPT ' + (i + 2) + '/' + slides.length + ' 页', 'info');
        await sleep(1100);
      }

      log('已翻到最后一页，等 5 秒上报', 'ok');
      await sleep(5000);
      finishJobOfPage();
      await sleep(2000);
      return;
    }

    // 书籍/图片阅读任务
    if (document.querySelector('#img.imglook')) {
      log('图片/书籍阅读任务，直接上报完成', 'info');
      finishJobOfPage();
      await sleep(3000);
      return;
    }

    // 长时阅读（iframe 带 timing 参数）
    const timingFrame = document.querySelector('iframe[name="bookifame"][src*="timing"]');
    if (timingFrame) {
      const m = String(timingFrame.getAttribute('src') || '').match(/timing=(\d+)/);
      const secs = m ? parseInt(m[1], 10) : 60;
      log('长时阅读任务，需要停留约 ' + secs + ' 秒', 'info');
      await sleep(Math.min(secs * 3, 600) * 1000);
      await sleep(4000);
      return;
    }

    log('认不出这是什么阅读任务，等 60 秒', 'warn');
    await sleep(60000);
  }

  /* ======================================================================
   * 任务识别与执行
   * ==================================================================== */
  function hasChildMedia() {
    try {
      return Array.from(document.querySelectorAll('iframe')).some((f) => {
        let d = null;
        try { d = f.contentDocument; } catch (e) { return false; }
        return !!(d && d.querySelector('video, audio'));
      });
    } catch (e) { return false; }
  }

  // 超星换节时不会把上一节的播放器 iframe 拆掉，只是把它藏起来。
  // 不判断这一层，脚本就会在一个看不见的 iframe 里把上一节的视频再播一遍。
  function frameIsVisible() {
    try {
      const fe = window.frameElement;
      if (!fe) return true;                       // 顶层
      if (fe.getClientRects().length === 0) return false;
      const st = getComputedStyle(fe);
      return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
    } catch (e) { return true; }
  }

  function mediaVisible(el) {
    try {
      if (!el || el.getClientRects().length === 0) return false;
      const st = getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden';
    } catch (e) { return true; }
  }

  function detectJob() {
    if (!document.body) return null;
    if (!frameIsVisible()) return null;           // 自己这一帧已经被藏起来了，别动手

    // 只有最内层那一帧才管视频，否则父子帧会抢着播；而且必须真的看得见
    const media = document.querySelector('video, audio');
    if (media && !hasChildMedia() && mediaVisible(media)) return 'video';

    // 作业页里常夹着一个空的 .TiMu，不能见到 .TiMu 就当章节测验：比数量
    const tiMu = document.querySelectorAll('.TiMu').length;
    const qli = document.querySelectorAll('.questionLi').length;
    if (qli > tiMu) return 'work';
    if (tiMu) return 'chapter';
    if (qli) return 'work';

    if (document.querySelector('.swiper-container, #img.imglook')) return 'read';
    return null;
  }

  const JOB_LABEL = { video: '视频', chapter: '章节测验', work: '作业', read: '阅读' };

  async function runJob(job) {
    STATE.running = true;
    STATE.stopRequested = false;
    STATE.job = job;
    STATE.since = Date.now();

    if (job === 'video') await runVideo();
    else if (job === 'chapter') await runChapterTest();
    else if (job === 'work') await runWork();
    else if (job === 'read') await runRead();

    STATE.running = false;
    STATE.job = null;
  }

  /* ======================================================================
   * 顶层：面板、下一节
   * ==================================================================== */
  // 只有真的带左侧目录的学习页才算「学习页」。
  // 作业/测验页也常带 #courseId 这类隐藏字段，不能用它判断，否则作业页会被当成学习页、压根不启动答题。
  function isStudyPage() {
    return !!(document.querySelector('.posCatalog') ||
      document.querySelector('#prevNextFocusNext') ||
      document.querySelector('[onclick^="getTeacherAjax"]'));
  }

  function isWorkPage() {
    return /\/work\//.test(location.pathname) ||
      /workId=/i.test(location.search) ||
      !!document.querySelector('.questionLi');
  }

  // 目录节点：超星是 <div class="posCatalog_select"><a onclick="getTeacherAjax('courseId','clazzId','chapterId')">
  // 「未完成」数在同一节点里的 .jobUnfinishCount 的 value 里
  function catalogNodes() {
    return Array.from(document.querySelectorAll('[onclick^="getTeacherAjax"]'));
  }

  function nodeChapterId(el) {
    const m = (el.getAttribute('onclick') || '').match(/'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'/);
    return m ? String(m[3]) : '';
  }

  function currentChapterId() {
    const el = document.querySelector('#curChapterId');
    return el ? String(el.value || '') : '';
  }

  function unfinishedOf(el) {
    const box = el.parentElement;
    if (!box) return 0;
    const cnt = box.querySelector('.jobUnfinishCount');
    if (!cnt) return 0;
    const n = parseInt(cnt.value || cnt.textContent || '0', 10);
    return isNaN(n) ? 0 : n;
  }

  function isActiveNode(el) {
    if (el.classList && el.classList.contains('posCatalog_active')) return true;
    let p = el.parentElement;
    for (let i = 0; i < 3 && p; i++) {
      if (p.classList && p.classList.contains('posCatalog_active')) return true;
      p = p.parentElement;
    }
    // 兜底：用 #curChapterId 对 chapterId
    const cur = currentChapterId();
    return !!cur && nodeChapterId(el) === cur;
  }

  // 内容区顶部那些「1视频 / 2章节测验」是本节的任务点标签，不是章
  function taskTabs() {
    return Array.from(document.querySelectorAll('.prev_ul li')).filter(visible);
  }

  function activeTaskTabIndex() {
    const tabs = taskTabs();
    return tabs.findIndex((t) => /(^|\s)active(\s|$)/.test(t.className || ''));
  }

  function goNext() {
    // 1) 本节还有没走的任务点（视频 → 章节测验 → …）
    const tabs = taskTabs();
    const ai = activeTaskTabIndex();
    if (ai >= 0 && ai + 1 < tabs.length) {
      try { tabs[ai + 1].click(); return 'taskpoint'; } catch (e) { /* 忽略 */ }
    }

    // 2) 真的「下一节」按钮（超星就挂在 #prevNextFocusNext）
    const nextBtn = document.querySelector('#prevNextFocusNext');
    if (nextBtn && visible(nextBtn)) {
      try {
        nextBtn.click();
        // 有未完成任务点时会弹「当前章节还有任务点未完成，是否去学习」。
        // 这里必须选「下一节」——点「去学习」会跳回没做完的那个视频，
        // 表现就是「下一节失效，又开始播视频」。
        setTimeout(() => {
          const tip = document.querySelector('.jobFinishTip, #jobFinishTip, .popDiv');
          if (!tip || !visible(tip)) return;

          const nextInTip = tip.querySelector('.nextChapter, .jb_btn.nextChapter, a.jb_btn');
          if (nextInTip && visible(nextInTip) && /下一节|下一章/.test(txt(nextInTip))) {
            try { nextInTip.click(); return; } catch (e) { /* 忽略 */ }
          }

          const cands = Array.from(tip.querySelectorAll('a,div,span,button'));
          const byText = cands.find((x) => /^(下一节|下一章|继续下一节)$/.test(txt(x)));
          if (byText) { try { byText.click(); } catch (e) { /* 忽略 */ } }
        }, 1200);
        return 'nextBtn';
      } catch (e) { /* 忽略 */ }
    }

    // 3) 目录里下一个（按 chapterId 定位当前节点）
    const nodes = catalogNodes();
    if (nodes.length) {
      const cur = currentChapterId();
      let idx = nodes.findIndex((n) => cur && nodeChapterId(n) === cur);
      if (idx < 0) idx = nodes.findIndex(isActiveNode);

      let target = null;
      if (idx >= 0) {
        for (let i = idx + 1; i < nodes.length; i++) {
          if (unfinishedOf(nodes[i]) > 0) { target = nodes[i]; break; }
        }
        if (!target) target = nodes[idx + 1] || null;
      } else {
        target = nodes.find((n) => unfinishedOf(n) > 0) || nodes[0];
      }

      // 绝不点自己：点了等于原地重载，视频会从头再播一遍
      if (target && cur && nodeChapterId(target) === cur) target = null;

      if (target) {
        try { target.scrollIntoView({ block: 'center' }); } catch (e) { /* 忽略 */ }
        try { target.click(); return 'catalog'; } catch (e) { /* 忽略 */ }
      }
    }

    return null;
  }

  const PANEL_CSS = `
    :host { all: initial; }
    .wrap {
      position: fixed; right: 16px; bottom: 16px; width: 320px; z-index: 2147483600;
      font: 12px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #e8eaed; background: #1f2126; border: 1px solid #33363d; border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0,0,0,.45); overflow: hidden;
    }
    .hd { display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: #26282e; cursor: default; }
    .hd b { font-size: 12px; font-weight: 600; }
    .st { color: #9aa0a6; }
    .sp { flex: 1; }
    .ver { color: #6b7280; font-size: 10px; }
    .mini { background: transparent; border: 0; color: #9aa0a6; cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 6px; }
    .bd { padding: 8px 10px 10px; }
    .row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
    button {
      font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid #3c3f46;
      background: #2e3138; color: #e8eaed; cursor: pointer;
    }
    button:hover { background: #383b43; }
    button.on { background: #2d5bff; border-color: #2d5bff; color: #fff; }
    label { display: inline-flex; align-items: center; gap: 4px; color: #b7bcc4; }
    input[type="number"] { width: 52px; }
    input[type="text"], input[type="number"] {
      font: inherit; background: #17191d; color: #e8eaed; border: 1px solid #3c3f46;
      border-radius: 5px; padding: 3px 6px;
    }
    select {
      font: inherit; background: #17191d; color: #e8eaed; border: 1px solid #3c3f46;
      border-radius: 5px; padding: 3px 4px; flex: 1; margin-left: 8px; min-width: 0;
    }
    details { margin-top: 6px; border-top: 1px solid #33363d; padding-top: 6px; }
    summary { cursor: pointer; color: #9aa0a6; outline: none; }
    .col { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
    .col label { justify-content: space-between; }
    .col input { flex: 1; margin-left: 8px; min-width: 0; }
    #log {
      margin: 8px 0 0; padding: 6px 8px; height: 132px; overflow: auto;
      background: #15171a; border: 1px solid #2b2e34; border-radius: 6px;
      font: 11px/1.55 Consolas, "Courier New", monospace; white-space: pre-wrap; word-break: break-all;
    }
    #log .warn { color: #f5c451; }
    #log .err { color: #ff7b72; }
    #log .ok { color: #7ee787; }
    #log .ai { color: #79c0ff; }
    #log .t { color: #5f6672; }
    .use {
      margin-top: 6px; font-size: 11px; color: #8b93a1; cursor: pointer;
      user-select: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .use:hover { color: #b7bcc4; }
  `;

  function mountPanel() {
    if (document.getElementById('cx-local-ai-host')) return;

    const host = document.createElement('div');
    host.id = 'cx-local-ai-host';
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483600;';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = `
      <div class="hd">
        <b>本地模型刷课</b><span class="ver">v1.6.8</span><span class="st" id="st">待机</span><span class="sp"></span>
        <button class="mini" id="fold">－</button>
      </div>
      <div class="bd" id="bd">
        <div class="row">
          <button id="btnRun">开始</button>
          <button id="btnStop">停止</button>
          <button id="btnTest">自检模型</button>
          <button id="btnDiag">诊断</button>
          <button id="btnDump">导出字体/题目</button>
        </div>
        <div class="row">
          <label>倍速 <input id="inRate" type="number" step="0.25" min="1" max="4"></label>
          <label><input id="inMute" type="checkbox"> 静音</label>
          <label><input id="inNext" type="checkbox"> 自动下一节</label>
        </div>
        <div class="row">
          <label><input id="inVideo" type="checkbox"> 视频弹窗题</label>
          <label><input id="inChapter" type="checkbox"> 章节测验</label>
          <label><input id="inWork" type="checkbox"> 作业</label>
          <label><input id="inSubmit" type="checkbox"> 自动提交</label>
        </div>
        <details>
          <summary>模型设置</summary>
          <div class="col">
            <label>服务<select id="inProvider"></select></label>
            <label>接口<input id="inEp" type="text"></label>
            <label>模型<input id="inModel" type="text"></label>
            <label>Key<input id="inKey" type="text" placeholder="本地可留空"></label>
          </div>
        </details>
        <pre id="log"></pre>
        <div class="use" id="use"></div>
      </div>`;
    shadow.appendChild(wrap);

    const $ = (sel) => shadow.querySelector(sel);
    const st = $('#st');

    const ui = {
      renderLog() {
        const box = $('#log');
        if (!box) return;
        const items = LOGS.slice(-60);
        box.innerHTML = items.map((it) => {
          const cls = it.lv === 'info' ? '' : it.lv;
          return '<div class="' + cls + '"><span class="t">' + it.t + '</span> ' +
            it.m.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) + '</div>';
        }).join('');
        box.scrollTop = box.scrollHeight;
      },
      renderUsage() {
        const box = $('#use');
        if (!box) return;
        box.textContent = usageLine();
        box.title = '提示 ' + fmtNum(TOK.prompt) + ' tok / 生成 ' + fmtNum(TOK.completion) +
          ' tok / ' + TOK.calls + ' 次请求（点两下清零）';
      },
      setStatus(text) { st.textContent = text; }
    };

    // 回填配置
    $('#inRate').value = CFG.rate;
    $('#inMute').checked = !!CFG.mute;
    $('#inNext').checked = !!CFG.autoNext;
    $('#inVideo').checked = !!CFG.answerVideoQuiz;
    $('#inChapter').checked = !!CFG.answerChapterTest;
    $('#inWork').checked = !!CFG.answerWork;
    $('#inSubmit').checked = !!CFG.autoSubmit;
    $('#inProvider').innerHTML = PROVIDERS.map((p) =>
      '<option value="' + p.id + '">' + p.name + '</option>').join('');
    $('#inProvider').value = CFG.provider || 'ollama';
    $('#inEp').value = CFG.endpoint;
    $('#inModel').value = CFG.model;
    $('#inKey').value = CFG.apiKey || '';

    // 绑定
    $('#inRate').addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      CFG.rate = isNaN(v) ? 2 : Math.min(4, Math.max(1, v));
      saveCfg();
    });
    $('#inMute').addEventListener('change', (e) => { CFG.mute = e.target.checked; saveCfg(); });
    $('#inNext').addEventListener('change', (e) => { CFG.autoNext = e.target.checked; saveCfg(); });
    $('#inVideo').addEventListener('change', (e) => { CFG.answerVideoQuiz = e.target.checked; saveCfg(); });
    $('#inChapter').addEventListener('change', (e) => { CFG.answerChapterTest = e.target.checked; saveCfg(); });
    $('#inWork').addEventListener('change', (e) => { CFG.answerWork = e.target.checked; saveCfg(); });
    $('#inSubmit').addEventListener('change', (e) => { CFG.autoSubmit = e.target.checked; saveCfg(); });
    $('#inEp').addEventListener('change', (e) => { CFG.endpoint = e.target.value.trim(); saveCfg(); });
    $('#inModel').addEventListener('change', (e) => { CFG.model = e.target.value.trim(); saveCfg(); });
    $('#inKey').addEventListener('change', (e) => {
      CFG.apiKey = e.target.value.trim();
      CFG.keys = CFG.keys || {};
      CFG.keys[CFG.provider || 'ollama'] = CFG.apiKey;   // 每个接口的 key 分开存
      saveCfg();
    });
    $('#inProvider').addEventListener('change', (e) => {
      const p = getProvider(e.target.value);
      CFG.keys = CFG.keys || {};
      CFG.provider = p.id;
      if (p.endpoint) CFG.endpoint = p.endpoint;
      if (p.model) CFG.model = p.model;
      CFG.apiKey = CFG.keys[p.id] || '';
      saveCfg();
      $('#inEp').value = CFG.endpoint;
      $('#inModel').value = CFG.model;
      $('#inKey').value = CFG.apiKey;
      log('接口切到 ' + p.name + '：' + (CFG.model || '（模型名自己填）'), 'ok');
    });

    $('#fold').addEventListener('click', () => {
      const bd = $('#bd');
      const hidden = bd.style.display === 'none';
      bd.style.display = hidden ? '' : 'none';
      $('#fold').textContent = hidden ? '－' : '＋';
    });

    $('#btnRun').addEventListener('click', () => startRun());
    $('#btnStop').addEventListener('click', () => {
      stopAll();
      releaseRunning();
      post('stop', null);
      ui.setStatus('已停止');
      log('已停止', 'warn');
    });
    $('#btnTest').addEventListener('click', () => selfTest());
    $('#btnDiag').addEventListener('click', () => diagnose());
    $('#btnDump').addEventListener('click', () => dumpForDebug());

    // 用量那行点两下清零
    $('#use').addEventListener('click', () => {
      const now = Date.now();
      if (now - (ui.lastUseClick || 0) < 700) {
        resetTokens();
        ui.lastUseClick = 0;
        log('token 用量已清零', 'ok');
      } else {
        ui.lastUseClick = now;
        log('再点一下「用量」这行就清零', 'info');
      }
    });

    UI = ui;
    ui.renderLog();
    ui.renderUsage();
    document.documentElement.appendChild(host);
  }

  async function selfTest() {
    const p = getProvider(CFG.provider);
    log('自检：' + p.name + ' / ' + CFG.model + ' 发一道样题…');
    UI && UI.setStatus('自检中');
    const q = {
      type: 'single',
      title: '下列哪一项属于操作系统？',
      options: [
        { letter: 'A', text: 'Word' },
        { letter: 'B', text: 'Linux' },
        { letter: 'C', text: 'Photoshop' },
        { letter: 'D', text: 'Chrome' }
      ]
    };
    try {
      const t0 = Date.now();
      const res = await solveQuestion(q);
      const ms = Date.now() - t0;
      if (res.ok) {
        const used = res.tokens
          ? (res.tokens.total_tokens || ((res.tokens.prompt_tokens || 0) + (res.tokens.completion_tokens || 0)))
          : 0;
        log('自检通过：选了 ' + res.indices.map((i) => q.options[i].letter).join('') +
          '（' + (ms / 1000).toFixed(1) + 's' + (used ? '，' + used + ' tok' : '') + '）', 'ok');
        UI && UI.setStatus('自检通过');
      } else {
        log('自检失败：模型有回应但没解析出答案 → ' + String(res.raw || '').slice(0, 80), 'err');
        UI && UI.setStatus('自检失败');
      }
    } catch (e) {
      log('自检失败：' + e.message, 'err');
      UI && UI.setStatus('自检失败');
    }
  }

  // 诊断：把这一页真实的结构打出来，哪一环不灵可以直接看
  function downloadBlob(name, blob) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
  }

  // 把这一页的混淆字体和题目结构导出来，用来排查「模型读不到题」
  function dumpForDebug() {
    log('—— 导出调试文件 ——', 'info');

    const src = findSecretFontSrc();
    if (src) {
      const b64 = (src.match(/base64,([^"')]+)/) || [])[1];
      if (b64) {
        try {
          const bin = atob(b64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          downloadBlob('cxsecret-' + Date.now() + '.ttf', new Blob([arr], { type: 'font/ttf' }));
          log('已导出混淆字体（' + Math.round(arr.length / 1024) + ' KB）', 'ok');
        } catch (e) {
          log('字体导出失败：' + e.message, 'err');
        }
      }
    } else {
      log('这页没找到混淆字体（可能没有混淆，或已被处理）', 'warn');
    }

    let qs = [];
    try { qs = extractTimuQuestions().concat(extractWorkQuestions()); } catch (e) { /* 忽略 */ }
    const roots = Array.from(document.querySelectorAll('.TiMu, .questionLi')).slice(0, 2);

    const payload = {
      url: location.href,
      time: new Date().toISOString(),
      secretNodes: document.querySelectorAll('.font-cxsecret').length,
      fontSrcHead: src ? src.slice(0, 100) : null,
      questions: qs.map((q) => ({
        type: q.type,
        title: q.title,
        options: q.options.map((o) => o.text)
      })),
      html: roots.map((r) => r.outerHTML.slice(0, 4000))
    };

    downloadBlob('cx-questions-' + Date.now() + '.json',
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    log('已导出题目结构，共 ' + qs.length + ' 题，两个文件都在下载目录', 'ok');
  }

  function diagnose() {
    log('—— 页面诊断 ——', 'info');
    log('URL ' + location.href.replace(/\?.*$/, '').slice(0, 90));
    log(usageLine(), 'info');
    log('接口 ' + getProvider(CFG.provider).name + ' / ' + CFG.model +
      ' / key=' + (CFG.apiKey ? '已填' : '空'), 'info');

    const nodes = catalogNodes();
    log('目录节点 ' + nodes.length + ' 个');
    nodes.slice(0, 10).forEach((el, i) => {
      log('  [' + i + '] ' + txt(el).slice(0, 14) +
        ' 未完成=' + unfinishedOf(el) +
        ' active=' + (isActiveNode(el) ? '是' : '否'));
    });

    const tabs = document.querySelectorAll('#prev_tab .prev_ul li, .prev_ul li');
    const activeTab = Array.from(tabs).findIndex((t) => t.classList.contains('active'));
    log('章标签 ' + tabs.length + ' 个，当前第 ' + (activeTab + 1) + ' 个');

    for (const sel of SUBMIT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) log('提交选择器命中 ' + sel + ' / 文字=' + txt(el).slice(0, 8), 'ok');
    }

    const w = pageWin();
    log('页面接口 btnBlueSubmit=' + (typeof w.btnBlueSubmit) +
      ' noSubmit=' + (typeof w.noSubmit) +
      ' swiperNext=' + (typeof w.swiperNext) +
      ' finishJob=' + (typeof w.finishJob));

    log('swiper 页数 ' + document.querySelectorAll('.swiper-container .swiper-slide').length +
      '，TiMu ' + document.querySelectorAll('.TiMu').length +
      '，questionLi ' + document.querySelectorAll('.questionLi').length +
      '，字体混淆 ' + document.querySelectorAll('.font-cxsecret').length +
      '，任务点标签 ' + taskTabs().map((t) => txt(t).slice(0, 6)).join('/'));

    const btns = Array.from(document.querySelectorAll('a,button,input[type="submit"]')).filter(visible).slice(0, 24);
    log('可见按钮 ' + btns.map((b) =>
      ((b.value || txt(b) || '').slice(0, 8) || b.tagName) + '#' + (b.id || String(b.className).slice(0, 18) || '')
    ).join(' | ').slice(0, 520));
  }

  function startRun() {
    STATE.stopRequested = false;
    claimRunning();
    UI && UI.setStatus('运行中');
    log('开始运行', 'ok');

    // 顶层自己就是任务页（章节测验独立页/作业页）；学习页的任务都在 iframe 里
    const job = isStudyPage() ? null : detectJob();
    if (job) {
      log('本页任务：' + (JOB_LABEL[job] || job));
      runJob(job).then(() => afterJobDone());
      return;
    }

    // 不是学习页 → 作业/测验页，题目可能还在加载，等它出来（最多 60 秒）
    if (!isStudyPage()) {
      let tries = 0;
      const timer = setInterval(() => {
        const j = detectJob();
        if (j) {
          clearInterval(timer);
          log('本页任务：' + (JOB_LABEL[j] || j));
          runJob(j).then(() => afterJobDone());
          return;
        }
        tries++;
        if (tries % 15 === 0) {
          log('还在等题目加载（' + tries + ' 秒）：questionLi=' + document.querySelectorAll('.questionLi').length +
            '，TiMu=' + document.querySelectorAll('.TiMu').length, 'info');
        }
        if (tries > 60) {
          clearInterval(timer);
          log('等了 60 秒没找到题目，停止。把「诊断」那行发我', 'warn');
          UI && UI.setStatus('没找到题目');
          releaseRunning();
        }
      }, 1000);
      return;
    }
    if (!isStudyPage()) {
      log('这页看起来不是课程学习页或答题页', 'warn');
      UI && UI.setStatus('页面不对');
      return;
    }
    // 当前节的任务由各 iframe 自己接手，这里只留一个兜底提示
    setTimeout(function () {
      if (isRunning() && !STATE.job) {
        log('15 秒内还没接到任务：如果停在目录页，手动点一个小节即可', 'warn');
      }
    }, 15000);
  }

  async function afterJobDone() {
    // 多个框架可能重复上报，5 秒内只处理一次
    const now = Date.now();
    if (now - (STATE.lastDoneAt || 0) < 5000) return;
    STATE.lastDoneAt = now;

    if (!isStudyPage()) {
      UI && UI.setStatus(CFG.autoSubmit ? '已提交' : '已答完');
      releaseRunning();
      return;
    }

    log('本节完成，3 秒后前往下一节', 'ok');
    await sleep(3000);

    if (!isRunning()) return;

    if (!CFG.autoNext) {
      log('自动下一节已关闭，停在这里', 'warn');
      UI && UI.setStatus('已完成本节');
      releaseRunning();
      return;
    }

    const sigBefore = currentChapterId() + '|' + activeTaskTabIndex();

    let moved = null;
    for (let i = 0; i < 3 && !moved; i++) {
      moved = goNext();
      if (!moved) await sleep(1500);
    }

    if (!moved) {
      log('找不到下一节，已停止', 'warn');
      UI && UI.setStatus('没有下一节');
      releaseRunning();
      return;
    }

    const movedLabel = { taskpoint: '下一个任务点', nextBtn: '下一节按钮', catalog: '目录节点', tab: '章标签' }[moved] || moved;
    log('已跳转（' + movedLabel + '）', 'ok');

    // 跳完确认一下真的换节了：没换说明按钮/弹窗没点对，早一点报出来
    setTimeout(() => {
      const sigAfter = currentChapterId() + '|' + activeTaskTabIndex();
      if (sigAfter === sigBefore) {
        log('跳转没生效（章节和任务点都没变），等下一轮重试；如果反复出现，把「诊断」那行发我', 'warn');
      }
    }, 4000);

    watchNextJob();
  }

  let watchTimer = null;

  function watchNextJob() {
    clearTimeout(watchTimer);
    const t0 = Date.now();
    const tick = () => {
      if (!isRunning()) return;
      if (STATE.job) return; // 子框架已经报上来了

      if (Date.now() - t0 > 25000) {
        STATE.emptyJumps = (STATE.emptyJumps || 0) + 1;
        if (STATE.emptyJumps > 6) {
          log('连续多节都没任务点，停止（可能已到课程末尾）', 'warn');
          releaseRunning();
          UI && UI.setStatus('结束');
          return;
        }
        log('25 秒内没检测到任务，再跳一节', 'warn');
        const moved = goNext();
        if (!moved) {
          log('没有下一节了，停止', 'warn');
          releaseRunning();
          UI && UI.setStatus('结束');
          return;
        }
        watchNextJob();
        return;
      }
      watchTimer = setTimeout(tick, 2000);
    };
    watchTimer = setTimeout(tick, 2000);
  }

  /* ======================================================================
   * 顶层初始化
   * ==================================================================== */
  function initTop() {
    // 只在看起来有用的页面挂面板，别到处乱弹。
    // 注意：作业页的题目是异步渲染的，这时候 detectJob() 还是空的，所以必须用 isWorkPage() 兜住，
    // 否则作业页上连面板都不会出现（这就是「作业功能失效」的直接原因）。
    const onChaoxing = /(^|\.)chaoxing\.com$/.test(location.hostname);
    if (!onChaoxing && !isStudyPage() && !detectJob() && !isWorkPage()) return;

    mountPanel();
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d[MSG] !== true) return;

      if (d.type === 'log' && d.data) {
        LOGS.push(d.data);
        if (LOGS.length > 200) LOGS.shift();
        if (UI) UI.renderLog();
        return;
      }

      if (d.type === 'job-start') {
        STATE.job = (d.data && d.data.job) || 'unknown';
        STATE.since = Date.now();
        STATE.emptyJumps = 0;
        UI && UI.setStatus('运行中 · ' + (JOB_LABEL[STATE.job] || STATE.job));
        return;
      }

      if (d.type === 'job-done') {
        STATE.job = null;
        afterJobDone();
      }
    });

    // 别的标签页已经点了开始（学习页在跑），这个作业/答题页就自己接手
    if (isRunning() && !isStudyPage()) {
      const job = detectJob();
      if (job === 'work' || job === 'chapter') {
        log('检测到正在运行，自动接手本页的' + (JOB_LABEL[job] || job));
        setTimeout(startRun, 1200);
        return;
      }
    }

    // 单独打开的作业/测验页：不用点开始，直接接手（考试页只作答、不交卷）
    if (!isStudyPage() && isWorkPage()) {
      log('这是作业/测验页，2 秒后自动开始', 'info');
      setTimeout(() => {
        if (!STATE.running) startRun();
      }, 2000);
    }
  }

  /* ======================================================================
   * 子框架初始化
   * ==================================================================== */
  async function initFrame() {
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d && d[MSG] === true && d.type === 'stop') stopAll();
    });

    // 等顶层按下开始；最长等 10 分钟
    await waitFor(() => isRunning(), 600000, 1500);

    // 任务点是切标签/翻页动态加载的，不能只找一次
    let ranKey = '';
    const doneKeys = new Set();   // 同一个（章节 + 任务点 + 类型）只做一次

    while (true) {
      await sleep(1200);

      if (!isRunning()) continue;
      if (STATE.running) continue;              // 当前正在做别的任务

      const job = detectJob();
      if (!job) continue;

      // 章节 id 一起进 key：换节之后哪怕旧 iframe 还在，也不会再被当成新任务
      let chapter = '';
      try { chapter = top.document.querySelector('#curChapterId') ? top.document.querySelector('#curChapterId').value : ''; } catch (e) { /* 跨域就算了 */ }

      const key = job + '|' + chapter + '|' + (location.href || '') + '|' + document.body.children.length;
      if (key === ranKey || doneKeys.has(key)) continue;
      ranKey = key;

      if (job === 'chapter' && !CFG.answerChapterTest) {
        log('章节测验自动答题已关闭，跳过', 'warn');
        continue;
      }
      if (job === 'work' && !CFG.answerWork) {
        log('作业自动答题已关闭，跳过', 'warn');
        continue;
      }

      post('job-start', { job: job, title: document.title });
      log('接手任务：' + (JOB_LABEL[job] || job));

      try {
        await runJob(job);
      } catch (e) {
        log('任务出错：' + e.message, 'err');
      }
      doneKeys.add(key);

      post('job-done', { job: job });
      await sleep(2000);
    }
  }

  /* ======================================================================
   * 启动
   * ==================================================================== */
  function boot() {
    if (!document.body) {
      setTimeout(boot, 300);
      return;
    }
    if (IS_TOP) initTop();
    else initFrame();
  }

  // 调试用：控制台里 __CXLA__ 可以直接调解析函数
  try {
    window.__CXLA__ = {
      cfg: CFG,
      parse: mapToOptions,
      cleanTitle: cleanTitle,
      extractJson: extractJson,
      extractAnswerItems: extractAnswerItems,
      mapTypeValue: mapTypeValue,
      goNext: goNext,
      submit: submitQuiz,
      diagnose: diagnose,
      runRead: runRead,
      decodeFont: decodeCxFont,
      detectJob: detectJob,
      frameIsVisible: frameIsVisible,
      mediaVisible: mediaVisible,
      tokens: TOK,
      usageLine: usageLine
    };
  } catch (e) { /* 忽略 */ }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      try { boot(); } catch (e) { console.error('[CX-LAI] 启动失败', e); }
    }, { once: true });
  } else {
    try { boot(); } catch (e) { console.error('[CX-LAI] 启动失败', e); }
  }
})();
