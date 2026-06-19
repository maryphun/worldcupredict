<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import BetView from './BetView.vue';
import { apiBaseConfigured, callApi, pingBackend, snapshot, type BetHistoryEntry, type Match, type Prediction, type Snapshot, type User } from './api';
import { flagBackgroundStyle, teamFlagUrl } from './flags';

type ViewKey = 'matches' | 'previous' | 'history';

const emptySnapshot: Snapshot = { user: null, matches: [], predictions: [], leaderboard: [], pendingUsers: [], betHistory: [] };
const token = ref(localStorage.getItem('wc-token') || '');
const loading = ref(false);
const message = ref('');
const connection = ref(apiBaseConfigured ? 'Checking backend...' : 'Set VITE_API_BASE to your Apps Script Web App URL.');
const data = ref<Snapshot>(emptySnapshot);
const authMode = ref<'login' | 'register'>('login');
const activeView = ref<ViewKey>('matches');
const selectedMatchId = ref('');

const auth = reactive({ username: '', displayName: '', password: '' });
const draftPredictions = reactive<Record<string, { predictedResult: 'home' | 'draw' | 'away' | ''; tokenAmount: number }>>({});
const draftScores = reactive<Record<string, { homeScore: number; awayScore: number; status: string }>>({});

const user = computed(() => data.value.user);
const matches = computed(() => [...data.value.matches].sort((a, b) => new Date(a.kickoffAt).getTime() - new Date(b.kickoffAt).getTime()));
const previousMatches = computed(() => matches.value.filter((match) => isWithinPreviousDays(match, 3) && (match.status === 'final' || (locked(match) && match.status !== 'live'))));
const liveMatches = computed(() => matches.value.filter((match) => match.status === 'live'));
const upcomingMatches = computed(() => matches.value.filter((match) => isWithinNextDays(match, 3) && !locked(match) && match.status === 'scheduled'));
const mainMatches = computed(() => [...liveMatches.value, ...upcomingMatches.value]);
const betHistory = computed(() => data.value.betHistory ?? []);
const visibleBetHistory = computed(() => betHistory.value.filter((entry) => isEntryWithinThreeDayWindow(entry)));
const selectedMatch = computed(() => matches.value.find((match) => match.matchId === selectedMatchId.value));
const selectedMatchEntries = computed(() => betHistory.value.filter((entry) => entry.matchId === selectedMatchId.value));
const currentMatches = computed(() => {
  if (activeView.value === 'matches') return mainMatches.value;
  if (activeView.value === 'previous') return previousMatches.value;
  return [];
});
const viewCards = computed(() => [
  { key: 'matches' as const, label: 'Matches', count: mainMatches.value.length, detail: 'Live first, then the next three days' },
  { key: 'previous' as const, label: 'Previous matches', count: previousMatches.value.length, detail: 'Scores, outcomes, and settled picks' },
  { key: 'history' as const, label: 'Bet history', count: visibleBetHistory.value.length, detail: 'Group picks, odds, and result status' },
]);
const predictionsByMatch = computed(() => {
  return data.value.predictions.reduce<Record<string, Prediction>>((map, prediction) => {
    map[prediction.matchId] = prediction;
    return map;
  }, {});
});

onMounted(async () => {
  await checkBackend();
  await load();
});

async function checkBackend() {
  if (!apiBaseConfigured) return;
  try {
    await pingBackend();
    connection.value = 'Backend connected';
  } catch (err) {
    connection.value = `Backend not connected: ${errorText(err)}`;
  }
}

async function load() {
  if (!apiBaseConfigured) return;
  loading.value = true;
  message.value = '';
  try {
    data.value = await snapshot(token.value);
    if (!data.value.betHistory) data.value.betHistory = [];
    seedDrafts();
  } catch (err) {
    message.value = errorText(err);
    token.value = '';
    localStorage.removeItem('wc-token');
  } finally {
    loading.value = false;
  }
}

async function submitAuth() {
  loading.value = true;
  message.value = '';
  try {
    if (authMode.value === 'register') {
      await callApi({ action: 'register', ...auth });
      message.value = 'Request sent. You can log in after approval.';
      authMode.value = 'login';
      return;
    }
    const result = await callApi<{ token: string }>({ action: 'login', username: auth.username, password: auth.password });
    token.value = result.token;
    localStorage.setItem('wc-token', result.token);
    await load();
  } catch (err) {
    message.value = errorText(err);
  } finally {
    loading.value = false;
  }
}

