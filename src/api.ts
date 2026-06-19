const API_BASE = import.meta.env.VITE_API_BASE || '';
export const apiBaseConfigured = Boolean(API_BASE);

export type User = {
  userId: string;
  username: string;
  displayName: string;
  status: string;
  role: 'admin' | 'user';
  startingTokens: number;
  tokenBalance: number;
};

export type Match = {
  matchId: string;
  competition: string;
  stage: string;
  groupName: string;
  homeTeam: string;
  awayTeam: string;
  kickoffAt: string;
  status: string;
  homeScore: number | '';
  awayScore: number | '';
  oddsHome: number | string | '';
  oddsDraw: number | string | '';
  oddsAway: number | string | '';
  scoreSource: string;
  oddsSource: string;
};

export type Prediction = {
  predictionId: string;
  userId: string;
  matchId: string;
  homeScore: number | '';
  awayScore: number | '';
  predictedResult: 'home' | 'draw' | 'away';
  oddsAtPrediction: number | string | '';
  tokenAmount: number;
  updatedAt: string;
};

export type BetHistoryEntry = {
  predictionId: string;
  userId: string;
  displayName: string;
  matchId: string;
  matchLabel: string;
  kickoffAt: string;
  matchStatus: string;
  homeTeam: string;
  awayTeam: string;
  predictedHomeScore: number;
  predictedAwayScore: number;
  predictedResult: 'home' | 'draw' | 'away';
  token: string;
  tokenAmount: number;
  oddsAtPrediction: number | string | '';
  points: number;
  resultStatus: 'pending' | 'won' | 'lost';
  isMine: boolean;
  updatedAt: string;
};

export type Snapshot = {
  user: User | null;
  matches: Match[];
  predictions: Prediction[];
  leaderboard: Array<{ userId: string; displayName: string; total: number }>;
  pendingUsers: User[];
  betHistory: BetHistoryEntry[];
};

export async function callApi<T>(payload: Record<string, unknown>): Promise<T> {
  if (!API_BASE) throw new Error('VITE_API_BASE is not configured.');
  const response = await fetch(API_BASE, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  });
  const json = await response.json();
  if (!json.ok) throw new Error(json.error || 'Request failed.');
  return json.data as T;
}

export function snapshot(token: string) {
  return callApi<Snapshot>({ action: 'snapshot', token });
}

export function pingBackend() {
  return callApi<{ app: string; status: string; time: string }>({ action: 'ping' });
}
