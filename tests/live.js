import { buildPostFragmentHtml, buildPostModel, getExpectedApiDate } from '../src/core.js';

const summary = document.querySelector('#summary');
const list = document.querySelector('#results');
const checks = [];

async function fetchJson(url) {
  const separator = url.includes('?') ? '&' : '?';
  const response = await fetch(`${url}${separator}ts=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.json();
}

async function check(name, callback) {
  try {
    await callback();
    checks.push({ name, passed: true });
  } catch (error) {
    checks.push({ name, passed: false, error: error.message });
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timeout = window.setTimeout(() => reject(new Error('이미지 로드 시간 초과')), 15000);
    image.onload = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    image.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error(`이미지 로드 실패: ${url}`));
    };
    image.src = url;
  });
}

let model;
let rules;
await check('라이브 API와 정적 데이터 CORS 로드', async () => {
  const [dailyData, nazarData, translations, challengeData, loadedRules] = await Promise.all([
    fetchJson('https://pepegapi.jeanropke.net/v3/rdo/dailies'),
    fetchJson('https://pepegapi.jeanropke.net/v2/rdo/nazar'),
    fetchJson('https://jeanropke.github.io/RDOMap/langs/ko.json'),
    fetchJson('../data/challenges.json'),
    fetchJson('../data/rules.json')
  ]);
  rules = loadedRules;
  model = buildPostModel({ dailyData, nazarData, translations, challengeData, rules, now: new Date() });
  if (model.date !== getExpectedApiDate(new Date())) {
    throw new Error(`날짜 불일치: ${model.date}`);
  }
});

await check('라이브 본문 구조와 도전 수', () => {
  const challenges = model.lines.filter((line) => line.type === 'challenge');
  const headings = model.lines.filter((line) => line.type === 'heading');
  if (challenges.length !== 22) {
    throw new Error(`도전 ${challenges.length}개 (예상 22개)`);
  }
  if (headings.length !== 6) {
    throw new Error(`섹션 ${headings.length}개 (예상 6개)`);
  }
  const encodedNazarUrl = model.nazarImageUrl.replaceAll('&', '&amp;');
  if (!buildPostFragmentHtml(model, rules).includes(encodedNazarUrl)) {
    throw new Error('나자르 이미지 URL 누락');
  }
});

await check('제목 카드와 오늘 나자르 웹 이미지 로드', async () => {
  await Promise.all([loadImage(model.titleImageUrl), loadImage(model.nazarImageUrl)]);
});

await check('현재 날짜가 2026-08-19이면 기존 로컬 결과와 일치', async () => {
  if (model.date !== '2026-08-19') {
    return;
  }
  const fixture = await fetchJson('./fixtures/2026-08-19.json');
  if (JSON.stringify(model.lines) !== JSON.stringify(fixture.expected.lines)) {
    throw new Error('라이브 도전 목록이 기존 로컬 결과와 다릅니다.');
  }
  const actualFragment = buildPostFragmentHtml(model, rules).replace(/\r\n/gu, '\n').trim();
  const expectedFragment = fixture.expected.fragmentHtml.replace(/\r\n/gu, '\n').trim();
  if (actualFragment !== expectedFragment) {
    throw new Error('라이브 복사용 HTML이 기존 로컬 결과와 다릅니다.');
  }
});

for (const result of checks) {
  const item = document.createElement('li');
  item.textContent = result.passed ? `PASS: ${result.name}` : `FAIL: ${result.name} - ${result.error}`;
  list.append(item);
}

const failures = checks.filter((result) => !result.passed);
summary.textContent = `${checks.length - failures.length}/${checks.length} live tests passed`;
summary.dataset.failed = String(failures.length);
window.__LIVE_TEST_RESULTS__ = { model, checks, failed: failures.length };
