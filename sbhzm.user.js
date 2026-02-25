// ==UserScript==
// @name         灰泽满烂梗搜索面板
// @namespace    https://github.com/QianQiuZy/sbhzm_Tampermonkey
// @version      1.0.0
// @description  在B站直播间弹幕输入框上方增加烂梗搜索（关键词/Tag/随机切换），点击结果一键复制；支持拖拽定位与随机再来一条
// @match        https://live.bilibili.com/1713546334*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @icon         https://sbhzm.cn/favicon.png
// @connect      sbhzm.cn
// ==/UserScript==

(function () {
  "use strict";

  const ROOM_URL_PREFIX = "https://live.bilibili.com/1713546334";
  if (!location.href.startsWith(ROOM_URL_PREFIX)) return;

  // -------------------------
  // Config
  // -------------------------
  const API_BASE = "https://sbhzm.cn/api/public";
  const SORT = "latest";
  const PAGE_SIZE = 20;
  const DEBOUNCE_MS = 300;

  const LS_KEY_DX = "hzm_meme_panel_dx";
  const LS_KEY_DY = "hzm_meme_panel_dy";

  // -------------------------
  // Utils
  // -------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function gmGetJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        headers: { Accept: "application/json" },
        onload: (resp) => {
          try {
            if (resp.status < 200 || resp.status >= 300) {
              reject(new Error(`HTTP ${resp.status}: ${resp.responseText?.slice?.(0, 200) ?? ""}`));
              return;
            }
            resolve(JSON.parse(resp.responseText));
          } catch (e) {
            reject(e);
          }
        },
        onerror: (e) => reject(e),
      });
    });
  }

  function debounce(fn, delay) {
    let t = null;
    return (...args) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn(...args), delay);
    };
  }

  function formatTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById("hzm-meme-toast");
    if (!el) return;
    el.textContent = msg;
    el.style.opacity = "1";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.style.opacity = "0"), 1200);
  }

  async function copyText(text) {
    try {
      GM_setClipboard(text, "text");
      toast("已复制 ✅");
      return;
    } catch (_) {}
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制 ✅");
    } catch (_) {
      toast("复制失败 ❌（浏览器限制）");
    }
  }

    function findDanmuInputEl() {
        // 以你已确认的容器为锚点
        const box = document.querySelector(".chat-input.border-box");
        if (box) {
            const el =
                  box.querySelector("textarea") ||
                  box.querySelector('input[type="text"]') ||
                  box.querySelector('[contenteditable="true"]');
            if (el) return el;
        }

        // 兜底：避免B站改版导致锚点失效
        return (
            document.querySelector(".chat-input.border-box textarea") ||
            document.querySelector('textarea[placeholder*="弹幕"]') ||
            document.querySelector('[contenteditable="true"][data-placeholder*="弹幕"]') ||
            document.querySelector('[contenteditable="true"]')
        );
    }

    function setDanmuText(text) {
        const el = findDanmuInputEl();
        if (!el) {
            toast("未找到弹幕输入框 ❌");
            return false;
        }

        // textarea / input
        if ("value" in el) {
            el.focus();
            el.value = text;

            // 触发框架监听（React/Vue通常靠input事件）
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));

            // 光标置尾
            try {
                el.setSelectionRange(text.length, text.length);
            } catch (_) {}
            return true;
        }

  // contenteditable
  if (el.isContentEditable) {
    el.focus();
    el.textContent = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));

    // 光标置尾
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
    return true;
  }

  toast("输入框类型不支持 ❌");
  return false;
}

  function clamp(n, min, max) {
    return Math.min(Math.max(n, min), max);
  }

  function loadOffset() {
    const dx = parseInt(localStorage.getItem(LS_KEY_DX) || "0", 10);
    const dy = parseInt(localStorage.getItem(LS_KEY_DY) || "0", 10);
    return { dx: Number.isFinite(dx) ? dx : 0, dy: Number.isFinite(dy) ? dy : 0 };
  }

  function saveOffset(dx, dy) {
    localStorage.setItem(LS_KEY_DX, String(dx));
    localStorage.setItem(LS_KEY_DY, String(dy));
  }

  // -------------------------
  // Styles
  // -------------------------
  GM_addStyle(`
    .hzm-meme-panel {
      position: fixed;
      z-index: 2147483647;
      box-sizing: border-box;

      padding: 10px;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 10px;
      background: rgba(0,0,0,0.35);
      backdrop-filter: blur(6px);
      color: rgba(255,255,255,0.92);
      font-size: 12px;
      box-shadow: 0 6px 20px rgba(0,0,0,0.25);

      pointer-events: auto;
    }

    .hzm-meme-dragbar {
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:8px;

      margin: -6px -6px 8px -6px;
      padding: 6px 8px;
      border-radius: 8px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.10);
      cursor: move;
      user-select: none;
    }
    .hzm-meme-dragbar .title { font-weight: 600; color: rgba(255,255,255,0.95); }
    .hzm-meme-dragbar .hint { opacity: 0.75; font-size: 12px; }
    .hzm-meme-dragbar button {
      height: 26px;
      padding: 0 10px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.16);
      background: rgba(255,255,255,0.10);
      color: #fff;
      cursor: pointer;
    }
    .hzm-meme-dragbar button:hover { background: rgba(255,255,255,0.16); }

    .hzm-meme-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .hzm-meme-row + .hzm-meme-row { margin-top:8px; }

    .hzm-meme-seg { display:inline-flex; border:1px solid rgba(255,255,255,0.16); border-radius:8px; overflow:hidden; }
    .hzm-meme-seg button { border:0; padding:6px 10px; background:transparent; color:rgba(255,255,255,0.85); cursor:pointer; }
    .hzm-meme-seg button.active { background:rgba(255,255,255,0.14); color:#fff; }

    .hzm-meme-input, .hzm-meme-select {
      height:30px; padding:0 10px; border-radius:8px;
      border:1px solid rgba(255,255,255,0.16);
      background:rgba(0,0,0,0.25); color:rgba(255,255,255,0.92);
      outline:none;
    }
    .hzm-meme-input { min-width:240px; flex:1; }
    .hzm-meme-select { min-width:180px; }

    .hzm-meme-btn {
      height:30px; padding:0 12px; border-radius:8px;
      border:1px solid rgba(255,255,255,0.16);
      background:rgba(255,255,255,0.10); color:#fff; cursor:pointer;
    }
    .hzm-meme-btn:hover { background:rgba(255,255,255,0.16); }

    .hzm-meme-meta { opacity:0.85; font-size:12px; }

    .hzm-meme-results {
      margin-top:10px;
      max-height:260px;
      overflow:auto;
      border-top:1px dashed rgba(255,255,255,0.14);
      padding-top:8px;
    }

    .hzm-meme-item { padding:8px 8px; border-radius:8px; cursor:pointer; }
    .hzm-meme-item:hover { background:rgba(255,255,255,0.08); }
    .hzm-meme-item .content { white-space:pre-wrap; word-break:break-word; line-height:1.45; font-size:13px; color:rgba(255,255,255,0.95); }
    .hzm-meme-item .sub { margin-top:4px; display:flex; gap:10px; flex-wrap:wrap; opacity:0.75; font-size:12px; }
    .hzm-meme-tag {
      padding:1px 6px; border-radius:999px;
      border:1px solid rgba(255,255,255,0.16);
      background:rgba(0,0,0,0.18);
    }

    .hzm-meme-footer { margin-top:10px; display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }

    #hzm-meme-toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483647;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(0,0,0,0.75);
      border: 1px solid rgba(255,255,255,0.16);
      color: #fff;
      opacity: 0;
      transition: opacity 180ms ease;
      pointer-events: none;
      font-size: 12px;
      max-width: 280px;
      word-break: break-word;
    }
  `);

  // -------------------------
  // State
  // -------------------------
  const state = {
    mode: "keyword", // keyword | tag | random
    keyword: "",
    tagId: "",
    page: 1,
    total: 0,
    items: [],
    tags: [],
    loading: false,
    lastError: "",

    // random
    allTotal: 0,
    allTotalFetchedAt: 0, // ms
  };

  // -------------------------
  // UI
  // -------------------------
  function buildPanel() {
    const panel = document.createElement("div");
    panel.className = "hzm-meme-panel";
    panel.id = "hzm-meme-panel";
    panel.innerHTML = `
      <div class="hzm-meme-dragbar" id="hzm-meme-dragbar">
        <div>
          <span class="title">烂梗搜索</span>
          <span class="hint">（拖拽调整位置）</span>
        </div>
        <div class="hzm-meme-row" style="gap:6px;">
          <button type="button" id="hzm-meme-resetpos">重置位置</button>
        </div>
      </div>

      <div class="hzm-meme-row">
        <div class="hzm-meme-seg">
          <button type="button" data-mode="keyword" class="active">关键词搜索</button>
          <button type="button" data-mode="tag">Tag搜索</button>
          <button type="button" data-mode="random">随机一条</button>
        </div>
      </div>

      <div class="hzm-meme-row" id="hzm-meme-row-keyword">
        <input class="hzm-meme-input" id="hzm-meme-keyword" placeholder="输入关键词（自动搜索 / 回车搜索）" />
        <button type="button" class="hzm-meme-btn" id="hzm-meme-search-btn">搜索</button>
      </div>

      <div class="hzm-meme-row" id="hzm-meme-row-tag" style="display:none;">
        <select class="hzm-meme-select" id="hzm-meme-tag-select">
          <option value="">加载中...</option>
        </select>
        <button type="button" class="hzm-meme-btn" id="hzm-meme-search-btn-tag">按Tag搜索</button>
      </div>

      <div class="hzm-meme-row" id="hzm-meme-row-random" style="display:none;">
        <button type="button" class="hzm-meme-btn" id="hzm-meme-random-again">再来一条</button>
      </div>

      <div class="hzm-meme-row">
        <div class="hzm-meme-meta" id="hzm-meme-status">就绪</div>
      </div>

      <div class="hzm-meme-results" id="hzm-meme-results"></div>

      <div class="hzm-meme-footer">
        <div class="hzm-meme-meta" id="hzm-meme-pageinfo">第 1 页</div>
        <div class="hzm-meme-row" style="gap:6px;">
          <button type="button" class="hzm-meme-btn" id="hzm-meme-prev">上一页</button>
          <button type="button" class="hzm-meme-btn" id="hzm-meme-next">下一页</button>
        </div>
      </div>
    `;
    return panel;
  }

  function render(panel) {
    const statusEl = panel.querySelector("#hzm-meme-status");
    const resultsEl = panel.querySelector("#hzm-meme-results");
    const pageInfoEl = panel.querySelector("#hzm-meme-pageinfo");
    const prevBtn = panel.querySelector("#hzm-meme-prev");
    const nextBtn = panel.querySelector("#hzm-meme-next");

    if (state.loading) statusEl.textContent = "请求中...";
    else if (state.lastError) statusEl.textContent = `错误：${state.lastError}`;
    else {
      if (state.mode === "random") statusEl.textContent = `随机模式 | total=${state.allTotal || state.total || 0}`;
      else statusEl.textContent = `总数 ${state.total} | 当前页 ${state.page} | 条数 ${state.items.length} | page_size=${PAGE_SIZE}`;
    }

    if (state.mode === "random") {
      pageInfoEl.textContent = `随机模式（每次随机从 total 中抽取）`;
      prevBtn.disabled = true;
      nextBtn.disabled = true;
    } else {
      pageInfoEl.textContent = `第 ${state.page} 页（每页 ${PAGE_SIZE}） 总计 ${state.total}`;
      prevBtn.disabled = state.loading || state.page <= 1;
      const maxPage = state.total ? Math.ceil(state.total / PAGE_SIZE) : 1;
      nextBtn.disabled = state.loading || state.page >= maxPage;
    }

    resultsEl.innerHTML = "";
    if (!state.items || state.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hzm-meme-meta";
      empty.style.padding = "10px 4px";
      empty.textContent = state.loading ? "加载中..." : "暂无结果";
      resultsEl.appendChild(empty);
      return;
    }

    for (const it of state.items) {
      const div = document.createElement("div");
      div.className = "hzm-meme-item";
      div.innerHTML = `
        <div class="content"></div>
        <div class="sub">
          <span>id:${it.id ?? "-"}</span>
          <span>复制:${it.copy_count ?? 0}</span>
          <span>${formatTime(it.created_at)}</span>
          <span class="tags"></span>
        </div>
      `;
      div.querySelector(".content").textContent = it.content ?? "";
      const tagsEl = div.querySelector(".tags");
      const tags = Array.isArray(it.tags) ? it.tags : [];
      for (const t of tags) {
        const s = document.createElement("span");
        s.className = "hzm-meme-tag";
        s.textContent = t?.name ?? "";
        tagsEl.appendChild(s);
      }
        div.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const text = it.content ?? "";
            if (!text) return;

            // 先写入弹幕输入框（你的进阶需求）
            const ok = setDanmuText(text);
            if (ok) toast("已写入弹幕输入框 ✍️");

            // 仍保留复制（如果你想取消复制，我也可以改成可配置）
            await copyText(text);
        });
      resultsEl.appendChild(div);
    }
  }

  // -------------------------
  // API
  // -------------------------
  function buildMemesUrl() {
    const p = new URLSearchParams();
    p.set("sort", SORT);
    p.set("page", String(state.page));
    p.set("page_size", String(PAGE_SIZE));
    if (state.mode === "keyword") p.set("search", state.keyword || "");
    else if (state.mode === "tag" && state.tagId) p.set("tag_ids", String(state.tagId));
    return `${API_BASE}/memes?${p.toString()}`;
  }

  async function fetchMemes(panel) {
    state.loading = true;
    state.lastError = "";
    render(panel);
    try {
      const data = await gmGetJson(buildMemesUrl());
      state.items = Array.isArray(data?.items) ? data.items : [];
      state.total = typeof data?.total === "number" ? data.total : 0;
      state.page = typeof data?.page === "number" ? data.page : state.page;
    } catch (e) {
      state.lastError = e?.message ? e.message : String(e);
      state.items = [];
      state.total = 0;
    } finally {
      state.loading = false;
      render(panel);
      updatePanelPositionRaf();
    }
  }

  async function fetchTags(panel) {
    const select = panel.querySelector("#hzm-meme-tag-select");
    select.innerHTML = `<option value="">加载中...</option>`;
    try {
      const data = await gmGetJson(`${API_BASE}/tags`);
      let tags = [];
      if (Array.isArray(data)) tags = data;
      else if (Array.isArray(data?.items)) tags = data.items;
      else if (Array.isArray(data?.tags)) tags = data.tags;

      state.tags = tags
        .map((t) => ({ id: t?.id, name: t?.name }))
        .filter((t) => t.id != null && t.name);

      select.innerHTML = `<option value="">请选择Tag</option>`;
      for (const t of state.tags) {
        const opt = document.createElement("option");
        opt.value = String(t.id);
        opt.textContent = `${t.name} (#${t.id})`;
        select.appendChild(opt);
      }
      if (state.tagId) select.value = String(state.tagId);
    } catch (e) {
      select.innerHTML = `<option value="">Tag加载失败</option>`;
      state.lastError = e?.message ? e.message : String(e);
      render(panel);
    }
  }

  // ---- random one ----
  async function ensureAllTotal() {
    // 5分钟内复用 total，减少请求
    const now = Date.now();
    if (state.allTotal > 0 && now - state.allTotalFetchedAt < 5 * 60 * 1000) return state.allTotal;

    const url = `${API_BASE}/memes?sort=${encodeURIComponent(SORT)}&page=1&page_size=${PAGE_SIZE}`;
    const data = await gmGetJson(url);
    const total = typeof data?.total === "number" ? data.total : 0;
    state.allTotal = total;
    state.allTotalFetchedAt = now;
    return total;
  }

  async function fetchRandomOne(panel) {
    if (state.loading) return;

    state.loading = true;
    state.lastError = "";
    render(panel);

    try {
      const total = await ensureAllTotal();
      if (!total || total <= 0) {
        toast("total=0，无法随机");
        state.items = [];
        return;
      }

      const idx = Math.floor(Math.random() * total); // [0,total-1]
      const page = Math.floor(idx / PAGE_SIZE) + 1;
      const offset = idx % PAGE_SIZE;

      const url = `${API_BASE}/memes?sort=${encodeURIComponent(SORT)}&page=${page}&page_size=${PAGE_SIZE}`;
      const data = await gmGetJson(url);
      const items = Array.isArray(data?.items) ? data.items : [];
      const picked = items[offset] || items[Math.floor(Math.random() * items.length)];

      if (!picked || !picked.content) {
        toast("随机结果为空，重试");
        state.items = [];
        return;
      }

      state.items = [picked];
      state.total = total;
      state.page = page;

      await copyText(picked.content);
      toast(`随机命中：#${picked.id ?? "?"}（第${page}页）✅`);
    } catch (e) {
      state.lastError = e?.message ? e.message : String(e);
      state.items = [];
    } finally {
      state.loading = false;
      render(panel);
      updatePanelPositionRaf();
    }
  }

  // -------------------------
  // Portal + Positioning（默认上侧 + 可拖拽偏移）
  // -------------------------
  function findChatInputBox() {
    return document.querySelector(".chat-input.border-box");
  }

  function ensureToast() {
    if (document.getElementById("hzm-meme-toast")) return;
    const t = document.createElement("div");
    t.id = "hzm-meme-toast";
    document.body.appendChild(t);
  }

  let panel = null;
  const offset = loadOffset();

  function updatePanelPosition() {
    if (!panel) return;
    const inputBox = findChatInputBox();
    if (!inputBox) return;

    const rect = inputBox.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 360), window.innerWidth - 16);
    panel.style.width = `${width}px`;

    const h = panel.getBoundingClientRect().height || 260;

    let left = rect.left + offset.dx;
    let top = rect.top - h - 8 + offset.dy; // 上侧

    left = clamp(left, 8, window.innerWidth - width - 8);
    top = clamp(top, 8, window.innerHeight - h - 8);

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  const updatePanelPositionRaf = (() => {
    let raf = 0;
    return () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        updatePanelPosition();
      });
    };
  })();

  function wireDrag(panel) {
    const bar = panel.querySelector("#hzm-meme-dragbar");
    const resetBtn = panel.querySelector("#hzm-meme-resetpos");

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startDx = 0;
    let startDy = 0;

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      offset.dx = startDx + dx;
      offset.dy = startDy + dy;
      updatePanelPositionRaf();
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      saveOffset(offset.dx, offset.dy);
      toast("位置已保存 📌");
    };

    bar.addEventListener("mousedown", (e) => {
      if (e.target && e.target.id === "hzm-meme-resetpos") return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startDx = offset.dx;
      startDy = offset.dy;

      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
      e.preventDefault();
      e.stopPropagation();
    });

    resetBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      offset.dx = 0;
      offset.dy = 0;
      saveOffset(0, 0);
      updatePanelPositionRaf();
      toast("已重置位置");
    });
  }

  function wireEvents(panel) {
    wireDrag(panel);

    const segBtns = Array.from(panel.querySelectorAll(".hzm-meme-seg button"));
    const rowKeyword = panel.querySelector("#hzm-meme-row-keyword");
    const rowTag = panel.querySelector("#hzm-meme-row-tag");
    const rowRandom = panel.querySelector("#hzm-meme-row-random");

    function setMode(mode) {
      if (state.mode === mode) return;

      state.mode = mode;
      state.page = 1;
      state.total = 0;
      state.items = [];
      state.lastError = "";

      for (const b of segBtns) b.classList.toggle("active", b.dataset.mode === mode);

      rowKeyword.style.display = mode === "keyword" ? "" : "none";
      rowTag.style.display = mode === "tag" ? "" : "none";
      rowRandom.style.display = mode === "random" ? "" : "none";

      render(panel);
      updatePanelPositionRaf();

      // 选中随机模式后：自动加载随机一条
      if (mode === "random") {
        fetchRandomOne(panel).catch(() => {});
      }
    }

    segBtns.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

    // keyword
    const kwInput = panel.querySelector("#hzm-meme-keyword");
    const kwSearchBtn = panel.querySelector("#hzm-meme-search-btn");

    const debouncedSearch = debounce(() => {
      if (state.mode !== "keyword") return;
      if (!state.keyword || state.keyword.trim().length === 0) {
        state.items = [];
        state.total = 0;
        render(panel);
        updatePanelPositionRaf();
        return;
      }
      state.page = 1;
      fetchMemes(panel).catch(() => {});
    }, DEBOUNCE_MS);

    kwInput.addEventListener("input", () => {
      state.keyword = kwInput.value || "";
      debouncedSearch();
    });

    kwInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        state.keyword = kwInput.value || "";
        state.page = 1;
        fetchMemes(panel).catch(() => {});
      }
    });

    kwSearchBtn.addEventListener("click", () => {
      state.keyword = kwInput.value || "";
      if (!state.keyword.trim()) {
        toast("请输入关键词");
        return;
      }
      state.page = 1;
      fetchMemes(panel).catch(() => {});
    });

    // tag
    const tagSel = panel.querySelector("#hzm-meme-tag-select");
    const tagSearchBtn = panel.querySelector("#hzm-meme-search-btn-tag");

    tagSel.addEventListener("change", () => (state.tagId = tagSel.value || ""));
    tagSearchBtn.addEventListener("click", () => {
      if (!tagSel.value) {
        toast("请选择Tag");
        return;
      }
      state.tagId = tagSel.value;
      state.page = 1;
      fetchMemes(panel).catch(() => {});
    });

    // random again
    const randomAgainBtn = panel.querySelector("#hzm-meme-random-again");
    randomAgainBtn.addEventListener("click", () => {
      fetchRandomOne(panel).catch(() => {});
    });

    // paging（随机模式下 render() 已禁用按钮，但这里也做保护）
    panel.querySelector("#hzm-meme-prev").addEventListener("click", () => {
      if (state.mode === "random") return;
      if (state.page <= 1) return;
      state.page -= 1;
      fetchMemes(panel).catch(() => {});
    });
    panel.querySelector("#hzm-meme-next").addEventListener("click", () => {
      if (state.mode === "random") return;
      const maxPage = state.total ? Math.ceil(state.total / PAGE_SIZE) : state.page + 1;
      if (state.page >= maxPage) return;
      state.page += 1;
      fetchMemes(panel).catch(() => {});
    });

    // 默认模式：关键词
    setMode("keyword");
  }

  function mountOrRemount() {
    const inputBox = findChatInputBox();
    if (!inputBox) return false;

    if (!panel || !document.body.contains(panel)) {
      panel = buildPanel();
      document.body.appendChild(panel);
      ensureToast();
      wireEvents(panel);

      // Tag 初始化加载一次（无刷新按钮）
      fetchTags(panel).catch(() => {});

      render(panel);
    }

    updatePanelPositionRaf();
    return true;
  }

  function startObservers() {
    const obs = new MutationObserver(() => mountOrRemount());
    obs.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener("resize", updatePanelPositionRaf);
    document.addEventListener("scroll", updatePanelPositionRaf, true);
  }

  // -------------------------
  // Boot
  // -------------------------
  (async function boot() {
    for (let i = 0; i < 30; i++) {
      if (mountOrRemount()) break;
      await sleep(250);
    }
    startObservers();
  })();
})();