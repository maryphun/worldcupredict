var SPREADSHEET_ID = '17hzGtZuyJTzOoEyJUmhsgCoT55sVoT8LVCk1xU1hqHA';
var FIFA_MATCHES_URL = 'https://api.fifa.com/api/v3/calendar/matches?language=en&count=500&idCompetition=17&idSeason=285023';
var THE_ODDS_API_HOST = 'https://api.the-odds-api.com';
var ODDS_API_IO_HOST = 'https://api.odds-api.io/v3';
var ALLOWED_ORIGIN = 'http://localhost:5174';
var STARTING_TOKENS = 1000;
var LIVE_ODDS_REFRESH_MS = 60 * 1000;
var LIVE_ODDS_EVENT_MAP_REFRESH_MS = 10 * 60 * 1000;
var SESSION_DAYS = 30;
var SESSION_TOKEN_LIMIT = 8;

var SHEETS = {
  users: 'Users',
  matches: 'Matches',
  predictions: 'Predictions',
  odds: 'Odds',
  audit: 'Audit',
  config: 'Config',
};

var HEADERS = {
  Users: ['userId', 'username', 'displayName', 'passwordSalt', 'passwordHash', 'status', 'role', 'token', 'tokenExpiresAt', 'createdAt', 'approvedAt', 'startingTokens'],
  Matches: ['matchId', 'competition', 'stage', 'groupName', 'homeTeam', 'awayTeam', 'kickoffAt', 'status', 'homeScore', 'awayScore', 'oddsHome', 'oddsDraw', 'oddsAway', 'scoreSource', 'oddsSource', 'lastSyncedAt', 'manualUpdatedBy'],
  Predictions: ['predictionId', 'userId', 'matchId', 'homeScore', 'awayScore', 'predictedResult', 'marketType', 'marketLabel', 'outcomeLabel', 'line', 'oddsAtPrediction', 'tokenAmount', 'updatedAt'],
  Odds: ['oddsId', 'matchId', 'marketType', 'marketLabel', 'outcomeKey', 'outcomeLabel', 'line', 'odds', 'source', 'lastSyncedAt'],
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

function installLiveOddsTrigger() {
  ScriptApp.newTrigger('refreshLiveOddsIfNeeded').timeBased().everyMinutes(1).create();
}

function installDailyUpcomingOddsTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'refreshOddsNow') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('refreshOddsNow')
    .timeBased()
    .atHour(12)
    .nearMinute(1)
    .everyDays(1)
    .create();
}

function cleanupInvalidCorrectScoreOdds() {
  var odds = table_(SHEETS.odds);
  var keptRows = odds.rows.filter(isValidSideOddsRow_);
  replaceRows_(SHEETS.odds, keptRows);
  return {
    removed: odds.rows.length - keptRows.length,
    remaining: keptRows.length,
  };
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
  if (action === 'transferCoins') return transferCoins_(body);
  if (action === 'approveUser') return approveUser_(body);
  if (action === 'syncFifa') {
    requireAdmin_(body.token);
    return syncFifaNow();
  }
  if (action === 'refreshOdds') {
    requireAdmin_(body.token);
    return refreshOddsNow();
  }
  if (action === 'refreshLiveOdds') {
    requireUser_(body.token);
    return refreshLiveOddsIfNeeded();
  }
  throw new Error('Unknown action.');
}

