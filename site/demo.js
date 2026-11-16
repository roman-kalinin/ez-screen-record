// Drives the live demo: the real Ez Screen Record window (built from the app's
// own renderer with a fake preload, see src/renderer/demo/) runs in an iframe,
// and a scripted cursor clicks through one recording.
(() => {
  const W = 880; // the app window's real size, scaled to fit
  const screenEl = document.getElementById('screen');
  const scaler = document.getElementById('scaler');
  const frame = document.getElementById('app-frame');
  const tbFrame = document.getElementById('tb-frame');
  const desk = document.getElementById('desk');
  const cursor = document.getElementById('cursor');
  const stepN = document.getElementById('step-n');
  const stepWrap = document.getElementById('step-wrap');
  const progress = document.getElementById('progress');
  // Every wait belongs to one run of the loop. Hiding the tab ends that run
  // (background timers are throttled, which would desync the clicks from the
  // app), and showing it again starts a clean one.
  const STALE = Symbol('stale');
  let gen = 0;
  const sleep = (ms) => {
    const g = gen;
    return new Promise((resolve, reject) =>
      setTimeout(() => (g === gen ? resolve() : reject(STALE)), ms));
  };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  new ResizeObserver(() => {
    scaler.style.transform = `scale(${screenEl.clientWidth / W})`;
  }).observe(screenEl);

  // While recording, the app hands over to its toolbar (as it does for real).
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || !m.ezDemo) return;
    // Relay app <-> toolbar messages between the two frames of this page only.
    if (m.type === 'bus') {
      const target = m.data.to === 'toolbar' ? tbFrame : frame;
      target.contentWindow && target.contentWindow.postMessage({ ezBus: true, ...m.data }, '*');
      return;
    }
    if (m.type !== 'toolbarMode') return;
    frame.classList.toggle('away', !!m.data);
    desk.classList.toggle('on', !!m.data);
    tbFrame.classList.toggle('on', !!m.data);
  });

  // The screen being recorded: the same animated desktop the app previews.
  const dctx = desk.getContext('2d');
  (function paint() {
    try {
      const get = frame.contentWindow && frame.contentWindow.__ezDesktopCanvas;
      if (get && desk.classList.contains('on')) {
        const src = get();
        const k = Math.max(desk.width / src.width, desk.height / src.height);
        const w = src.width * k, h = src.height * k;
        dctx.drawImage(src, (desk.width - w) / 2, (desk.height - h) / 2, w, h);
      }
    } catch { /* frame reloading */ }
    requestAnimationFrame(paint);
  })();

  const doc = () => frame.contentDocument;
  const tbDoc = () => tbFrame.contentDocument;
  async function find(selector, timeout = 6000, docFn = doc) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const d = docFn();
      const el = d && (typeof selector === 'function' ? selector(d) : d.querySelector(selector));
      if (el && el.getClientRects().length) return el;
      await sleep(80);
    }
    return null;
  }
  const pillToggle = (label) => (d) => {
    const chev = d.querySelector(`button[aria-label="Choose ${label}"]`);
    return chev && chev.parentElement.querySelector('button[aria-pressed]');
  };
  const byText = (re) => (d) => [...d.querySelectorAll('a, button')].find((b) => re.test(b.textContent.trim()));

  // ---- cursor ----
  function moveTo(x, y) {
    cursor.style.transform = `translate(${x - 4}px, ${y - 3}px)`;
  }
  function centre(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; // both frames sit at 0,0
  }
  async function point(el) {
    if (!el) return false;
    const p = centre(el);
    moveTo(p.x, p.y);
    await sleep(850);
    return true;
  }
  async function click(el) {
    if (!(await point(el))) return;
    cursor.classList.remove('click'); void cursor.offsetWidth; cursor.classList.add('click');
    el.click();
    await sleep(200);
  }
  const rest = () => moveTo(W * 0.6, 300);

  // ---- caption: old line rolls up and out, new one rolls in ----
  let line = null;
  function caption(n, text) {
    stepN.textContent = n;
    stepN.classList.remove('bump'); void stepN.offsetWidth; stepN.classList.add('bump');
    setTimeout(() => stepN.classList.remove('bump'), 260);
    if (line) {
      const old = line;
      old.classList.add('out');
      setTimeout(() => old.remove(), 600);
    }
    line = document.createElement('span');
    line.className = 'step-t in';
    line.textContent = text;
    stepWrap.appendChild(line);
    void line.offsetWidth;
    line.classList.remove('in');
  }

  // Each step has a fixed length, so the progress bars and the action stay in step.
  const STEPS = [
    {
      text: 'Pick what to record',
      ms: 3400,
      run: async () => {
        await click(await find('button[aria-label="Choose what to record"]'));
        await sleep(600);
        await click(await find('button[title="Entire screen"]'));
      },
    },
    { text: 'Turn on your mic', ms: 1900, run: async () => click(await find(pillToggle('microphone'))) },
    { text: 'Add your camera', ms: 2300, run: async () => click(await find(pillToggle('camera'))) },
    {
      text: 'Include computer sound if you need it',
      ms: 2000,
      run: async () => click(await find('button[aria-label="Include computer audio"]')),
    },
    {
      text: 'Hit record',
      ms: 4600, // includes the app's own 3-2-1 countdown
      run: async () => {
        await click(await find('button[aria-label="Start recording"]'));
        await sleep(400);
        rest();
      },
    },
    {
      text: 'Record. The controls stay out of the video',
      ms: 3800,
      run: async () => {
        // drift around the screen a little, like someone explaining something
        moveTo(W * 0.42, 380); await sleep(1300);
        moveTo(W * 0.66, 250);
      },
    },
    {
      text: 'Stop when you’re done',
      ms: 2200,
      run: async () => click(await find('button[aria-label="Stop recording"]', 4000, tbDoc)),
    },
    {
      text: 'Saved as MP4. Trim it in the editor',
      ms: 5000,
      run: async () => point(await find(byText(/^Edit/), 4000)),
    },
  ];
  STEPS.forEach(() => progress.appendChild(document.createElement('i')));
  const bars = [...progress.children];

  const loaded = () => new Promise((r) => frame.addEventListener('load', r, { once: true }));

  let firstRun = true;
  async function loop() {
    if (doc()?.readyState !== 'complete') await loaded();
    for (let round = firstRun ? 0 : 1; ; round++) {
      firstRun = false;
      if (round > 0) {
        const l = loaded();
        frame.contentWindow.location.reload();
        tbFrame.contentWindow.location.reload();
        await l;
      }
      frame.classList.remove('away'); desk.classList.remove('on'); tbFrame.classList.remove('on');
      await find('button[aria-label="Start recording"]', 15000);
      bars.forEach((b) => (b.className = ''));
      rest();
      await sleep(round === 0 ? 1600 : 700);
      for (let i = 0; i < STEPS.length; i++) {
        const s = STEPS[i];
        caption(i + 1, s.text);
        const bar = bars[i];
        bar.style.setProperty('--d', s.ms + 'ms');
        bar.className = 'now start'; void bar.offsetWidth; bar.className = 'now';
        const started = Date.now();
        try { await s.run(); } catch (e) { if (e === STALE) throw e; console.warn('demo step failed', e); }
        await sleep(Math.max(0, s.ms - (Date.now() - started)));
        bar.className = 'done';
      }
    }
  }
  function start() {
    gen++;
    loop().catch((e) => { if (e !== STALE) console.warn('demo stopped', e); });
  }
  if (!reduced) {
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) gen++; // abandon the current run
      else start();
    });
  } else caption(1, 'Pick a screen, turn on mic and camera, hit record.');
})();
