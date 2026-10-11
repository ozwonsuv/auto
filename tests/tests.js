import {
  DataSourceError,
  adaptRdoGgLiveData,
  buildPlainText,
  buildPostFragmentHtml,
  buildPostModel,
  getExpectedApiDate,
  normalizeGoalDisplay,
  normalizeText,
  resolveChallengeText
} from '../src/core.js';

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

await test('RDO.GG 대체 응답을 기존 도전 형식으로 변환', () => {
  const startTime = Date.UTC(2026, 7, 19, 6, 0, 0) / 1000;
  const challengePayload = {
    startTime,
    general: [{ title: 'MPGC_TEST_GENERAL', goal: 3 }],
    bounty_hunter: [{ title: 'MPRC_TEST_BOUNTY', goal: 1 }],
    trader: [{ title: 'MPRC_TEST_TRADER', goal: 2 }],
    collector: [{ title: 'MPRC_TEST_COLLECTOR', goal: 3 }],
    moonshiner: [{ title: 'MPRC_MOONSHINER_MONEY_MADE', goal: '$200.00' }],
    naturalist: [{ title: 'MPRC_TEST_NATURALIST', goal: 1 }]
  };
  const adapted = adaptRdoGgLiveData(
    challengePayload,
    { startTime, id: 'MPSW_LOCATION_01' },
    {
      mpgc_test_general: '일반 테스트',
      mprc_moonshiner_money_made: '밀주 판매로 획득한 돈'
    }
  );

  assert(adapted.dailyData.date === '2026-08-19', '대체 도전 날짜 변환 실패');
  assert(adapted.nazarData.date === '2026-08-19', '대체 나자르 날짜 변환 실패');
  assert(adapted.nazarData.nazar === 'MPSW_LOCATION_01', '대체 나자르 코드 변환 실패');
  assert(
    adapted.dailyData.data.general.challenges[0].description.localizedFull === '0/3 일반 테스트',
    '일반 도전 목표 변환 실패'
  );
  assert(
    adapted.dailyData.data.hard[0].role === 'CHARACTER_RANK_BOUNTY_HUNTER',
    '직업 코드 변환 실패'
  );
  assert(
    adapted.dailyData.data.hard[3].challenges[0].description.localizedFull ===
      '0￠/$200.00 밀주 판매로 획득한 돈',
    '화폐 목표 변환 실패'
  );
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
  assert(thrown instanceof DataSourceError && thrown.code === 'UNKNOWN_NAZAR', '알 수 없는 나자르 차단 실패');
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
window.__UNIT_TEST_RESULTS__ = { total: results.length, failed: failed.length, results };