function ping_() {
  return {
    app: 'landugui-predict-site',
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

  var tokens = sessionTokens_(user.token);
  var token = Utilities.getUuid() + Utilities.getUuid();
  var expires = sessionExpiry_();
  tokens.push(token);
  users.update(index, { token: serializeSessionTokens_(tokens), tokenExpiresAt: expires });
  return { token: token, user: publicUser_(Object.assign({}, user, { token: token, tokenExpiresAt: expires })) };
}

function snapshot_(token) {
  refreshFifaForSnapshot_();
  var user = token ? authOptional_(token) : null;
  if (user) refreshLiveOddsForSnapshot_();
  var matchRows = table_(SHEETS.matches).rows;
  var oddsRows = table_(SHEETS.odds).rows;
  var matches = matchRows.map(function(match) { return publicMatch_(match, oddsRows); });
  var users = table_(SHEETS.users).rows;
  var auditRows = table_(SHEETS.audit).rows;
  var allPredictions = table_(SHEETS.predictions).rows;
  var predictions = user ? allPredictions.filter(function(p) { return p.userId === user.userId; }) : [];
  return {
    user: user ? publicUser_(user, matchRows, allPredictions, auditRows) : null,
    matches: matches,
    predictions: predictions,
    leaderboard: leaderboard_(),
    pendingUsers: user && user.role === 'admin' ? users.filter(function(u) { return u.status === 'pending'; }).map(function(u) { return publicUser_(u, matchRows, allPredictions, auditRows); }) : [],
    betHistory: user ? betHistory_(user, matchRows, allPredictions, users) : [],
    coinTransfers: user ? coinTransfers_(auditRows, users) : [],
  };
}

function refreshFifaForSnapshot_() {
  try {
    syncFifaIfNeeded();
  } catch (err) {
    console.warn('FIFA snapshot refresh skipped: ' + String(err && err.message ? err.message : err));
  }
}

function refreshLiveOddsForSnapshot_() {
  try {
    refreshLiveOddsIfNeeded();
  } catch (err) {
    console.warn('Live odds snapshot refresh skipped: ' + String(err && err.message ? err.message : err));
  }
}

function submitPrediction_(body) {
  var user = requireUser_(body.token);
  var matches = table_(SHEETS.matches).rows;
  var match = find_(matches, function(m) { return m.matchId === body.matchId; });
  if (!match) throw new Error('Match not found.');
  if (['final', 'postponed', 'cancelled'].indexOf(match.status) >= 0) throw new Error('This match is closed for betting.');
  if (match.status !== 'live' && new Date(match.kickoffAt).getTime() <= Date.now()) throw new Error('Predictions are locked unless the match is live.');
  if (match.status === 'live') {
    refreshLiveOddsIfNeeded();
    matches = table_(SHEETS.matches).rows;
    match = find_(matches, function(m) { return m.matchId === body.matchId; });
  }
  var tokenAmount = parseTokenAmount_(body.tokenAmount);
  var betOption = resolveBetOption_(match, body);

  var predictions = table_(SHEETS.predictions);
  var existingPredictions = predictions.rows.filter(function(p) {
    return p.userId === user.userId && p.matchId === match.matchId;
  });
  if (oppositeBetExists_(existingPredictions, betOption)) {
    throw new Error('You already bet on the opposite team for this match. Draw is still available.');
  }

  var availableForThisBet = tokenBalance_(user, matches, predictions.rows);
  if (tokenAmount > availableForThisBet) throw new Error('Not enough coins for this bet.');

  var patch = {
    homeScore: '',
    awayScore: '',
    predictedResult: betOption.predictedResult,
    marketType: betOption.marketType,
    marketLabel: betOption.marketLabel,
    outcomeLabel: betOption.outcomeLabel,
    line: betOption.line,
    oddsAtPrediction: betOption.oddsAtPrediction,
    tokenAmount: tokenAmount,
    updatedAt: nowIso_(),
  };
  var prediction = Object.assign({
    predictionId: Utilities.getUuid(),
    userId: user.userId,
    matchId: match.matchId,
  }, patch);
  predictions.append(prediction);
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

function transferCoins_(body) {
  var sender = requireUser_(body.token);
  var toUserId = String(body.toUserId || '').trim();
  if (!toUserId) throw new Error('Choose a user to transfer coins to.');
  if (toUserId === sender.userId) throw new Error('You cannot transfer coins to yourself.');

  var amount = parseTokenAmount_(body.amount);
  var users = table_(SHEETS.users).rows;
  var recipient = find_(users, function(u) { return u.userId === toUserId && u.status === 'approved'; });
  if (!recipient) throw new Error('Recipient not found.');

  var matches = table_(SHEETS.matches).rows;
  var predictions = table_(SHEETS.predictions).rows;
  var auditRows = table_(SHEETS.audit).rows;
  var available = tokenBalance_(sender, matches, predictions, auditRows);
  if (amount > available) throw new Error('Not enough coins to transfer.');

  audit_(sender.userId, 'transferCoins', recipient.userId, {
    amount: amount,
    fromDisplayName: sender.displayName,
    toDisplayName: recipient.displayName,
  });
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
  if (!configValue_('THE_ODDS_API_KEY', '')) {
    return {
      skipped: true,
      reason: 'Manual upcoming odds refresh needs THE_ODDS_API_KEY. Live odds still use ODDS_API_IO_KEY.',
      provider: 'the-odds-api.com',
      events: 0,
      updated: 0,
      unmatched: [],
      missingOdds: 0,
    };
  }
  return refreshOddsForWindow_(new Date(Date.now() - 3 * 60 * 60 * 1000), new Date(Date.now() + 4 * 24 * 60 * 60 * 1000), {});
}

function refreshLiveOddsIfNeeded() {
  var liveMatches = table_(SHEETS.matches).rows.filter(isLiveMatchForOdds_);
  if (!liveMatches.length) return { skipped: true, reason: 'no live matches' };

  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty('LAST_LIVE_ODDS_SYNC') || 0);
  if (Date.now() - last < LIVE_ODDS_REFRESH_MS) return { skipped: true, reason: 'throttled' };

  var result = refreshLiveOddsNow();
  props.setProperty('LAST_LIVE_ODDS_SYNC', String(Date.now()));
  return result;
}

function refreshLiveOddsNow() {
  var liveMatches = table_(SHEETS.matches).rows.filter(isLiveMatchForOdds_);
  if (!liveMatches.length) return { skipped: true, reason: 'no live matches' };

  var config = oddsApiIoConfig_();
  var props = PropertiesService.getScriptProperties();
  var eventMap = resolveOddsApiIoLiveEventMap_(liveMatches, config, props);
  var eventIds = liveMatches.map(function(match) {
    return eventMap[String(match.matchId)];
  }).filter(function(eventId, index, values) {
    return eventId && values.indexOf(eventId) === index;
  });

  if (!eventIds.length) return { skipped: true, reason: 'live events not found on odds-api.io', provider: 'odds-api.io' };

  var response = fetchOddsApiIoOdds_(config, eventIds);
  var events = normalizeOddsApiIoOddsFeed_(response.payload);
  var result = applyOddsApiIoToLiveMatches_(events, eventMap);
  result.provider = 'odds-api.io';
  result.requestsRemaining = response.headers['x-ratelimit-remaining'] || '';
  result.requestsLimit = response.headers['x-ratelimit-limit'] || '';
  result.requestsReset = response.headers['x-ratelimit-reset'] || '';
  result.requestsLast = '1';
  return result;
}

function refreshOddsForWindow_(fromDate, toDate, options) {
  var config = oddsConfig_();
  var from = oddsApiIso_(fromDate);
  var to = oddsApiIso_(toDate);
  var markets = configValue_('THE_ODDS_MARKETS', 'h2h,spreads,totals');
  var url = config.host + '/v4/sports/' + encodeURIComponent(config.sportKey) + '/odds/?apiKey=' + encodeURIComponent(config.apiKey) +
    '&regions=' + encodeURIComponent(config.regions) +
    '&markets=' + encodeURIComponent(markets) + '&oddsFormat=decimal&dateFormat=iso' +
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
  var result = applyOddsToMatches_(events, options || {});
  result.requestsRemaining = response.getHeaders()['x-requests-remaining'] || '';
  result.requestsUsed = response.getHeaders()['x-requests-used'] || '';
  result.requestsLast = response.getHeaders()['x-requests-last'] || '';
  result.liveOnly = !!(options && options.liveOnly);
  return result;
}

function isLiveMatchForOdds_(match) {
  return match && match.status === 'live';
}

function oddsApiIoConfig_() {
  var apiKey = configValue_('ODDS_API_IO_KEY', '');
  if (!apiKey) throw new Error('Add ODDS_API_IO_KEY to Script properties first.');
  return {
    apiKey: apiKey,
    host: configValue_('ODDS_API_IO_HOST', ODDS_API_IO_HOST),
    sport: configValue_('ODDS_API_IO_SPORT', 'football'),
    bookmakers: configValue_('ODDS_API_IO_BOOKMAKERS', 'Bet365,Unibet'),
  };
}

function resolveOddsApiIoLiveEventMap_(liveMatches, config, props) {
  var currentMap = parsePayload_(props.getProperty('ODDS_API_IO_EVENT_MAP'));
  var shouldRefresh = Date.now() - Number(props.getProperty('LAST_ODDS_API_IO_EVENT_MAP') || 0) > LIVE_ODDS_EVENT_MAP_REFRESH_MS;
  var missing = liveMatches.some(function(match) {
    return !currentMap[String(match.matchId)];
  });

  if (!missing && !shouldRefresh) return currentMap;

  var response = fetchOddsApiIoLiveEvents_(config);
  var events = normalizeOddsApiIoEvents_(response.payload);
  var nextMap = Object.assign({}, currentMap);
  liveMatches.forEach(function(match) {
    var index = findOddsApiIoMatchIndex_([match], events);
    if (index >= 0) nextMap[String(match.matchId)] = String(events[index].eventId);
  });

  props.setProperty('ODDS_API_IO_EVENT_MAP', JSON.stringify(nextMap));
  props.setProperty('LAST_ODDS_API_IO_EVENT_MAP', String(Date.now()));
  return nextMap;
}

function fetchOddsApiIoLiveEvents_(config) {
  return fetchJsonWithHeaders_(config.host + '/events/live?apiKey=' + encodeURIComponent(config.apiKey) + '&sport=' + encodeURIComponent(config.sport), 'Odds-API.io live events failed');
}

function fetchOddsApiIoOdds_(config, eventIds) {
  return fetchJsonWithHeaders_(config.host + '/odds/multi?apiKey=' + encodeURIComponent(config.apiKey) +
    '&eventIds=' + encodeURIComponent(eventIds.slice(0, 10).join(',')) +
    '&bookmakers=' + encodeURIComponent(config.bookmakers), 'Odds-API.io live odds failed');
}

function fetchJsonWithHeaders_(url, errorPrefix) {
  var response = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
  });
  if (response.getResponseCode() >= 400) {
    throw new Error(errorPrefix + ': ' + response.getResponseCode() + ' ' + response.getContentText());
  }
  return {
    payload: JSON.parse(response.getContentText()),
    headers: lowerCaseHeaders_(response.getHeaders()),
  };
}

