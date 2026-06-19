var SPREADSHEET_ID = '17hzGtZuyJTzOoEyJUmhsgCoT55sVoT8LVCk1xU1hqHA';
var FIFA_MATCHES_URL = 'https://api.fifa.com/api/v3/calendar/matches?language=en&count=500&idCompetition=17&idSeason=285023';
var ODDS_API_HOST = 'https://api.the-odds-api.com';
var ALLOWED_ORIGIN = 'http://localhost:5174';
var STARTING_TOKENS = 1000;

var SHEETS = {
  users: 'Users',
  matches: 'Matches',
  predictions: 'Predictions',
  audit: 'Audit',
  config: 'Config',
};

var HEADERS = {
  Users: ['userId', 'username', 'displayName', 'passwordSalt', 'passwordHash', 'status', 'role', 'token', 'tokenExpiresAt', 'createdAt', 'approvedAt', 'startingTokens'],
  Matches: ['matchId', 'competition', 'stage', 'groupName', 'homeTeam', 'awayTeam', 'kickoffAt', 'status', 'homeScore', 'awayScore', 'oddsHome', 'oddsDraw', 'oddsAway', 'scoreSource', 'oddsSource', 'lastSyncedAt', 'manualUpdatedBy'],
  Predictions: ['predictionId', 'userId', 'matchId', 'homeScore', 'awayScore', 'predictedResult', 'oddsAtPrediction', 'tokenAmount', 'updatedAt'],
  Audit: ['auditId', 'createdAt', 'userId', 'action', 'targetId', 'payload'],
  Config: ['key', 'value'],
};

function setup() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  Object.keys(HEADERS).forEach(function(name) {
    var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    ensureHeaders_(sheet, HEADERS[name]);
  });
  seedApprovedStartingTokens_();
}

function seedApprovedStartingTokens_() {
  var users = table_(SHEETS.users);
  users.rows.forEach(function(user, index) {
    if (user.status === 'approved' && (user.startingTokens === '' || user.startingTokens == null)) {
      users.update(index, { startingTokens: STARTING_TOKENS });
    }
    if (user.status !== 'approved' && (user.startingTokens === '' || user.startingTokens == null)) {
      users.update(index, { startingTokens: 0 });
    }
  });
}

function ensureHeaders_(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    return;
  }

  var values = sheet.getDataRange().getValues();
  var existingHeaders = values[0];
  var alreadyExact = existingHeaders.length === headers.length && headers.every(function(header, index) {
    return existingHeaders[index] === header;
  });
  if (alreadyExact) {
    sheet.setFrozenRows(1);
    return;
  }

  var rows = values.slice(1).filter(function(row) {
    return row.some(function(value) {
      return value !== '';
    });
  });
  var remapped = rows.map(function(row) {
    return headers.map(function(header) {
      var oldIndex = existingHeaders.indexOf(header);
      return oldIndex >= 0 ? row[oldIndex] : '';
    });
  });

  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  if (sheet.getMaxColumns() > headers.length) {
    sheet.deleteColumns(headers.length + 1, sheet.getMaxColumns() - headers.length);
  }

  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (remapped.length) sheet.getRange(2, 1, remapped.length, headers.length).setValues(remapped);
  sheet.setFrozenRows(1);
}

function createFirstAdmin(username, displayName, password) {
  var users = table_(SHEETS.users);
  if (users.rows.some(function(u) { return u.role === 'admin'; })) throw new Error('Admin already exists.');
  var salt = Utilities.getUuid();
  users.append({
    userId: Utilities.getUuid(),
    username: cleanUsername_(username),
    displayName,
    passwordSalt: salt,
    passwordHash: hashPassword_(salt, password),
    status: 'approved',
    role: 'admin',
    token: '',
    tokenExpiresAt: '',
    createdAt: nowIso_(),
    approvedAt: nowIso_(),
    startingTokens: STARTING_TOKENS,
  });
}

function installSyncTrigger() {
  ScriptApp.newTrigger('syncFifaIfNeeded').timeBased().everyMinutes(5).create();
}

function doGet(e) {
  return handle_((e && e.parameter) || {});
}

function doPost(e) {
  var body = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
  return handle_(body);
}

