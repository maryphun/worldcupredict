const FLAG_FILES: Record<string, string> = {
  Algeria: 'Flag_of_Algeria.svg',
  Argentina: 'Flag_of_Argentina.svg',
  Australia: 'Flag_of_Australia.svg',
  Austria: 'Flag_of_Austria.svg',
  Belgium: 'Flag_of_Belgium.svg',
  'Bosnia and Herzegovina': 'Flag_of_Bosnia_and_Herzegovina.svg',
  Brazil: 'Flag_of_Brazil.svg',
  Canada: 'Flag_of_Canada.svg',
  'Cape Verde': 'Flag_of_Cape_Verde.svg',
  'Cabo Verde': 'Flag_of_Cape_Verde.svg',
  Colombia: 'Flag_of_Colombia.svg',
  'Congo DR': 'Flag_of_Congo_DR.svg',
  'DR Congo': 'Flag_of_Congo_DR.svg',
  'Democratic Republic of the Congo': 'Flag_of_Congo_DR.svg',
  Croatia: 'Flag_of_Croatia.svg',
  Curaçao: 'Flag_of_Curaçao.svg',
  Czechia: 'Flag_of_Czech_Republic.svg',
  'Czech Republic': 'Flag_of_Czech_Republic.svg',
  Ecuador: 'Flag_of_Ecuador.svg',
  Egypt: 'Flag_of_Egypt.svg',
  England: 'Flag_of_England.svg',
  France: 'Flag_of_France.svg',
  Germany: 'Flag_of_Germany.svg',
  Ghana: 'Flag_of_Ghana.svg',
  Haiti: 'Flag_of_Haiti.svg',
  Iran: 'Flag_of_Iran.svg',
  'IR Iran': 'Flag_of_Iran.svg',
  Iraq: 'Flag_of_Iraq.svg',
  Japan: 'Flag_of_Japan.svg',
  Jordan: 'Flag_of_Jordan.svg',
  'Korea Republic': 'Flag_of_South_Korea.svg',
  'South Korea': 'Flag_of_South_Korea.svg',
  Mexico: 'Flag_of_Mexico.svg',
  Morocco: 'Flag_of_Morocco.svg',
  Netherlands: 'Flag_of_Netherlands.svg',
  'New Zealand': 'Flag_of_New_Zealand.svg',
  Norway: 'Flag_of_Norway.svg',
  Panama: 'Flag_of_Panama.svg',
  Paraguay: 'Flag_of_Paraguay.svg',
  Portugal: 'Flag_of_Portugal.svg',
  Qatar: 'Flag_of_Qatar.svg',
  'Saudi Arabia': 'Flag_of_Saudi_Arabia.svg',
  Scotland: 'Flag_of_Scotland.svg',
  Senegal: 'Flag_of_Senegal.svg',
  'South Africa': 'Flag_of_South_Africa.svg',
  Spain: 'Flag_of_Spain.svg',
  Sweden: 'Flag_of_Sweden.svg',
  Switzerland: 'Flag_of_Switzerland.svg',
  Tunisia: 'Flag_of_Tunisia.svg',
  Türkiye: 'Flag_of_Turkey.svg',
  Turkey: 'Flag_of_Turkey.svg',
  Uruguay: 'Flag_of_Uruguay.svg',
  USA: 'Flag_of_United_States.svg',
  'United States': 'Flag_of_United_States.svg',
  'United States of America': 'Flag_of_United_States.svg',
  Uzbekistan: 'Flag_of_Uzbekistan.svg',
  "Côte d'Ivoire": 'Flag_of_Côte_dIvoire.svg',
  'Côte d’Ivoire': 'Flag_of_Côte_dIvoire.svg',
};

const COUNTRY_COLORS: Record<string, string> = {
  Algeria: '#006233',
  Argentina: '#74acdf',
  Australia: '#00843d',
  Austria: '#ed2939',
  Belgium: '#ef3340',
  'Bosnia and Herzegovina': '#002f6c',
  Brazil: '#009c3b',
  Canada: '#d80621',
  'Cape Verde': '#003893',
  'Cabo Verde': '#003893',
  Colombia: '#fcd116',
  'Congo DR': '#007fff',
  'DR Congo': '#007fff',
  'Democratic Republic of the Congo': '#007fff',
  Croatia: '#171796',
  'Cura\u00e7ao': '#002b7f',
  Czechia: '#11457e',
  'Czech Republic': '#11457e',
  Ecuador: '#ffdd00',
  Egypt: '#ce1126',
  England: '#cf142b',
  France: '#0055a4',
  Germany: '#dd0000',
  Ghana: '#006b3f',
  Haiti: '#00209f',
  Iran: '#239f40',
  'IR Iran': '#239f40',
  Iraq: '#ce1126',
  Japan: '#bc002d',
  Jordan: '#007a3d',
  'Korea Republic': '#0047a0',
  'South Korea': '#0047a0',
  Mexico: '#006847',
  Morocco: '#c1272d',
  Netherlands: '#ff4f00',
  'New Zealand': '#00247d',
  Norway: '#ba0c2f',
  Panama: '#005293',
  Paraguay: '#0038a8',
  Portugal: '#006600',
  Qatar: '#8a1538',
  'Saudi Arabia': '#006c35',
  Scotland: '#005eb8',
  Senegal: '#00853f',
  'South Africa': '#007a4d',
  Spain: '#aa151b',
  Sweden: '#006aa7',
  Switzerland: '#d52b1e',
  Tunisia: '#e70013',
  'T\u00fcrkiye': '#e30a17',
  Turkey: '#e30a17',
  Uruguay: '#0038a8',
  USA: '#3c3b6e',
  'United States': '#3c3b6e',
  'United States of America': '#3c3b6e',
  Uzbekistan: '#1eb53a',
  "C\u00f4te d'Ivoire": '#f77f00',
  'C\u00f4te d\u2019Ivoire': '#f77f00',
};

const FALLBACK_COLORS = ['#0b4db6', '#0a8f7a', '#8a1538', '#aa151b', '#0038a8', '#006847'];
const BASE_URL = import.meta.env.BASE_URL || '/';

export function teamFlagUrl(teamName: string) {
  const fileName = FLAG_FILES[teamName];
  return fileName ? publicAssetUrl(`flags/${encodeURIComponent(fileName)}`) : '';
}

export function teamColor(teamName: string) {
  const color = COUNTRY_COLORS[teamName];
  if (color) return color;
  const hash = [...teamName].reduce((total, char) => total + char.charCodeAt(0), 0);
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

export function flagBackgroundStyle(homeTeam: string, awayTeam: string) {
  const homeColor = teamColor(homeTeam);
  const awayColor = teamColor(awayTeam);
  const homeFlag = teamFlagUrl(homeTeam);
  const awayFlag = teamFlagUrl(awayTeam);
  return {
    '--home-flag': homeFlag ? `url("${homeFlag}")` : 'none',
    '--away-flag': awayFlag ? `url("${awayFlag}")` : 'none',
    '--home-color': homeColor,
    '--away-color': awayColor,
    '--home-color-soft': hexToRgba(homeColor, 0.18),
    '--away-color-soft': hexToRgba(awayColor, 0.18),
  };
}

function hexToRgba(hex: string, alpha: number) {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function publicAssetUrl(path: string) {
  const base = BASE_URL.endsWith('/') ? BASE_URL : `${BASE_URL}/`;
  return `${base}${path.replace(/^\/+/, '')}`;
}
