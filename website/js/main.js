/* ZopMop landing — GSAP orchestration + Three.js bubble field */

const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/* ?static=1 — QA/screenshot mode: plain page, no animation states */
const staticMode = new URLSearchParams(location.search).has('static');

/* If CDN libs failed, degrade to a static (but fully readable) page. */
if (staticMode || typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined') {
  document.documentElement.classList.add('no-js');
  document.querySelector('.preloader')?.remove();
} else {
  init();
}

function init() {
  gsap.registerPlugin(ScrollTrigger);

  /* ---------- Theme toggle (mirrors app's 340ms dark<->light morph) ---------- */
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    document.querySelector('meta[name="theme-color"]').setAttribute('content', next === 'dark' ? '#0A0A0A' : '#FAF7F2');
    try { localStorage.setItem('zopmop_theme', next); } catch (e) { /* private mode */ }
  });

  /* ---------- Smooth scroll (Lenis) ---------- */
  let lenis = null;
  if (typeof Lenis !== 'undefined' && !prefersReduced) {
    lenis = new Lenis({ duration: 1.1, smoothWheel: true });
    window.__lenis = lenis;
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
  }

  const scrollTo = (target) => {
    if (lenis) lenis.scrollTo(target, { offset: 0 });
    else document.querySelector(target)?.scrollIntoView({ behavior: 'smooth' });
  };
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    const id = a.getAttribute('href');
    if (id.length > 1 && document.querySelector(id)) {
      a.addEventListener('click', (e) => { e.preventDefault(); scrollTo(id); });
    }
  });

  /* ---------- Preloader → hero reveal ---------- */
  const preloader = document.querySelector('.preloader');
  const countEl = document.querySelector('.preloader__count');
  const heroTl = gsap.timeline({ paused: true });

  heroTl
    .to('.hero .h-line__inner', {
      y: 0, rotate: 0, duration: 1.15, stagger: 0.12, ease: 'power4.out',
    })
    .to('.hero .reveal-up', {
      opacity: 1, y: 0, duration: 0.9, stagger: 0.09, ease: 'power3.out',
    }, '-=0.7');

  if (prefersReduced) {
    preloader?.remove();
    gsap.set('.hero .h-line__inner, .hero .reveal-up', { clearProps: 'all' });
  } else {
    const counter = { v: 0 };
    gsap.timeline()
      .to(counter, {
        v: 100, duration: 1.0, ease: 'power2.inOut',
        onUpdate: () => { countEl.textContent = Math.round(counter.v); },
      })
      .to(preloader, {
        yPercent: -100, duration: 0.8, ease: 'power4.inOut',
        onComplete: () => { preloader.remove(); ScrollTrigger.refresh(); },
      }, '+=0.1')
      .add(() => heroTl.play(), '-=0.55');
  }

  /* ---------- Nav: blur on scroll, hide on scroll-down ---------- */
  const nav = document.getElementById('nav');
  let lastY = 0;
  const onScrollY = (y) => {
    nav.classList.toggle('is-scrolled', y > 40);
    nav.classList.toggle('is-hidden', y > 200 && y > lastY);
    lastY = y;
  };
  if (lenis) lenis.on('scroll', ({ scroll }) => onScrollY(scroll));
  else window.addEventListener('scroll', () => onScrollY(window.scrollY), { passive: true });

  /* ---------- Custom cursor + magnetic buttons ---------- */
  if (window.matchMedia('(pointer: fine)').matches && !prefersReduced) {
    const dotX = gsap.quickTo('.cursor', 'x', { duration: 0.12, ease: 'power3' });
    const dotY = gsap.quickTo('.cursor', 'y', { duration: 0.12, ease: 'power3' });
    const ringX = gsap.quickTo('.cursor-ring', 'x', { duration: 0.45, ease: 'power3' });
    const ringY = gsap.quickTo('.cursor-ring', 'y', { duration: 0.45, ease: 'power3' });
    window.addEventListener('mousemove', (e) => {
      document.body.classList.add('cursor-active');
      dotX(e.clientX); dotY(e.clientY); ringX(e.clientX); ringY(e.clientY);
    });
    document.querySelectorAll('[data-cursor]').forEach((el) => {
      el.addEventListener('mouseenter', () => document.body.classList.add('cursor-hover'));
      el.addEventListener('mouseleave', () => document.body.classList.remove('cursor-hover'));
    });

    document.querySelectorAll('[data-magnetic]').forEach((el) => {
      const mx = gsap.quickTo(el, 'x', { duration: 0.35, ease: 'power3' });
      const my = gsap.quickTo(el, 'y', { duration: 0.35, ease: 'power3' });
      el.addEventListener('mousemove', (e) => {
        const r = el.getBoundingClientRect();
        mx((e.clientX - r.left - r.width / 2) * 0.3);
        my((e.clientY - r.top - r.height / 2) * 0.3);
      });
      el.addEventListener('mouseleave', () => {
        gsap.to(el, { x: 0, y: 0, duration: 0.6, ease: 'elastic.out(1, 0.4)' });
      });
    });
  }

  /* ---------- Manifesto: word-by-word ink reveal ---------- */
  const manifesto = document.getElementById('manifesto-text');
  if (manifesto) {
    const words = manifesto.textContent.trim().split(/\s+/);
    manifesto.replaceChildren(...words.flatMap((w, i) => {
      const span = document.createElement('span');
      span.className = 'w';
      span.textContent = w;
      return i < words.length - 1 ? [span, document.createTextNode(' ')] : [span];
    }));
    gsap.to('#manifesto-text .w', {
      opacity: 1,
      stagger: 0.08,
      ease: 'none',
      scrollTrigger: {
        trigger: manifesto,
        start: 'top 78%',
        end: 'bottom 45%',
        scrub: 0.6,
      },
    });
  }

  /* ---------- Services: pinned horizontal scroll (desktop only) ---------- */
  ScrollTrigger.matchMedia({
    '(min-width: 900px)': () => {
      const track = document.getElementById('services-track');
      const getDistance = () => track.scrollWidth - window.innerWidth + window.innerWidth * 0.06;
      gsap.to(track, {
        x: () => -getDistance(),
        ease: 'none',
        scrollTrigger: {
          trigger: '.services',
          start: 'top top',
          end: () => '+=' + getDistance(),
          pin: true,
          scrub: 1,
          invalidateOnRefresh: true,
          anticipatePin: 1,
        },
      });
    },
  });

  /* ---------- Generic section reveals ---------- */
  const sectionReveal = (targets, trigger, vars = {}) => {
    gsap.from(targets, {
      opacity: 0, y: 40, duration: 1, stagger: 0.12, ease: 'power3.out',
      scrollTrigger: { trigger, start: 'top 80%' },
      ...vars,
    });
  };
  sectionReveal('.services__head > *', '.services');
  sectionReveal('.steps__head > *, .step', '.steps');
  sectionReveal('.quote__text, .quote__cite', '.quote');

  /* ---------- Stats counters ---------- */
  document.querySelectorAll('[data-count]').forEach((el) => {
    const target = +el.dataset.count;
    const obj = { v: 0 };
    gsap.to(obj, {
      v: target, duration: 1.6, ease: 'power2.out',
      onUpdate: () => { el.textContent = Math.round(obj.v); },
      scrollTrigger: { trigger: '.stats', start: 'top 75%' },
    });
  });
  sectionReveal('.stat', '.stats');

  /* ---------- CTA line reveal ---------- */
  gsap.to('.cta .h-line__inner', {
    y: 0, rotate: 0, duration: 1.1, stagger: 0.12, ease: 'power4.out',
    scrollTrigger: { trigger: '.cta', start: 'top 70%' },
  });
  gsap.from('.cta__sub, .cta__actions', {
    opacity: 0, y: 30, duration: 0.9, stagger: 0.12, ease: 'power3.out',
    scrollTrigger: { trigger: '.cta', start: 'top 60%' },
  });

  /* ---------- Zop, the mascot who runs this page ---------- */
  initZop(lenis);

  /* ---------- Three.js bubble field ---------- */
  if (!prefersReduced) initBubbles().catch(() => { /* hero glows remain as fallback */ });
}