async function savePrediction(match: Match) {
  await mutate({
    action: 'submitPrediction',
    token: token.value,
    matchId: match.matchId,
    ...draftPredictions[match.matchId],
  });
}

async function reportScore(match: Match) {
  await mutate({
    action: 'reportScore',
    token: token.value,
    matchId: match.matchId,
    ...draftScores[match.matchId],
  });
}

async function approve(pendingUser: User, approved: boolean) {
  await mutate({ action: 'approveUser', token: token.value, userId: pendingUser.userId, approved });
}

async function refreshFifa() {
  loading.value = true;
  message.value = '';
  try {
    const result = await callApi<{ refreshed?: number; removedDuplicates?: number }>({ action: 'syncFifa', token: token.value });
    data.value = await snapshot(token.value);
    if (!data.value.betHistory) data.value.betHistory = [];
    seedDrafts();
    message.value = `FIFA refreshed: ${result.refreshed ?? 0} matches, ${result.removedDuplicates ?? 0} duplicates removed.`;
  } catch (err) {
    message.value = errorText(err);
  } finally {
    loading.value = false;
  }
}

async function refreshOdds() {
  loading.value = true;
  message.value = '';
  try {
    const result = await callApi<{ updated?: number; events?: number; missingOdds?: number; unmatched?: string[]; requestsRemaining?: string; requestsLast?: string }>({ action: 'refreshOdds', token: token.value });
    data.value = await snapshot(token.value);
    if (!data.value.betHistory) data.value.betHistory = [];
    seedDrafts();
    const unmatchedText = result.unmatched?.length ? ` Unmatched: ${result.unmatched.join(', ')}.` : '';
    const costText = result.requestsLast ? ` Cost: ${result.requestsLast} credit${result.requestsLast === '1' ? '' : 's'}.` : '';
    const remainingText = result.requestsRemaining ? ` Requests left: ${result.requestsRemaining}.` : '';
    message.value = `Odds refreshed: ${result.updated ?? 0} matches updated from ${result.events ?? 0} odds events.${costText}${unmatchedText}${remainingText}`;
  } catch (err) {
    message.value = errorText(err);
  } finally {
    loading.value = false;
  }
}

async function mutate(payload: Record<string, unknown>) {
  loading.value = true;
  message.value = '';
  try {
    data.value = await callApi<Snapshot>(payload);
    if (!data.value.betHistory) data.value.betHistory = [];
    seedDrafts();
  } catch (err) {
    message.value = errorText(err);
  } finally {
    loading.value = false;
  }
}

function logout() {
  token.value = '';
  localStorage.removeItem('wc-token');
  data.value = { ...emptySnapshot };
  selectedMatchId.value = '';
}

function seedDrafts() {
  data.value.matches.forEach((match) => {
    const prediction = predictionsByMatch.value[match.matchId];
    draftPredictions[match.matchId] = {
      predictedResult: prediction?.predictedResult ?? '',
      tokenAmount: Number(prediction?.tokenAmount ?? 0),
    };
    draftScores[match.matchId] = {
      homeScore: Number(match.homeScore || 0),
      awayScore: Number(match.awayScore || 0),
      status: match.status || 'live',
    };
  });
}

function locked(match: Match) {
  return new Date(match.kickoffAt).getTime() <= Date.now();
}

function isWithinNextDays(match: Match, days: number) {
  const kickoff = new Date(match.kickoffAt).getTime();
  const now = Date.now();
  return kickoff >= now && kickoff <= now + days * 24 * 60 * 60 * 1000;
}

function isWithinPreviousDays(match: Match, days: number) {
  const kickoff = new Date(match.kickoffAt).getTime();
  const now = Date.now();
  return kickoff < now && kickoff >= now - days * 24 * 60 * 60 * 1000;
}

function isEntryWithinThreeDayWindow(entry: BetHistoryEntry) {
  const kickoff = new Date(entry.kickoffAt).getTime();
  const now = Date.now();
  return kickoff >= now - 3 * 24 * 60 * 60 * 1000 && kickoff <= now + 3 * 24 * 60 * 60 * 1000;
}

function openBet(match: Match) {
  selectedMatchId.value = match.matchId;
}