function normalizeOddsApiIoEvents_(payload) {
  var items = Array.isArray(payload) ? payload : (payload && (payload.events || payload.data || payload.results)) || [];
  return items.map(function(event) {
    var homeTeam = String(event.home || event.homeTeam || event.home_team || event.homeName || '');
    var awayTeam = String(event.away || event.awayTeam || event.away_team || event.awayName || '');
    return {
      eventId: String(event.id || event.eventId || event.event_id || ''),
      homeTeam: homeTeam,
      awayTeam: awayTeam,
      kickoffAt: String(event.date || event.startTime || event.commence_time || event.kickoffAt || ''),
      status: String(event.status || ''),
      score: extractOddsApiIoScore_(event, homeTeam, awayTeam),
    };
  }).filter(function(event) {
    return event.eventId && event.homeTeam && event.awayTeam;
  });
}

function normalizeOddsApiIoOddsFeed_(payload) {
  var items = Array.isArray(payload) ? payload : (payload && (payload.events || payload.data || payload.results)) || [];
  return items.map(function(event) {
    var homeTeam = String(event.home || event.homeTeam || event.home_team || event.homeName || '');
    var awayTeam = String(event.away || event.awayTeam || event.away_team || event.awayName || '');
    return {
      eventId: String(event.id || event.eventId || event.event_id || ''),
      homeTeam: homeTeam,
      awayTeam: awayTeam,
      kickoffAt: String(event.date || event.startTime || event.commence_time || event.kickoffAt || ''),
      score: extractOddsApiIoScore_(event, homeTeam, awayTeam),
      prices: extractOddsApiIoPrices_(event, homeTeam, awayTeam),
      sideOdds: extractOddsApiIoSideOdds_(event, homeTeam, awayTeam),
    };
  }).filter(function(event) {
    return event.eventId && ((event.prices && (event.prices.home !== '' || event.prices.draw !== '' || event.prices.away !== '')) || (event.sideOdds && event.sideOdds.length) || hasLiveScore_(event.score));
  });
}

function extractOddsApiIoScore_(event, homeTeam, awayTeam) {
  var direct = normalizeLiveScorePair_(
    firstPresent_([
      event.homeScore,
      event.home_score,
      event.scoreHome,
      event.score_home,
      event.homeGoals,
      event.home_goals,
      event.home && event.home.score,
      event.homeTeam && event.homeTeam.score,
      event.teams && event.teams.home && event.teams.home.score,
    ]),
    firstPresent_([
      event.awayScore,
      event.away_score,
      event.scoreAway,
      event.score_away,
      event.awayGoals,
      event.away_goals,
      event.away && event.away.score,
      event.awayTeam && event.awayTeam.score,
      event.teams && event.teams.away && event.teams.away.score,
    ])
  );
  if (hasLiveScore_(direct)) return direct;

  var scoreObjects = [event.score, event.scores, event.result, event.results, event.currentScore, event.current_score];
  for (var i = 0; i < scoreObjects.length; i += 1) {
    var score = extractLiveScoreFromValue_(scoreObjects[i], homeTeam, awayTeam);
    if (hasLiveScore_(score)) return score;
  }

  return { homeScore: '', awayScore: '' };
}

function extractLiveScoreFromValue_(value, homeTeam, awayTeam) {
  if (value == null || value === '') return { homeScore: '', awayScore: '' };

  if (typeof value === 'string' || typeof value === 'number') {
    return parseLiveScoreString_(value);
  }

  if (Array.isArray(value)) {
    return extractLiveScoreFromRows_(value, homeTeam, awayTeam);
  }

  var direct = normalizeLiveScorePair_(
    firstPresent_([value.home, value.homeScore, value.home_score, value.scoreHome, value.score_home]),
    firstPresent_([value.away, value.awayScore, value.away_score, value.scoreAway, value.score_away])
  );
  if (hasLiveScore_(direct)) return direct;

  return extractLiveScoreFromRows_(value.participants || value.teams || value.rows || [], homeTeam, awayTeam);
}

function extractLiveScoreFromRows_(rows, homeTeam, awayTeam) {
  if (!Array.isArray(rows)) return { homeScore: '', awayScore: '' };
  var home = '';
  var away = '';
  rows.forEach(function(row) {
    var direct = normalizeLiveScorePair_(
      firstPresent_([row.home, row.homeScore, row.home_score, row.scoreHome, row.score_home]),
      firstPresent_([row.away, row.awayScore, row.away_score, row.scoreAway, row.score_away])
    );
    if (hasLiveScore_(direct)) {
      home = direct.homeScore;
      away = direct.awayScore;
      return;
    }

    var team = normalizeTeamNameForOdds_(row.name || row.team || row.teamName || row.team_name || row.label || row.side || '');
    var score = parseLiveScoreValue_(firstPresent_([row.score, row.goals, row.points, row.value]));
    if (score === '') return;
    if (team === normalizeTeamNameForOdds_(homeTeam) || team === 'home') home = score;
    if (team === normalizeTeamNameForOdds_(awayTeam) || team === 'away') away = score;
  });
  return normalizeLiveScorePair_(home, away);
}

function parseLiveScoreString_(value) {
  var text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text) || /t\d{2}:\d{2}/i.test(text)) return { homeScore: '', awayScore: '' };
  var match = text.match(/^(\d{1,2})\s*[-:]\s*(\d{1,2})$/);
  if (!match) return { homeScore: '', awayScore: '' };
  return normalizeLiveScorePair_(match[1], match[2]);
}

function normalizeLiveScorePair_(homeScore, awayScore) {
  var home = parseLiveScoreValue_(homeScore);
  var away = parseLiveScoreValue_(awayScore);
  if (home === '' || away === '') return { homeScore: '', awayScore: '' };
  return { homeScore: home, awayScore: away };
}

function parseLiveScoreValue_(value) {
  if (value == null || value === '') return '';
  var n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : '';
}

function hasLiveScore_(score) {
  return !!score && score.homeScore !== '' && score.awayScore !== '';
}

function extractOddsApiIoPrices_(event, homeTeam, awayTeam) {
  var totals = {
    home: { sum: 0, count: 0 },
    draw: { sum: 0, count: 0 },
    away: { sum: 0, count: 0 },
  };
  var bookmakers = event.bookmakers || {};

  if (Array.isArray(bookmakers)) {
    bookmakers.forEach(function(bookmaker) {
      collectOddsApiIoMarkets_(bookmaker.markets || bookmaker.odds || [], totals, homeTeam, awayTeam);
    });
  } else {
    Object.keys(bookmakers).forEach(function(name) {
      collectOddsApiIoMarkets_(bookmakers[name], totals, homeTeam, awayTeam);
    });
  }

  return {
    home: averageOdds_(totals.home),
    draw: averageOdds_(totals.draw),
    away: averageOdds_(totals.away),
  };
}