function handle_(body) {
  try {
    var action = body.action || 'snapshot';
    var data = route_(action, body);
    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function route_(action, body) {
  if (action === 'ping') return ping_();
  if (action === 'snapshot') return snapshot_(body.token || '');
  if (action === 'register') return register_(body);
  if (action === 'login') return login_(body);
  if (action === 'submitPrediction') return submitPrediction_(body);
  if (action === 'reportScore') return reportScore_(body);
  if (action === 'approveUser') return approveUser_(body);
  if (action === 'syncFifa') {
    requireAdmin_(body.token);
    return syncFifaNow();
  }
  if (action === 'refreshOdds') {
    requireAdmin_(body.token);
    return refreshOddsNow();
  }
  throw new Error('Unknown action.');
}

function ping_() {
  return {
    app: 'private-world-cup-predictions',
    status: 'ok',
    time: nowIso_(),
  };
}

function register_(body) {
  var username = cleanUsername_(body.username);
  var password = String(body.password || '');
  var displayName = String(body.displayName || '').trim();
  if (!username || username.length < 3) throw new Error('Username must be at least 3 characters.');
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');
  if (!displayName) throw new Error('Display name is required.');

  var users = table_(SHEETS.users);
  if (users.rows.some(function(u) { return u.username === username; })) throw new Error('Username already exists.');

  var salt = Utilities.getUuid();
  users.append({
    userId: Utilities.getUuid(),
    username: username,
    displayName: displayName,
    passwordSalt: salt,
    passwordHash: hashPassword_(salt, password),
    status: 'pending',
    role: 'user',
    token: '',
    tokenExpiresAt: '',
    createdAt: nowIso_(),
    approvedAt: '',
    startingTokens: 0,
  });
  return { status: 'pending' };
}

function login_(body) {
  var username = cleanUsername_(body.username);
  var password = String(body.password || '');
  var users = table_(SHEETS.users);
  var index = findIndex_(users.rows, function(u) { return u.username === username; });
  if (index < 0) throw new Error('Invalid username or password.');
  var user = users.rows[index];
  if (user.passwordHash !== hashPassword_(user.passwordSalt, password)) throw new Error('Invalid username or password.');
  if (user.status !== 'approved') throw new Error('Account is waiting for approval.');
  user = ensureStartingTokens_(users, index);

  var token = Utilities.getUuid() + Utilities.getUuid();
  var expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  users.update(index, { token: token, tokenExpiresAt: expires });
  return { token: token, user: publicUser_(Object.assign({}, user, { token: token, tokenExpiresAt: expires })) };
}

function snapshot_(token) {
  var user = token ? authOptional_(token) : null;
  var matchRows = table_(SHEETS.matches).rows;
  var matches = matchRows.map(publicMatch_);
  var users = table_(SHEETS.users).rows;
  var allPredictions = latestPredictions_(table_(SHEETS.predictions).rows);
  var predictions = user ? allPredictions.filter(function(p) { return p.userId === user.userId; }) : [];
  return {
    user: user ? publicUser_(user, matchRows, allPredictions) : null,
    matches: matches,
    predictions: predictions,
    leaderboard: leaderboard_(),
    pendingUsers: user && user.role === 'admin' ? users.filter(function(u) { return u.status === 'pending'; }).map(function(u) { return publicUser_(u); }) : [],
    betHistory: user ? betHistory_(user, matchRows, allPredictions, users) : [],
  };
}

function submitPrediction_(body) {
  var user = requireUser_(body.token);
  var matches = table_(SHEETS.matches).rows;
  var match = find_(matches, function(m) { return m.matchId === body.matchId; });
  if (!match) throw new Error('Match not found.');
  if (new Date(match.kickoffAt).getTime() <= Date.now()) throw new Error('Predictions are locked after kickoff.');
  var predictedResult = parsePredictedResult_(body.predictedResult);
  var tokenAmount = parseTokenAmount_(body.tokenAmount);
  var oddsAtPrediction = oddsForResult_(match, predictedResult);

  var predictions = table_(SHEETS.predictions);
  var existingPredictions = predictions.rows.filter(function(p) {
    return p.userId === user.userId && p.matchId === match.matchId;
  });
  var oldStake = existingPredictions.reduce(function(total, prediction) {
    return total + Number(prediction.tokenAmount || 0);
  }, 0);
  var availableForThisBet = tokenBalance_(user, matches, predictions.rows) + oldStake;
  if (tokenAmount > availableForThisBet) throw new Error('Not enough coins for this bet.');

  var patch = { homeScore: '', awayScore: '', predictedResult: predictedResult, oddsAtPrediction: oddsAtPrediction, tokenAmount: tokenAmount, updatedAt: nowIso_() };
  var replacement = Object.assign({
    predictionId: existingPredictions.length ? existingPredictions[0].predictionId : Utilities.getUuid(),
    userId: user.userId,
    matchId: match.matchId,
  }, patch);
  replaceRows_(SHEETS.predictions, predictions.rows.filter(function(p) {
    return !(p.userId === user.userId && p.matchId === match.matchId);
  }).concat([replacement]));
  audit_(user.userId, 'submitPrediction', match.matchId, patch);
  return snapshot_(body.token);
}

function reportScore_(body) {
  var user = requireUser_(body.token);
  var homeScore = parseScore_(body.homeScore);
  var awayScore = parseScore_(body.awayScore);
  var matches = table_(SHEETS.matches);
  var index = findIndex_(matches.rows, function(m) { return m.matchId === body.matchId; });
  if (index < 0) throw new Error('Match not found.');
  if (matches.rows[index].status !== 'live') throw new Error('Score reports are only available for live matches.');
  matches.update(index, { homeScore: homeScore, awayScore: awayScore, status: cleanStatus_(body.status || 'live'), scoreSource: 'manual', lastSyncedAt: nowIso_(), manualUpdatedBy: user.userId });
  audit_(user.userId, 'reportScore', body.matchId, { homeScore: homeScore, awayScore: awayScore, status: body.status || 'live' });
  return snapshot_(body.token);
}

function approveUser_(body) {
  var admin = requireAdmin_(body.token);
  var users = table_(SHEETS.users);
  var index = findIndex_(users.rows, function(u) { return u.userId === body.userId; });
  if (index < 0) throw new Error('User not found.');
  var status = body.approved ? 'approved' : 'rejected';
  var startingTokens = body.approved ? STARTING_TOKENS : 0;
  users.update(index, { status: status, approvedAt: nowIso_(), startingTokens: startingTokens });
  audit_(admin.userId, 'approveUser', body.userId, { status: status, startingTokens: startingTokens });
  return snapshot_(body.token);
}

function syncFifaIfNeeded() {
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty('LAST_FIFA_SYNC') || 0);
  if (Date.now() - last < 6 * 60 * 1000) return { skipped: true, reason: 'throttled' };

  var activeWindow = table_(SHEETS.matches).rows.some(function(m) {
    var kickoff = new Date(m.kickoffAt).getTime();
    return Date.now() >= kickoff - 30 * 60 * 1000 && Date.now() <= kickoff + 3 * 60 * 60 * 1000;
  });
  if (!activeWindow) return { skipped: true, reason: 'no active match window' };
  return syncFifaNow();
}

function syncFifaNow() {
  var response = UrlFetchApp.fetch(FIFA_MATCHES_URL, {
    muteHttpExceptions: true,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
  });
  if (response.getResponseCode() >= 400) throw new Error('FIFA feed failed: ' + response.getResponseCode());
  var payload = JSON.parse(response.getContentText());
  var normalized = normalizeFifaMatches_(payload);
  var result = refreshMatches_(normalized);
  PropertiesService.getScriptProperties().setProperty('LAST_FIFA_SYNC', String(Date.now()));
  return result;
}

function refreshFifaNow() {
  return syncFifaNow();
}

function refreshOddsNow() {
  var config = oddsConfig_();
  var from = oddsApiIso_(new Date(Date.now() - 3 * 60 * 60 * 1000));
  var to = oddsApiIso_(new Date(Date.now() + 4 * 24 * 60 * 60 * 1000));
  var url = config.host + '/v4/sports/' + encodeURIComponent(config.sportKey) + '/odds/?apiKey=' + encodeURIComponent(config.apiKey) +
    '&regions=' + encodeURIComponent(config.regions) +
    '&markets=h2h&oddsFormat=decimal&dateFormat=iso' +
    '&commenceTimeFrom=' + encodeURIComponent(from) +
    '&commenceTimeTo=' + encodeURIComponent(to);

  var response = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
  });
  if (response.getResponseCode() >= 400) {
    throw new Error('Odds feed failed: ' + response.getResponseCode() + ' ' + response.getContentText());
  }

  var payload = JSON.parse(response.getContentText());
  var events = normalizeOddsFeed_(payload);
  var result = applyOddsToMatches_(events);
  result.requestsRemaining = response.getHeaders()['x-requests-remaining'] || '';
  result.requestsUsed = response.getHeaders()['x-requests-used'] || '';
  result.requestsLast = response.getHeaders()['x-requests-last'] || '';
  return result;
}

