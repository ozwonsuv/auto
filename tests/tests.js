import {
  RdoDataError,
  buildPlainText,
  buildPostFragmentHtml,
  buildPostModel,
  getExpectedApiDate,
  normalizeGoalDisplay,
  normalizeText,
  resolveChallengeText
} from '../src/rdo-core.js';

const resultsElement = document.querySelector('#results');
const summaryElement = document.querySelector('#summary');
const results = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeNewlines(value) {
  return String(value).replace(/\r\n/gu, '\n').trim();
}

function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(actualJson === expectedJson, `${message}\nactual: ${actualJson}\nexpected: ${expectedJson}`);
}

async function test(name, callback) {
  try {
    await callback();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.stack ?? error.message });
  }
}

async function loadJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  assert(response.ok, `${path} 로드 실패: ${response.status}`);
  return response.json();
}

const [fixture, challengeData, rules] = await Promise.all([
  loadJson('./fixtures/2026-08-19.json'),
  loadJson('../data/challenges.json'),
  loadJson('../data/rules.json')
]);

await test('문구와 목표값 정규화', () => {
  assert(normalizeText('  말\u00a0 먹이   주기 ') === '말 먹이 주기', '공백 정규화 실패');
  assert(normalizeGoalDisplay(' 0￠ / $200.00 ') === '0c/$200.00', '화폐 목표 정규화 실패');
});

await test('한국 시간 15시 경계 날짜', () => {
  assert(getExpectedApiDate(new Date('2026-08-19T05:59:59Z')) === '2026-08-18', '15시 직전 날짜 오류');
  assert(getExpectedApiDate(new Date('2026-08-19T06:00:00Z')) === '2026-08-19', '15시 정각 날짜 오류');
});

let historicalModel;
await test('2026-08-19 로컬 결과와 전체 도전 목록 일치', () => {
  historicalModel = buildPostModel({
    dailyData: fixture.dailyData,
    nazarData: fixture.nazarData,
    challengeData,
    translations: fixture.translations,
    rules,
    now: new Date(fixture.now)
  });
  assert(historicalModel.title === fixture.expected.title, '제목 불일치');
  assert(historicalModel.headText === fixture.expected.headText, '말머리 불일치');
  assert(historicalModel.nazarCode === fixture.expected.nazarCode, '나자르 코드 불일치');
  assert(historicalModel.nazarLocation === fixture.expected.nazarLocation, '나자르 지명 불일치');
  assertDeepEqual(historicalModel.lines, fixture.expected.lines, '게시물 줄 목록 불일치');
  assertDeepEqual(historicalModel.fallbacks, fixture.expected.fallbacks, 'fallback 목록 불일치');
});

await test('2026-08-19 로컬 복사용 HTML과 일치', () => {
  const actual = buildPostFragmentHtml(historicalModel, rules);
  assert(normalizeNewlines(actual) === normalizeNewlines(fixture.expected.fragmentHtml), '복사용 HTML 불일치');
});

await test('2026-08-19 로컬 일반 텍스트와 일치', () => {
  const actual = buildPlainText(historicalModel);
  assert(normalizeNewlines(actual) === normalizeNewlines(fixture.expected.plainText), '일반 텍스트 불일치');
});

await test('엑셀에 없는 도전은 생성 중단 없이 fallback', () => {
  const challenge = {
    description: {
      label: 'MPGC_TEST_UNKNOWN',
      localized: '테스트 도전',
      localizedFull: '0/4 테스트 도전'
    }
  };
  const resolved = resolveChallengeText(challenge, {}, {}, rules);
  assert(resolved.source === 'fallback', 'fallback 소스 누락');
  assert(resolved.text === '테스트 도전: 0/4', 'fallback 문구 오류');
});

await test('등록되지 않은 나자르 코드는 잘못된 이미지 생성 차단', () => {
  let thrown = null;
  try {
    buildPostModel({
      dailyData: fixture.dailyData,
      nazarData: { date: fixture.nazarData.date, nazar: 'MPSW_LOCATION_UNKNOWN' },
      challengeData,
      translations: fixture.translations,
      rules,
      now: new Date(fixture.now)
    });
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof RdoDataError && thrown.code === 'UNKNOWN_NAZAR', '알 수 없는 나자르 차단 실패');
});

for (const result of results) {
  const item = document.createElement('li');
  item.className = result.passed ? 'pass' : 'fail';
  item.textContent = result.passed ? `PASS: ${result.name}` : `FAIL: ${result.name}\n${result.error}`;
  resultsElement.append(item);
}

const failed = results.filter((result) => !result.passed);
summaryElement.className = failed.length === 0 ? 'pass' : 'fail';
summaryElement.textContent = `${results.length - failed.length}/${results.length} tests passed`;
window.__RDO_TEST_RESULTS__ = { total: results.length, failed: failed.length, results };
