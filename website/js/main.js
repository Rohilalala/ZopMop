/* ZopMop landing — GSAP orchestration + Three.js bubble field */

const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/* ?static=1 — QA/screenshot mode: plain page, no animation states */
const staticMode = new URLSearchParams(location.search).has('static');

/* ---------- GSAP-free bits: run in every mode (static QA, CDN failure) ---------- */
/* Theme toggle (mirrors app's 340ms dark<->light morph — the morph itself is CSS) */
document.getElementById('theme-toggle')?.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', next === 'dark' ? '#0A0A0A' : '#FAF7F2');
  try { localStorage.setItem('zopmop_theme', next); } catch (e) { /* private mode */ }
});
/* Ghosted numeral watermark on the service slabs */
document.querySelectorAll('.card').forEach((card) => {
  const ghost = document.createElement('span');
  ghost.className = 'card__ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.textContent = card.querySelector('.card__index')?.textContent ?? '';
  card.appendChild(ghost);
});

/* If CDN libs failed, degrade to a static (but fully readable) page. */
if (staticMode || typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined') {
  document.documentElement.classList.add('no-js');
  document.querySelector('.preloader')?.remove();
} else {
  init();
}

function init() {
  gsap.registerPlugin(ScrollTrigger);

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
  /* re-measure once the headline is in its final place — Zop's perch
     (#zop-anchor) is inside the masked h-line, so any measurement taken
     before this point is ~1 line-height too low */
  heroTl.eventCallback('onComplete', () => ScrollTrigger.refresh());
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => ScrollTrigger.refresh()).catch(() => {});
  }

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
      el.addEventListener('mouseleave', () => { mx(0); my(0); });
    });
  }

  /* ---------- Scroll choreography (skipped under prefers-reduced-motion:
     content renders in its final state, counters jump to their values) ---------- */
  if (prefersReduced) {
    document.querySelectorAll('[data-count]').forEach((el) => { el.textContent = el.dataset.count; });
  }

  /* ---------- Manifesto: word-by-word ink reveal ---------- */
  const manifesto = document.getElementById('manifesto-text');
  if (manifesto && !prefersReduced) {
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

  if (!prefersReduced) {
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
  let cardsReady = false;
  gsap.from('.card', {
    y: 70, opacity: 0, rotateZ: 2.5, duration: 1, stagger: 0.09, ease: 'power3.out',
    scrollTrigger: { trigger: '.services', start: 'top 70%' },
    onComplete: () => { cardsReady = true; },
  });

  /* ---------- Liquid-glass slabs: cursor specular + 3D tilt ---------- */
  if (window.matchMedia('(pointer: fine)').matches && !prefersReduced) {
    document.querySelectorAll('.card').forEach((card) => {
      gsap.set(card, { transformPerspective: 1000 });
      const rx = gsap.quickTo(card, 'rotationX', { duration: 0.5, ease: 'power3' });
      const ry = gsap.quickTo(card, 'rotationY', { duration: 0.5, ease: 'power3' });
      const ty = gsap.quickTo(card, 'y', { duration: 0.5, ease: 'power3' });
      let rect = null;
      card.addEventListener('mouseenter', () => { rect = card.getBoundingClientRect(); });
      card.addEventListener('mousemove', (e) => {
        if (!cardsReady || !rect) return;
        const px = (e.clientX - rect.left) / rect.width;
        const py = (e.clientY - rect.top) / rect.height;
        card.style.setProperty('--mx', `${px * 100}%`);
        card.style.setProperty('--my', `${py * 100}%`);
        ry((px - 0.5) * 10);
        rx((0.5 - py) * 8);
        ty(-12);
      });
      card.addEventListener('mouseleave', () => { rx(0); ry(0); ty(0); });
    });
  }
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
  } /* end !prefersReduced scroll choreography */

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
  const heroScale = () => (isMobile() ? 1.0 : 1.6);
  /* perch ABOVE-RIGHT of the "handled." full stop — never on the glyphs
     (the idle float is ±9px, so keep ~0.75 of his size of clearance) */
  const heroXY = () => {
    const r = anchor.getBoundingClientRect();
    const s = BOX * heroScale();
    const cx = r.left + window.scrollX + r.width / 2;
    const cy = r.top + window.scrollY + r.height / 2;
    let vcx = cx + s * 0.45;
    /* mobile: the right edge clamps him inward, so go higher — into the
       empty space right of the shorter "Home," line */
    const vcy = cy - s * (isMobile() ? 1.1 : 0.75);
    vcx = Math.min(vcx, window.scrollX + window.innerWidth - s / 2 - 12);
    return { x: vcx - BOX / 2, y: vcy - BOX / 2 };
  };

  /* ---- star bursts + sparkle trail ---- */
  function spawnStars(cx, cy, n, opts = {}) {
    for (let i = 0; i < n; i++) {
      const s = document.createElement('span');
      s.textContent = '✦';
      s.setAttribute('aria-hidden', 'true');
      Object.assign(s.style, {
        position: 'fixed', left: `${cx}px`, top: `${cy}px`,
        color: opts.color || '#FFC042', fontSize: `${opts.size || 14}px`,
        zIndex: 8599, pointerEvents: 'none',
      });
      document.body.appendChild(s);
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.9;
      const d = (opts.dist || 46) + Math.random() * 42;
      gsap.to(s, {
        x: Math.cos(a) * d, y: Math.sin(a) * d - (opts.lift ?? 18),
        rotation: Math.random() * 240 - 120, opacity: 0, scale: 0.4,
        duration: opts.dur || 0.8, ease: 'power2.out', onComplete: () => s.remove(),
      });
    }
  }

  zop.classList.add('zop--hero-side');
  const perch = () => gsap.set(zop, { ...heroXY(), scale: heroScale() });
  perch();
  /* the anchor moves when the headline reveal lands / fonts swap / resize —
     re-perch on every ScrollTrigger refresh so leg-1 starts from truth */
  ScrollTrigger.addEventListener('refreshInit', perch);

  /* birth: pop out of the headline once the reveal has fully landed */
  gsap.from(bob, { scale: 0, rotation: -135, duration: 0.7, ease: 'back.out(1.6)', delay: 2.9 });
  /* lissajous idle float — livelier than a straight bob */
  gsap.to(bob, { y: -9, duration: 1.7, yoyo: true, repeat: -1, ease: 'sine.inOut' });
  gsap.to(bob, { x: 6, duration: 2.6, yoyo: true, repeat: -1, ease: 'sine.inOut' });

  /* roll that always lands flat: tween to the next clean multiple of 360 */
  function roll(dur = 0.75, ease = 'back.out(1.2)') {
    const cur = Number(gsap.getProperty(bob, 'rotation')) || 0;
    gsap.to(bob, { rotation: (Math.floor(cur / 360) + 1) * 360, duration: dur, ease });
  }
  /* vertical hops live on svgEl — bob's y belongs to the lissajous float */
  function hop(height, withSquash = true) {
    const tl = gsap.timeline();
    if (withSquash) {
      tl.to(bob, { scaleY: 0.75, scaleX: 1.2, duration: 0.12 })
        .to(bob, { scaleY: 1, scaleX: 1, duration: 0.3, ease: 'back.out(2.5)' }, '<0.12');
    }
    tl.to(svgEl, { y: -height, duration: 0.35, ease: 'back.out(2.2)' }, 0)
      .to(svgEl, { y: 0, duration: 0.5, ease: 'bounce.out' });
    return tl;
  }

  /* hero → dock: dive off the headline, rolling sweep across the marquee
     band (sparkle trail behind him), then land in the corner with a bounce */
  let docked = false;
  let lastTrail = 0;
  const flight = gsap.timeline({
    scrollTrigger: {
      trigger: '.hero', start: '8% top', end: '110% top', scrub: 0.7,
      invalidateOnRefresh: true,
      onUpdate: (self) => {
        zop.classList.toggle('zop--hero-side', self.progress < 0.4);
        /* the bubble + zzz live inside the rotating container — keep them level */
        const rot = Number(gsap.getProperty(zop, 'rotation')) || 0;
        gsap.set([bubble, zzz], { rotation: -rot });
        const wasDocked = docked;
        docked = self.progress > 0.96;
        if (docked && !wasDocked) {
          gsap.fromTo(bob, { scaleY: 0.7, scaleX: 1.25 }, { scaleY: 1, scaleX: 1, duration: 0.6, ease: 'elastic.out(1, 0.4)' });
          const r = zop.getBoundingClientRect();
          spawnStars(r.left + r.width / 2, r.bottom - 6, 5, { dist: 30, size: 10, lift: 4, dur: 0.6 });
        }
        if (self.progress > 0.25 && self.progress < 0.85) {
          const now = performance.now();
          if (now - lastTrail > 70 && Math.abs(self.getVelocity()) > 100) {
            lastTrail = now;
            const r = zop.getBoundingClientRect();
            spawnStars(r.left + r.width / 2, r.top + r.height / 2, 1, { dist: 26, size: 9, lift: 0, dur: 0.55 });
          }
        }
      },
    },
  });
  flight
    .to(zop, {
      x: () => heroXY().x - window.innerWidth * 0.18,
      y: () => heroXY().y + window.innerHeight * 0.34,
      rotation: -24, scale: () => heroScale() * 0.9,
      ease: 'power1.in', duration: 1,
    })
    .to(zop, {
      x: () => window.innerWidth * 0.62,
      y: () => heroXY().y + window.innerHeight * 0.42,
      rotation: 400, scale: () => heroScale() * 0.8,
      ease: 'none', duration: 1.3,
    })
    .to(zop, {
      x: () => dockX(), y: () => dockY(),
      rotation: 720, scale: () => dockScale(),
      ease: 'power2.out', duration: 1,
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

  /* ---- section reactions (lines from the old site) — roll into each one ---- */
  const reactions = [
    ['#why', 'smug', 'Zop lives for the job. Yours, specifically.', null],
    ['#services', 'cool', 'Pick your first job.', null],
    ['#how', 'thinking', 'Two taps. Done.', null],
    ['.stats', 'smug', '100% verified pros', null],
    ['#get-app', 'love', 'Get early access.', () => {
      /* big celebratory leap + two-tone heart burst */
      hop(30);
      const r = zop.getBoundingClientRect();
      spawnStars(r.left + r.width / 2, r.top + r.height / 2, 5, { color: '#E63946', dist: 40 });
      spawnStars(r.left + r.width / 2, r.top + r.height / 2, 5, { dist: 58 });
    }],
  ];
  reactions.forEach(([sel, face, line, fx]) => {
    const react = () => {
      wake();
      setFace(face);
      say(line);
      roll();
      if (fx) fx();
    };
    ScrollTrigger.create({ trigger: sel, start: 'top 62%', onEnter: react, onEnterBack: react });
  });

  /* ---- docked antics: he never just sits there ---- */
  const antics = [
    () => roll(0.8, 'back.inOut(1.2)'),
    () => hop(18),
    () => { setFace('tongue'); gsap.delayedCall(0.9, () => setFace('default', false)); },
    () => { setFace('wink'); gsap.delayedCall(0.7, () => setFace('default', false)); },
  ];
  (function antic() {
    gsap.delayedCall(8 + Math.random() * 6, () => {
      if (docked && !sleeping && !document.hidden && current !== 'dizzy') {
        antics[Math.floor(Math.random() * antics.length)]();
      }
      antic();
    });
  })();

  /* ---- lean into the services rail while it scrubs sideways ----
     (rotates svgEl, not bob — bob's rotation belongs to rolls/antics
     and a quickTo sharing that channel gets its tween overwritten) */
  const leanTo = gsap.quickTo(svgEl, 'rotation', { duration: 0.4, ease: 'power2' });
  ScrollTrigger.create({
    trigger: '.services', start: 'top top', end: 'bottom top',
    onUpdate: (self) => { if (!sleeping) leanTo(gsap.utils.clamp(-14, 14, self.getVelocity() / 60)); },
    onLeave: () => leanTo(0),
    onLeaveBack: () => leanTo(0),
  });

  /* ---- he notices your cursor when you get close ---- */
  if (window.matchMedia('(pointer: fine)').matches) {
    let near = false;
    window.addEventListener('mousemove', (e) => {
      if (!docked || sleeping) return;
      const r = zop.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const isNear = dx * dx + dy * dy < 130 * 130;
      if (isNear !== near) {
        near = isNear;
        if (isNear && current === 'default') {
          setFace('happy');
          gsap.to(bob, { scale: 1.12, duration: 0.3, ease: 'back.out(2)' });
        } else if (!isNear) {
          if (current === 'happy') setFace('default', false);
          gsap.to(bob, { scale: 1, duration: 0.3 });
        }
      }
    }, { passive: true });
  }

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
    leanTo(0);
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
    leanTo(0);
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
    hop(22);
    const r = zop.getBoundingClientRect();
    spawnStars(r.left + r.width / 2, r.top + r.height / 2, 6);
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