function collectOddsApiIoMarkets_(markets, totals, homeTeam, awayTeam) {
  if (!Array.isArray(markets)) return;
  markets.forEach(function(market) {
    var marketName = String(market.name || market.key || market.market || '').toLowerCase();
    if (['ml', 'h2h', 'moneyline', 'match winner', 'match result', '1x2'].indexOf(marketName) < 0) return;
    (market.odds || market.outcomes || []).forEach(function(row) {
      if (row.home != null) addOddsTotal_(totals.home, row.home);
      if (row.draw != null) addOddsTotal_(totals.draw, row.draw);
      if (row.away != null) addOddsTotal_(totals.away, row.away);

      var name = normalizeTeamNameForOdds_(row.name || row.label || row.outcome || '');
      if (name && name === normalizeTeamNameForOdds_(homeTeam)) addOddsTotal_(totals.home, row.price || row.odds);
      if (name && name === normalizeTeamNameForOdds_(awayTeam)) addOddsTotal_(totals.away, row.price || row.odds);
      if (name && name === 'draw') addOddsTotal_(totals.draw, row.price || row.odds);
    });
  });
}

function extractOddsApiIoSideOdds_(event, homeTeam, awayTeam) {
  var sideTotals = {};
  var bookmakers = event.bookmakers || {};

  if (Array.isArray(bookmakers)) {
    bookmakers.forEach(function(bookmaker) {
      collectOddsApiIoSideMarkets_(bookmaker.markets || bookmaker.odds || [], sideTotals, homeTeam, awayTeam);
    });
  } else {
    Object.keys(bookmakers).forEach(function(name) {
      collectOddsApiIoSideMarkets_(bookmakers[name], sideTotals, homeTeam, awayTeam);
    });
  }

  return averageSideOdds_(sideTotals);
}

function collectOddsApiIoSideMarkets_(markets, sideTotals, homeTeam, awayTeam) {
  if (!Array.isArray(markets)) return;
  markets.forEach(function(market) {
    var marketName = String(market.name || market.key || market.market || '').toLowerCase();
    var rows = market.odds || market.outcomes || market.selections || [];

    if (marketName.indexOf('total') >= 0 || marketName.indexOf('over') >= 0 || marketName.indexOf('under') >= 0) {
      rows.forEach(function(row) {
        var direction = overUnderKey_(row.name || row.label || row.outcome || row.selection);
        if (!direction) return;
        var line = valueOrBlank_(firstPresent_([row.point, row.line, row.handicap, row.total, market.point, market.line]));
        addSideOddsTotal_(sideTotals, {
          marketType: 'total',
          marketLabel: 'Over / Under',
          outcomeKey: direction,
          outcomeLabel: capitalize_(direction) + ' ' + line,
          line: line,
        }, row.price || row.odds);
      });
      return;
    }

    if (marketName.indexOf('spread') >= 0 || marketName.indexOf('handicap') >= 0) {
      rows.forEach(function(row) {
        var side = sideForTeamName_(row.name || row.label || row.outcome || row.selection, homeTeam, awayTeam);
        if (!side) return;
        var line = valueOrBlank_(firstPresent_([row.point, row.line, row.handicap]));
        addSideOddsTotal_(sideTotals, {
          marketType: 'handicap',
          marketLabel: 'Handicap',
          outcomeKey: side,
          outcomeLabel: (side === 'home' ? homeTeam : awayTeam) + ' ' + signedLine_(line),
          line: line,
        }, row.price || row.odds);
      });
      return;
    }

    if (marketName.indexOf('correct') >= 0 && marketName.indexOf('score') >= 0) {
      rows.forEach(function(row) {
        var score = parseScoreOutcomeLabel_(row.name || row.label || row.outcome || row.selection);
        if (!score) return;
        addSideOddsTotal_(sideTotals, {
          marketType: 'correct_score',
          marketLabel: 'Correct score',
          outcomeKey: 'score:' + score,
          outcomeLabel: score,
          line: score,
        }, row.price || row.odds);
      });
    }
  });
}

function addOddsTotal_(total, value) {
  var price = Number(value);
  if (!Number.isFinite(price) || price <= 0) return;
  total.sum += price;
  total.count += 1;
}

function averageOdds_(total) {
  return total.count ? Math.round((total.sum / total.count) * 100) / 100 : '';
}

function applyOddsApiIoToLiveMatches_(events, eventMap) {
  var matches = table_(SHEETS.matches);
  var updated = 0;
  var scoreUpdated = 0;
  var missingOdds = 0;
  var unmatched = [];
  var sideRows = [];
  var sideMatchIds = {};

  events.forEach(function(event) {
    var matchId = findMatchIdForOddsApiIoEvent_(eventMap, event.eventId);
    var index = matchId ? findIndex_(matches.rows, function(match) { return String(match.matchId) === matchId; }) : findOddsApiIoEventMatchIndex_(matches.rows, event);
    if (index < 0) {
      unmatched.push(event.homeTeam + ' vs ' + event.awayTeam);
      return;
    }

    var match = matches.rows[index];
    if (!isLiveMatchForOdds_(match)) return;

    var update = {};
    if (hasLiveScore_(event.score) && (Number(match.homeScore) !== event.score.homeScore || Number(match.awayScore) !== event.score.awayScore || match.scoreSource !== 'odds-api.io')) {
      update.homeScore = event.score.homeScore;
      update.awayScore = event.score.awayScore;
      update.status = 'live';
      update.scoreSource = 'odds-api.io';
      update.manualUpdatedBy = '';
      scoreUpdated += 1;
    }

    if (match.oddsSource !== 'manual') {
      sideRows = sideRows.concat(sideOddsRowsForMatch_(match, event.sideOdds || [], 'odds-api.io'));
      sideMatchIds[String(match.matchId)] = true;
      if (event.prices.home === '' || event.prices.draw === '' || event.prices.away === '') {
        missingOdds += 1;
      } else {
        update.oddsHome = event.prices.home;
        update.oddsDraw = event.prices.draw;
        update.oddsAway = event.prices.away;
        update.oddsSource = 'odds-api.io';
        updated += 1;
      }
    }

    if (Object.keys(update).length) {
      update.lastSyncedAt = nowIso_();
      matches.update(index, update);
    }
  });

  var sideUpdated = upsertSideOddsRows_(sideRows, sideMatchIds);

  return {
    events: events.length,
    updated: updated,
    scoreUpdated: scoreUpdated,
    sideOdds: sideUpdated,
    unmatched: unmatched.slice(0, 8),
    missingOdds: missingOdds,
  };
}

function findMatchIdForOddsApiIoEvent_(eventMap, eventId) {
  eventId = String(eventId);
  for (var matchId in eventMap) {
    if (String(eventMap[matchId]) === eventId) return String(matchId);
  }
  return '';
}

