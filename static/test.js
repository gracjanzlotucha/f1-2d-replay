/**
 * test.js — Bahrain Pre-Season Testing Replay (static data loader)
 *
 * Points app.js at pre-generated test-data.json + test-positions.json
 * (created by scripts/generate_test.js), then loads app.js.
 * Loads instantly — no API calls at page load.
 */

window.__F1_DATA_URLS = {
  data: './test-data.json',
  positions: './test-positions.json',
};

// Load app.js dynamically
const script = document.createElement('script');
script.src = 'app.js';
script.onerror = () => {
  document.getElementById('loading-msg').textContent = 'Failed to load replay engine';
};
document.body.appendChild(script);
