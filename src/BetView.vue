<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import type { BetHistoryEntry, BetOption, Match } from './api';
import { flagBackgroundStyle, teamFlagUrl } from './flags';

const props = defineProps<{
  match: Match;
  entries: BetHistoryEntry[];
  scoreDraft: { homeScore: number; awayScore: number; status: string };
  tokenBalance: number;
  loading: boolean;
  locked: boolean;
}>();

const emit = defineEmits<{
  back: [];
  savePrediction: [option: BetOption, tokenAmount: number];
  reportScore: [homeScore: number, awayScore: number, status: string];
  openUser: [userId: string];
}>();

const score = reactive({ homeScore: 0, awayScore: 0, status: 'live' });
const selectedOptionId = ref('');
const tokenInput = ref('');
const modalOpen = ref(false);
const tokenModal = ref<HTMLElement | null>(null);

const winnerOptions = computed<BetOption[]>(() => [
  { optionId: `${props.match.matchId}:h2h:home`, marketType: 'h2h', marketLabel: 'Match winner', outcomeKey: 'home', outcomeLabel: props.match.homeTeam, line: '', odds: props.match.oddsHome },
  { optionId: `${props.match.matchId}:h2h:draw`, marketType: 'h2h', marketLabel: 'Match winner', outcomeKey: 'draw', outcomeLabel: 'Draw', line: '', odds: props.match.oddsDraw },
  { optionId: `${props.match.matchId}:h2h:away`, marketType: 'h2h', marketLabel: 'Match winner', outcomeKey: 'away', outcomeLabel: props.match.awayTeam, line: '', odds: props.match.oddsAway },
]);
const sideOptions = computed(() => (props.match.sideOdds ?? []).filter(isDisplayableBetOption));
const sideMarketGroups = computed(() => {
  const groups = sideOptions.value.reduce<Record<string, { label: string; options: BetOption[] }>>((map, option) => {
    const key = option.marketType;
    if (!map[key]) map[key] = { label: option.marketLabel, options: [] };
    map[key].options.push(option);
    return map;
  }, {});
  return Object.values(groups);
});
const allOptions = computed(() => [...winnerOptions.value, ...sideOptions.value]);
const sortedEntries = computed(() => [...props.entries].sort((a, b) => (
  Number(b.isMine) - Number(a.isMine)
  || new Date(b.updatedAt || b.kickoffAt).getTime() - new Date(a.updatedAt || a.kickoffAt).getTime()
  || a.displayName.localeCompare(b.displayName)
)));
const myActiveEntries = computed(() => props.entries.filter((entry) => entry.isMine && entry.resultStatus === 'pending'));
const activeStake = computed(() => myActiveEntries.value.reduce((total, entry) => total + Number(entry.tokenAmount || 0), 0));
const activePickCount = computed(() => myActiveEntries.value.length);
const tokenAmount = computed(() => Number(tokenInput.value || 0));
const maxBetTokens = computed(() => Math.max(0, Number(props.tokenBalance || 0)));
const isOverBalance = computed(() => tokenAmount.value > maxBetTokens.value);
const selectedOption = computed(() => allOptions.value.find((option) => option.optionId === selectedOptionId.value));
const selectedOddsMultiplier = computed(() => {
  const odds = Number(selectedOption.value?.odds);
  return Number.isFinite(odds) && odds > 0 ? odds : 2;
});
const potentialReturn = computed(() => Math.floor(tokenAmount.value * selectedOddsMultiplier.value));

watch(
  () => props.match.matchId,
  () => {
    selectedOptionId.value = '';
    tokenInput.value = '';
  },
  { immediate: true },
);

watch(
  () => props.scoreDraft,
  (draft) => {
    score.homeScore = Number(draft?.homeScore ?? 0);
    score.awayScore = Number(draft?.awayScore ?? 0);
    score.status = draft?.status || 'live';
  },
  { immediate: true, deep: true },
);

function choosePick(option: BetOption) {
  if (props.locked || isPickBlocked(option) || formatOdds(option.odds) === '-') return;
  selectedOptionId.value = option.optionId;
  modalOpen.value = true;
  nextTick(() => {
    requestAnimationFrame(() => {
      tokenModal.value?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    });
  });
}

function isDisplayableBetOption(option: BetOption) {
  if (option.marketType !== 'correct_score') return true;
  return /^\d{1,2}\s*[-:]\s*\d{1,2}$/.test(String(option.outcomeLabel || '').trim());
}

function isPickBlocked(option: BetOption) {
  if (option.marketType !== 'h2h' || option.outcomeKey === 'draw') return false;
  const opposite = option.outcomeKey === 'home' ? 'away' : 'home';
  return myActiveEntries.value.some((entry) => (entry.marketType || 'h2h') === 'h2h' && entry.predictedResult === opposite);
}