/* ============================================================
   Zop controller — one mascot, born in the hero headline, flies
   to a bottom-right dock (same spot as the app's IosZopButton),
   reacts to sections, blinks, naps, gets dizzy, pops on click.
   ============================================================ */
function initZop(lenis) {
  const zop = document.getElementById('zop');
  const bob = document.getElementById('zop-bob');
  const svgEl = document.getElementById('zop-svg');
  const bubble = document.getElementById('zop-bubble');
  const zzz = document.getElementById('zop-zzz');
  const anchor = document.getElementById('zop-anchor');
  if (!zop || !anchor) return;

  if (prefersReduced) {
    zop.classList.add('zop--static');
    setFaceRaw('happy');
    return;
  }

  /* ---- faces ---- */
  const faces = {};
  svgEl.querySelectorAll('.zop-face').forEach((g) => { faces[g.dataset.face] = g; });
  let current = 'default';
  let sleeping = false;

  function setFaceRaw(name) {
    svgEl.querySelectorAll('.zop-face').forEach((g) => { g.style.display = g.dataset.face === name ? 'block' : 'none'; });
  }
  function setFace(name, pop = true) {
    if (!faces[name] || current === name) return;
    current = name;
    setFaceRaw(name);
    if (pop) {
      gsap.fromTo(svgEl, { scaleY: 0.85, scaleX: 1.1 }, { scaleY: 1, scaleX: 1, duration: 0.5, ease: 'elastic.out(1, 0.45)', overwrite: 'auto' });
    }
  }

  /* ---- geometry ---- */
  const isMobile = () => window.innerWidth < 720;
  const BOX = 64; // .zop CSS box; mobile visual size handled by scale
  const dockX = () => window.innerWidth - BOX - (isMobile() ? 12 : 28);
  const dockY = () => window.innerHeight - BOX - (isMobile() ? 16 : 28);
  const dockScale = () => (isMobile() ? 0.84 : 1);
  const heroXY = () => {
    const r = anchor.getBoundingClientRect();
    return {
      x: r.left + window.scrollX + r.width / 2 - BOX / 2,
      y: r.top + window.scrollY + r.height / 2 - BOX / 2,
    };
  };
  const heroScale = () => (isMobile() ? 1.0 : 1.6);

  zop.classList.add('zop--hero-side');
  gsap.set(zop, { ...heroXY(), scale: heroScale() });

  /* birth: pop out of the headline after the hero reveal */
  gsap.from(bob, { scale: 0, rotation: -135, duration: 0.7, ease: 'back.out(1.6)', delay: 2.2 });
  gsap.to(bob, { y: -7, duration: 1.7, yoyo: true, repeat: -1, ease: 'sine.inOut' });

  /* hero → dock flight, scrubbed to scroll */
  gsap.fromTo(zop,
    { x: () => heroXY().x, y: () => heroXY().y, scale: () => heroScale() },
    {
      x: () => dockX(), y: () => dockY(), scale: () => dockScale(),
      ease: 'power2.inOut', immediateRender: true,
      scrollTrigger: {
        trigger: '.hero', start: '8% top', end: '75% top', scrub: 0.6,
        invalidateOnRefresh: true,
        onUpdate: (self) => zop.classList.toggle('zop--hero-side', self.progress < 0.5),
      },
    });

  /* ---- speech bubble ---- */
  let hideCall = null;
  function say(text, ms = 3200) {
    bubble.textContent = text;
    if (hideCall) hideCall.kill();
    gsap.to(bubble, { opacity: 1, scale: 1, duration: 0.45, ease: 'back.out(1.8)', overwrite: 'auto' });
    hideCall = gsap.delayedCall(ms / 1000, () => gsap.to(bubble, { opacity: 0, scale: 0.6, duration: 0.3, ease: 'power2.in' }));
  }

  /* greeting (assets/zop/hi-i-am-zop.svg) */
  gsap.delayedCall(3.1, () => { setFace('happy'); say("Hi — I'm Zop."); });
  gsap.delayedCall(6.0, () => setFace('default', false));

  /* ---- blink loop ---- */
  (function blink() {
    gsap.delayedCall(2.6 + Math.random() * 2.6, () => {
      if (!sleeping && (current === 'default' || current === 'happy')) {
        const prev = current;
        setFaceRaw('blink');
        gsap.delayedCall(0.12, () => { if (!sleeping) setFaceRaw(prev); });
      }
      blink();
    });
  })();

  /* ---- section reactions (lines from the old site) ---- */
  const reactions = [
    ['#why', 'smug', 'Zop lives for the job. Yours, specifically.'],
    ['#services', 'cool', 'Pick your first job.'],
    ['#how', 'thinking', 'Two taps. Done.'],
    ['.stats', 'smug', '100% verified pros'],
    ['#get-app', 'love', 'Get early access.'],
  ];
  reactions.forEach(([sel, face, line]) => {
    ScrollTrigger.create({
      trigger: sel, start: 'top 62%',
      onEnter: () => { wake(); setFace(face); say(line); },
      onEnterBack: () => { wake(); setFace(face); say(line); },
    });
  });

  /* the quote section IS Zop — hide the companion so there's only one of him */
  ScrollTrigger.create({
    trigger: '.quote', start: 'top 70%', end: 'bottom 35%',
    onToggle: (self) => gsap.to(zop, { autoAlpha: self.isActive ? 0 : 1, duration: 0.25 }),
  });
  gsap.from('.quote__zop', {
    scale: 0, rotation: -30, duration: 0.8, ease: 'back.out(1.8)',
    scrollTrigger: { trigger: '.quote', start: 'top 72%' },
  });

  /* ---- sleep / wake ---- */
  const zzzTl = gsap.timeline({ repeat: -1, paused: true });
  zzzTl.fromTo('#zop-zzz span',
    { y: 6, opacity: 0 },
    { y: -34, opacity: 1, duration: 1.4, stagger: 0.4, ease: 'sine.out' })
    .to('#zop-zzz span', { opacity: 0, duration: 0.4 }, '-=0.3');

  function sleep() {
    if (sleeping) return;
    sleeping = true;
    setFaceRaw('blink');
    gsap.to(bob, { rotation: 10, duration: 0.5 });
    zzz.style.display = 'block';
    zzzTl.play(0);
  }
  function wake() {
    if (!sleeping) return;
    sleeping = false;
    zzzTl.pause();
    zzz.style.display = 'none';
    gsap.to(bob, { rotation: 0, duration: 0.4 });
    setFaceRaw('shocked');
    gsap.delayedCall(0.45, () => { if (!sleeping) { current = 'shocked'; setFace('default', false); } });
  }

  ScrollTrigger.create({
    trigger: '.footer', start: 'top 92%',
    onEnter: () => { sleep(); },
    onLeaveBack: () => { wake(); },
  });

  let idleTimer = setTimeout(sleep, 18000);
  const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(sleep, 18000); };
  window.addEventListener('mousemove', resetIdle, { passive: true });
  window.addEventListener('touchstart', resetIdle, { passive: true });

  /* ---- scroll-speed dizziness ---- */
  if (lenis) {
    let settle = null;
    lenis.on('scroll', ({ velocity }) => {
      resetIdle();
      if (sleeping) wake();
      if (Math.abs(velocity) > 38 && current !== 'dizzy') {
        setFace('dizzy', false);
        gsap.to(bob, { rotation: velocity > 0 ? 14 : -14, duration: 0.3, overwrite: 'auto' });
      }
      if (settle) settle.kill();
      settle = gsap.delayedCall(0.7, () => {
        if (current === 'dizzy') { setFace('default', false); gsap.to(bob, { rotation: 0, duration: 0.5, ease: 'back.out(2)' }); }
      });
    });
  }

  /* ---- poke Zop ---- */
  const pokeFaces = ['tongue', 'wink', 'shocked'];
  const pokeLines = ['Home, handled.', 'Book in 30 seconds', 'Pros nearby · under 15 min'];
  let pokeCount = 0;
  function poke() {
    wake();
    resetIdle();
    setFace(pokeFaces[pokeCount % pokeFaces.length]);
    say(pokeLines[pokeCount % pokeLines.length], 2200);
    pokeCount++;
    gsap.timeline()
      .to(bob, { scaleY: 0.72, scaleX: 1.22, duration: 0.12, ease: 'power2.in' })
      .to(bob, { scaleY: 1, scaleX: 1, y: -22, duration: 0.35, ease: 'back.out(3)' })
      .to(bob, { y: -7, duration: 0.4, ease: 'bounce.out' });
    /* star burst */
    const r = zop.getBoundingClientRect();
    for (let i = 0; i < 6; i++) {
      const s = document.createElement('span');
      s.textContent = '✦';
      s.setAttribute('aria-hidden', 'true');
      Object.assign(s.style, {
        position: 'fixed', left: `${r.left + r.width / 2}px`, top: `${r.top + r.height / 2}px`,
        color: '#FFC042', fontSize: '14px', zIndex: 8599, pointerEvents: 'none',
      });
      document.body.appendChild(s);
      const a = (i / 6) * Math.PI * 2 + Math.random() * 0.6;
      const d = 46 + Math.random() * 42;
      gsap.to(s, {
        x: Math.cos(a) * d, y: Math.sin(a) * d - 18,
        rotation: Math.random() * 240 - 120, opacity: 0, scale: 0.4,
        duration: 0.8, ease: 'power2.out', onComplete: () => s.remove(),
      });
    }
    gsap.delayedCall(1.4, () => setFace('default', false));
  }
  zop.addEventListener('click', poke);
  zop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); poke(); } });
}

