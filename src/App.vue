<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import BetView from './BetView.vue';
import { apiBaseConfigured, callApi, pingBackend, snapshot, type BetHistoryEntry, type BetOption, type CoinTransferEntry, type Match, type Snapshot, type User } from './api';
import { flagBackgroundStyle, teamFlagUrl } from './flags';

type ViewKey = 'matches' | 'previous' | 'history';
type SettledBetNotification = {
  id: string;
  resultStatus: 'won' | 'lost';
  title: string;
  detail: string;
};
const MATCH_WINDOW_HOURS = 24;
const PREVIOUS_MATCH_LIMIT = 20;
const STARTING_COINS = 1000;
const SNAPSHOT_CACHE_KEY = 'wc-snapshot-cache-v4';
const SNAPSHOT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BET_NOTICE_KEY_PREFIX = 'wc-seen-settled-bets-v1';
const siteBannerUrl = `${import.meta.env.BASE_URL}site-banner.png`;

const emptySnapshot: Snapshot = { user: null, matches: [], predictions: [], leaderboard: [], pendingUsers: [], betHistory: [], coinTransfers: [] };
const token = ref(localStorage.getItem('wc-token') || '');
const loading = ref(false);
const loadingAction = ref('');
const backgroundAction = ref('');
const booting = ref(Boolean(token.value));
const message = ref('');
const connection = ref(apiBaseConfigured ? 'Checking backend...' : 'Set VITE_API_BASE to your Apps Script Web App URL.');
const data = ref<Snapshot>(emptySnapshot);
const authMode = ref<'login' | 'register'>('login');
const activeView = ref<ViewKey>('matches');
const selectedMatchId = ref('');
const selectedUserId = ref('');
const transferAmount = ref('');
const settledBetNotifications = ref<SettledBetNotification[]>([]);

const auth = reactive({ username: '', displayName: '', password: '' });
const draftScores = reactive<Record<string, { homeScore: number; awayScore: number; status: string }>>({});

const user = computed(() => data.value.user);
const matches = computed(() => [...data.value.matches].sort((a, b) => new Date(a.kickoffAt).getTime() - new Date(b.kickoffAt).getTime()));
const previousMatches = computed(() => matches.value
  .filter((match) => match.status === 'final' || (locked(match) && match.status !== 'live'))
  .sort((a, b) => new Date(b.kickoffAt).getTime() - new Date(a.kickoffAt).getTime())
  .slice(0, PREVIOUS_MATCH_LIMIT));
const liveMatches = computed(() => matches.value.filter((match) => match.status === 'live' && isWithinAroundNow(match, MATCH_WINDOW_HOURS)));
const upcomingMatches = computed(() => matches.value.filter((match) => isWithinNextHours(match, MATCH_WINDOW_HOURS) && !locked(match) && match.status === 'scheduled'));
const mainMatches = computed(() => [...liveMatches.value, ...upcomingMatches.value]);
const betHistory = computed(() => data.value.betHistory ?? []);
const visibleBetHistory = computed(() => betHistory.value
  .filter((entry) => isEntryWithinMatchWindow(entry))
  .sort((a, b) => new Date(b.updatedAt || b.kickoffAt).getTime() - new Date(a.updatedAt || a.kickoffAt).getTime()));