function pressDigit(digit: string) {
  if (tokenInput.value.length >= 4) return;
  const nextValue = tokenInput.value === '0' ? digit : tokenInput.value + digit;
  tokenInput.value = Number(nextValue) > maxBetTokens.value ? String(maxBetTokens.value) : nextValue;
}

function backspace() {
  tokenInput.value = tokenInput.value.slice(0, -1);
}

function clearTokens() {
  tokenInput.value = '';
}

function confirmBet() {
  if (!selectedOption.value || tokenAmount.value < 1 || isOverBalance.value) return;
  emit('savePrediction', selectedOption.value, tokenAmount.value);
  modalOpen.value = false;
}

function scoreText(match: Match) {
  return `${match.homeScore === '' ? '-' : match.homeScore} : ${match.awayScore === '' ? '-' : match.awayScore}`;
}

function statusText(status: string) {
  if (status === 'pending') return 'Waiting';
  if (status === 'won') return 'Won';
  if (status === 'lost') return 'Lost';
  if (status === 'void') return 'Returned';
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

function payoutText(entry: BetHistoryEntry) {
  const stake = Number(entry.tokenAmount || 0);
  const odds = Number(entry.oddsAtPrediction);
  if (!Number.isFinite(stake) || !Number.isFinite(odds) || stake <= 0 || odds <= 0) return '-';
  return `${Math.floor(stake * odds)} coins`;
}

function settlementLabel(entry: BetHistoryEntry) {
  if (entry.resultStatus === 'won') return 'Payout';
  if (entry.resultStatus === 'lost') return 'Lost';
  if (entry.resultStatus === 'void') return 'Returned';
  return 'Potential';
}

function settlementText(entry: BetHistoryEntry) {
  const stake = Math.max(0, Math.floor(Number(entry.tokenAmount || 0)));
  if (entry.resultStatus === 'lost') return `${stake} coins`;
  if (entry.resultStatus === 'void') return `${stake} coins`;
  return payoutText(entry);
}
</script>

<template>
  <section class="bet-page">
    <button type="button" class="ghost-button back-button" @click="emit('back')">Back</button>

    <div class="bet-hero flag-gradient-card" :style="flagBackgroundStyle(match.homeTeam, match.awayTeam)">
      <div>
        <p class="eyebrow">{{ match.groupName || match.stage || match.competition }}</p>
        <h2><img v-if="teamFlagUrl(match.homeTeam)" class="flag-badge hero-flag" :src="teamFlagUrl(match.homeTeam)" :alt="`${match.homeTeam} flag`" />{{ match.homeTeam }} vs {{ match.awayTeam }}<img v-if="teamFlagUrl(match.awayTeam)" class="flag-badge hero-flag" :src="teamFlagUrl(match.awayTeam)" :alt="`${match.awayTeam} flag`" /></h2>
        <time>{{ formatKickoff(match.kickoffAt) }}</time>
      </div>
      <span :class="['status-pill', match.status]">{{ statusText(match.status) }}</span>
    </div>

    <div class="bet-score flag-gradient-card" :style="flagBackgroundStyle(match.homeTeam, match.awayTeam)">
      <strong><img v-if="teamFlagUrl(match.homeTeam)" class="flag-badge" :src="teamFlagUrl(match.homeTeam)" :alt="`${match.homeTeam} flag`" />{{ match.homeTeam }}</strong>
      <span>{{ scoreText(match) }}</span>
      <strong>{{ match.awayTeam }}<img v-if="teamFlagUrl(match.awayTeam)" class="flag-badge" :src="teamFlagUrl(match.awayTeam)" :alt="`${match.awayTeam} flag`" /></strong>
    </div>

    <div class="bet-wallet">
      <small>Your coins</small>
      <strong>{{ tokenBalance }}</strong>
      <span v-if="activeStake">Active on this match: {{ activeStake }} coins in {{ activePickCount }} {{ activePickCount === 1 ? 'bet' : 'bets' }}</span>
    </div>

    <div class="bet-layout" :class="{ 'bet-layout-full': match.status !== 'live' }">
      <div class="bet-slip" data-bet-target="pick">
        <div class="section-head">
          <h2>Your bet</h2>
          <span class="status-pill">{{ locked ? 'Locked' : 'Open' }}</span>
        </div>

        <div class="pick-grid">
          <button v-for="option in winnerOptions" :key="option.optionId" type="button" class="pick-card" :class="{ active: selectedOptionId === option.optionId, blocked: isPickBlocked(option) }" :disabled="locked || loading || isPickBlocked(option)" @click="choosePick(option)">
            <span>{{ option.outcomeLabel }}</span>
            <strong>{{ formatOdds(option.odds) }}</strong>
            <small v-if="!locked && isPickBlocked(option)">Locked</small>
          </button>
        </div>

        <div v-if="sideMarketGroups.length" class="side-market-list">
          <section v-for="group in sideMarketGroups" :key="group.label" class="side-market-group">
            <h3>{{ group.label }}</h3>
            <div class="side-pick-grid">
              <button v-for="option in group.options" :key="option.optionId" type="button" class="side-pick-card" :class="{ active: selectedOptionId === option.optionId }" :disabled="locked || loading" @click="choosePick(option)">
                <span>{{ option.outcomeLabel }}</span>
                <strong>{{ formatOdds(option.odds) }}</strong>
              </button>
            </div>
          </section>
        </div>
        <p v-else class="bet-note">Side bets appear here when Over/Under, handicap, or correct score odds are available.</p>
        <p v-if="activePickCount" class="bet-note">You can add more bets. The opposite team is locked, but draw stays open.</p>
      </div>

      <form v-if="match.status === 'live'" class="score-slip" @submit.prevent="emit('reportScore', score.homeScore, score.awayScore, score.status)">
        <div class="section-head">
          <h2>Score report</h2>
        </div>
        <div class="bet-inputs compact">
          <input v-model.number="score.homeScore" type="number" min="0" max="99" />
          <input v-model.number="score.awayScore" type="number" min="0" max="99" />
          <select v-model="score.status">
            <option value="scheduled">Scheduled</option>
            <option value="live">Live</option>
            <option value="final">Final</option>
            <option value="postponed">Postponed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <button type="submit" class="secondary" :class="{ 'is-loading': loading }" :disabled="loading">Update score</button>
      </form>
    </div>

    <div class="section-head bets-head">
      <h2>Everyone's bets</h2>
      <span>{{ sortedEntries.length }} picks</span>
    </div>

    <p v-if="!sortedEntries.length" class="empty-state">No bets yet.</p>

    <div class="history-grid">
      <article
        v-for="entry in sortedEntries"
        :key="entry.predictionId"
        class="history-card profile-trigger"
        :class="{ mine: entry.isMine, won: entry.resultStatus === 'won', lost: entry.resultStatus === 'lost', returned: entry.resultStatus === 'void' }"
        role="button"
        tabindex="0"
        @click="emit('openUser', entry.userId)"
        @keydown.enter.prevent="emit('openUser', entry.userId)"
        @keydown.space.prevent="emit('openUser', entry.userId)"
      >
        <div class="history-person">
          <strong>{{ entry.displayName }}</strong>
          <time v-if="formatKickoff(entry.updatedAt)">Bet {{ formatKickoff(entry.updatedAt) }}</time>
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
            <small>{{ settlementLabel(entry) }}</small>
            <strong>{{ settlementText(entry) }}</strong>
          </span>
          <span>
            <small>Result</small>
            <strong>{{ statusText(entry.resultStatus) }}</strong>
          </span>
        </div>
        <span v-if="entry.isMine" class="status-pill live">You</span>
      </article>
    </div>

    <div v-if="modalOpen" class="modal-backdrop" role="dialog" aria-modal="true">
      <div ref="tokenModal" class="token-modal" tabindex="-1">
        <div class="section-head">
          <h2>Coin amount</h2>
          <button type="button" class="ghost-button small-button" @click="modalOpen = false">Close</button>
        </div>
        <div class="token-meta">
          <p class="token-pick">Pick: <strong>{{ selectedOption?.outcomeLabel }}</strong></p>
          <p class="token-help">Available: <strong>{{ maxBetTokens }}</strong> coins</p>
        </div>
        <div class="token-display">
          <strong>{{ tokenInput || '0' }}</strong>
          <small>Payouts {{ potentialReturn }} coins</small>
        </div>
        <p v-if="isOverBalance" class="token-warning">Not enough coins for this bet.</p>
        <div class="numpad" aria-label="Coin numpad">
          <button v-for="digit in ['1','2','3','4','5','6','7','8','9']" :key="digit" type="button" @click="pressDigit(digit)">{{ digit }}</button>
          <button type="button" class="secondary" @click="clearTokens">Clear</button>
          <button type="button" @click="pressDigit('0')">0</button>
          <button type="button" class="secondary" @click="backspace">Delete</button>
        </div>
        <button type="button" class="confirm-bet" :class="{ 'is-loading': loading }" :disabled="tokenAmount < 1 || isOverBalance || loading" @click="confirmBet">Confirm bet</button>
      </div>
    </div>
  </section>
</template>