async function initBubbles() {
  const canvas = document.getElementById('bubble-canvas');
  if (!canvas || !window.WebGLRenderingContext) return;

  const THREE = await import('three');
  const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');

  const hero = document.getElementById('hero');
  const isMobile = window.innerWidth < 768;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: !isMobile });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.z = 10;

  const group = new THREE.Group();
  scene.add(group);

  const geo = new THREE.SphereGeometry(1, 48, 48);
  const soapMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    transmission: 1,
    roughness: 0.04,
    thickness: 0.9,
    ior: 1.15,
    iridescence: 1,
    iridescenceIOR: 1.35,
    clearcoat: 1,
    transparent: true,
    opacity: 0.92,
  });
  const amberMat = soapMat.clone();
  amberMat.color = new THREE.Color(0xffc042);
  const champagneMat = soapMat.clone();
  champagneMat.color = new THREE.Color(0xffe2b0);
  champagneMat.iridescenceIOR = 1.5;

  const mats = [soapMat, amberMat, soapMat, champagneMat, amberMat];
  const COUNT = isMobile ? 8 : 15;
  const bubbles = [];
  for (let i = 0; i < COUNT; i++) {
    const m = new THREE.Mesh(geo, mats[i % mats.length]);
    const scale = 0.25 + Math.pow(Math.random(), 1.6) * 1.15;
    m.scale.setScalar(scale);
    m.position.set(
      (Math.random() - 0.5) * 14,
      (Math.random() - 0.5) * 9,
      -2 - Math.random() * 5,
    );
    m.userData = {
      speed: 0.12 + Math.random() * 0.3,
      wobble: Math.random() * Math.PI * 2,
      wobbleAmp: 0.2 + Math.random() * 0.5,
    };
    group.add(m);
    bubbles.push(m);
  }

  /* Mouse parallax */
  let targetRX = 0, targetRY = 0;
  if (window.matchMedia('(pointer: fine)').matches) {
    window.addEventListener('mousemove', (e) => {
      targetRY = (e.clientX / window.innerWidth - 0.5) * 0.22;
      targetRX = (e.clientY / window.innerHeight - 0.5) * 0.16;
    });
  }

  const resize = () => {
    const w = hero.clientWidth, h = hero.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  /* Render only while hero is visible */
  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(hero);

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    if (!visible) return;
    const t = clock.getElapsedTime();
    for (const b of bubbles) {
      b.position.y += b.userData.speed * 0.016;
      b.position.x += Math.sin(t * 0.6 + b.userData.wobble) * 0.002 * b.userData.wobbleAmp * 10;
      if (b.position.y > 6.5) {
        b.position.y = -6.5;
        b.position.x = (Math.random() - 0.5) * 14;
      }
    }
    group.rotation.x += (targetRX - group.rotation.x) * 0.04;
    group.rotation.y += (targetRY - group.rotation.y) * 0.04;
    renderer.render(scene, camera);
  });
}
