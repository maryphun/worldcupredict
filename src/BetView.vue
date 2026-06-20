<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { BetHistoryEntry, Match } from './api';
import { flagBackgroundStyle, teamFlagUrl } from './flags';

type Pick = 'home' | 'draw' | 'away';

const props = defineProps<{
  match: Match;
  entries: BetHistoryEntry[];
  predictionDraft: { predictedResult: Pick | ''; tokenAmount: number };
  scoreDraft: { homeScore: number; awayScore: number; status: string };
  tokenBalance: number;
  loading: boolean;
  locked: boolean;
}>();

const emit = defineEmits<{
  back: [];
  savePrediction: [predictedResult: Pick, tokenAmount: number];
  reportScore: [homeScore: number, awayScore: number, status: string];
  openUser: [userId: string];
}>();

const score = reactive({ homeScore: 0, awayScore: 0, status: 'live' });
const selectedPick = ref<Pick | ''>('');
const tokenInput = ref('');
const modalOpen = ref(false);

const pickOptions = computed(() => [
  { key: 'home' as const, label: props.match.homeTeam, odds: props.match.oddsHome },
  { key: 'draw' as const, label: 'Draw', odds: props.match.oddsDraw },
  { key: 'away' as const, label: props.match.awayTeam, odds: props.match.oddsAway },
]);
const sortedEntries = computed(() => [...props.entries].sort((a, b) => Number(b.isMine) - Number(a.isMine) || a.displayName.localeCompare(b.displayName)));
const tokenAmount = computed(() => Number(tokenInput.value || 0));
const maxBetTokens = computed(() => Math.max(0, Number(props.tokenBalance || 0) + Number(props.predictionDraft?.tokenAmount || 0)));
const isOverBalance = computed(() => tokenAmount.value > maxBetTokens.value);
const existingStake = computed(() => Number(props.predictionDraft?.tokenAmount || 0));
const selectedOption = computed(() => pickOptions.value.find((option) => option.key === selectedPick.value));
const selectedOddsMultiplier = computed(() => {
  const odds = Number(selectedOption.value?.odds);
  return Number.isFinite(odds) && odds > 0 ? odds : 2;
});
const potentialReturn = computed(() => Math.floor(tokenAmount.value * selectedOddsMultiplier.value));
const currentPickLabel = computed(() => pickOptions.value.find((option) => option.key === props.predictionDraft?.predictedResult)?.label || '');
const isChangingPick = computed(() => Boolean(props.predictionDraft?.predictedResult && selectedPick.value && props.predictionDraft.predictedResult !== selectedPick.value));

watch(
  () => props.predictionDraft,
  (draft) => {
    selectedPick.value = draft?.predictedResult ?? '';
    tokenInput.value = draft?.tokenAmount ? String(draft.tokenAmount) : '';
  },
  { immediate: true, deep: true },
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

function choosePick(pick: Pick) {
  if (props.locked) return;
  selectedPick.value = pick;
  modalOpen.value = true;
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
  if (!selectedPick.value || tokenAmount.value < 1 || isOverBalance.value) return;
  emit('savePrediction', selectedPick.value, tokenAmount.value);
  modalOpen.value = false;
}

function scoreText(match: Match) {
  return `${match.homeScore === '' ? '-' : match.homeScore} : ${match.awayScore === '' ? '-' : match.awayScore}`;
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
      <span v-if="existingStake">Current bet: {{ existingStake }} coins</span>
    </div>

    <div class="bet-layout" :class="{ 'bet-layout-full': match.status !== 'live' }">
      <div class="bet-slip" data-bet-target="pick">
        <div class="section-head">
          <h2>Your bet</h2>
          <span class="status-pill">{{ locked ? 'Locked' : 'Open' }}</span>
        </div>

        <div class="pick-grid">
          <button v-for="option in pickOptions" :key="option.key" type="button" class="pick-card" :class="{ active: selectedPick === option.key }" :disabled="locked || loading" @click="choosePick(option.key)">
            <span>{{ option.label }}</span>
            <strong>{{ formatOdds(option.odds) }}</strong>
          </button>
        </div>
        <p v-if="existingStake" class="bet-note">One active bet only. Confirming another pick replaces your {{ currentPickLabel }} bet.</p>
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
        :class="{ mine: entry.isMine }"
        role="button"
        tabindex="0"
        @click="emit('openUser', entry.userId)"
        @keydown.enter.prevent="emit('openUser', entry.userId)"
        @keydown.space.prevent="emit('openUser', entry.userId)"
      >
        <div class="history-top">
          <div class="history-person">
            <strong>{{ entry.displayName }}</strong>
            <time v-if="formatKickoff(entry.updatedAt)">Bet {{ formatKickoff(entry.updatedAt) }}</time>
          </div>
          <span v-if="entry.isMine" class="status-pill live">You</span>
        </div>
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
      </article>
    </div>

    <div v-if="modalOpen" class="modal-backdrop" role="dialog" aria-modal="true">
      <div class="token-modal">
        <div class="section-head">
          <h2>Coin amount</h2>
          <button type="button" class="ghost-button small-button" @click="modalOpen = false">Close</button>
        </div>
        <p class="token-pick">Pick: <strong>{{ selectedOption?.label }}</strong></p>
        <p class="token-help">Available to bet: <strong>{{ maxBetTokens }}</strong> coins</p>
        <p v-if="isChangingPick" class="token-warning">This replaces your {{ currentPickLabel }} bet for this match.</p>
        <div class="token-display">{{ tokenInput || '0' }}</div>
        <div class="return-preview">
          <span>If correct</span>
          <strong>{{ potentialReturn }} coins</strong>
          <small>{{ tokenAmount || 0 }} coins x {{ selectedOddsMultiplier.toFixed(2) }} odds</small>
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