function oddsApiIso_(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function debugOddsSports() {
  return listOddsSports_();
}

function listOddsSports_() {
  var apiKey = configValue_('ODDS_API_KEY', '');
  if (!apiKey) throw new Error('Add ODDS_API_KEY to the Config sheet first.');
  var host = configValue_('ODDS_API_HOST', ODDS_API_HOST);
  var response = UrlFetchApp.fetch(host + '/v4/sports/?apiKey=' + encodeURIComponent(apiKey) + '&all=true', {
    muteHttpExceptions: true,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
  });
  if (response.getResponseCode() >= 400) throw new Error('Odds sports list failed: ' + response.getResponseCode());
  var sports = JSON.parse(response.getContentText());
  return sports.filter(function(sport) {
    return String(sport.group || '').toLowerCase() === 'soccer' || String(sport.key || '').indexOf('soccer') === 0;
  }).map(function(sport) {
    return {
      key: sport.key,
      title: sport.title,
      description: sport.description,
      active: sport.active,
    };
  });
}

function oddsConfig_() {
  var apiKey = configValue_('ODDS_API_KEY', '');
  if (!apiKey) throw new Error('Add ODDS_API_KEY to the Config sheet first.');
  return {
    apiKey: apiKey,
    host: configValue_('ODDS_API_HOST', ODDS_API_HOST),
    sportKey: configValue_('ODDS_SPORT_KEY', 'soccer_fifa_world_cup'),
    regions: configValue_('ODDS_REGIONS', 'eu'),
  };
}

function normalizeOddsFeed_(payload) {
  if (!Array.isArray(payload)) return [];
  return payload.map(function(event) {
    var totals = {};
    (event.bookmakers || []).forEach(function(bookmaker) {
      (bookmaker.markets || []).forEach(function(market) {
        if (market.key !== 'h2h') return;
        (market.outcomes || []).forEach(function(outcome) {
          var price = Number(outcome.price);
          if (!Number.isFinite(price)) return;
          var key = normalizeTeamNameForOdds_(outcome.name);
          if (!key) return;
          if (!totals[key]) totals[key] = { sum: 0, count: 0 };
          totals[key].sum += price;
          totals[key].count += 1;
        });
      });
    });

    var prices = {};
    Object.keys(totals).forEach(function(key) {
      prices[key] = Math.round((totals[key].sum / totals[key].count) * 100) / 100;
    });

    return {
      eventId: event.id,
      homeTeam: String(event.home_team || ''),
      awayTeam: String(event.away_team || ''),
      kickoffAt: String(event.commence_time || ''),
      prices: prices,
    };
  }).filter(function(event) {
    return event.homeTeam && event.awayTeam && event.kickoffAt;
  });
}

function applyOddsToMatches_(events) {
  var matches = table_(SHEETS.matches);
  var updated = 0;
  var missingOdds = 0;
  var skippedManual = 0;
  var unmatched = [];

  events.forEach(function(event) {
    var index = findOddsMatchIndex_(matches.rows, event);
    if (index < 0) {
      unmatched.push(event.homeTeam + ' vs ' + event.awayTeam);
      return;
    }

    var match = matches.rows[index];
    if (match.oddsSource === 'manual') {
      skippedManual += 1;
      return;
    }

    var oddsHome = valueOrBlank_(event.prices[normalizeTeamNameForOdds_(match.homeTeam)]);
    var oddsDraw = valueOrBlank_(event.prices.draw);
    var oddsAway = valueOrBlank_(event.prices[normalizeTeamNameForOdds_(match.awayTeam)]);
    if (oddsHome === '' || oddsDraw === '' || oddsAway === '') {
      missingOdds += 1;
      return;
    }

    matches.update(index, {
      oddsHome: oddsHome,
      oddsDraw: oddsDraw,
      oddsAway: oddsAway,
      oddsSource: 'odds-api',
      lastSyncedAt: nowIso_(),
    });
    updated += 1;
  });

  return {
    events: events.length,
    updated: updated,
    unmatched: unmatched.slice(0, 8),
    missingOdds: missingOdds,
    skippedManual: skippedManual,
  };
}

function findOddsMatchIndex_(matches, event) {
  var eventHome = normalizeTeamNameForOdds_(event.homeTeam);
  var eventAway = normalizeTeamNameForOdds_(event.awayTeam);
  var eventKickoff = new Date(event.kickoffAt).getTime();
  var bestIndex = -1;
  var bestDiff = Infinity;

  matches.forEach(function(match, index) {
    var matchHome = normalizeTeamNameForOdds_(match.homeTeam);
    var matchAway = normalizeTeamNameForOdds_(match.awayTeam);
    var samePair = (matchHome === eventHome && matchAway === eventAway) || (matchHome === eventAway && matchAway === eventHome);
    if (!samePair) return;

    var diff = Math.abs(new Date(match.kickoffAt).getTime() - eventKickoff);
    if (diff <= 12 * 60 * 60 * 1000 && diff < bestDiff) {
      bestDiff = diff;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function normalizeTeamNameForOdds_(value) {
  var normalized = String(value || '').toLowerCase();
  try {
    normalized = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch (err) {
    // Apps Script V8 supports normalize, but this keeps old runtimes harmless.
  }
  normalized = normalized.replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
  var aliases = {
    caboverde: 'caboverde',
    capeverde: 'caboverde',
    congodr: 'congodr',
    drcongo: 'congodr',
    democraticrepublicofthecongo: 'congodr',
    coteivoire: 'cotedivoire',
    cotedivoire: 'cotedivoire',
    ivorycoast: 'cotedivoire',
    england: 'england',
    iran: 'iran',
    iriran: 'iran',
    iraq: 'iraq',
    korearepublic: 'korearepublic',
    southkorea: 'korearepublic',
    republicofkorea: 'korearepublic',
    turkey: 'turkiye',
    turkiye: 'turkiye',
    unitedstates: 'usa',
    unitedstatesofamerica: 'usa',
    usmnt: 'usa',
    usa: 'usa',
    draw: 'draw',
    tie: 'draw',
  };
  return aliases[normalized] || normalized;
}

function debugFifaFetch() {
  var response = UrlFetchApp.fetch(FIFA_MATCHES_URL, {
    muteHttpExceptions: true,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
  });
  var payload = JSON.parse(response.getContentText());
  var normalized = normalizeFifaMatches_(payload);
  return {
    responseCode: response.getResponseCode(),
    fifaResults: payload.Results ? payload.Results.length : 0,
    normalized: normalized.length,
    firstMatch: normalized.length ? normalized[0] : null,
  };
}

function normalizeFifaMatches_(payload) {
  var items = payload.Results || payload.matches || payload.results || payload.Match || [];
  return items.map(function(m) {
    var oddsHome = valueOrBlank_(firstPresent_([
      m.oddsHome,
      m.homeOdds,
      m.OddsHome,
      m.HomeOdds,
      m.odds && (m.odds.home || m.odds.Home),
      m.odds && m.odds['1'],
    ]));
    var oddsDraw = valueOrBlank_(firstPresent_([
      m.oddsDraw,
      m.drawOdds,
      m.OddsDraw,
      m.DrawOdds,
      m.odds && (m.odds.draw || m.odds.Draw),
      m.odds && m.odds.X,
    ]));
    var oddsAway = valueOrBlank_(firstPresent_([
      m.oddsAway,
      m.awayOdds,
      m.OddsAway,
      m.AwayOdds,
      m.odds && (m.odds.away || m.odds.Away),
      m.odds && m.odds['2'],
    ]));

    return {
      matchId: String(m.id || m.matchId || m.IdMatch || m.MatchId),
      competition: String(m.competition || localizedText_(m.CompetitionName) || 'FIFA World Cup'),
      stage: String(m.stage || localizedText_(m.StageName) || ''),
      groupName: String(m.group || localizedText_(m.GroupName) || ''),
      homeTeam: String((m.homeTeam && (m.homeTeam.name || m.homeTeam.Name)) || (m.Home && (localizedText_(m.Home.TeamName) || m.Home.ShortClubName || m.Home.Abbreviation)) || m.HomeTeamName || m.HomeTeam || ''),
      awayTeam: String((m.awayTeam && (m.awayTeam.name || m.awayTeam.Name)) || (m.Away && (localizedText_(m.Away.TeamName) || m.Away.ShortClubName || m.Away.Abbreviation)) || m.AwayTeamName || m.AwayTeam || ''),
      kickoffAt: String(m.kickoffAt || m.Date || m.MatchDate || m.LocalDate || ''),
      status: fifaStatus_(m.status != null ? m.status : m.MatchStatus),
      homeScore: valueOrBlank_(firstPresent_([m.homeScore, m.HomeTeamScore, m.Home && m.Home.Score])),
      awayScore: valueOrBlank_(firstPresent_([m.awayScore, m.AwayTeamScore, m.Away && m.Away.Score])),
      oddsHome: oddsHome,
      oddsDraw: oddsDraw,
      oddsAway: oddsAway,
      scoreSource: 'fifa',
      oddsSource: oddsHome !== '' || oddsDraw !== '' || oddsAway !== '' ? 'fifa' : '',
      lastSyncedAt: nowIso_(),
      manualUpdatedBy: '',
    };
  }).filter(function(m) {
    return m.matchId && m.homeTeam && m.awayTeam && m.kickoffAt;
  });
}

function refreshMatches_(incoming) {
  var matches = table_(SHEETS.matches);
  var existingById = {};
  matches.rows.forEach(function(match) {
    if (!match.matchId) return;
    if (!existingById[match.matchId] || match.scoreSource === 'manual' || match.oddsSource === 'manual') {
      existingById[match.matchId] = match;
    }
  });

  var seen = {};
  var refreshed = [];
  incoming.forEach(function(match) {
    if (seen[match.matchId]) return;
    seen[match.matchId] = true;
    refreshed.push(mergeExistingMatch_(match, existingById[match.matchId]));
  });

  replaceRows_(SHEETS.matches, refreshed);
  return {
    refreshed: refreshed.length,
    removedDuplicates: Math.max(0, matches.rows.length - refreshed.length),
  };
}

function mergeExistingMatch_(incoming, existing) {
  if (!existing) return incoming;
  var match = Object.assign({}, incoming);

  if (existing.scoreSource === 'manual' && incoming.status !== 'final') {
    match.status = existing.status || incoming.status;
    match.homeScore = existing.homeScore;
    match.awayScore = existing.awayScore;
    match.scoreSource = 'manual';
    match.manualUpdatedBy = existing.manualUpdatedBy;
  }

  var incomingHasOdds = incoming.oddsHome !== '' || incoming.oddsDraw !== '' || incoming.oddsAway !== '';
  var existingHasOdds = existing.oddsHome !== '' || existing.oddsDraw !== '' || existing.oddsAway !== '';
  if (existing.oddsSource === 'manual' || (!incomingHasOdds && existingHasOdds)) {
    match.oddsHome = existing.oddsHome;
    match.oddsDraw = existing.oddsDraw;
    match.oddsAway = existing.oddsAway;
    match.oddsSource = existing.oddsSource || incoming.oddsSource;
  }

  return match;
}

function replaceRows_(name, rows) {
  var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name);
  var headers = HEADERS[name];
  ensureHeaders_(sheet, headers);

  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, headers.length).clearContent();
  }

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows.map(function(row) {
      return headers.map(function(header) {
        return row[header] == null ? '' : row[header];
      });
    }));
  }
}

function leaderboard_() {
  var users = table_(SHEETS.users).rows.filter(function(u) { return u.status === 'approved'; });
  var matches = table_(SHEETS.matches).rows;
  var predictions = latestPredictions_(table_(SHEETS.predictions).rows);
  return users.map(function(user) {
    var stats = leaderboardStats_(user, matches, predictions);
    return { userId: user.userId, displayName: user.displayName, total: stats.total, wins: stats.wins, losses: stats.losses };
  }).sort(function(a, b) {
    return b.total - a.total || b.wins - a.wins || a.losses - b.losses || a.displayName.localeCompare(b.displayName);
  });
}

function leaderboardStats_(user, matches, predictions) {
  var stats = {
    total: startingTokens_(user),
    wins: 0,
    losses: 0,
  };

  predictions.filter(function(prediction) {
    return prediction.userId === user.userId;
  }).forEach(function(prediction) {
    var match = find_(matches, function(m) { return m.matchId === prediction.matchId; });
    var status = predictionStatus_(prediction, match);
    if (status === 'pending') return;

    stats.total -= Number(prediction.tokenAmount || 0);
    stats.total += payoutForPrediction_(prediction, match);
    if (status === 'won') stats.wins += 1;
    if (status === 'lost') stats.losses += 1;
  });

  stats.total = Math.max(0, Math.floor(stats.total));
  return stats;
}

function betHistory_(viewer, matches, predictions, users) {
  var now = Date.now();
  return latestPredictions_(predictions).map(function(prediction) {
    var match = find_(matches, function(m) { return m.matchId === prediction.matchId; });
    var owner = find_(users, function(u) { return u.userId === prediction.userId; });
    if (!match || !owner) return null;

    return {
      predictionId: prediction.predictionId,
      userId: prediction.userId,
      displayName: owner.displayName,
      matchId: prediction.matchId,
      matchLabel: match.homeTeam + ' vs ' + match.awayTeam,
      kickoffAt: match.kickoffAt,
      matchStatus: match.status,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      predictedHomeScore: prediction.homeScore,
      predictedAwayScore: prediction.awayScore,
      predictedResult: prediction.predictedResult,
      token: resultToken_(prediction.predictedResult, match),
      tokenAmount: Number(prediction.tokenAmount || 0),
      oddsAtPrediction: prediction.oddsAtPrediction,
      points: scorePrediction_(prediction, match),
      resultStatus: predictionStatus_(prediction, match),
      isMine: prediction.userId === viewer.userId,
      updatedAt: prediction.updatedAt,
    };
  }).filter(function(row) {
    return row;
  }).sort(function(a, b) {
    return new Date(b.kickoffAt).getTime() - new Date(a.kickoffAt).getTime() || a.displayName.localeCompare(b.displayName);
  });
}

function resultToken_(predictedResult, match) {
  if (predictedResult === 'home') return match.homeTeam;
  if (predictedResult === 'away') return match.awayTeam;
  return 'Draw';
}

function scorePrediction_(prediction, match) {
  return payoutForPrediction_(prediction, match);
}

function predictionStatus_(prediction, match) {
  if (!match || match.homeScore === '' || match.awayScore === '' || match.status !== 'final') return 'pending';
  return prediction.predictedResult === resultFromScores_(Number(match.homeScore), Number(match.awayScore)) ? 'won' : 'lost';
}

function tokenBalance_(user, matches, predictions) {
  var balance = startingTokens_(user);
  latestPredictions_(predictions).filter(function(prediction) {
    return prediction.userId === user.userId;
  }).forEach(function(prediction) {
    var match = find_(matches, function(m) { return m.matchId === prediction.matchId; });
    balance -= Number(prediction.tokenAmount || 0);
    balance += payoutForPrediction_(prediction, match);
  });
  return Math.max(0, Math.floor(balance));
}

function payoutForPrediction_(prediction, match) {
  if (!match || match.status !== 'final' || match.homeScore === '' || match.awayScore === '') return 0;
  if (prediction.predictedResult !== resultFromScores_(Number(match.homeScore), Number(match.awayScore))) return 0;
  return Math.floor(Number(prediction.tokenAmount || 0) * oddsMultiplier_(prediction.oddsAtPrediction));
}

function oddsMultiplier_(value) {
  var n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

function startingTokens_(user) {
  var tokens = Number(user.startingTokens);
  if (Number.isFinite(tokens) && tokens > 0) return tokens;
  return user.status === 'approved' ? STARTING_TOKENS : 0;
}

function latestPredictions_(predictions) {
  var byUserMatch = {};
  predictions.forEach(function(prediction) {
    var key = prediction.userId + '::' + prediction.matchId;
    if (!byUserMatch[key] || new Date(prediction.updatedAt).getTime() >= new Date(byUserMatch[key].updatedAt).getTime()) {
      byUserMatch[key] = prediction;
    }
  });
  return Object.keys(byUserMatch).map(function(key) {
    return byUserMatch[key];
  });
}

function ensureStartingTokens_(users, index) {
  var user = users.rows[index];
  if (user.status === 'approved' && (user.startingTokens === '' || user.startingTokens == null)) {
    users.update(index, { startingTokens: STARTING_TOKENS });
    user.startingTokens = STARTING_TOKENS;
  }
  return user;
}

function table_(name) {
  var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var rows = values.slice(1).filter(function(r) {
    return r.some(function(v) { return v !== ''; });
  }).map(function(row) {
    return objectFromRow_(headers, row);
  });
  return {
    rows: rows,
    append: function(obj) {
      sheet.appendRow(headers.map(function(h) { return obj[h] == null ? '' : obj[h]; }));
    },
    update: function(index, patch) {
      Object.keys(patch).forEach(function(key) {
        var col = headers.indexOf(key);
        if (col >= 0) sheet.getRange(index + 2, col + 1).setValue(patch[key]);
      });
    },
  };
}

function objectFromRow_(headers, row) {
  return headers.reduce(function(obj, h, i) {
    obj[h] = row[i];
    return obj;
  }, {});
}

function findMatch_(matchId) {
  return find_(table_(SHEETS.matches).rows, function(m) { return m.matchId === matchId; });
}

function requireUser_(token) {
  var user = authOptional_(token);
  if (!user) throw new Error('Please log in.');
  return user;
}

function requireAdmin_(token) {
  var user = requireUser_(token);
  if (user.role !== 'admin') throw new Error('Admin only.');
  return user;
}

function authOptional_(token) {
  if (!token) return null;
  var users = table_(SHEETS.users);
  var index = findIndex_(users.rows, function(u) { return u.token === token; });
  if (index < 0) return null;
  var user = users.rows[index];
  if (!user || user.status !== 'approved') return null;
  if (new Date(user.tokenExpiresAt).getTime() < Date.now()) return null;
  return ensureStartingTokens_(users, index);
}

function publicUser_(user, matches, predictions) {
  var startingTokens = startingTokens_(user);
  return {
    userId: user.userId,
    username: user.username,
    displayName: user.displayName,
    status: user.status,
    role: user.role,
    startingTokens: startingTokens,
    tokenBalance: matches && predictions ? tokenBalance_(user, matches, predictions) : startingTokens,
  };
}

function publicMatch_(match) {
  return {
    matchId: match.matchId,
    competition: match.competition,
    stage: match.stage,
    groupName: match.groupName,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    kickoffAt: match.kickoffAt,
    status: match.status,
    homeScore: match.homeScore,
    awayScore: match.awayScore,
    oddsHome: match.oddsHome,
    oddsDraw: match.oddsDraw,
    oddsAway: match.oddsAway,
    scoreSource: match.scoreSource,
    oddsSource: match.oddsSource,
  };
}

function hashPassword_(salt, password) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + password);
  return bytes.map(function(b) { return (b + 256).toString(16).slice(-2); }).join('');
}

