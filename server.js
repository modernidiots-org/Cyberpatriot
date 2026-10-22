// server.js
// Simple Express proxy that scrapes scoreboard.uscyberpatriot.org and returns a JSON list of teams + scores.
// Usage: node server.js
// Install: npm install express node-fetch@2 cors

const express = require('express');
const path = require('path');
const fetch = require('node-fetch'); // v2
const cors = require('cors');

const SCORES_URL = 'https://scoreboard.uscyberpatriot.org/api/team/scores.php';
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

  const res = await fetch(SCORES_URL, { headers: { 'User-Agent': 'Scoreboard-Scraper/1.0' }});
  if (!res.ok) throw new Error('Failed to fetch scoreboard: ' + res.status);
  const rows = (await res.json()).data || [];

  // The scoreboard page fills its table from this JSON endpoint, so use it directly.
  const parsed = rows.map(r => {
    const n = parseFloat(String(r.total ?? r.ccs_score ?? '').replace(/,/g, ''));
    return {
      teamNumber: r.team_number || null,
      location: r.location || null,
      division: r.division || null,
      tier: r.tier || null,
      images: r.images ?? null,
      playTime: r.play_time || null,
      scoreTime: r.score_time || null,
      code: r.code || '',
      score: Number.isFinite(n) ? n : null
    };
  });

  const filtered = parsed.filter(p => p.teamNumber);
  // higher score first; equal scores are separated by who reached it sooner (score time)
filtered.sort((a, b) => ((b.score ?? -Infinity) - (a.score ?? -Infinity)) || String(a.scoreTime).localeCompare(String(b.scoreTime)));

  // competition ranking (ties share a rank) overall and within each division
  const rankOf = (list) => {
    const m = new Map();
    list.forEach((t, i) => {
      const prev = list[i - 1];
      m.set(t, prev && prev.score === t.score && prev.scoreTime === t.scoreTime ? m.get(prev) : i + 1);
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
    // teams may be plain numbers or { number, name } (the scoreboard feed has no team names)
    const entries = (cfg.teams || []).map(t => typeof t === 'string' ? { number: t } : t);
    const mine = new Map(entries.map(t => [norm(t.number), t]));
    const all = await fetchTeams();
    const found = all.filter(t => mine.has(norm(t.teamNumber)));
    const foundSet = new Set(found.map(t => norm(t.teamNumber)));
    const missing = [...mine.entries()].filter(([k]) => !foundSet.has(k)).map(([, v]) => v.number);
    found.forEach(t => { t.name = mine.get(norm(t.teamNumber)).name || null; });
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