function findOddsApiIoMatchIndex_(matches, events) {
  for (var eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    var event = events[eventIndex];
    var eventHome = normalizeTeamNameForOdds_(event.homeTeam);
    var eventAway = normalizeTeamNameForOdds_(event.awayTeam);
    var eventKickoff = new Date(event.kickoffAt).getTime();
    for (var matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
      var match = matches[matchIndex];
      var matchHome = normalizeTeamNameForOdds_(match.homeTeam);
      var matchAway = normalizeTeamNameForOdds_(match.awayTeam);
      var samePair = (matchHome === eventHome && matchAway === eventAway) || (matchHome === eventAway && matchAway === eventHome);
      if (!samePair) continue;
      if (!Number.isFinite(eventKickoff)) return eventIndex;
      if (Math.abs(new Date(match.kickoffAt).getTime() - eventKickoff) <= 12 * 60 * 60 * 1000) return eventIndex;
    }
  }
  return -1;
}

function findOddsApiIoEventMatchIndex_(matches, event) {
  var eventHome = normalizeTeamNameForOdds_(event.homeTeam);
  var eventAway = normalizeTeamNameForOdds_(event.awayTeam);
  var eventKickoff = new Date(event.kickoffAt).getTime();
  for (var matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
    var match = matches[matchIndex];
    var matchHome = normalizeTeamNameForOdds_(match.homeTeam);
    var matchAway = normalizeTeamNameForOdds_(match.awayTeam);
    var samePair = (matchHome === eventHome && matchAway === eventAway) || (matchHome === eventAway && matchAway === eventHome);
    if (!samePair) continue;
    if (!Number.isFinite(eventKickoff)) return matchIndex;
    if (Math.abs(new Date(match.kickoffAt).getTime() - eventKickoff) <= 12 * 60 * 60 * 1000) return matchIndex;
  }
  return -1;
}