function cleanUsername_(username) {
  return String(username || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '');
}

function parseScore_(value) {
  var n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 99) throw new Error('Score must be a whole number.');
  return n;
}

function parsePredictedResult_(value) {
  var result = String(value || '').trim().toLowerCase();
  if (['home', 'draw', 'away'].indexOf(result) < 0) throw new Error('Choose a team or draw.');
  return result;
}

function parseTokenAmount_(value) {
  var n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 9999) throw new Error('Coin amount must be between 1 and 9999.');
  return n;
}

function resultFromScores_(homeScore, awayScore) {
  if (homeScore > awayScore) return 'home';
  if (homeScore < awayScore) return 'away';
  return 'draw';
}

function oddsForResult_(match, predictedResult) {
  if (predictedResult === 'home') return valueOrBlank_(match.oddsHome);
  if (predictedResult === 'away') return valueOrBlank_(match.oddsAway);
  return valueOrBlank_(match.oddsDraw);
}

function cleanStatus_(status) {
  var normalized = String(status || '').trim().toLowerCase();
  if (['scheduled', 'live', 'final', 'postponed', 'cancelled'].indexOf(normalized) >= 0) return normalized;
  if (normalized === 'in progress' || normalized === 'in_progress' || normalized === 'playing') return 'live';
  if (normalized === 'finished' || normalized === 'complete' || normalized === 'completed') return 'final';
  return 'scheduled';
}

