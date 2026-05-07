    (function () {
      'use strict';
      gsap.registerPlugin(ScrollTrigger);
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      /* -------- Cursor (dot + ring + 3-trail) ----- */
      const cursor = document.getElementById('cursor');
      const ring = document.getElementById('cursorRing');
      const trails = [
        document.getElementById('cursorTrail1'),
        document.getElementById('cursorTrail2'),
        document.getElementById('cursorTrail3')
      ];
      if (cursor && window.matchMedia('(hover: hover)').matches) {
        const xTo = gsap.quickTo(cursor, 'x', { duration: 0.18, ease: 'power3' });
        const yTo = gsap.quickTo(cursor, 'y', { duration: 0.18, ease: 'power3' });
        const rxTo = gsap.quickTo(ring, 'x', { duration: 0.45, ease: 'power3' });
        const ryTo = gsap.quickTo(ring, 'y', { duration: 0.45, ease: 'power3' });
        const trailTos = trails.map((el, i) => ({
          x: gsap.quickTo(el, 'x', { duration: 0.3 + i * 0.15, ease: 'power3' }),
          y: gsap.quickTo(el, 'y', { duration: 0.3 + i * 0.15, ease: 'power3' })
        }));
        window.addEventListener('mousemove', (e) => {
          xTo(e.clientX); yTo(e.clientY);
          rxTo(e.clientX); ryTo(e.clientY);
          trailTos.forEach(t => { t.x(e.clientX); t.y(e.clientY); });
        });
        document.querySelectorAll('a, button, input, select, .svc-card, .why-card, .how-step, .phone-mockup').forEach(el => {
          el.addEventListener('mouseenter', () => { ring.classList.add('is-hot'); gsap.to(cursor, { scale: 0, opacity: 0, duration: 0.18 }); });
          el.addEventListener('mouseleave', () => { ring.classList.remove('is-hot'); gsap.to(cursor, { scale: 1, opacity: 1, duration: 0.18 }); });
        });
      } else {
        [cursor, ring, ...trails].forEach(el => el && (el.style.display = 'none'));
      }

      /* -------- Magnetic CTAs (skip hero CTA. caused misalign) -------- */
      document.querySelectorAll('.nav-cta, .submit-btn, .launch-cta').forEach(btn => {
        gsap.set(btn, { x: 0, y: 0 });
        const strength = 0.3;
        btn.addEventListener('mousemove', (e) => {
          const r = btn.getBoundingClientRect();
          const x = (e.clientX - r.left - r.width / 2) * strength;
          const y = (e.clientY - r.top - r.height / 2) * strength;
          gsap.to(btn, { x, y, duration: 0.4, ease: 'power3.out' });
        });
        btn.addEventListener('mouseleave', () => gsap.to(btn, { x: 0, y: 0, duration: 0.6, ease: 'elastic.out(1, 0.4)' }));
      });

      /* -------- Heading word-split reveal -------- */
      function splitHeading(el) {
        if (el.dataset.splitDone) return;
        const html = el.innerHTML;
        // Wrap each word in a span-mask, preserving inner spans (.accent, .stroke)
        const wrapper = document.createElement('div');
        wrapper.innerHTML = html;
        const out = [];
        function walk(node) {
          if (node.nodeType === 3) {
            // text. split by word
            const txt = node.textContent;
            return txt.split(/(\s+)/).map(t => {
              if (!t.trim()) return t;
              return `<span class="word-mask"><span class="word">${t}</span></span>`;
            }).join('');
          }
          if (node.nodeType === 1) {
            if (node.tagName === 'BR') return '<br/>';
            const cls = node.getAttribute('class') || '';
            const inner = Array.from(node.childNodes).map(walk).join('');
            return `<span class="${cls}">${inner}</span>`;
          }
          return '';
        }
        el.innerHTML = Array.from(wrapper.childNodes).map(walk).join('');
        el.dataset.splitDone = '1';
      }
      document.querySelectorAll('[data-split]').forEach(splitHeading);

      // Inject the masking CSS once
      const splitStyle = document.createElement('style');
      splitStyle.textContent = `
    .word-mask { display: inline-block; overflow: hidden; vertical-align: bottom; line-height: 1.05; padding: 0 0.06em 0.06em 0; }
    .word { display: inline-block; transform: translateY(110%); padding-right: 0.04em; }
  `;
      document.head.appendChild(splitStyle);

      document.querySelectorAll('[data-split]').forEach(h => {
        if (h.classList.contains('hero-title')) return; // handled in runEntrance
        const words = h.querySelectorAll('.word');
        ScrollTrigger.create({
          trigger: h,
          start: 'top 85%',
          once: true,
          onEnter: () => gsap.to(words, { y: 0, duration: 0.9, stagger: 0.05, ease: 'power3.out' })
        });
      });

      /* -------- Preloader -------- */
      const preloader = document.getElementById('preloader');
      const pMascot = document.getElementById('preloaderMascot');
      const pLetters = document.querySelectorAll('.preloader-word span');

      const intro = gsap.timeline({ defaults: { ease: 'power3.out' } });
      intro
        .to(pMascot, { scale: 1, rotation: 360, duration: 0.9, ease: 'back.out(1.6)' })
        .to(pLetters, { opacity: 1, duration: 0.05, stagger: 0.06 }, '-=0.2')
        .to(preloader, {
          opacity: 0, duration: 0.5, delay: 0.35, onComplete: () => {
            preloader.style.display = 'none';
            runEntrance();
          }
        }, '+=0.1');

      /* -------- Hero entrance -------- */
      function runEntrance() {
        gsap.from('.nav', { y: -30, opacity: 0, duration: 0.7, ease: 'power3.out' });
        gsap.from('.hero-eyebrow', { y: 20, opacity: 0, duration: 0.7, delay: 0.1, ease: 'power3.out' });
        const heroWords = document.querySelectorAll('.hero-title .word');
        gsap.to(heroWords, { y: 0, duration: 1.0, stagger: 0.07, delay: 0.25, ease: 'power3.out' });
        gsap.from('.hero-sub', { y: 20, opacity: 0, duration: 0.8, delay: 0.55, ease: 'power3.out' });
        gsap.from('.hero-ctas > *', { y: 20, opacity: 0, duration: 0.7, stagger: 0.08, delay: 0.7, ease: 'power3.out', clearProps: 'transform' });
        gsap.from('.hero-meta', { y: 16, opacity: 0, duration: 0.7, delay: 0.95, ease: 'power3.out' });
        gsap.from('.phone-mockup', { y: 60, opacity: 0, scale: 0.94, duration: 1.1, delay: 0.3, ease: 'power3.out' });
      }

      /* -------- Phone idle float + Zop float -------- */
      if (!reduceMotion) {
        gsap.to('#heroPhone', { y: -14, duration: 4.5, repeat: -1, yoyo: true, ease: 'sine.inOut' });
        gsap.to('.ph-hero-zop', {
          keyframes: [{ rotate: -12, y: 0 }, { rotate: -12, y: -6 }, { rotate: -12, y: 0 }],
          duration: 4, repeat: -1, ease: 'sine.inOut'
        });

        // Auto-marquee of preset cards: clone the row, slide left infinitely.
        // Bolt pin + ph-rail-fade gradient mask cards as they pass underneath.
        const presets = document.querySelector('.ph-presets');
        if (presets) {
          const items = Array.from(presets.children).filter(c => c.classList.contains('ph-preset'));
          // Clone presets once for seamless loop
          items.forEach(it => presets.appendChild(it.cloneNode(true)));
          // Compute single-loop width: original items + their gaps
          requestAnimationFrame(() => {
            const totalWidth = presets.scrollWidth;
            const halfWidth = totalWidth / 2;
            gsap.to(presets, {
              x: -halfWidth,
              duration: halfWidth / 26, // ~26px/sec
              repeat: -1,
              ease: 'none',
              modifiers: { x: gsap.utils.unitize(x => parseFloat(x) % -halfWidth) }
            });
          });
        }
      }

      /* -------- Scroll-tied: bg blooms parallax + nav state -------- */
      const nav = document.getElementById('nav');
      const bloomTR = document.getElementById('bloomTR');
      const bloomBL = document.getElementById('bloomBL');

      if (!reduceMotion) {
        gsap.to(bloomTR, { yPercent: 25, xPercent: -10, scrollTrigger: { trigger: 'body', start: 'top top', end: 'bottom bottom', scrub: true } });
        gsap.to(bloomBL, { yPercent: -20, xPercent: 8, scrollTrigger: { trigger: 'body', start: 'top top', end: 'bottom bottom', scrub: true } });

        /* Hero parallax */
        gsap.to('.hero-copy', { y: -60, scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
        gsap.to('.phone-mockup', { y: -100, scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
        gsap.to('.ph-hero-zop', { y: -25, scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
      }

      // Nav: scrolled-bg toggle on body scroll; hide while phone-zoom section
      // is the active view, show before/after.
      gsap.set(nav, { xPercent: -50, left: '50%', x: 0, yPercent: 0, opacity: 1 });
      const navYTo = gsap.quickTo(nav, 'yPercent', { duration: 0.4, ease: 'power3.out' });
      const navOTo = gsap.quickTo(nav, 'opacity', { duration: 0.3, ease: 'power3.out' });
      let navHidden = false;
      const showNav = () => { if (!navHidden) return; navHidden = false; navYTo(0); navOTo(1); nav.style.pointerEvents = 'auto'; };
      const hideNav = () => { if (navHidden) return; navHidden = true; navYTo(-180); navOTo(0); nav.style.pointerEvents = 'none'; };

      window.addEventListener('scroll', () => {
        if (window.scrollY > 40) nav.classList.add('scrolled');
        else nav.classList.remove('scrolled');
      }, { passive: true });

      // Hide nav while zoom-stage / services-section occupies viewport
      const stageForNav = document.getElementById('zoomStage') || document.querySelector('.services-section');
      if (stageForNav) {
        ScrollTrigger.create({
          trigger: stageForNav,
          start: 'top top',
          end: 'bottom top',
          onEnter: hideNav,
          onLeave: showNav,
          onEnterBack: hideNav,
          onLeaveBack: showNav
        });
      }

      // Nav burger toggle (mobile)
      const navBurger = document.getElementById('navBurger');
      if (navBurger) {
        const closeMenu = () => {
          nav.classList.remove('menu-open');
          navBurger.setAttribute('aria-expanded', 'false');
        };
        navBurger.addEventListener('click', () => {
          const open = nav.classList.toggle('menu-open');
          navBurger.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        document.querySelectorAll('.nav-links a').forEach(a => a.addEventListener('click', closeMenu));
        document.addEventListener('click', (e) => {
          if (!nav.contains(e.target)) closeMenu();
        });
      }

      // Nav CTA visibility: hidden on first screen, appears once user reaches services
      const navCtaEl = document.getElementById('navCta');
      const servicesEl = document.querySelector('.services-section');
      if (navCtaEl && servicesEl) {
        ScrollTrigger.create({
          trigger: servicesEl,
          start: 'top 90%',
          onEnter:     () => navCtaEl.classList.add('is-on'),
          onEnterBack: () => navCtaEl.classList.add('is-on'),
          onLeaveBack: () => navCtaEl.classList.remove('is-on')
        });
      }

      /* -------- Phone-zoom → horizontal-pin services -------- */
      const zoomStage = document.getElementById('zoomStage');
      const phoneWin = document.getElementById('phoneWindow');
      const phoneNotch = document.getElementById('phoneNotch');
      const phoneStatus = document.getElementById('phoneStatus');
      const hRail = document.getElementById('hScrollRail');
      const hFill = document.getElementById('hProgressFill');
      const hHint = document.getElementById('hHint');
      const hProg = document.getElementById('hProgress');
      const zoomCue = document.getElementById('zoomCue');

      if (zoomStage && phoneWin && hRail && !reduceMotion && window.innerWidth > 720) {
        const getRailDist = () => Math.max(0, hRail.scrollWidth - window.innerWidth + 60);
        // Total scroll length: zoom phase (≈1.2vh) + rail phase (rail width)
        const zoomLen = () => window.innerHeight * 1.4;
        const totalLen = () => zoomLen() + getRailDist();

        // Master timeline driven by scrub
        const master = gsap.timeline({
          scrollTrigger: {
            trigger: zoomStage,
            start: 'top top',
            end: () => '+=' + totalLen(),
            pin: true,
            scrub: 1,
            invalidateOnRefresh: true,
            onUpdate: (self) => {
              // Progress fill applies to overall, but visually only matters during rail phase
              const zoomFrac = zoomLen() / totalLen();
              const railProg = self.progress <= zoomFrac ? 0 : (self.progress - zoomFrac) / (1 - zoomFrac);
              if (hFill) hFill.style.width = (railProg * 100) + '%';
              // Toggle progress + hint visibility
              if (self.progress > zoomFrac - 0.05) {
                hProg && hProg.classList.add('show');
                hHint && hHint.classList.add('show');
                zoomCue && (zoomCue.style.opacity = '0');
              } else {
                hProg && hProg.classList.remove('show');
                hHint && hHint.classList.remove('show');
                zoomCue && (zoomCue.style.opacity = '1');
              }
            }
          }
        });

        // ---- Phase 1: phone window grows from 380x780 → 100vw x 100vh, radius 56→0
        master.to(phoneWin, {
          width: () => window.innerWidth + 'px',
          height: () => window.innerHeight + 'px',
          borderRadius: 0,
          boxShadow: '0 0 0 0 transparent, 0 0 0 0 transparent, 0 0 0 rgba(0,0,0,0), 0 0 0 rgba(245,163,0,0)',
          ease: 'power2.inOut',
          duration: 1
        }, 0);
        // Notch + status bar fade out as phone fills viewport
        master.to([phoneNotch, phoneStatus], {
          opacity: 0,
          y: -30,
          duration: 0.4,
          ease: 'power2.in'
        }, 0.6);

        // ---- Phase 2: rail translates horizontally
        master.to(hRail, {
          x: () => -getRailDist(),
          ease: 'none',
          duration: 1.6
        }, 1);

        // Card stagger reveal as stage enters viewport
        gsap.from(hRail.children, {
          y: 24, opacity: 0,
          stagger: 0.06, duration: 0.6, ease: 'power3.out',
          scrollTrigger: { trigger: zoomStage, start: 'top 70%' }
        });
      } else if (zoomStage) {
        // Fallback: drop pin/zoom, show plain horizontal scrollable rail
        zoomStage.style.height = 'auto';
        zoomStage.style.padding = '40px 0';
        if (phoneWin) {
          phoneWin.style.width = '100%';
          phoneWin.style.height = 'auto';
          phoneWin.style.borderRadius = '0';
          phoneWin.style.boxShadow = 'none';
          phoneWin.style.background = 'transparent';
        }
        if (phoneNotch) phoneNotch.style.display = 'none';
        if (phoneStatus) phoneStatus.style.display = 'none';
        if (zoomCue) zoomCue.style.display = 'none';
        const railArea = document.querySelector('.phone-window-rail');
        if (railArea) {
          railArea.style.position = 'relative';
          railArea.style.inset = 'auto';
          railArea.style.height = '500px';
          railArea.style.overflowX = 'auto';
        }
        gsap.from('.h-scroll-rail > *', {
          y: 30, opacity: 0,
          stagger: 0.08, duration: 0.7, ease: 'power3.out',
          scrollTrigger: { trigger: '.h-scroll-rail', start: 'top 85%' }
        });
      }

      /* -------- Marquee infinite scroll + scroll-direction speed -------- */
      const marqueeTrack = document.getElementById('marqueeTrack');
      if (marqueeTrack) {
        const speed = 60; // px per second
        const halfWidth = () => marqueeTrack.scrollWidth / 2;
        let mx = 0;
        let direction = -1;
        let lastScroll = window.scrollY;
        let lastTime = performance.now();
        function tickMarquee(now) {
          const dt = (now - lastTime) / 1000;
          lastTime = now;
          mx += direction * speed * dt;
          const w = halfWidth();
          if (mx <= -w) mx += w;
          if (mx >= 0) mx -= w;
          marqueeTrack.style.transform = `translate3d(${mx}px, 0, 0)`;
          requestAnimationFrame(tickMarquee);
        }
        requestAnimationFrame(tickMarquee);
        window.addEventListener('scroll', () => {
          direction = window.scrollY >= lastScroll ? -1 : 1;
          lastScroll = window.scrollY;
        }, { passive: true });
        // Glyphs slow-spin
        // Subtle bob + tilt instead of full rotation
        gsap.to('.marquee-glyph', {
          y: -6,
          rotation: 6,
          duration: 2.4,
          repeat: -1,
          yoyo: true,
          ease: 'sine.inOut'
        });
      }

      /* -------- Service cards reveal w/ tilt on hover -------- */
      document.querySelectorAll('.svc-card').forEach(card => {
        const img = card.querySelector('.svc-img');
        card.addEventListener('mousemove', (e) => {
          const r = card.getBoundingClientRect();
          const px = (e.clientX - r.left) / r.width - 0.5;
          const py = (e.clientY - r.top) / r.height - 0.5;
          gsap.to(card, { rotateX: -py * 6, rotateY: px * 8, duration: 0.4, ease: 'power2.out', transformPerspective: 800 });
          if (img) gsap.to(img, { x: px * 6, y: py * 6, duration: 0.4, ease: 'power2.out' });
        });
        card.addEventListener('mouseleave', () => {
          gsap.to(card, { rotateX: 0, rotateY: 0, duration: 0.5, ease: 'power3.out' });
          if (img) gsap.to(img, { x: 0, y: 0, duration: 0.5, ease: 'power3.out' });
        });
      });

      /* -------- Mascot section -------- */
      ScrollTrigger.create({
        trigger: '.mascot-section',
        start: 'top 75%',
        once: true,
        onEnter: () => {
          gsap.fromTo('#zopBig',
            { scale: 0, rotation: -180, opacity: 0 },
            {
              scale: 1, rotation: 0, opacity: 1, duration: 1.2, ease: 'back.out(1.7)',
              onComplete: () => { gsap.to('#zopBig', { y: -18, duration: 2.6, repeat: -1, yoyo: true, ease: 'sine.inOut' }); }
            }
          );
          gsap.from('.mascot-caption', { y: 30, opacity: 0, duration: 0.8, delay: 0.3 });
          gsap.from('.mascot-body', { y: 20, opacity: 0, duration: 0.8, delay: 0.5 });
          gsap.from('.stat-block', { y: 24, opacity: 0, duration: 0.7, delay: 0.65, stagger: 0.12 });
        }
      });

      /* -------- Stat counters -------- */
      document.querySelectorAll('.stat-number').forEach(el => {
        const target = parseFloat(el.dataset.target) || 0;
        const suffix = el.dataset.suffix || '';
        const obj = { val: 0 };
        ScrollTrigger.create({
          trigger: el, start: 'top 85%', once: true,
          onEnter: () => {
            gsap.to(obj, {
              val: target, duration: 2, ease: 'power2.out',
              onUpdate: () => { el.textContent = Math.round(obj.val) + suffix; }
            });
          }
        });
      });

      /* -------- Doors theatre (screen-becomes-next-door) ------------------ */
      const doorsSection = document.querySelector('.doors-section');
      const doorsPin     = document.getElementById('doorsPin');
      const layerInit    = document.getElementById('layerInit');
      const layer1       = document.getElementById('layer1');
      const layer2       = document.getElementById('layer2');
      const orbEl        = document.getElementById('checkOrb');
      const confettiEl   = document.getElementById('howConfetti');

      if (doorsSection && doorsPin && layerInit && layer1 && layer2 && !reduceMotion) {
        // Initial: all halves at center (looks closed).
        [layerInit, layer1, layer2].forEach(layer => {
          gsap.set(layer.querySelector('.half.left'),  { x: '0%' });
          gsap.set(layer.querySelector('.half.right'), { x: '0%' });
        });
        gsap.set('#checkOrb', { scale: 0, opacity: 0 });

        const tl = gsap.timeline({
          defaults: { ease: 'power3.inOut' },
          scrollTrigger: {
            trigger: doorsSection,
            start: 'top top',
            end: '+=400%',
            pin: doorsPin,
            scrub: 1,
            invalidateOnRefresh: true
          }
        });

        // Helper: split a layer (slide its halves outward)
        function split (layer, t0, dur) {
          tl.to(layer.querySelector('.half.left'),  { x: '-105%', duration: dur }, t0)
            .to(layer.querySelector('.half.right'), { x: '105%',  duration: dur }, t0);
        }

        // 1st split: init blank doors → reveal scene 1
        split(layerInit, 0.00, 0.24);
        // 2nd split: scene 1 → scene 2
        split(layer1,    0.34, 0.24);
        // 3rd split: scene 2 → finale (tick)
        split(layer2,    0.66, 0.24);

        // Tick + confetti pop — fires as the final door is opening
        tl.add(() => {
          if (orbEl)     orbEl.classList.add('is-popped');
          if (confettiEl) confettiEl.classList.add('is-active');
        }, 0.78)
        .add(() => {
          if (orbEl)     orbEl.classList.remove('is-popped');
          if (confettiEl) confettiEl.classList.remove('is-active');
        }, 0.76);
      } else {
        // Reduced motion fallback: show only finale, all doors slid open.
        [layerInit, layer1, layer2].forEach(l => {
          if (!l) return;
          gsap.set(l.querySelector('.half.left'),  { x: '-110%' });
          gsap.set(l.querySelector('.half.right'), { x: '110%'  });
        });
        if (orbEl) orbEl.classList.add('is-popped');
        if (confettiEl) confettiEl.classList.add('is-active');
      }

      /* -------- Why grid reveal -------- */
      gsap.from('.why-card', {
        y: 50, opacity: 0,
        stagger: 0.10, duration: 0.8, ease: 'power3.out',
        scrollTrigger: { trigger: '.why-grid', start: 'top 80%' }
      });

      /* -------- Trust strip -------- */
      gsap.from('.trust-col', {
        y: 30, opacity: 0,
        stagger: 0.10, duration: 0.7, ease: 'power3.out',
        scrollTrigger: { trigger: '.trust-strip', start: 'top 85%' }
      });

      /* -------- Waitlist -------- */
      gsap.fromTo('.waitlist-card',
        { scale: 0.94, opacity: 0, y: 40 },
        {
          scale: 1, opacity: 1, y: 0, duration: 0.9, ease: 'power3.out',
          scrollTrigger: { trigger: '#waitlist', start: 'top 70%' }
        }
      );
      gsap.fromTo('.waitlist-zop',
        { scale: 0, rotation: -120 },
        {
          scale: 1, rotation: 0, duration: 0.9, ease: 'back.out(1.6)', delay: 0.3,
          scrollTrigger: { trigger: '#waitlist', start: 'top 70%' }
        }
      );

      /* -------- Smooth scroll -------- */
      document.querySelectorAll('[data-scroll]').forEach(link => {
        link.addEventListener('click', (e) => {
          const href = link.getAttribute('href');
          if (href && href.startsWith('#')) {
            e.preventDefault();
            const tgt = document.querySelector(href);
            if (tgt) {
              const offset = tgt.getBoundingClientRect().top + window.scrollY - 24;
              window.scrollTo({ top: offset, behavior: 'smooth' });
            }
          }
        });
      });

      /* -------- Form select color -------- */
      const sel = document.querySelector('.form-select');
      if (sel) sel.addEventListener('change', () => sel.classList.toggle('has-value', !!sel.value));

      /* -------- Waitlist form (Web3Forms) -------- */
      const WEB3FORMS_KEY = 'a6064cac-2234-4e78-aabd-add219fb4741';
      const form = document.getElementById('waitlistForm');
      const btn = document.getElementById('submitBtn');
      const btnLabel = btn.querySelector('.btn-label');
      const successLine = document.getElementById('successLine');

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (btn.classList.contains('is-loading') || btn.classList.contains('is-success')) return;

        const data = new FormData(form);
        const email = (data.get('email') || '').toString().trim();
        if (!data.get('name') || !email || !data.get('city') || !data.get('area')) {
          gsap.fromTo(form, { x: -8 }, { x: 0, duration: 0.5, ease: 'elastic.out(1, 0.4)' });
          return;
        }
        // Normalize checkbox values for the email payload
        data.set('early_access', form.querySelector('[name="early_access"]').checked ? 'yes' : 'no');
        data.set('newsletter',   form.querySelector('[name="newsletter"]').checked   ? 'yes' : 'no');

        // Web3Forms required + helpful fields
        data.append('access_key', WEB3FORMS_KEY);
        data.append('subject', `ZopMop waitlist signup — ${data.get('name')}`);
        data.append('from_name', 'ZopMop Waitlist');
        data.append('botcheck', ''); // honeypot
        // Disable the default Web3Forms thank-you page redirect
        data.append('redirect', 'false');

        btn.classList.add('is-loading');
        btnLabel.textContent = '';

        try {
          const res = await fetch('https://api.web3forms.com/submit', {
            method: 'POST',
            body: data,
            headers: { 'Accept': 'application/json' }
          });
          const json = await res.json().catch(() => ({}));

          if (res.ok && json.success) {
            btn.classList.remove('is-loading');
            btn.classList.add('is-success');
            btnLabel.textContent = "✓  You're on the list!";
            successLine.textContent = `We'll notify ${email} when ZopMop launches near you.`;
            successLine.classList.add('show');
            form.querySelectorAll('input, select').forEach(i => i.setAttribute('disabled', 'true'));
          } else {
            throw new Error(json.message || 'Submission failed');
          }
        } catch (err) {
          btn.classList.remove('is-loading');
          btnLabel.textContent = 'Try again';
          successLine.textContent = 'Something went wrong. Please retry or email hello@zopmop.com.';
          successLine.classList.add('show');
          gsap.fromTo(form, { x: -8 }, { x: 0, duration: 0.5, ease: 'elastic.out(1, 0.4)' });
        }
      });

      /* -------- Zop sidekick: per-section expression + bob -------- */

      /* -------- Zop peekers reveal -------- */
      document.querySelectorAll('[data-peek]').forEach(peek => {
        const dir = peek.classList.contains('tl') || peek.classList.contains('bl') ? -1 : 1;
        const isTop = peek.classList.contains('tl') || peek.classList.contains('tr');
        gsap.set(peek, { opacity: 0, y: isTop ? -80 : 80, x: dir * 30 });
        ScrollTrigger.create({
          trigger: peek.parentElement,
          start: 'top 70%',
          onEnter: () => gsap.to(peek, { opacity: 1, y: 0, x: 0, duration: 1.0, ease: 'back.out(1.4)' }),
          onLeaveBack: () => gsap.to(peek, { opacity: 0, y: isTop ? -80 : 80, x: dir * 30, duration: 0.5, ease: 'power3.in' })
        });
        // idle wiggle
        gsap.to(peek.querySelector('img'), { rotation: dir * 6, duration: 2.4, repeat: -1, yoyo: true, ease: 'sine.inOut' });
      });

      /* -------- Phone scroll-tilt (3D) -------- */
      if (!reduceMotion) {
        gsap.to('.phone-mockup', {
          rotateY: -8,
          rotateX: 4,
          scrollTrigger: {
            trigger: '.hero',
            start: 'top top',
            end: 'bottom top',
            scrub: 1
          },
          transformPerspective: 1200,
          transformOrigin: 'center center'
        });
      }

      /* -------- Launch popup (Gurugram) -------- */
      const launchModal = document.getElementById('launchModal');
      const launchClose = document.getElementById('launchClose');
      const launchCta   = document.getElementById('launchCta');
      const navLaunchOpen = document.getElementById('navLaunchOpen');
      function openLaunch () {
        if (!launchModal) return;
        launchModal.classList.add('open');
        launchModal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
      }
      function closeLaunch () {
        if (!launchModal) return;
        launchModal.classList.remove('open');
        launchModal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
      }
      if (launchClose) launchClose.addEventListener('click', closeLaunch);
      if (launchCta) launchCta.addEventListener('click', () => { closeLaunch(); /* data-scroll handles smooth-scroll to #waitlist */ });
      if (launchModal) launchModal.addEventListener('click', (e) => { if (e.target === launchModal) closeLaunch(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLaunch(); });
      if (navLaunchOpen) navLaunchOpen.addEventListener('click', (e) => { e.preventDefault(); openLaunch(); });

      // Auto-show every page load
      setTimeout(openLaunch, 2400);

      /* -------- Refresh ScrollTrigger after fonts -------- */
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => ScrollTrigger.refresh());
      }
    })();
