// server.js
// Simple Express proxy that scrapes scoreboard.uscyberpatriot.org and returns a JSON list of teams + scores.
// Usage: node server.js
// Install: npm install express node-fetch@2 cheerio cors

const express = require('express');
const fetch = require('node-fetch'); // v2
const cheerio = require('cheerio');
const cors = require('cors');

const SCOREBOARD_URL = 'https://scoreboard.uscyberpatriot.org/';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());

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

  // try to find table rows with team data
  // The scoreboard page generates rows dynamically sometimes; we attempt to be tolerant.
  const rows = $('table tbody tr');
  let teams = [];

  if (rows.length === 0) {
    // fallback: find any <tr> under the page that look like they contain team info
    $('tr').each((i, el) => {
      const tds = $(el).find('td');
      if (tds.length >= 3) {
        // push candidate
        teams.push(Array.from(tds).map(td => $(td).text().trim()));
      }
    });
  } else {
    rows.each((i, el) => {
      const tds = $(el).find('td');
      const textCells = Array.from(tds).map(td => $(td).text().trim());
      if (textCells.length) teams.push(textCells);
    });
  }

  // transform rows into objects. We don't know exact column layout (it can vary),
  // so attempt to detect team number/name/score heuristically.
  const parsed = teams.map(cells => {
    // candidate fields
    const joined = cells.join(' | ');
    // find last numeric token that looks like a score (integer)
    let score = null;
    for (let i = cells.length - 1; i >= 0; i--) {
      const n = cells[i].replace(/,/g, '').match(/-?\d+/);
      if (n) { score = parseInt(n[0], 10); break; }
    }

    // attempt to find team number (usually a small integer) - first numeric token
    let teamNumber = null;
    for (let i = 0; i < cells.length; i++) {
      const n = cells[i].replace(/,/g, '').match(/^\d{1,6}$/);
      if (n) { teamNumber = n[0]; break; }
    }

    // find team name heuristically: a long-ish cell that is not numeric
    let teamName = null;
    for (let i = 0; i < cells.length; i++) {
      if (!/^\s*$/.test(cells[i]) && !/^\d+$/.test(cells[i]) && cells[i].length > 2) {
        // avoid known keywords
        if (!/Score|Time|Images|Play Time|hh:mm:ss|Locat|Division|Tier|Team/i.test(cells[i])) {
          teamName = cells[i];
          break;
        }
      }
    }

    // fallback: first non-empty cell as name
    if (!teamName && cells.length) teamName = cells[0];

    return {
      teamNumber: teamNumber || null,
      name: teamName || null,
      score: (Number.isFinite(score) ? score : null),
      raw: cells
    };
  });

  // Only keep items that have at least a name or score
  const filtered = parsed.filter(p => p.name || p.score !== null);

  // sort by score desc where available; if no score, keep original order
  filtered.sort((a, b) => {
    if (a.score === null && b.score === null) return 0;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score;
  });

  cache = { ts: Date.now(), ttl: cache.ttl, data: filtered };
  return filtered;
}

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
  console.log(`Scoreboard proxy running on http://localhost:${PORT}`);
  console.log(`API endpoint: http://localhost:${PORT}/api/teams`);
});