function fifaStatus_(status) {
  if (status === 0 || status === '0') return 'final';
  if (status === 1 || status === '1') return 'scheduled';
  if (status === 3 || status === '3' || status === 12 || status === '12') return 'live';
  if (status === 4 || status === '4') return 'postponed';
  if (status === 5 || status === '5') return 'cancelled';
  return cleanStatus_(status || 'scheduled');
}

function localizedText_(items) {
  if (!items || !items.length) return '';
  for (var i = 0; i < items.length; i += 1) {
    if ((items[i].Locale || '').toLowerCase() === 'en-gb') return items[i].Description || '';
  }
  return items[0].Description || '';
}

function firstPresent_(values) {
  for (var i = 0; i < values.length; i += 1) {
    if (values[i] != null && values[i] !== '') return values[i];
  }
  return '';
}

function find_(items, predicate) {
  var index = findIndex_(items, predicate);
  return index >= 0 ? items[index] : null;
}

function findIndex_(items, predicate) {
  for (var i = 0; i < items.length; i += 1) {
    if (predicate(items[i], i)) return i;
  }
  return -1;
}

function audit_(userId, action, targetId, payload) {
  table_(SHEETS.audit).append({
    auditId: Utilities.getUuid(),
    createdAt: nowIso_(),
    userId,
    action,
    targetId,
    payload: JSON.stringify(payload || {}),
  });
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function nowIso_() {
  return new Date().toISOString();
}

function configValue_(key, fallback) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEETS.config);
  if (!sheet) return fallback || '';
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i += 1) {
    if (String(values[i][0] || '').trim() === key) {
      var value = values[i][1];
      return value == null || value === '' ? (fallback || '') : String(value).trim();
    }
  }
  return fallback || '';
}

function valueOrBlank_(value) {
  return value == null ? '' : value;
}
