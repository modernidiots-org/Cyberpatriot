// server.js
// Simple Express proxy that scrapes scoreboard.uscyberpatriot.org and returns a JSON list of teams + scores.
// Usage: node server.js
// Install: npm install express node-fetch@2 cheerio cors

const express = require('express');
const path = require('path');
const fetch = require('node-fetch'); // v2
const cheerio = require('cheerio');
const cors = require('cors');

const SCOREBOARD_URL = 'https://scoreboard.uscyberpatriot.org/';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());

// serve the front-end (index.html and any other static assets) from the repo root
app.use(express.static(path.join(__dirname)));

// simple in-memory cache to avoid hammering the scoreboard
let cache = {
  ts: 0,
  ttl: 30 * 1000, // cache for 30 seconds
  data: null
};

async function fetchTeams() {
  const now = Date.now();
  if (cache.data && (now - cache.ts) < cache.ttl) {
    return cache.data;
  }

  const res = await fetch(SCOREBOARD_URL, { headers: { 'User-Agent': 'Scoreboard-Scraper/1.0' }});
  if (!res.ok) throw new Error('Failed to fetch scoreboard: ' + res.status);
  const html = await res.text();
  const $ = cheerio.load(html);

  // Read the header row so columns are located by name, not position.
  const headerCells = $('table tr').first().find('th, td').map((i, el) => $(el).text().trim().toLowerCase()).get();
  const col = (re) => headerCells.findIndex(h => re.test(h));
  const idx = {
    number: col(/team\s*(number|#|id)?$/),
    location: col(/locat/),
    division: col(/division/),
    tier: col(/tier/),
    score: col(/(current|total)?\s*score$/)
  };
  if (idx.score === -1) idx.score = col(/score/);

  const parsed = [];
  $('table tr').each((i, el) => {
    const tds = $(el).find('td');
    if (!tds.length) return;
    const cells = Array.from(tds).map(td => $(td).text().trim());
    const get = (k) => (idx[k] >= 0 && cells[idx[k]] !== undefined) ? cells[idx[k]] : null;
    const scoreMatch = (get('score') || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    parsed.push({
      teamNumber: get('number') || cells[0] || null,
      location: get('location'),
      division: get('division'),
      tier: get('tier'),
      score: scoreMatch ? parseFloat(scoreMatch[0]) : null,
      raw: cells
    });
  });

  const filtered = parsed.filter(p => p.teamNumber);
  filtered.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));

  // competition ranking (ties share a rank) overall and within each division
  const rankOf = (list) => {
    const m = new Map();
    list.forEach((t, i) => {
      const prev = list[i - 1];
      m.set(t, prev && prev.score === t.score ? m.get(prev) : i + 1);
    });
    return m;
  };
  const overall = rankOf(filtered);
  const byDiv = {};
  filtered.forEach(t => (byDiv[t.division || ''] = byDiv[t.division || ''] || []).push(t));
  const divRank = new Map(), divSize = {};
  Object.entries(byDiv).forEach(([d, list]) => { divSize[d] = list.length; rankOf(list).forEach((r, t) => divRank.set(t, r)); });
  filtered.forEach(t => {
    t.nationalRank = overall.get(t);
    t.nationalTotal = filtered.length;
    t.divisionRank = divRank.get(t);
    t.divisionTotal = divSize[t.division || ''];
  });

  cache = { ts: Date.now(), ttl: cache.ttl, data: filtered };
  return filtered;
}

const fs = require('fs');
const norm = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Only the school's teams (listed in teams.json), ranked within the school, with national ranks attached.
app.get('/api/school', async (req, res) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'teams.json'), 'utf8'));
    const mine = new Map((cfg.teams || []).map(t => [norm(t), t]));
    const all = await fetchTeams();
    const found = all.filter(t => mine.has(norm(t.teamNumber)));
    const foundSet = new Set(found.map(t => norm(t.teamNumber)));
    const missing = [...mine.entries()].filter(([k]) => !foundSet.has(k)).map(([, v]) => v);
    found.forEach((t, i) => { t.schoolRank = i + 1; });
    res.json({ school: cfg.school || '', updated: new Date().toISOString(), count: found.length, missing, teams: found });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build school view', details: err.message });
  }
});

app.get('/api/teams', async (req, res) => {
  try {
    const teams = await fetchTeams();
    res.json({ updated: new Date().toISOString(), count: teams.length, teams });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch scoreboard', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Leaderboard running on http://localhost:${PORT}`);
  console.log(`API endpoint: http://localhost:${PORT}/api/teams`);
});