function oddsApiIso_(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function debugOddsSports() {
  return listOddsSports_();
}

function listOddsSports_() {
  var apiKey = configValue_('THE_ODDS_API_KEY', '');
  if (!apiKey) throw new Error('Add THE_ODDS_API_KEY to Script properties or the Config sheet first.');
  var host = configValue_('THE_ODDS_API_HOST', THE_ODDS_API_HOST);
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
  var apiKey = configValue_('THE_ODDS_API_KEY', '');
  if (!apiKey) throw new Error('Add THE_ODDS_API_KEY to Script properties or the Config sheet first.');
  return {
    apiKey: apiKey,
    host: configValue_('THE_ODDS_API_HOST', THE_ODDS_API_HOST),
    sportKey: configValue_('THE_ODDS_SPORT_KEY', configValue_('ODDS_SPORT_KEY', 'soccer_fifa_world_cup')),
    regions: configValue_('THE_ODDS_REGIONS', configValue_('ODDS_REGIONS', 'eu')),
  };
}

function normalizeOddsFeed_(payload) {
  if (!Array.isArray(payload)) return [];
  return payload.map(function(event) {
    var totals = {};
    var sideTotals = {};
    (event.bookmakers || []).forEach(function(bookmaker) {
      (bookmaker.markets || []).forEach(function(market) {
        if (market.key === 'h2h') {
          (market.outcomes || []).forEach(function(outcome) {
            var price = Number(outcome.price);
            if (!Number.isFinite(price)) return;
            var key = normalizeTeamNameForOdds_(outcome.name);
            if (!key) return;
            if (!totals[key]) totals[key] = { sum: 0, count: 0 };
            totals[key].sum += price;
            totals[key].count += 1;
          });
          return;
        }
        collectTheOddsSideMarket_(sideTotals, market, event.home_team, event.away_team);
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
      sideOdds: averageSideOdds_(sideTotals),
    };
  }).filter(function(event) {
    return event.homeTeam && event.awayTeam && event.kickoffAt;
  });
}

function collectTheOddsSideMarket_(sideTotals, market, homeTeam, awayTeam) {
  var key = String(market.key || '').toLowerCase();
  if (key === 'spreads' || key === 'alternate_spreads') {
    (market.outcomes || []).forEach(function(outcome) {
      var side = sideForTeamName_(outcome.name, homeTeam, awayTeam);
      if (!side) return;
      var line = valueOrBlank_(outcome.point);
      addSideOddsTotal_(sideTotals, {
        marketType: 'handicap',
        marketLabel: 'Handicap',
        outcomeKey: side,
        outcomeLabel: (side === 'home' ? homeTeam : awayTeam) + ' ' + signedLine_(line),
        line: line,
      }, outcome.price);
    });
    return;
  }

  if (key === 'totals' || key === 'alternate_totals') {
    (market.outcomes || []).forEach(function(outcome) {
      var direction = overUnderKey_(outcome.name);
      if (!direction) return;
      var line = valueOrBlank_(outcome.point);
      addSideOddsTotal_(sideTotals, {
        marketType: 'total',
        marketLabel: 'Over / Under',
        outcomeKey: direction,
        outcomeLabel: capitalize_(direction) + ' ' + line,
        line: line,
      }, outcome.price);
    });
    return;
  }

  if (key === 'correct_score' || key === 'correctscore' || key === 'exact_score') {
    (market.outcomes || []).forEach(function(outcome) {
      var score = parseScoreOutcomeLabel_(outcome.name);
      if (!score) return;
      addSideOddsTotal_(sideTotals, {
        marketType: 'correct_score',
        marketLabel: 'Correct score',
        outcomeKey: 'score:' + score,
        outcomeLabel: score,
        line: score,
      }, outcome.price);
    });
  }
}

function addSideOddsTotal_(sideTotals, option, value) {
  var odds = Number(value);
  if (!Number.isFinite(odds) || odds <= 0) return;
  var key = option.marketType + '::' + option.outcomeKey + '::' + option.line;
  if (!sideTotals[key]) sideTotals[key] = Object.assign({ sum: 0, count: 0 }, option);
  sideTotals[key].sum += odds;
  sideTotals[key].count += 1;
}

function averageSideOdds_(sideTotals) {
  return Object.keys(sideTotals).map(function(key) {
    var item = sideTotals[key];
    return {
      marketType: item.marketType,
      marketLabel: item.marketLabel,
      outcomeKey: item.outcomeKey,
      outcomeLabel: item.outcomeLabel,
      line: item.line,
      odds: Math.round((item.sum / item.count) * 100) / 100,
    };
  });
}

function applyOddsToMatches_(events, options) {
  var matches = table_(SHEETS.matches);
  var updated = 0;
  var missingOdds = 0;
  var skippedManual = 0;
  var skippedNotLive = 0;
  var unmatched = [];
  var sideRows = [];
  var sideMatchIds = {};
  options = options || {};

  events.forEach(function(event) {
    var index = findOddsMatchIndex_(matches.rows, event);
    if (index < 0) {
      unmatched.push(event.homeTeam + ' vs ' + event.awayTeam);
      return;
    }

    var match = matches.rows[index];
    if (options.allowedMatchIds && !options.allowedMatchIds[String(match.matchId)]) return;
    if (options.liveOnly && !isLiveMatchForOdds_(match)) {
      skippedNotLive += 1;
      return;
    }
    if (match.oddsSource === 'manual') {
      skippedManual += 1;
      return;
    }

    sideRows = sideRows.concat(sideOddsRowsForMatch_(match, event.sideOdds || [], 'odds-api'));
    sideMatchIds[String(match.matchId)] = true;

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

  var sideUpdated = upsertSideOddsRows_(sideRows, sideMatchIds);

  return {
    events: events.length,
    updated: updated,
    sideOdds: sideUpdated,
    unmatched: unmatched.slice(0, 8),
    missingOdds: missingOdds,
    skippedManual: skippedManual,
    skippedNotLive: skippedNotLive,
  };
}

function sideOddsRowsForMatch_(match, sideOdds, source) {
  return (sideOdds || []).map(function(option) {
    var odds = valueOrBlank_(option.odds);
    if (odds === '') return null;
    var cleanOption = sanitizeSideOddsOption_(option);
    if (!cleanOption) return null;
    var row = {
      matchId: String(match.matchId),
      marketType: cleanOption.marketType,
      marketLabel: cleanOption.marketLabel,
      outcomeKey: cleanOption.outcomeKey,
      outcomeLabel: cleanOption.outcomeLabel,
      line: cleanOption.line == null ? '' : cleanOption.line,
      odds: odds,
      source: source,
      lastSyncedAt: nowIso_(),
    };
    row.oddsId = sideOddsId_(row.matchId, row.marketType, row.outcomeKey, row.line);
    return row;
  }).filter(function(row) {
    return row && isValidSideOddsRow_(row);
  });
}

function upsertSideOddsRows_(sideRows, matchIds) {
  matchIds = matchIds || {};
  var matchIdKeys = Object.keys(matchIds);
  if (!matchIdKeys.length) return 0;

  var odds = table_(SHEETS.odds);
  var manualIds = {};
  odds.rows.forEach(function(row) {
    if (matchIds[String(row.matchId)] && row.source === 'manual') manualIds[String(row.oddsId)] = true;
  });

  var providerRows = (sideRows || []).filter(function(row) {
    return !manualIds[String(row.oddsId)];
  });
  var keptRows = odds.rows.filter(function(row) {
    return row.source === 'manual' || !matchIds[String(row.matchId)];
  });

  replaceRows_(SHEETS.odds, keptRows.concat(providerRows));
  return providerRows.length;
}

function sideOddsId_(matchId, marketType, outcomeKey, line) {
  return [matchId, marketType, outcomeKey, line].map(function(part) {
    return String(part == null ? '' : part).trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_');
  }).join('|');
}

function sanitizeSideOddsOption_(option) {
  if (!option || !option.marketType || !option.outcomeKey) return null;
  var clean = {
    marketType: normalizeMarketType_(option.marketType, option),
    marketLabel: String(option.marketLabel || ''),
    outcomeKey: String(option.outcomeKey || ''),
    outcomeLabel: String(option.outcomeLabel || ''),
    line: option.line == null ? '' : option.line,
  };
  if (clean.marketType === 'total') {
    var direction = overUnderKey_(firstPresent_([clean.outcomeKey, clean.outcomeLabel]));
    var totalLine = parseBetLine_(firstPresent_([clean.line, clean.outcomeLabel, clean.outcomeKey]));
    if (!direction || totalLine === '') return null;
    clean.marketLabel = clean.marketLabel || 'Over / Under';
    clean.outcomeKey = direction;
    clean.outcomeLabel = capitalize_(direction) + ' ' + totalLine;
    clean.line = totalLine;
  }
  if (clean.marketType === 'handicap') {
    var handicapLine = parseBetLine_(firstPresent_([clean.line, clean.outcomeLabel, clean.outcomeKey]));
    if (handicapLine === '') return null;
    clean.marketLabel = clean.marketLabel || 'Handicap';
    clean.line = handicapLine;
  }
  if (clean.marketType === 'correct_score') {
    var score = parseScoreOutcomeLabel_(firstPresent_([
      clean.outcomeLabel,
      clean.line,
      String(clean.outcomeKey).replace(/^score:/, ''),
    ]));
    if (!score) return null;
    clean.marketLabel = clean.marketLabel || 'Correct score';
    clean.outcomeKey = 'score:' + score;
    clean.outcomeLabel = score;
    clean.line = score;
  }
  return clean;
}

function isValidSideOddsRow_(row) {
  if (!row || !row.marketType || !row.outcomeKey || row.odds === '') return false;
  var marketType = normalizeMarketType_(row.marketType, row);
  if (marketType === 'total') {
    return !!overUnderKey_(firstPresent_([row.outcomeKey, row.outcomeLabel])) && parseBetLine_(firstPresent_([row.line, row.outcomeLabel, row.outcomeKey])) !== '';
  }
  if (marketType === 'handicap') {
    return parseBetLine_(firstPresent_([row.line, row.outcomeLabel, row.outcomeKey])) !== '';
  }
  if (marketType !== 'correct_score') return true;
  return Boolean(parseScoreOutcomeLabel_(firstPresent_([
    row.outcomeLabel,
    row.line,
    String(row.outcomeKey).replace(/^score:/, ''),
  ])));
}

function sideMarketOrder_(marketType) {
  if (marketType === 'total') return 1;
  if (marketType === 'handicap') return 2;
  if (marketType === 'correct_score') return 3;
  return 9;
}

function sideForTeamName_(value, homeTeam, awayTeam) {
  var key = normalizeTeamNameForOdds_(value);
  if (!key) return '';
  if (key === normalizeTeamNameForOdds_(homeTeam)) return 'home';
  if (key === normalizeTeamNameForOdds_(awayTeam)) return 'away';
  return '';
}

function overUnderKey_(value) {
  var key = String(value || '').trim().toLowerCase();
  if (key.indexOf('over') >= 0) return 'over';
  if (key.indexOf('under') >= 0) return 'under';
  return '';
}

function signedLine_(line) {
  var n = Number(line);
  if (!Number.isFinite(n)) return String(line || '');
  return n > 0 ? '+' + n : String(n);
}

function parseBetLine_(value) {
  if (value == null || value === '') return '';
  var direct = Number(value);
  if (Number.isFinite(direct)) return direct;
  var text = String(value || '').trim();
  var match = text.match(/[+-]?\d+(?:\.\d+)?/);
  if (!match) return '';
  var parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : '';
}

function capitalize_(value) {
  value = String(value || '');
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function parseScoreOutcomeLabel_(value) {
  var text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text) || /t\d{2}:\d{2}/i.test(text)) return '';
  var match = text.match(/^(\d{1,2})\s*[-:]\s*(\d{1,2})$/);
  if (!match) return '';
  return Number(match[1]) + '-' + Number(match[2]);
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
    existingById[match.matchId] = mergeExistingMatchSnapshot_(existingById[match.matchId], match);
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

  if (existing.scoreSource === 'manual' && incoming.status !== 'final' && !hasMatchScore_(incoming)) {
    match.status = existing.status || incoming.status;
    match.homeScore = existing.homeScore;
    match.awayScore = existing.awayScore;
    match.scoreSource = 'manual';
    match.manualUpdatedBy = existing.manualUpdatedBy;
  }

  if (hasMatchOdds_(existing)) {
    match.oddsHome = existing.oddsHome;
    match.oddsDraw = existing.oddsDraw;
    match.oddsAway = existing.oddsAway;
    match.oddsSource = existing.oddsSource || 'manual';
  }

  return match;
}

function mergeExistingMatchSnapshot_(current, candidate) {
  if (!current) return Object.assign({}, candidate);
  var merged = Object.assign({}, current);

  if (candidate.scoreSource === 'manual' && !hasMatchScore_(merged)) {
    merged.status = candidate.status || merged.status;
    merged.homeScore = candidate.homeScore;
    merged.awayScore = candidate.awayScore;
    merged.scoreSource = 'manual';
    merged.manualUpdatedBy = candidate.manualUpdatedBy;
  }

  if (candidate.scoreSource === 'fifa' && hasMatchScore_(candidate)) {
    merged.status = candidate.status || merged.status;
    merged.homeScore = candidate.homeScore;
    merged.awayScore = candidate.awayScore;
    merged.scoreSource = 'fifa';
    merged.manualUpdatedBy = '';
  }

  if (!hasMatchOdds_(merged) && hasMatchOdds_(candidate)) {
    merged.oddsHome = candidate.oddsHome;
    merged.oddsDraw = candidate.oddsDraw;
    merged.oddsAway = candidate.oddsAway;
    merged.oddsSource = candidate.oddsSource || 'manual';
  }

  if (candidate.oddsSource === 'manual' || candidate.oddsSource === 'odds-api' || candidate.oddsSource === 'odds-api.io') {
    merged.oddsHome = candidate.oddsHome;
    merged.oddsDraw = candidate.oddsDraw;
    merged.oddsAway = candidate.oddsAway;
    merged.oddsSource = candidate.oddsSource;
  }

  return merged;
}

function hasMatchOdds_(match) {
  return !!match && (match.oddsHome !== '' || match.oddsDraw !== '' || match.oddsAway !== '');
}

function hasMatchScore_(match) {
  return !!match && match.homeScore !== '' && match.awayScore !== '';
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
  var predictions = table_(SHEETS.predictions).rows;
  var auditRows = table_(SHEETS.audit).rows;
  return users.map(function(user) {
    var stats = leaderboardStats_(user, matches, predictions, auditRows);
    return {
      userId: user.userId,
      displayName: user.displayName,
      total: stats.total,
      settledCoins: stats.total,
      availableCoins: tokenBalance_(user, matches, predictions, auditRows),
      waitingCoins: stats.waitingCoins,
      wins: stats.wins,
      losses: stats.losses,
    };
  }).sort(function(a, b) {
    return b.total - a.total || b.wins - a.wins || a.losses - b.losses || a.displayName.localeCompare(b.displayName);
  });
}

function leaderboardStats_(user, matches, predictions, auditRows) {
  var stats = {
    total: startingTokens_(user) + transferDelta_(user.userId, auditRows),
    waitingCoins: 0,
    wins: 0,
    losses: 0,
  };

  predictions.filter(function(prediction) {
    return prediction.userId === user.userId;
  }).forEach(function(prediction) {
    var match = find_(matches, function(m) { return m.matchId === prediction.matchId; });
    var status = predictionStatus_(prediction, match);
    if (status === 'pending') {
      stats.waitingCoins += Number(prediction.tokenAmount || 0);
      return;
    }

    stats.total -= Number(prediction.tokenAmount || 0);
    stats.total += payoutForPrediction_(prediction, match);
    if (status === 'won') stats.wins += 1;
    if (status === 'lost') stats.losses += 1;
  });

  stats.total = Math.max(0, Math.floor(stats.total));
  return stats;
}

function betHistory_(viewer, matches, predictions, users) {
  return predictions.map(function(prediction) {
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
      marketType: predictionMarketType_(prediction),
      marketLabel: prediction.marketLabel || 'Match winner',
      outcomeLabel: prediction.outcomeLabel || resultToken_(prediction.predictedResult, match),
      line: prediction.line || '',
      token: prediction.outcomeLabel || resultToken_(prediction.predictedResult, match),
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

function coinTransfers_(auditRows, users) {
  return (auditRows || []).filter(function(row) {
    return row.action === 'transferCoins';
  }).map(function(row) {
    var payload = parsePayload_(row.payload);
    var sender = find_(users, function(u) { return u.userId === row.userId; });
    var recipient = find_(users, function(u) { return u.userId === row.targetId; });
    return {
      transferId: row.auditId,
      createdAt: row.createdAt,
      fromUserId: row.userId,
      fromDisplayName: sender ? sender.displayName : payload.fromDisplayName || 'Someone',
      toUserId: row.targetId,
      toDisplayName: recipient ? recipient.displayName : payload.toDisplayName || 'Someone',
      amount: Number(payload.amount || 0),
    };
  }).filter(function(row) {
    return row.amount > 0;
  }).sort(function(a, b) {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
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
  var outcome = evaluatePrediction_(prediction, match);
  return outcome;
}

function oppositeBetExists_(predictions, betOption) {
  if (betOption.marketType !== 'h2h' || betOption.predictedResult === 'draw') return false;
  var opposite = betOption.predictedResult === 'home' ? 'away' : 'home';
  return predictions.some(function(prediction) {
    return predictionMarketType_(prediction) === 'h2h' && prediction.predictedResult === opposite;
  });
}

function tokenBalance_(user, matches, predictions, auditRows) {
  var balance = startingTokens_(user) + transferDelta_(user.userId, auditRows);
  predictions.filter(function(prediction) {
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
  var status = evaluatePrediction_(prediction, match);
  if (status === 'void') return Number(prediction.tokenAmount || 0);
  if (status !== 'won') return 0;
  return Math.floor(Number(prediction.tokenAmount || 0) * oddsMultiplier_(prediction.oddsAtPrediction));
}

function predictionMarketType_(prediction) {
  return normalizeMarketType_(prediction.marketType, prediction) || 'h2h';
}

function normalizeMarketType_(marketType, row) {
  var key = String(marketType || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  var label = String(firstPresent_([
    row && row.marketLabel,
    row && row.outcomeLabel,
    row && row.predictedResult,
    row && row.outcomeKey,
  ]) || '').trim().toLowerCase();

  if (['h2h', 'winner', 'match winner', 'match result', 'moneyline', 'ml', '1x2'].indexOf(key) >= 0) return 'h2h';
  if (['total', 'totals', 'over under', 'over / under', 'over/under'].indexOf(key) >= 0) return 'total';
  if (key.indexOf('over') >= 0 || key.indexOf('under') >= 0) return 'total';
  if (['handicap', 'spread', 'spreads'].indexOf(key) >= 0) return 'handicap';
  if (key === 'correct score' || key === 'correctscore' || key === 'exact score') return 'correct_score';

  if (overUnderKey_(label)) return 'total';
  if (label.indexOf('handicap') >= 0 || label.indexOf('spread') >= 0) return 'handicap';
  if (label.indexOf('correct score') >= 0 || parseScoreOutcomeLabel_(label)) return 'correct_score';
  return key || '';
}

function evaluatePrediction_(prediction, match) {
  var homeScore = Number(match.homeScore);
  var awayScore = Number(match.awayScore);
  var marketType = predictionMarketType_(prediction);

  if (marketType === 'h2h') {
    return prediction.predictedResult === resultFromScores_(homeScore, awayScore) ? 'won' : 'lost';
  }

  if (marketType === 'total') {
    var total = homeScore + awayScore;
    var totalDirection = overUnderKey_(firstPresent_([
      prediction.predictedResult,
      prediction.outcomeLabel,
    ]));
    var totalLine = parseBetLine_(firstPresent_([
      prediction.line,
      prediction.outcomeLabel,
      prediction.marketLabel,
      prediction.predictedResult,
    ]));
    if (totalLine === '') return 'pending';
    if (total === totalLine) return 'void';
    if (totalDirection === 'over') return total > totalLine ? 'won' : 'lost';
    if (totalDirection === 'under') return total < totalLine ? 'won' : 'lost';
    return 'lost';
  }

  if (marketType === 'handicap') {
    var line = parseBetLine_(firstPresent_([
      prediction.line,
      prediction.outcomeLabel,
      prediction.marketLabel,
    ]));
    if (line === '') return 'pending';
    var adjustedHome = homeScore + (prediction.predictedResult === 'home' ? line : 0);
    var adjustedAway = awayScore + (prediction.predictedResult === 'away' ? line : 0);
    if (adjustedHome === adjustedAway) return 'void';
    if (prediction.predictedResult === 'home') return adjustedHome > adjustedAway ? 'won' : 'lost';
    if (prediction.predictedResult === 'away') return adjustedAway > adjustedHome ? 'won' : 'lost';
    return 'lost';
  }

  if (marketType === 'correct_score') {
    return prediction.predictedResult === 'score:' + homeScore + '-' + awayScore ? 'won' : 'lost';
  }

  return 'lost';
}

function oddsMultiplier_(value) {
  var n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

function transferDelta_(userId, auditRows) {
  var rows = auditRows || table_(SHEETS.audit).rows;
  return rows.reduce(function(total, row) {
    if (row.action !== 'transferCoins') return total;
    var amount = Number(parsePayload_(row.payload).amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) return total;
    if (row.userId === userId) total -= amount;
    if (row.targetId === userId) total += amount;
    return total;
  }, 0);
}

function parsePayload_(payload) {
  if (!payload) return {};
  if (typeof payload === 'object') return payload;
  try {
    return JSON.parse(String(payload));
  } catch (err) {
    return {};
  }
}

function startingTokens_(user) {
  var tokens = Number(user.startingTokens);
  if (Number.isFinite(tokens) && tokens > 0) return tokens;
  return user.status === 'approved' ? STARTING_TOKENS : 0;
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
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (HEADERS[name]) ensureHeaders_(sheet, HEADERS[name]);
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
  var index = findIndex_(users.rows, function(u) {
    return sessionTokens_(u.token).indexOf(String(token)) >= 0;
  });
  if (index < 0) return null;
  var user = users.rows[index];
  if (!user || user.status !== 'approved') return null;
  if (new Date(user.tokenExpiresAt).getTime() < Date.now()) return null;
  var expires = sessionExpiry_();
  users.update(index, { tokenExpiresAt: expires });
  user.tokenExpiresAt = expires;
  return ensureStartingTokens_(users, index);
}

function sessionExpiry_() {
  return new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function sessionTokens_(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  var raw = String(value || '').trim();
  if (!raw) return [];
  if (raw.charAt(0) === '[') {
    try {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch (err) {
      // Fall through to legacy parsing.
    }
  }
  return raw.split('|').map(function(token) { return token.trim(); }).filter(Boolean);
}

function serializeSessionTokens_(tokens) {
  var seen = {};
  var unique = [];
  tokens.forEach(function(token) {
    token = String(token || '').trim();
    if (!token || seen[token]) return;
    seen[token] = true;
    unique.push(token);
  });
  return JSON.stringify(unique.slice(Math.max(0, unique.length - SESSION_TOKEN_LIMIT)));
}

function publicUser_(user, matches, predictions, auditRows) {
  var startingTokens = startingTokens_(user);
  return {
    userId: user.userId,
    username: user.username,
    displayName: user.displayName,
    status: user.status,
    role: user.role,
    startingTokens: startingTokens,
    tokenBalance: matches && predictions ? tokenBalance_(user, matches, predictions, auditRows) : startingTokens + transferDelta_(user.userId, auditRows),
  };
}

function publicMatch_(match, oddsRows) {
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
    sideOdds: publicSideOdds_(match.matchId, oddsRows),
    scoreSource: match.scoreSource,
    oddsSource: match.oddsSource,
  };
}

function publicSideOdds_(matchId, oddsRows) {
  return (oddsRows || []).filter(function(row) {
    return String(row.matchId) === String(matchId) && isValidSideOddsRow_(row);
  }).map(function(row) {
    var clean = sanitizeSideOddsOption_(row) || row;
    return {
      optionId: row.oddsId,
      marketType: normalizeMarketType_(clean.marketType, clean),
      marketLabel: clean.marketLabel,
      outcomeKey: clean.outcomeKey,
      outcomeLabel: clean.outcomeLabel,
      line: clean.line,
      odds: row.odds,
      source: row.source,
    };
  }).sort(function(a, b) {
    return sideMarketOrder_(a.marketType) - sideMarketOrder_(b.marketType) || String(a.outcomeLabel).localeCompare(String(b.outcomeLabel));
  });
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

function resolveBetOption_(match, body) {
  var marketType = String(body.marketType || 'h2h').trim().toLowerCase();
  if (marketType === 'winner') marketType = 'h2h';

  if (marketType === 'h2h') {
    var predictedResult = parsePredictedResult_(body.predictedResult);
    var oddsAtPrediction = oddsForResult_(match, predictedResult);
    if (oddsAtPrediction === '') throw new Error('Odds are not available for this match yet.');
    return {
      marketType: 'h2h',
      marketLabel: 'Match winner',
      predictedResult: predictedResult,
      outcomeLabel: resultToken_(predictedResult, match),
      line: '',
      oddsAtPrediction: oddsAtPrediction,
    };
  }

  if (['total', 'handicap', 'correct_score'].indexOf(marketType) < 0) throw new Error('Bet type is not available.');
  var optionId = String(body.optionId || '').trim();
  if (!optionId) throw new Error('Choose an available betting option.');
  var option = find_(table_(SHEETS.odds).rows, function(row) {
    return String(row.oddsId) === optionId && String(row.matchId) === String(match.matchId) && String(row.marketType) === marketType && isValidSideOddsRow_(row);
  });
  if (!option || option.odds === '') throw new Error('That side bet is not available anymore.');
  var cleanOption = sanitizeSideOddsOption_(option);
  if (!cleanOption) throw new Error('That side bet is not available anymore.');

  return {
    marketType: cleanOption.marketType,
    marketLabel: cleanOption.marketLabel,
    predictedResult: cleanOption.outcomeKey,
    outcomeLabel: cleanOption.outcomeLabel,
    line: cleanOption.line,
    oddsAtPrediction: valueOrBlank_(option.odds),
  };
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

function lowerCaseHeaders_(headers) {
  var normalized = {};
  Object.keys(headers || {}).forEach(function(key) {
    normalized[String(key).toLowerCase()] = headers[key];
  });
  return normalized;
}

function nowIso_() {
  return new Date().toISOString();
}

function configValue_(key, fallback) {
  var propValue = PropertiesService.getScriptProperties().getProperty(key);
  if (propValue != null && propValue !== '') return String(propValue).trim();

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
