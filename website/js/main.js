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
      color: '#0D0D0F',
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
  sectionReveal('.quote > *', '.quote');

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

  /* ---------- Three.js bubble field ---------- */
  if (!prefersReduced) initBubbles().catch(() => { /* hero glows remain as fallback */ });
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
  const indigoMat = soapMat.clone();
  indigoMat.color = new THREE.Color(0x818cf8);
  indigoMat.iridescenceIOR = 1.6;
  const amberMat = soapMat.clone();
  amberMat.color = new THREE.Color(0xffc042);

  const mats = [soapMat, soapMat, soapMat, indigoMat, amberMat];
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
