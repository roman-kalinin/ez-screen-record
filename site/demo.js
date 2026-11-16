// Drives the live demo: the real Ez Screen Record UI (built from the app's own
// renderer with a fake preload, see src/renderer/demo/) runs in two iframes,
// and a scripted cursor clicks through one recording.
(() => {
  const VW = 1200; // virtual display size the frames are laid out in
  const screenEl = document.getElementById('screen');
  const scaler = document.getElementById('scaler');
  const desk = document.getElementById('desk');
  const appFrame = document.getElementById('app-frame');
  const tbFrame = document.getElementById('tb-frame');
  const cursor = document.getElementById('cursor');
  const stepN = document.getElementById('step-n');
  const stepT = document.getElementById('step-t');
  const progress = document.getElementById('progress');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let scale = 1;
  function fit() {
    scale = screenEl.clientWidth / VW;
    scaler.style.transform = `scale(${scale})`;
  }
  new ResizeObserver(fit).observe(screenEl);
  fit();

  // Paint the same animated desktop the app is "recording" behind its windows.
  const dctx = desk.getContext('2d');
  (function paint() {
    try {
      const src = appFrame.contentWindow && appFrame.contentWindow.__ezDesktopCanvas;
      if (src) dctx.drawImage(src(), 0, 0, desk.width, desk.height);
    } catch { /* frame not ready */ }
    requestAnimationFrame(paint);
  })();

  // The app tells us when it collapses into the recording toolbar.
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || !m.ezDemo) return;
    if (m.type === 'toolbarMode') {
      appFrame.classList.toggle('away', !!m.data);
      tbFrame.classList.toggle('on', !!m.data);
    }
  });

  const appDoc = () => appFrame.contentDocument;
  const tbDoc = () => tbFrame.contentDocument;

  async function find(docFn, selector, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const d = docFn();
      const el = d && (typeof selector === 'function' ? selector(d) : d.querySelector(selector));
      if (el && el.getClientRects().length) return el;
      await sleep(100);
    }
    return null;
  }
  const pillToggle = (label) => (d) => {
    const chev = d.querySelector(`button[aria-label="Choose ${label}"]`);
    return chev && chev.parentElement.querySelector('button[aria-pressed]');
  };

  /** Element centre, in the scaler's (virtual display) coordinates. */
  function pointOf(el, frame) {
    const r = el.getBoundingClientRect();
    return { x: frame.offsetLeft + r.left + r.width / 2, y: frame.offsetTop + r.top + r.height / 2 };
  }
  function moveCursor(x, y) {
    cursor.style.transform = `translate(${x - 4}px, ${y - 3}px)`;
  }
  async function clickOn(el, frame) {
    const p = pointOf(el, frame);
    moveCursor(p.x, p.y);
    await sleep(850);
    cursor.classList.remove('click'); void cursor.offsetWidth; cursor.classList.add('click');
    el.click();
    await sleep(250);
  }

  const STEPS = [
    {
      text: 'Pick what to record',
      run: async () => {
        await clickOn(await find(appDoc, 'button[aria-label="Choose what to record"]'), appFrame);
        await sleep(700);
        const tile = await find(appDoc, 'button[title="Entire screen"]');
        if (tile) await clickOn(tile, appFrame);
      },
    },
    { text: 'Turn on your mic', run: async () => clickOn(await find(appDoc, pillToggle('microphone')), appFrame) },
    { text: 'Add your camera', run: async () => clickOn(await find(appDoc, pillToggle('camera')), appFrame), hold: 1400 },
    {
      text: 'Include computer sound if you need it',
      run: async () => clickOn(await find(appDoc, 'button[aria-label="Include computer audio"]'), appFrame),
    },
    {
      text: 'Hit record',
      run: async () => {
        await clickOn(await find(appDoc, 'button[aria-label="Start recording"]'), appFrame);
        await sleep(3300); // the app's own 3-2-1 countdown
        moveCursor(VW * 0.62, 470);
      },
      hold: 1200,
    },
    {
      text: 'Record your tutorial. The controls stay out of the video',
      run: async () => {
        const stop = await find(tbDoc, 'button[aria-label="Stop recording"]');
        if (stop) { const p = pointOf(stop, tbFrame); moveCursor(p.x + 140, p.y + 220); }
      },
      hold: 3600,
    },
    {
      text: 'Stop when you’re done',
      run: async () => {
        const stop = await find(tbDoc, 'button[aria-label="Stop recording"]');
        if (stop) await clickOn(stop, tbFrame);
      },
      hold: 600,
    },
    {
      text: 'Saved as MP4. Trim it in the editor',
      run: async () => {
        const edit = await find(appDoc, (d) =>
          [...d.querySelectorAll('a, button')].find((b) => /^Edit/.test(b.textContent.trim())), 10000);
        if (edit) { const p = pointOf(edit, appFrame); moveCursor(p.x, p.y); }
      },
      hold: 4500,
    },
  ];
  STEPS.forEach(() => progress.appendChild(document.createElement('i')));
  const bars = [...progress.children];

  const loaded = (f) => new Promise((r) => {
    f.addEventListener('load', r, { once: true });
  });

  async function resetFrames(first) {
    if (!first) {
      const a = loaded(appFrame), b = loaded(tbFrame);
      appFrame.contentWindow.location.reload();
      tbFrame.contentWindow.location.reload();
      await Promise.all([a, b]);
    }
    appFrame.classList.remove('away');
    tbFrame.classList.remove('on');
    await find(appDoc, 'button[aria-label="Start recording"]', 15000);
  }

  async function loop() {
    if (appFrame.contentDocument?.readyState !== 'complete') await loaded(appFrame);
    let first = true;
    for (;;) {
      bars.forEach((b) => (b.className = ''));
      await resetFrames(first);
      first = false;
      moveCursor(VW * 0.62, 470);
      await sleep(1000);
      for (let i = 0; i < STEPS.length; i++) {
        const s = STEPS[i];
        stepN.textContent = i + 1;
        stepT.style.opacity = 0;
        await sleep(160);
        stepT.textContent = s.text;
        stepT.style.opacity = 1;
        const bar = bars[i];
        const t0 = Date.now();
        bar.className = 'now start'; void bar.offsetWidth;
        bar.style.setProperty('--d', '1800ms'); bar.className = 'now';
        try { await s.run(); } catch (e) { console.warn('demo step failed', e); }
        await sleep(s.hold || 900);
        bar.className = 'done';
        void t0;
      }
      await sleep(800);
    }
  }
  loop();
})();