const selectedMatch = computed(() => matches.value.find((match) => match.matchId === selectedMatchId.value));
const selectedMatchEntries = computed(() => betHistory.value.filter((entry) => entry.matchId === selectedMatchId.value));
const betCountsByMatch = computed(() => {
  return betHistory.value.reduce<Record<string, number>>((map, entry) => {
    map[entry.matchId] = (map[entry.matchId] ?? 0) + 1;
    return map;
  }, {});
});
const waitingCoinsByUser = computed(() => {
  return betHistory.value.reduce<Record<string, number>>((map, entry) => {
    if (entry.resultStatus !== 'pending') return map;
    map[entry.userId] = (map[entry.userId] ?? 0) + Number(entry.tokenAmount || 0);
    return map;
  }, {});
});
const activeBetsByUser = computed(() => {
  return betHistory.value.reduce<Record<string, number>>((map, entry) => {
    const matchStatus = (entry.matchStatus || '').toLowerCase();
    if (entry.resultStatus !== 'pending') return map;
    if (['final', 'postponed', 'cancelled'].includes(matchStatus)) return map;
    map[entry.userId] = (map[entry.userId] ?? 0) + 1;
    return map;
  }, {});
});
const settledRecordByUser = computed(() => {
  return betHistory.value.reduce<Record<string, { wins: number; losses: number }>>((map, entry) => {
    if (!map[entry.userId]) map[entry.userId] = { wins: 0, losses: 0 };
    if (entry.resultStatus === 'won') map[entry.userId].wins += 1;
    if (entry.resultStatus === 'lost') map[entry.userId].losses += 1;
    return map;
  }, {});
});
const finishedBetsByUser = computed(() => {
  return betHistory.value.reduce<Record<string, number>>((map, entry) => {
    if (entry.resultStatus === 'pending') return map;
    map[entry.userId] = (map[entry.userId] ?? 0) + 1;
    return map;
  }, {});
});
const displayLeaderboard = computed(() => {
  return data.value.leaderboard
    .filter((entry) => (finishedBetsByUser.value[entry.userId] ?? 0) >= 1)
    .map((entry) => {
      const record = settledRecordByUser.value[entry.userId] ?? { wins: 0, losses: 0 };
      return {
        ...entry,
        displayTotal: leaderboardCoins(entry),
        displayWins: Math.max(Number(entry.wins ?? 0), record.wins),
        displayLosses: Math.max(Number(entry.losses ?? 0), record.losses),
        activeBetCount: activeBetsByUser.value[entry.userId] ?? 0,
      };
    })
    .sort((a, b) => b.displayTotal - a.displayTotal || b.displayWins - a.displayWins || a.displayLosses - b.displayLosses || a.displayName.localeCompare(b.displayName));
});
const visibleLeaderboard = computed(() => displayLeaderboard.value.slice(0, 12));
const selectedUserProfile = computed(() => {
  if (!selectedUserId.value) return null;
  return displayLeaderboard.value.find((entry) => entry.userId === selectedUserId.value)
    || (user.value?.userId === selectedUserId.value
      ? { userId: user.value.userId, displayName: user.value.displayName, displayTotal: user.value.tokenBalance ?? STARTING_COINS, availableCoins: user.value.tokenBalance ?? STARTING_COINS, waitingCoins: 0, displayWins: 0, displayLosses: 0 }
      : null);
});
const selectedUserHoldCoins = computed(() => {
  if (!selectedUserId.value) return 0;
  const localHold = waitingCoinsByUser.value[selectedUserId.value] ?? 0;
  const profileHold = Number(selectedUserProfile.value?.waitingCoins ?? 0);
  return Math.max(0, Math.floor(Number.isFinite(profileHold) ? Math.max(localHold, profileHold) : localHold));
});
const selectedUserAvailableCoins = computed(() => {
  const direct = Number(selectedUserProfile.value?.availableCoins);
  if (Number.isFinite(direct)) return Math.max(0, Math.floor(direct));
  const total = Number(selectedUserProfile.value?.displayTotal ?? STARTING_COINS);
  return Math.max(0, Math.floor(total - selectedUserHoldCoins.value));
});
const selectedUserBets = computed(() => {
  if (!selectedUserId.value) return [];
  return betHistory.value
    .filter((entry) => entry.userId === selectedUserId.value)
    .sort((a, b) => new Date(b.updatedAt || b.kickoffAt).getTime() - new Date(a.updatedAt || a.kickoffAt).getTime());
});
const selectedUserTransfers = computed(() => {
  if (!selectedUserId.value) return [];
  return (data.value.coinTransfers ?? [])
    .filter((entry) => entry.fromUserId === selectedUserId.value || entry.toUserId === selectedUserId.value)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
});
const selectedUserTimeline = computed(() => {
  const events = [
    ...selectedUserBets.value
      .filter((entry) => entry.resultStatus === 'won' || entry.resultStatus === 'lost')
      .map((entry) => ({
        at: entry.kickoffAt,
        label: entry.matchLabel,
        delta: entry.resultStatus === 'won' ? Number(entry.points || 0) - Number(entry.tokenAmount || 0) : -Number(entry.tokenAmount || 0),
      })),
    ...selectedUserTransfers.value.map((entry) => ({
      at: entry.createdAt,
      label: entry.fromUserId === selectedUserId.value ? `Sent to ${entry.toDisplayName}` : `Received from ${entry.fromDisplayName}`,
      delta: entry.fromUserId === selectedUserId.value ? -Number(entry.amount || 0) : Number(entry.amount || 0),
    })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  let balance = STARTING_COINS;
  return [
    { at: '', label: 'Start', balance },
    ...events.map((event) => {
      balance += event.delta;
      return { ...event, balance: Math.max(0, Math.floor(balance)) };
    }),
  ];
});
const selectedUserGraphItems = computed(() => {
  const points = selectedUserTimeline.value;
  if (!points.length) return [];
  const width = 320;
  const plotTop = 24;
  const plotBottom = 124;
  const pad = 16;
  const balances = points.map((point) => point.balance);
  const min = Math.min(...balances, STARTING_COINS);
  const max = Math.max(...balances, STARTING_COINS);
  const spread = Math.max(1, max - min);
  let lastDateLabel = '';

  return points.map((point, index) => {
    const x = points.length === 1 ? width / 2 : pad + (index * (width - pad * 2)) / (points.length - 1);
    const y = plotBottom - ((point.balance - min) / spread) * (plotBottom - plotTop);
    const previousX = index > 0 ? pad + ((index - 1) * (width - pad * 2)) / Math.max(1, points.length - 1) : -Infinity;
    const nextX = index < points.length - 1 ? pad + ((index + 1) * (width - pad * 2)) / Math.max(1, points.length - 1) : Infinity;
    const dateLabel = graphDateLabel(point.at);
    const showDate = dateLabel && dateLabel !== lastDateLabel;
    if (dateLabel) lastDateLabel = dateLabel;
    return {
      ...point,
      x,
      y,
      dateLabel,
      showDate,
      showValue: Math.min(x - previousX, nextX - x) >= 42 || points.length <= 6,
    };
  });
});
const selectedUserGraphPoints = computed(() => {
  return selectedUserGraphItems.value.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
});
const canTransferToSelectedUser = computed(() => Boolean(user.value && selectedUserProfile.value && selectedUserProfile.value.userId !== user.value.userId));
const currentMatches = computed(() => {
  if (activeView.value === 'matches') return mainMatches.value;
  if (activeView.value === 'previous') return previousMatches.value;
  return [];
});
const viewCards = computed(() => [
  { key: 'matches' as const, label: 'Matches', count: mainMatches.value.length, detail: 'Live first, then the next 24 hours' },
  { key: 'previous' as const, label: 'Previous matches', count: previousMatches.value.length, detail: 'Newest 20 results' },
  { key: 'history' as const, label: 'Bet history', count: visibleBetHistory.value.length, detail: 'Picks tied to the 24-hour match window' },
]);
onMounted(async () => {
  const restoredCache = restoreSnapshotCache();
  if (restoredCache) booting.value = false;

  try {
    void checkBackend();
    await load('refresh', { background: restoredCache, quiet: restoredCache });
  } finally {
    booting.value = false;
  }
});

async function checkBackend() {
  if (!apiBaseConfigured) return;
  try {
    await pingBackend();
    connection.value = 'Backend connected';
  } catch (err) {
    if (!data.value.user) connection.value = `Backend not connected: ${errorText(err)}`;
  }
}

async function load(action = 'refresh', options: { background?: boolean; quiet?: boolean } = {}) {
  if (!apiBaseConfigured) return;
  if (options.background) {
    backgroundAction.value = action;
  } else {
    loading.value = true;
    loadingAction.value = action;
  }
  if (!options.quiet) message.value = '';
  try {
    const nextSnapshot = await snapshot(token.value);
    if (token.value && !nextSnapshot.user) {
      message.value = 'Saved login expired. Please log in again.';
      clearSavedSession();
      return;
    }
    applySnapshot(nextSnapshot);
    connection.value = 'Backend connected';
  } catch (err) {
    if (options.background && data.value.user) {
      connection.value = `Showing saved data. Refresh failed: ${errorText(err)}`;
    } else {
      message.value = errorText(err);
    }
  } finally {
    if (options.background) {
      backgroundAction.value = '';
    } else {
      loading.value = false;
      loadingAction.value = '';
    }
  }
}

async function refreshMainPage() {
  await load('refresh', { background: Boolean(data.value.user) });
}

async function submitAuth() {
  loading.value = true;
  loadingAction.value = 'auth';
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
    applySnapshot(await snapshot(token.value));
  } catch (err) {
    message.value = errorText(err);
  } finally {
    loading.value = false;
    loadingAction.value = '';
  }
}

async function savePrediction(match: Match, option: BetOption, tokenAmount: number) {
  await mutate({
    action: 'submitPrediction',
    token: token.value,
    matchId: match.matchId,
    optionId: option.optionId,
    marketType: option.marketType,
    predictedResult: option.outcomeKey,
    tokenAmount,
  }, 'bet');
}

async function reportScore(match: Match) {
  await mutate({
    action: 'reportScore',
    token: token.value,
    matchId: match.matchId,
    ...draftScores[match.matchId],
  }, 'score');
}

async function approve(pendingUser: User, approved: boolean) {
  await mutate({ action: 'approveUser', token: token.value, userId: pendingUser.userId, approved }, approved ? 'approve' : 'reject');
}

async function refreshFifa() {
  loading.value = true;
  loadingAction.value = 'fifa';
  message.value = '';
  try {
    const result = await callApi<{ refreshed?: number; removedDuplicates?: number }>({ action: 'syncFifa', token: token.value });
    applySnapshot(await snapshot(token.value));
    message.value = `FIFA refreshed: ${result.refreshed ?? 0} matches, ${result.removedDuplicates ?? 0} duplicates removed.`;
  } catch (err) {
    message.value = errorText(err);
  } finally {
    loading.value = false;
    loadingAction.value = '';
  }
}

async function refreshOdds() {
  loading.value = true;
  loadingAction.value = 'odds';
  message.value = '';
  try {
    const result = await callApi<{ skipped?: boolean; reason?: string; updated?: number; events?: number; missingOdds?: number; unmatched?: string[]; requestsRemaining?: string; requestsLast?: string }>({ action: 'refreshOdds', token: token.value });
    applySnapshot(await snapshot(token.value));
    if (result.skipped) {
      message.value = result.reason || 'Manual odds refresh skipped.';
      return;
    }
    const unmatchedText = result.unmatched?.length ? ` Unmatched: ${result.unmatched.join(', ')}.` : '';
    const costText = result.requestsLast ? ` Cost: ${result.requestsLast} credit${result.requestsLast === '1' ? '' : 's'}.` : '';
    const remainingText = result.requestsRemaining ? ` Requests left: ${result.requestsRemaining}.` : '';
    message.value = `Odds refreshed: ${result.updated ?? 0} matches updated from ${result.events ?? 0} odds events.${costText}${unmatchedText}${remainingText}`;
  } catch (err) {
    message.value = errorText(err);
  } finally {
    loading.value = false;
    loadingAction.value = '';
  }
}

async function refreshAccessRequests() {
  loading.value = true;
  loadingAction.value = 'requests';
  message.value = '';
  try {
    applySnapshot(await snapshot(token.value));
    const count = data.value.pendingUsers.length;
    message.value = `Access requests refreshed: ${count} waiting.`;
  } catch (err) {
    message.value = errorText(err);
  } finally {
    loading.value = false;
    loadingAction.value = '';
  }
}

async function mutate(payload: Record<string, unknown>, action = 'save') {
  loading.value = true;
  loadingAction.value = action;
  message.value = '';
  try {
    applySnapshot(await callApi<Snapshot>(payload));
  } catch (err) {
    message.value = errorText(err);
  } finally {
    loading.value = false;
    loadingAction.value = '';
  }
}

function logout() {
  clearSavedSession();
}

function clearSavedSession() {
  token.value = '';
  localStorage.removeItem('wc-token');
  localStorage.removeItem(SNAPSHOT_CACHE_KEY);
  data.value = { ...emptySnapshot };
  selectedMatchId.value = '';
}

function seedDrafts() {
  data.value.matches.forEach((match) => {
    draftScores[match.matchId] = {
      homeScore: Number(match.homeScore || 0),
      awayScore: Number(match.awayScore || 0),
      status: match.status || 'live',
    };
  });
}

function applySnapshot(nextSnapshot: Snapshot, options: { cache?: boolean; notify?: boolean } = {}) {
  data.value = normalizeSnapshot(nextSnapshot);
  if (!data.value.betHistory) data.value.betHistory = [];
  if (!data.value.coinTransfers) data.value.coinTransfers = [];
  seedDrafts();
  if (options.notify !== false) queueSettledBetNotifications(data.value);
  if (options.cache !== false) writeSnapshotCache(data.value);
}

function queueSettledBetNotifications(nextSnapshot: Snapshot) {
  if (!nextSnapshot.user) return;
  const seen = readSeenBetNotices(nextSnapshot.user.userId);
  const fresh = (nextSnapshot.betHistory ?? [])
    .filter((entry) => entry.isMine && (entry.resultStatus === 'won' || entry.resultStatus === 'lost') && !seen.has(entry.predictionId))
    .sort((a, b) => new Date(b.updatedAt || b.kickoffAt).getTime() - new Date(a.updatedAt || a.kickoffAt).getTime());
  if (!fresh.length) return;

  fresh.forEach((entry) => seen.add(entry.predictionId));
  writeSeenBetNotices(nextSnapshot.user.userId, seen);

  settledBetNotifications.value = [
    ...fresh.slice(0, 5).map(settledBetNotificationFromEntry),
    ...settledBetNotifications.value,
  ].slice(0, 5);
}

function settledBetNotificationFromEntry(entry: BetHistoryEntry): SettledBetNotification {
  const won = entry.resultStatus === 'won';
  const payout = Math.max(0, Math.floor(Number(entry.points || 0)));
  const stake = Math.max(0, Math.floor(Number(entry.tokenAmount || 0)));
  return {
    id: entry.predictionId,
    resultStatus: won ? 'won' : 'lost',
    title: won ? `Bet won: +${Math.max(0, payout - stake)} coins` : `Bet lost: -${stake} coins`,
    detail: `${entry.matchLabel} • ${entry.token} • ${won ? `${payout} coins payout` : `${stake} coins stake`}`,
  };
}

function dismissBetNotification(id: string) {
  settledBetNotifications.value = settledBetNotifications.value.filter((item) => item.id !== id);
}

function betNoticeStorageKey(userId: string) {
  return `${BET_NOTICE_KEY_PREFIX}:${userId}`;
}

function readSeenBetNotices(userId: string) {
  try {
    const ids = JSON.parse(localStorage.getItem(betNoticeStorageKey(userId)) || '[]');
    return new Set<string>(Array.isArray(ids) ? ids.map(String) : []);
  } catch {
    localStorage.removeItem(betNoticeStorageKey(userId));
    return new Set<string>();
  }
}

function writeSeenBetNotices(userId: string, ids: Set<string>) {
  localStorage.setItem(betNoticeStorageKey(userId), JSON.stringify([...ids].slice(-500)));
}

function normalizeSnapshot(nextSnapshot: Snapshot): Snapshot {
  return {
    ...emptySnapshot,
    ...nextSnapshot,
    matches: Array.isArray(nextSnapshot.matches) ? nextSnapshot.matches : [],
    predictions: Array.isArray(nextSnapshot.predictions) ? nextSnapshot.predictions : [],
    leaderboard: Array.isArray(nextSnapshot.leaderboard) ? nextSnapshot.leaderboard : [],
    pendingUsers: Array.isArray(nextSnapshot.pendingUsers) ? nextSnapshot.pendingUsers : [],
    betHistory: Array.isArray(nextSnapshot.betHistory) ? nextSnapshot.betHistory : [],
    coinTransfers: Array.isArray(nextSnapshot.coinTransfers) ? nextSnapshot.coinTransfers : [],
  };
}

function restoreSnapshotCache() {
  if (!token.value) return false;
  try {
    const cached = JSON.parse(localStorage.getItem(SNAPSHOT_CACHE_KEY) || 'null') as { version?: number; token?: string; savedAt?: number; snapshot?: Snapshot } | null;
    if (!cached || cached.version !== 4 || cached.token !== token.value || !cached.snapshot?.user) return false;
    if (!cached.savedAt || Date.now() - cached.savedAt > SNAPSHOT_CACHE_MAX_AGE_MS) return false;
    applySnapshot(cached.snapshot, { cache: false, notify: false });
    connection.value = 'Showing saved data while refreshing...';
    return true;
  } catch {
    localStorage.removeItem(SNAPSHOT_CACHE_KEY);
    return false;
  }
}

function writeSnapshotCache(nextSnapshot: Snapshot) {
  if (!token.value || !nextSnapshot.user) {
    localStorage.removeItem(SNAPSHOT_CACHE_KEY);
    return;
  }
  try {
    localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 4,
      token: token.value,
      savedAt: Date.now(),
      snapshot: nextSnapshot,
    }));
  } catch {
    localStorage.removeItem(SNAPSHOT_CACHE_KEY);
  }
}

