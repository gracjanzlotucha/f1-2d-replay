/**
 * F1 2D Replay — MultiView extensions.
 * Loaded after app.js on multi.html. Adds detachable panels: each panel can be
 * popped out into its own browser window (panel.html) and kept in sync via
 * BroadcastChannel. The main window stays the playback clock master; popups
 * load the same static data themselves and only receive the clock + commands.
 *
 * Protocol (channel "f1-replay-sync"):
 *   main → panels : { type:'state', t, playing, speed, lap, follow, wall }
 *   main → panels : { type:'main-hello' } / { type:'main-bye' }
 *   panel → main  : { type:'panel-open', panel } / { type:'panel-close', panel }
 *   panel → main  : { type:'cmd', action:'seek'|'play'|'pause'|'toggle'|'follow', ... }
 */

'use strict';

(function () {
  const TAB_PANELS = ['insights', 'events', 'track'];
  const PANEL_FEATURES = {
    standings: 'width=920,height=920',
    insights:  'width=400,height=840',
    events:    'width=400,height=780',
    track:     'width=400,height=640',
  };

  const bc = new BroadcastChannel('f1-replay-sync');
  const detached = { standings: false, insights: false, events: false, track: false };
  const wins = {}; // panel -> WindowProxy

  // ── State broadcasting (clock master) ────────────────────────────────────
  function sendState() {
    if (typeof G === 'undefined' || !G.maxT) return;
    bc.postMessage({
      type: 'state',
      t: G.currentT,
      playing: G.playing,
      speed: G.speed,
      lap: G.currentLap,
      follow: G.followDriver,
      wall: Date.now(),
    });
  }
  setInterval(sendState, 200);

  // Instant echo on seek / play-pause so popups don't lag the scrubber.
  // Top-level function declarations are mutable globals in classic scripts,
  // so wrapping them here also affects internal callers in app.js.
  const _seekToT = window.seekToT;
  window.seekToT = function (t) { _seekToT(t); sendState(); };
  const _togglePlay = window.togglePlay;
  window.togglePlay = function () { _togglePlay(); sendState(); };

  // ── Incoming messages ─────────────────────────────────────────────────────
  bc.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'panel-open' && m.panel in detached) {
      setDetached(m.panel, true);
      sendState();
    } else if (m.type === 'panel-close' && m.panel in detached) {
      setDetached(m.panel, false);
    } else if (m.type === 'cmd') {
      handleCmd(m);
    }
  };

  function handleCmd(m) {
    if (typeof G === 'undefined') return;
    switch (m.action) {
      case 'seek':   if (typeof m.t === 'number') seekToT(m.t); break;
      case 'play':   if (!G.playing) togglePlay(); break;
      case 'pause':  if (G.playing) togglePlay(); break;
      case 'toggle': togglePlay(); break;
      case 'follow':
        if (m.driver && G.drivers[m.driver]) {
          if (G.followDriver === m.driver) { stopFollowing(); }
          else { G.followDriver = m.driver; G.followZoom = 3; renderStandings(); }
        } else {
          stopFollowing();
        }
        break;
    }
    sendState();
  }

  // ── Detach / reattach ────────────────────────────────────────────────────
  function openPanel(panel) {
    const url = 'panel.html?panel=' + encodeURIComponent(panel);
    const w = window.open(url, 'f1-panel-' + panel, 'popup=yes,' + PANEL_FEATURES[panel]);
    if (!w) {
      showShareToast('Popup blocked — allow popups to detach panels');
      return;
    }
    wins[panel] = w;
    try { w.focus(); } catch (_) {}
    // detached state is set when the popup reports panel-open
  }

  // Backup close detection (pagehide can be missed on hard window kill)
  setInterval(() => {
    for (const panel in wins) {
      if (detached[panel] && wins[panel] && wins[panel].closed) {
        setDetached(panel, false);
      }
    }
  }, 1000);

  function setDetached(panel, isDetached) {
    if (detached[panel] === isDetached) return;
    detached[panel] = isDetached;
    if (!isDetached) delete wins[panel];

    if (panel === 'standings') {
      document.body.classList.toggle('mv-d-standings', isDetached);
    } else {
      updateTabs();
    }
  }

  function updateTabs() {
    const tabBar = document.querySelector('.insights-panel .panel-tab-bar');
    if (!tabBar) return;

    let visibleCount = 0;
    let firstVisible = null;
    let activeHidden = false;

    for (const name of TAB_PANELS) {
      const tab = tabBar.querySelector(`.seg-tab[data-tab="${name}"]`);
      if (!tab) continue;
      const hide = detached[name];
      tab.classList.toggle('mv-tab-hidden', hide);
      if (hide) {
        if (tab.classList.contains('active')) {
          tab.classList.remove('active');
          activeHidden = true;
        }
        // Hide its content pane too
        contentEl(name)?.classList.add('hidden');
      } else {
        visibleCount++;
        if (!firstVisible) firstVisible = tab;
      }
    }

    // Whole right panel collapses when all three tabs are detached
    document.body.classList.toggle('mv-d-right', visibleCount === 0);

    // Make sure one remaining tab is active
    if (visibleCount > 0) {
      const active = tabBar.querySelector('.seg-tab.active:not(.mv-tab-hidden)');
      if (!active || activeHidden) {
        (firstVisible || tabBar.querySelector('.seg-tab:not(.mv-tab-hidden)')).click();
      } else {
        // Re-position the segmented-control indicator after layout change
        requestAnimationFrame(() => moveSegIndicator(active));
      }
    }
  }

  function contentEl(name) {
    return document.getElementById({
      insights: 'race-insights-content',
      events: 'events-content',
      track: 'track-content',
    }[name]);
  }

  // ── Buttons ──────────────────────────────────────────────────────────────
  document.getElementById('btn-detach-standings')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openPanel('standings');
  });

  document.getElementById('btn-detach-tab')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const active = document.querySelector('.insights-panel .seg-tab.active:not(.mv-tab-hidden)');
    if (active) openPanel(active.dataset.tab);
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────
  // If the main page was reloaded while popups are open, ask them to
  // re-register so their panels get hidden here again.
  bc.postMessage({ type: 'main-hello' });

  window.addEventListener('pagehide', () => {
    bc.postMessage({ type: 'main-bye' });
  });
})();