async function savePredictionFromBetView(predictedResult: 'home' | 'draw' | 'away', tokenAmount: number) {
  if (!selectedMatch.value) return;
  draftPredictions[selectedMatch.value.matchId] = { predictedResult, tokenAmount };
  await savePrediction(selectedMatch.value);
}

async function reportScoreFromBetView(homeScore: number, awayScore: number, status: string) {
  if (!selectedMatch.value) return;
  draftScores[selectedMatch.value.matchId] = { homeScore, awayScore, status };
  await reportScore(selectedMatch.value);
}

function scoreText(match: Match) {
  return `${match.homeScore === '' ? '-' : match.homeScore} : ${match.awayScore === '' ? '-' : match.awayScore}`;
}

function countdownText(kickoffAt: string) {
  const diffMs = new Date(kickoffAt).getTime() - Date.now();
  if (diffMs <= 0) return 'Starting now';
  if (diffMs < 60 * 60 * 1000) return 'Starting soon';
  const hours = Math.ceil(diffMs / (60 * 60 * 1000));
  return hours === 1 ? 'Starts in 1h' : `Starts in ${hours}h`;
}

function statusText(status: string) {
  if (status === 'pending') return 'Waiting';
  if (status === 'won') return 'Won';
  if (status === 'lost') return 'Lost';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatKickoff(value: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatOdds(value: number | string | '') {
  if (value === '' || value == null) return '-';
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : String(value);
}

function errorText(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">Private pool</p>
        <h1>World Cup Predictions</h1>
      </div>
      <div v-if="user" class="account">
        <div class="coin-wallet" aria-label="Available coins">
          <small>Available coins</small>
          <strong>{{ user.tokenBalance ?? 0 }}</strong>
        </div>
        <span>{{ user.displayName }}</span>
        <button type="button" class="ghost-button" @click="logout">Log out</button>
      </div>
    </header>

    <p class="connection-status">{{ connection }}</p>
    <p v-if="message" class="notice">{{ message }}</p>

    <section v-if="!user" class="auth-card">
      <div class="tabs">
        <button :class="{ active: authMode === 'login' }" type="button" @click="authMode = 'login'">Log in</button>
        <button :class="{ active: authMode === 'register' }" type="button" @click="authMode = 'register'">Request access</button>
      </div>
      <form class="auth-form" @submit.prevent="submitAuth">
        <label>
          Username
          <input v-model="auth.username" autocomplete="username" required />
        </label>
        <label v-if="authMode === 'register'">
          Display name
          <input v-model="auth.displayName" autocomplete="name" required />
        </label>
        <label>
          Password
          <input v-model="auth.password" autocomplete="current-password" type="password" required />
        </label>
        <button type="submit" :disabled="loading">{{ authMode === 'login' ? 'Log in' : 'Send request' }}</button>
      </form>
    </section>

    <template v-else>
      <BetView
        v-if="selectedMatch"
        :match="selectedMatch"
        :entries="selectedMatchEntries"
        :prediction-draft="draftPredictions[selectedMatch.matchId] || { predictedResult: '', tokenAmount: 0 }"
        :score-draft="draftScores[selectedMatch.matchId] || { homeScore: 0, awayScore: 0, status: 'live' }"
        :token-balance="user.tokenBalance ?? 0"
        :loading="loading"
        :locked="locked(selectedMatch)"
        @back="selectedMatchId = ''"
        @save-prediction="savePredictionFromBetView"
        @report-score="reportScoreFromBetView"
      />

      <template v-else>
      <section class="overview-grid" aria-label="Main views">
        <button v-for="card in viewCards" :key="card.key" type="button" class="view-card" :class="{ active: activeView === card.key }" @click="activeView = card.key">
          <span>{{ card.label }}</span>
          <strong>{{ card.count }}</strong>
              <small>{{ card.detail }}</small>
        </button>
      </section>

      <section class="utility-grid">
        <div class="stat-card leaderboard-card">
          <div class="section-head">
            <h2>Coin leaderboard</h2>
          </div>
          <ol class="leaderboard">
            <li v-for="entry in data.leaderboard" :key="entry.userId">
              <span>{{ entry.displayName }}</span>
              <strong>{{ entry.total }} coins</strong>
            </li>
          </ol>
        </div>

        <div v-if="user.role === 'admin'" class="stat-card admin-card">
          <div class="section-head">
            <h2>Admin</h2>
            <div class="admin-actions">
              <button type="button" class="small-button" @click="refreshFifa">Refresh FIFA</button>
              <button type="button" class="small-button secondary" @click="refreshOdds">Refresh odds</button>
            </div>
          </div>
          <p v-if="!data.pendingUsers.length" class="muted">No pending users.</p>
          <div v-for="pendingUser in data.pendingUsers" :key="pendingUser.userId" class="approval">
            <span>{{ pendingUser.displayName }} <small>@{{ pendingUser.username }}</small></span>
            <div>
              <button type="button" class="small-button" @click="approve(pendingUser, true)">Approve</button>
              <button type="button" class="small-button secondary" @click="approve(pendingUser, false)">Reject</button>
            </div>
          </div>
        </div>
      </section>

      <section v-if="activeView !== 'history'" class="content-section">
        <div class="section-head">
          <h2>{{ viewCards.find((card) => card.key === activeView)?.label }}</h2>
          <button type="button" class="small-button secondary" @click="load">Refresh</button>
        </div>

        <p v-if="!currentMatches.length" class="empty-state">Nothing here right now.</p>

        <div class="match-grid">
          <button v-for="match in currentMatches" :key="match.matchId" type="button" class="match-card match-card-button flag-gradient-card" :style="flagBackgroundStyle(match.homeTeam, match.awayTeam)" @click="openBet(match)">
            <div class="match-card-header">
              <div class="match-card-time">
                <span>{{ match.groupName || match.stage || match.competition }}</span>
                <time>{{ formatKickoff(match.kickoffAt) }}</time>
              </div>
              <strong v-if="match.status === 'scheduled'" class="countdown-pill">{{ countdownText(match.kickoffAt) }}</strong>
              <strong v-else :class="['status-pill', match.status]">{{ statusText(match.status) }}</strong>
            </div>

            <div class="teams" :class="{ 'teams-upcoming': match.status === 'scheduled' }">
              <strong><img v-if="teamFlagUrl(match.homeTeam)" class="flag-badge" :src="teamFlagUrl(match.homeTeam)" :alt="`${match.homeTeam} flag`" />{{ match.homeTeam }}</strong>
              <span v-if="match.status !== 'scheduled'">{{ scoreText(match) }}</span>
              <strong>{{ match.awayTeam }}<img v-if="teamFlagUrl(match.awayTeam)" class="flag-badge" :src="teamFlagUrl(match.awayTeam)" :alt="`${match.awayTeam} flag`" /></strong>
            </div>

            <div class="odds-row" aria-label="Result odds">
              <span>{{ match.homeTeam }} <strong>{{ formatOdds(match.oddsHome) }}</strong></span>
              <span>Draw <strong>{{ formatOdds(match.oddsDraw) }}</strong></span>
              <span>{{ match.awayTeam }} <strong>{{ formatOdds(match.oddsAway) }}</strong></span>
            </div>

          </button>
        </div>
      </section>

      <section v-else class="content-section">
        <div class="section-head">
          <h2>Bet history</h2>
          <button type="button" class="small-button secondary" @click="load">Refresh</button>
        </div>

        <p v-if="!visibleBetHistory.length" class="empty-state">No bets in the three-day window yet.</p>

        <div class="history-grid">
          <article v-for="entry in visibleBetHistory" :key="entry.predictionId" class="history-card" :class="{ mine: entry.isMine }">
            <div class="history-top">
              <div class="history-person">
                <strong>{{ entry.displayName }}</strong>
                <time v-if="formatKickoff(entry.updatedAt)">Bet {{ formatKickoff(entry.updatedAt) }}</time>
              </div>
              <span :class="['status-pill', entry.matchStatus]">{{ statusText(entry.matchStatus) }}</span>
            </div>
            <p>{{ entry.matchLabel }}</p>
            <div class="history-stats">
              <span>
                <small>Pick</small>
                <strong>{{ entry.token }}</strong>
              </span>
              <span>
                <small>Coins</small>
                <strong>{{ entry.tokenAmount }}</strong>
              </span>
              <span>
                <small>Odds</small>
                <strong>{{ formatOdds(entry.oddsAtPrediction) }}</strong>
              </span>
              <span>
                <small>Result</small>
                <strong>{{ statusText(entry.resultStatus) }}</strong>
              </span>
            </div>
            <time>Match {{ formatKickoff(entry.kickoffAt) }}</time>
          </article>
        </div>
      </section>
      </template>
    </template>
  </main>
</template>