function isLoadingAction(action: string) {
  return (loading.value && loadingAction.value === action) || backgroundAction.value === action;
}

function locked(match: Match) {
  if (match.status === 'live') return false;
  if (['final', 'postponed', 'cancelled'].includes(match.status)) return true;
  return new Date(match.kickoffAt).getTime() <= Date.now();
}

function isWithinNextHours(match: Match, hours: number) {
  const kickoff = new Date(match.kickoffAt).getTime();
  const now = Date.now();
  return kickoff >= now && kickoff <= now + hours * 60 * 60 * 1000;
}

function isWithinAroundNow(match: Match, hours: number) {
  const kickoff = new Date(match.kickoffAt).getTime();
  const now = Date.now();
  const windowMs = hours * 60 * 60 * 1000;
  return kickoff >= now - windowMs && kickoff <= now + windowMs;
}

function isEntryWithinMatchWindow(entry: BetHistoryEntry) {
  const kickoff = new Date(entry.kickoffAt).getTime();
  const now = Date.now();
  const windowMs = MATCH_WINDOW_HOURS * 60 * 60 * 1000;
  return kickoff >= now - windowMs && kickoff <= now + windowMs;
}

function selectView(view: ViewKey) {
  activeView.value = view;
  nextTick(() => {
    const cardSelector = view === 'history' ? '.history-grid .history-card' : '.match-grid .match-card-button';
    const target = document.querySelector<HTMLElement>(cardSelector) || document.querySelector<HTMLElement>('[data-content-start]');
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}

function openBet(match: Match) {
  selectedMatchId.value = match.matchId;
  nextTick(() => {
    document.querySelector('[data-bet-target="pick"]')?.scrollIntoView({ block: 'start' });
  });
}

function openUserProfile(userId: string) {
  selectedUserId.value = userId;
  transferAmount.value = '';
}

function closeUserProfile() {
  selectedUserId.value = '';
  transferAmount.value = '';
}

async function submitTransfer() {
  if (!selectedUserProfile.value || !canTransferToSelectedUser.value) return;
  const amount = Number(transferAmount.value);
  if (!Number.isInteger(amount) || amount < 1) {
    message.value = 'Transfer amount must be at least 1 coin.';
    return;
  }

  await mutate({
    action: 'transferCoins',
    token: token.value,
    toUserId: selectedUserProfile.value.userId,
    amount,
  }, 'transfer');
  transferAmount.value = '';
}

function transferText(entry: CoinTransferEntry) {
  if (entry.fromUserId === selectedUserId.value) return `Sent ${entry.amount} coins to ${entry.toDisplayName}`;
  return `Received ${entry.amount} coins from ${entry.fromDisplayName}`;
}

async function savePredictionFromBetView(option: BetOption, tokenAmount: number) {
  if (!selectedMatch.value) return;
  await savePrediction(selectedMatch.value, option, tokenAmount);
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
  if (status === 'void') return 'Returned';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function betCountText(matchId: string) {
  const count = betCountsByMatch.value[matchId] ?? 0;
  return `${count} ${count === 1 ? 'bet' : 'bets'}`;
}

function leaderboardCoins(entry: Snapshot['leaderboard'][number]) {
  const settled = Number(entry.settledCoins);
  if (Number.isFinite(settled)) return Math.max(0, Math.floor(settled));
  return Math.max(0, Math.floor(Number(entry.total || 0) + (waitingCoinsByUser.value[entry.userId] ?? 0)));
}

function formatKickoff(value: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function graphDateLabel(value: string) {
  if (!value) return 'Start';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
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
  <main class="shell" :class="{ 'is-busy': loading, 'auth-shell': !user }" :aria-busy="loading">
    <div class="site-banner" aria-hidden="true">
      <img :src="siteBannerUrl" alt="" />
    </div>

    <header v-if="user" class="topbar account-strip">
      <p class="connection-status inline-status">{{ connection }}</p>
      <div class="account">
        <div class="coin-wallet" aria-label="Available coins">
          <small>Available coins</small>
          <strong>{{ user.tokenBalance ?? 0 }}</strong>
        </div>
        <span>{{ user.displayName }}</span>
        <div class="account-actions">
          <button type="button" class="ghost-button" :class="{ 'is-loading': isLoadingAction('refresh') }" :disabled="isLoadingAction('refresh')" @click="refreshMainPage">Refresh</button>
          <button type="button" class="ghost-button" @click="logout">Log out</button>
        </div>
      </div>
    </header>

    <p v-if="!user" class="connection-status">{{ connection }}</p>
    <div v-if="loading" class="loading-bar" aria-hidden="true"><span></span></div>
    <p v-if="message" class="notice">{{ message }}</p>
    <div v-if="settledBetNotifications.length" class="bet-notification-stack" aria-live="polite" aria-label="Bet result notifications">
      <article v-for="item in settledBetNotifications" :key="item.id" class="bet-notification" :class="item.resultStatus">
        <div>
          <strong>{{ item.title }}</strong>
          <span>{{ item.detail }}</span>
        </div>
        <button type="button" class="notification-close" aria-label="Dismiss notification" @click="dismissBetNotification(item.id)">Close</button>
      </article>
    </div>

    <section v-if="!user && booting" class="auth-card session-card">
      <h2>Loading your page...</h2>
      <p class="muted">Restoring saved login.</p>
    </section>

    <section v-else-if="!user" class="auth-card">
      <div class="tabs">
        <button :class="{ active: authMode === 'login' }" type="button" :disabled="loading" @click="authMode = 'login'">Log in</button>
        <button :class="{ active: authMode === 'register' }" type="button" :disabled="loading" @click="authMode = 'register'">Request access</button>
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
        <button type="submit" :class="{ 'is-loading': isLoadingAction('auth') }" :disabled="loading">{{ authMode === 'login' ? 'Log in' : 'Send request' }}</button>
      </form>
    </section>

    <template v-else>
      <BetView
        v-if="selectedMatch"
        :match="selectedMatch"
        :entries="selectedMatchEntries"
        :score-draft="draftScores[selectedMatch.matchId] || { homeScore: 0, awayScore: 0, status: 'live' }"
        :token-balance="user.tokenBalance ?? 0"
        :loading="loading"
        :locked="locked(selectedMatch)"
        @back="selectedMatchId = ''"
        @save-prediction="savePredictionFromBetView"
        @report-score="reportScoreFromBetView"
        @open-user="openUserProfile"
      />

      <template v-else>
      <nav class="view-tabs" aria-label="Main views">
        <button v-for="card in viewCards" :key="card.key" type="button" class="view-tab" :class="{ active: activeView === card.key }" @click="selectView(card.key)">
          <span>{{ card.label.replace(' ', '\n') }}</span>
          <strong>{{ card.count }}</strong>
        </button>
      </nav>

      <section class="utility-grid" :class="{ 'non-admin-utility': user.role !== 'admin' }">
        <div class="stat-card leaderboard-card">
          <div class="section-head leaderboard-head">
            <div>
              <h2>Ländüğüï Leaderboard</h2>
              <p class="leaderboard-prize">&#31532;&#19968;&#21517;&#21487;&#20197;&#25910;&#29554;&#19968;&#20491;&#12300;&#31639;&#20320;&#21426;&#23475;&#12301;</p>
            </div>
          </div>
          <ol class="leaderboard">
            <li
              v-for="(entry, index) in visibleLeaderboard"
              :key="entry.userId"
              class="profile-trigger"
              role="button"
              tabindex="0"
              @click="openUserProfile(entry.userId)"
              @keydown.enter.prevent="openUserProfile(entry.userId)"
              @keydown.space.prevent="openUserProfile(entry.userId)"
            >
              <strong class="leaderboard-rank">{{ index + 1 }}</strong>
              <span class="leaderboard-player">
                <span>{{ entry.displayName }}</span>
                <small>
                  <span class="record-win">{{ entry.displayWins }}W</span>
                  <span class="record-loss">{{ entry.displayLosses }}L</span>
                  <span v-if="entry.activeBetCount" class="active-bet-chip">{{ entry.activeBetCount }} active {{ entry.activeBetCount === 1 ? 'bet' : 'bets' }}</span>
                </small>
              </span>
              <strong>{{ entry.displayTotal }} coins</strong>
            </li>
          </ol>
          <p class="leaderboard-disclaimer">
            Leaderboard ranking starts after a player has at least 1 finished bet. Active bets do not count yet.
            <span v-if="displayLeaderboard.length > visibleLeaderboard.length">Showing top {{ visibleLeaderboard.length }}.</span>
          </p>
        </div>
      </section>

      <section v-if="activeView !== 'history'" class="content-section" data-content-start>
        <div class="section-head">
          <h2>{{ viewCards.find((card) => card.key === activeView)?.label }}</h2>
          <button type="button" class="small-button secondary" :class="{ 'is-loading': isLoadingAction('refresh') }" :disabled="isLoadingAction('refresh')" @click="refreshMainPage">Refresh</button>
        </div>

        <p v-if="!currentMatches.length" class="empty-state">Nothing here right now.</p>

        <div class="match-grid">
          <button v-for="match in currentMatches" :key="match.matchId" type="button" class="match-card match-card-button flag-gradient-card" :style="flagBackgroundStyle(match.homeTeam, match.awayTeam)" @click="openBet(match)">
            <div class="match-card-header">
              <strong class="bet-count-pill">{{ betCountText(match.matchId) }}</strong>
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

      <section v-else class="content-section" data-content-start>
        <div class="section-head">
          <h2>Bet history</h2>
          <button type="button" class="small-button secondary" :class="{ 'is-loading': isLoadingAction('refresh') }" :disabled="isLoadingAction('refresh')" @click="refreshMainPage">Refresh</button>
        </div>

        <p v-if="!visibleBetHistory.length" class="empty-state">No bets in the 24-hour window yet.</p>

        <div class="history-grid">
          <article
            v-for="entry in visibleBetHistory"
            :key="entry.predictionId"
            class="history-card profile-trigger"
            :class="{ mine: entry.isMine, won: entry.resultStatus === 'won', lost: entry.resultStatus === 'lost' }"
            role="button"
            tabindex="0"
            @click="openUserProfile(entry.userId)"
            @keydown.enter.prevent="openUserProfile(entry.userId)"
            @keydown.space.prevent="openUserProfile(entry.userId)"
          >
            <div class="history-person">
              <strong>{{ entry.displayName }}</strong>
              <time v-if="formatKickoff(entry.updatedAt)">Bet {{ formatKickoff(entry.updatedAt) }}</time>
            </div>
            <div class="history-match">
              <strong>{{ entry.matchLabel }}</strong>
              <time>Match {{ formatKickoff(entry.kickoffAt) }}</time>
            </div>
            <div class="history-stats">
              <span>
                <small>{{ entry.marketLabel || 'Pick' }}</small>
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
            <span :class="['status-pill', entry.matchStatus]">{{ statusText(entry.matchStatus) }}</span>
          </article>
        </div>
      </section>

      <section v-if="user.role === 'admin'" class="admin-space">
        <div class="stat-card admin-card">
          <div class="section-head">
            <h2>Admin</h2>
            <div class="admin-actions">
              <button type="button" class="small-button secondary" :class="{ 'is-loading': isLoadingAction('requests') }" :disabled="loading" @click="refreshAccessRequests">Refresh requests</button>
              <button type="button" class="small-button" :class="{ 'is-loading': isLoadingAction('fifa') }" :disabled="loading" @click="refreshFifa">Refresh FIFA</button>
              <button type="button" class="small-button secondary" :class="{ 'is-loading': isLoadingAction('odds') }" :disabled="loading" @click="refreshOdds">Refresh odds</button>
            </div>
          </div>
          <p v-if="!data.pendingUsers.length" class="muted">No pending users.</p>
          <div v-for="pendingUser in data.pendingUsers" :key="pendingUser.userId" class="approval">
            <span>{{ pendingUser.displayName }} <small>@{{ pendingUser.username }}</small></span>
            <div>
              <button type="button" class="small-button" :class="{ 'is-loading': isLoadingAction('approve') }" :disabled="loading" @click="approve(pendingUser, true)">Approve</button>
              <button type="button" class="small-button secondary" :class="{ 'is-loading': isLoadingAction('reject') }" :disabled="loading" @click="approve(pendingUser, false)">Reject</button>
            </div>
          </div>
        </div>
      </section>
      </template>
    </template>

    <div v-if="selectedUserProfile" class="profile-backdrop" role="dialog" aria-modal="true" @click.self="closeUserProfile">
      <section class="profile-modal">
        <div class="section-head">
          <div>
            <p class="eyebrow">Player profile</p>
            <h2>{{ selectedUserProfile.displayName }}</h2>
          </div>
          <button type="button" class="ghost-button small-button" @click="closeUserProfile">Close</button>
        </div>

        <div class="profile-summary">
          <span>
            <small>Available</small>
            <strong>{{ selectedUserAvailableCoins }}</strong>
          </span>
          <span>
            <small>On hold</small>
            <strong>{{ selectedUserHoldCoins }}</strong>
          </span>
          <span>
            <small>Record</small>
            <strong>{{ selectedUserProfile.displayWins }}W / {{ selectedUserProfile.displayLosses }}L</strong>
          </span>
          <span>
            <small>Bets</small>
            <strong>{{ selectedUserBets.length }}</strong>
          </span>
        </div>

        <div class="profile-graph">
          <div class="section-head compact-head">
            <h3>Coin history</h3>
            <span>{{ selectedUserTimeline[selectedUserTimeline.length - 1]?.balance ?? STARTING_COINS }} coins</span>
          </div>
          <svg viewBox="0 0 320 164" role="img" aria-label="Coin history graph">
            <polyline :points="selectedUserGraphPoints" />
            <g v-for="point in selectedUserGraphItems" :key="`${point.at}-${point.balance}-${point.x}`">
              <text v-if="point.showValue" class="graph-value" :x="point.x" :y="Math.max(12, point.y - 9)">{{ point.balance }}</text>
              <circle :cx="point.x" :cy="point.y" r="3.4" />
              <text v-if="point.showDate" class="graph-date" :x="point.x" y="154">{{ point.dateLabel }}</text>
            </g>
          </svg>
        </div>

        <form v-if="canTransferToSelectedUser" class="transfer-form" @submit.prevent="submitTransfer">
          <label>
            Transfer coins
            <input v-model="transferAmount" type="number" inputmode="numeric" min="1" :max="user?.tokenBalance ?? 0" placeholder="Amount" />
          </label>
          <button type="submit" :class="{ 'is-loading': isLoadingAction('transfer') }" :disabled="loading">Send</button>
        </form>
        <p v-else class="muted profile-muted">This is you, so coin transfer is hidden.</p>

        <div class="profile-columns">
          <section>
            <div class="section-head compact-head">
              <h3>Bet history</h3>
              <span>{{ selectedUserBets.length }}</span>
            </div>
            <p v-if="!selectedUserBets.length" class="empty-state compact-empty">No bets yet.</p>
            <div v-else class="profile-list">
              <article v-for="entry in selectedUserBets" :key="entry.predictionId" :class="{ won: entry.resultStatus === 'won', lost: entry.resultStatus === 'lost', returned: entry.resultStatus === 'void' }">
                <strong>{{ entry.matchLabel }}</strong>
                <span>{{ entry.marketLabel || 'Pick' }} · {{ entry.token }} · {{ entry.tokenAmount }} coins · {{ formatOdds(entry.oddsAtPrediction) }} odds</span>
                <small>{{ statusText(entry.resultStatus) }} · {{ formatKickoff(entry.updatedAt || entry.kickoffAt) }}</small>
              </article>
            </div>
          </section>

          <section>
            <div class="section-head compact-head">
              <h3>Coin activity</h3>
              <span>{{ selectedUserTransfers.length }}</span>
            </div>
            <p v-if="!selectedUserTransfers.length" class="empty-state compact-empty">No transfers yet.</p>
            <div v-else class="profile-list">
              <article v-for="entry in selectedUserTransfers" :key="entry.transferId">
                <strong>{{ transferText(entry) }}</strong>
                <small>{{ formatKickoff(entry.createdAt) }}</small>
              </article>
            </div>
          </section>
        </div>
      </section>
    </div>
  </main>
</template>
