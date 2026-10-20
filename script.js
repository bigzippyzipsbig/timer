(() => {
  "use strict";

  // ---- settings ----
  const DEFAULT_SEC = 45 * 60;
  const PRESETS = [10, 15 * 60, 45 * 60, 90 * 60]; // in seconds
  const MAX_MS = 99 * 3600 * 1000;

  const R = 44;
  const C = 2 * Math.PI * R;

  const $ = (s) => document.querySelector(s);
  const el = {
    body: document.body,
    progress: $("#progress"),
    head: $("#head"),
    ticks: $("#ticks"),
    timeBtn: $("#timeBtn"),
    timeInput: $("#timeInput"),
    timeEdit: $("#timeEdit"),
    timeMask: $("#timeMask"),
    sub: $("#sub"),
    presets: $("#presets"),
    startBtn: $("#startBtn"),
    startLabel: $("#startLabel"),
    icoPlay: $("#icoPlay"),
    icoPause: $("#icoPause"),
    resetBtn: $("#resetBtn"),
    soundBtn: $("#soundBtn"),
    fsBtn: $("#fsBtn"),
  };

  // ---- state ----
  let duration = DEFAULT_SEC * 1000;
  let remaining = duration;
  let running = false;
  let done = false;
  let endAt = 0;
  let interval = 0;
  let raf = 0;
  let audioCtx = null;
  let wakeLock = null;
  let soundOn = load("timer.soundOn", true);
  let resumeAfterEdit = false;

  // ?t=25 in the URL sets the starting minutes
  const qp = parseFloat(new URLSearchParams(location.search).get("t"));
  if (qp > 0) duration = remaining = Math.min(qp * 60000, MAX_MS);

  // ---- storage helpers ----
  function load(k, fallback) {
    try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

  // ---- formatting ----
  const pad = (n) => String(n).padStart(2, "0");
  function fmt(ms) {
    const total = Math.ceil(Math.max(0, ms) / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }
  function human(ms) {
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    const parts = [];
    if (h) parts.push(`${h} hr`);
    if (m) parts.push(`${m} min`);
    if (s) parts.push(`${s} sec`);
    return (parts.join(" ") || "0 sec") + " timer";
  }
  function presetLabel(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (!h && !m) return `${s} sec`;
    if (!h) return s ? `${m}m ${s}s` : `${m} min`;
    return m ? `${h}h ${m}m` : `${h} hr`;
  }
  function clock(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  // Typed digits fill in from the right, like a microwave:
  //   4 -> 0:04   50 -> 0:50   500 -> 5:00   5000 -> 50:00   50000 -> 5:00:00
  // Colons also work: 1:30 -> 1m30s, 1:05:00 -> 1h5m
  function parse(str) {
    const s = str.trim().replace(/\s+/g, "");
    if (!s) return NaN;
    let h = 0, m = 0, sec = 0;
    if (/^\d+$/.test(s)) {
      const d = s.slice(-6).padStart(6, "0");
      h = +d.slice(0, 2); m = +d.slice(2, 4); sec = +d.slice(4, 6);
    } else if (/^[\d:]+$/.test(s)) {
      const parts = s.split(":").map((p) => (p === "" ? 0 : Number(p)));
      if (parts.length > 3) return NaN;
      while (parts.length < 3) parts.unshift(0);
      [h, m, sec] = parts;
    } else {
      return NaN;
    }
    return ((h * 60 + m) * 60 + sec) * 1000;
  }

  // ---- ring ticks ----
  (function buildTicks() {
    const ns = "http://www.w3.org/2000/svg";
    for (let i = 0; i < 60; i++) {
      const a = (i * 6 - 90) * Math.PI / 180;
      const major = i % 5 === 0;
      // Kept well inside the white disc (radius 50) and outside the ring.
      const r1 = major ? 46.3 : 46.9, r2 = 48.1;
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", 50 + r1 * Math.cos(a));
      line.setAttribute("y1", 50 + r1 * Math.sin(a));
      line.setAttribute("x2", 50 + r2 * Math.cos(a));
      line.setAttribute("y2", 50 + r2 * Math.sin(a));
      line.setAttribute("class", major ? "tick major" : "tick");
      el.ticks.appendChild(line);
    }
    el.progress.style.strokeDasharray = `${C} ${C}`;
  })();

  // ---- presets ----
  PRESETS.forEach((sec) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.dataset.sec = sec;
    b.textContent = presetLabel(sec);
    b.addEventListener("click", () => { setDuration(sec * 1000); start(); });
    el.presets.appendChild(b);
  });

  // ---- render ----
  // The ring is redrawn every animation frame for smooth motion;
  // text only changes when the displayed value actually changes.
  const cache = {};
  function setText(node, key, value) {
    if (cache[key] !== value) { node.textContent = value; cache[key] = value; }
  }

  function renderRing() {
    const f = duration > 0 ? Math.min(1, remaining / duration) : 0;
    el.progress.style.strokeDashoffset = C * (1 - f);
    el.progress.style.opacity = f > 0 ? 1 : 0;
    const a = 2 * Math.PI * f - Math.PI / 2;
    el.head.setAttribute("cx", 50 + R * Math.cos(a));
    el.head.setAttribute("cy", 50 + R * Math.sin(a));
    el.head.style.opacity = f > 0 ? 1 : 0;
  }

  function render() {
    renderRing();

    const text = fmt(remaining);
    setText(el.timeBtn, "time", text);
    el.body.classList.toggle("long", text.length > 5);
    el.body.classList.toggle("running", running);
    el.body.classList.toggle("done", done);

    const paused = !running && !done && remaining < duration;
    let sub;
    if (done) sub = "Time's up";
    else if (running) sub = `Ends at ${clock(Date.now() + remaining)}`;
    else if (paused) sub = "Paused";
    else sub = human(duration);
    setText(el.sub, "sub", sub);

    setText(el.startLabel, "label", running ? "Pause" : paused ? "Resume" : done ? "Restart" : "Start");
    el.icoPlay.toggleAttribute("hidden", running);
    el.icoPause.toggleAttribute("hidden", !running);

    el.presets.querySelectorAll(".chip").forEach((b) => {
      b.classList.toggle("active", +b.dataset.sec * 1000 === duration);
    });

    const title = done ? "⏰ Time's up" : (running || paused) ? `${text} · Timer` : "Timer";
    if (cache.title !== title) { document.title = title; cache.title = title; }
  }

  // ---- timer logic ----
  function update() {
    remaining = Math.max(0, endAt - performance.now());
    if (remaining <= 0) finish();
  }

  function frame() {
    if (!running) return;
    update();
    render();
    if (running) raf = requestAnimationFrame(frame);
  }

  // Backup check so the timer still finishes (and chimes) in a background tab,
  // where animation frames are paused.
  function backgroundTick() {
    if (!running) return;
    update();
    if (document.hidden || !running) render();
  }

  function stopLoops() {
    clearInterval(interval);
    cancelAnimationFrame(raf);
  }

  function start() {
    if (done) { remaining = duration; done = false; }
    if (remaining <= 0) return;
    unlockAudio();
    running = true;
    endAt = performance.now() + remaining;
    stopLoops();
    interval = setInterval(backgroundTick, 250);
    raf = requestAnimationFrame(frame);
    keepAwake();
    render();
  }

  function pause() {
    if (!running) return;
    remaining = Math.max(0, endAt - performance.now());
    running = false;
    stopLoops();
    letSleep();
    render();
  }

  function toggle() { running ? pause() : start(); }

  function reset() {
    running = false;
    done = false;
    stopLoops();
    remaining = duration;
    letSleep();
    render();
  }

  function finish() {
    running = false;
    done = true;
    remaining = 0;
    stopLoops();
    letSleep();
    chime();
    render();
  }

  function setDuration(ms) {
    running = false;
    done = false;
    stopLoops();
    duration = remaining = Math.min(Math.max(1000, ms), MAX_MS);
    letSleep();
    render();
  }

  function add(sec) {
    const ms = sec * 1000;
    if (done) { done = false; duration = 0; remaining = 0; }
    if (duration + ms > MAX_MS) return;
    duration += ms;
    remaining += ms;
    if (running) endAt += ms;
    render();
  }

  // ---- editing the time by typing ----
  // Shows a 00:00:00 template; typed digits fill in from the right and
  // are drawn in full ink, the untouched 0s and colons stay greyed out.
  function digitsOf(v) {
    return v.replace(/\D/g, "").replace(/^0+/, "").slice(0, 6);
  }
  function renderMask() {
    const digits = digitsOf(el.timeInput.value);
    if (el.timeInput.value !== digits) el.timeInput.value = digits;
    const padded = digits.padStart(6, "0");
    const firstFilled = 6 - digits.length; // index of first typed digit
    let html = "";
    for (let i = 0; i < 6; i++) {
      html += `<span class="${i >= firstFilled ? "on" : "off"}">${padded[i]}</span>`;
      if (i === 1 || i === 3) {
        html += `<span class="${i >= firstFilled ? "on" : "off"}">:</span>`;
      }
    }
    html += '<span class="caret"></span>';
    el.timeMask.innerHTML = html;
  }
  function beginEdit() {
    resumeAfterEdit = running;
    pause();
    el.timeInput.value = "";
    renderMask();
    el.timeBtn.hidden = true;
    el.timeEdit.hidden = false;
    el.timeInput.focus();
  }
  // mode: "start" (Enter), "apply" (clicked away), "cancel" (Escape)
  function endEdit(mode) {
    if (el.timeEdit.hidden) return;
    const ms = parse(digitsOf(el.timeInput.value));
    el.timeEdit.hidden = true;
    el.timeBtn.hidden = false;
    if (mode !== "cancel" && ms > 0) {
      setDuration(ms);
      if (mode === "start") start();
    } else if (resumeAfterEdit) {
      start();
    }
    resumeAfterEdit = false;
  }
  el.timeBtn.addEventListener("click", beginEdit);
  el.timeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); endEdit("start"); }
    else if (e.key === "Escape") { e.preventDefault(); endEdit("cancel"); }
    e.stopPropagation();
  });
  el.timeInput.addEventListener("input", renderMask);
  el.timeInput.addEventListener("blur", () => endEdit("apply"));

  // ---- sound ----
  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch {}
  }
  function tone(freq, t0, dur) {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }
  function chime() {
    if (!soundOn || !audioCtx) return;
    const t = audioCtx.currentTime + 0.05;
    for (let i = 0; i < 4; i++) {
      tone(880, t + i * 0.9, 0.7);
      tone(1318.5, t + i * 0.9 + 0.16, 0.8);
    }
  }
  function syncSoundBtn() { el.soundBtn.setAttribute("aria-pressed", String(soundOn)); }
  el.soundBtn.addEventListener("click", () => {
    soundOn = !soundOn;
    save("timer.soundOn", soundOn);
    syncSoundBtn();
    if (soundOn) unlockAudio();
  });
  syncSoundBtn();

  // ---- keep screen awake while running ----
  async function keepAwake() {
    try { if ("wakeLock" in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request("screen"); }
    catch {}
  }
  function letSleep() {
    try { wakeLock && wakeLock.release(); } catch {}
    wakeLock = null;
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && running) {
      wakeLock = null;
      keepAwake();
      update();
      render();
      if (running) { cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); }
    }
  });

  // ---- fullscreen ----
  function toggleFs() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.();
  }
  el.fsBtn.addEventListener("click", toggleFs);

  // ---- buttons & keys ----
  el.startBtn.addEventListener("click", toggle);
  el.resetBtn.addEventListener("click", reset);
  document.querySelectorAll("[data-add]").forEach((b) =>
    b.addEventListener("click", () => add(+b.dataset.add))
  );

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === " " || k === "spacebar") { e.preventDefault(); toggle(); }
    else if (k === "r") reset();
    else if (k === "f") toggleFs();
    else if (k === "m") el.soundBtn.click();
  });

  // Browsers block sound until the person interacts with the page,
  // so unlock audio on the first click/tap/key press anywhere.
  const firstTouch = () => {
    unlockAudio();
    ["pointerdown", "keydown", "touchstart"].forEach((t) =>
      document.removeEventListener(t, firstTouch, true)
    );
  };
  ["pointerdown", "keydown", "touchstart"].forEach((t) =>
    document.addEventListener(t, firstTouch, true)
  );

  // Start counting down immediately on load (and on every refresh).
  start();
})();
