export class RdoDataError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RdoDataError';
    this.code = code;
    this.details = details;
  }
}

const SECTION_ORDER = [
  'general',
  'bounty_hunter',
  'trader',
  'collector',
  'moonshiner',
  'naturalist'
];

export function normalizeText(value) {
  return String(value ?? '')
    .replaceAll('\u00a0', ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

export function normalizeGoalDisplay(value) {
  return String(value ?? '')
    .replaceAll('¢', 'c')
    .replaceAll('￠', 'c')
    .replace(/\s+/gu, '')
    .trim()
    .toLocaleLowerCase('en-US');
}

export function getLocalizedProgressPrefix(challenge) {
  const localizedFull = String(challenge?.description?.localizedFull ?? '');
  const match = localizedFull.match(/^(0(?:[/¢￠].*?))(?:\s|$)/u);
  return match ? match[1].trim() : '';
}

function dateFromParts(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function getKstParts(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    date: dateFromParts(parts.year, parts.month, parts.day)
  };
}

export function getExpectedApiDate(now = new Date()) {
  const kst = getKstParts(now);
  if (kst.hour >= 15) {
    return kst.date;
  }

  const previous = new Date(Date.UTC(kst.year, kst.month - 1, kst.day - 1));
  return dateFromParts(previous.getUTCFullYear(), previous.getUTCMonth() + 1, previous.getUTCDate());
}

export function formatKstTimestamp(now = new Date()) {
  const kst = getKstParts(now);
  return `${kst.date} ${String(kst.hour).padStart(2, '0')}:${String(kst.minute).padStart(2, '0')}:${String(kst.second).padStart(2, '0')}`;
}

export function validateLiveState(dailyData, nazarData, now = new Date()) {
  const expectedDate = getExpectedApiDate(now);
  const apiDate = String(dailyData?.date ?? '');
  const nazarApiDate = String(nazarData?.date ?? '');
  const generalChallenges = dailyData?.data?.general?.challenges;
  const nazarCode = String(nazarData?.nazar ?? '');

  if (!Array.isArray(generalChallenges) || generalChallenges.length === 0) {
    throw new RdoDataError('INCOMPLETE_DAILIES', '오늘의 도전 API 응답에 일반 도전 목록이 없습니다.', {
      expectedDate,
      apiDate,
      nazarApiDate
    });
  }
  if (!nazarCode) {
    throw new RdoDataError('INCOMPLETE_NAZAR', '마담 나자르 API 응답에 위치 코드가 없습니다.', {
      expectedDate,
      apiDate,
      nazarApiDate
    });
  }
  if (apiDate !== expectedDate || nazarApiDate !== expectedDate) {
    throw new RdoDataError(
      'UPSTREAM_NOT_READY',
      `최신 데이터 대기 중입니다. 기준 ${expectedDate}, 도전 ${apiDate || '없음'}, 나자르 ${nazarApiDate || '없음'}`,
      { expectedDate, apiDate, nazarApiDate }
    );
  }

  return { expectedDate, apiDate, nazarApiDate, nazarCode };
}

function getRoleKey(roleValue) {
  const normalized = String(roleValue ?? '')
    .replace(/CHARACTER_RANK_?/giu, '')
    .toLocaleLowerCase('en-US');
  return normalized || 'general';
}

function resolveLocalizedLabel(challenge, translations, rules) {
  const challengeKey = String(challenge?.description?.label ?? '');
  const labelKey = challengeKey.toLocaleLowerCase('en-US');
  if (Object.hasOwn(rules.labelOverrides ?? {}, labelKey)) {
    return String(rules.labelOverrides[labelKey]);
  }
  if (Object.hasOwn(translations ?? {}, labelKey)) {
    return String(translations[labelKey]);
  }
  return String(challenge?.description?.localized ?? challengeKey);
}

function newFallbackChallengeText(localizedLabel, challenge) {
  let goalDisplay = getLocalizedProgressPrefix(challenge);
  if (!goalDisplay) {
    goalDisplay = '0/1';
  }
  return `${localizedLabel.trim()}: ${goalDisplay.replaceAll('¢', '￠')}`;
}

export function resolveChallengeText(challenge, sectionIndex, translations, rules) {
  const challengeKey = String(challenge?.description?.label ?? '');
  const localizedLabel = resolveLocalizedLabel(challenge, translations, rules);
  const normalizedBase = normalizeText(localizedLabel);
  const progressPrefix = normalizeGoalDisplay(getLocalizedProgressPrefix(challenge));
  const candidates = sectionIndex?.[normalizedBase];

  if (Array.isArray(candidates) && candidates.length > 0) {
    if (progressPrefix) {
      const matched = candidates.find((candidate) => normalizeGoalDisplay(candidate.goal) === progressPrefix);
      if (matched) {
        return {
          text: String(matched.text),
          source: 'workbook',
          localizedLabel,
          challengeKey
        };
      }
    } else {
      return {
        text: String(candidates[0].text),
        source: 'workbook',
        localizedLabel,
        challengeKey
      };
    }
  }

  return {
    text: newFallbackChallengeText(localizedLabel, challenge),
    source: 'fallback',
    localizedLabel,
    challengeKey
  };
}

function applyFallbackOverride(section, text, rules) {
  const overrideKey = `[${section}] ${text}`;
  return Object.hasOwn(rules.fallbackTextOverrides ?? {}, overrideKey)
    ? String(rules.fallbackTextOverrides[overrideKey])
    : text;
}

function assertStaticData(challengeData, rules) {
  if (challengeData?.schemaVersion !== 1 || !challengeData?.sections) {
    throw new RdoDataError('INVALID_CHALLENGE_DATA', '내장 도전 문구 데이터의 형식이 올바르지 않습니다.');
  }
  if (rules?.schemaVersion !== 1 || !rules?.nazarMappings) {
    throw new RdoDataError('INVALID_RULES_DATA', '내장 게시물 규칙 데이터의 형식이 올바르지 않습니다.');
  }
}

function resolveChallengeEntry(challenge, section, challengeData, translations, rules, fallbacks) {
  const resolved = resolveChallengeText(
    challenge,
    challengeData.sections[section] ?? {},
    translations,
    rules
  );
  const finalText = applyFallbackOverride(section, resolved.text, rules);
  const entry = {
    type: 'challenge',
    section,
    text: finalText,
    source: resolved.source,
    challengeKey: resolved.challengeKey,
    localizedLabel: resolved.localizedLabel
  };

  if (resolved.source !== 'workbook') {
    fallbacks.push({
      section,
      label: resolved.challengeKey,
      text: finalText
    });
  }
  return entry;
}

export function buildPostModel({ dailyData, nazarData, challengeData, translations, rules, now = new Date() }) {
  assertStaticData(challengeData, rules);
  const liveState = validateLiveState(dailyData, nazarData, now);
  const difficulty = String(rules.roleDifficulty ?? 'hard');
  const roleSets = dailyData?.data?.[difficulty];
  if (!Array.isArray(roleSets)) {
    throw new RdoDataError('INCOMPLETE_ROLES', `${difficulty} 직업 도전 목록이 없습니다.`);
  }

  const lines = [];
  const fallbacks = [];
  lines.push({ type: 'heading', section: 'general', text: String(rules.roleHeadings.general) });
  for (const challenge of dailyData.data.general.challenges) {
    lines.push(resolveChallengeEntry(challenge, 'general', challengeData, translations, rules, fallbacks));
  }

  for (const roleSet of roleSets) {
    const section = getRoleKey(roleSet?.role);
    if (!SECTION_ORDER.includes(section) || section === 'general') {
      throw new RdoDataError('UNKNOWN_ROLE', `알 수 없는 직업 코드입니다: ${String(roleSet?.role ?? '')}`);
    }
    if (!Array.isArray(roleSet?.challenges)) {
      throw new RdoDataError('INCOMPLETE_ROLE_CHALLENGES', `${section} 도전 목록이 없습니다.`);
    }

    lines.push({ type: 'heading', section, text: String(rules.roleHeadings[section] ?? `[${section}]`) });
    for (const challenge of roleSet.challenges) {
      lines.push(resolveChallengeEntry(challenge, section, challengeData, translations, rules, fallbacks));
    }
  }

  const nazarCode = liveState.nazarCode;
  const nazarMapping = rules.nazarMappings[nazarCode];
  if (!nazarMapping?.location || !nazarMapping?.imageUrl) {
    throw new RdoDataError('UNKNOWN_NAZAR', `등록되지 않은 마담 나자르 위치입니다: ${nazarCode}`, { nazarCode });
  }

  const nazarLocation = String(nazarMapping.location);
  lines.push({
    type: 'nazar',
    section: 'nazar',
    text: `마담 나자르 위치 : ${nazarLocation}`,
    nazarCode,
    nazarLocation
  });

  return {
    date: liveState.apiDate,
    apiDate: liveState.apiDate,
    nazarApiDate: liveState.nazarApiDate,
    expectedDate: liveState.expectedDate,
    generatedAtKst: formatKstTimestamp(now),
    roleDifficulty: difficulty,
    headText: String(rules.headText),
    title: String(rules.title),
    titleImageUrl: String(rules.titleImageUrl),
    nazarCode,
    nazarLocation,
    nazarImageUrl: String(nazarMapping.imageUrl),
    lines,
    fallbacks
  };
}

export function getDisplayText(text) {
  return String(text)
    .replace('[현상금 사냥꾼]', '[현상금사냥꾼]')
    .replace('마담 나자르 위치 : ', '마담나자르 위치 : ');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getChallengeLink(line, rules) {
  if (line.challengeKey && Object.hasOwn(rules.challengeKeyLinks ?? {}, line.challengeKey)) {
    return String(rules.challengeKeyLinks[line.challengeKey]);
  }
  if (Object.hasOwn(rules.challengeLineLinks ?? {}, line.text)) {
    return String(rules.challengeLineLinks[line.text]);
  }
  return '';
}

function hasTimetableTrigger(text, timetable) {
  return (timetable?.triggerPatterns ?? []).some((pattern) => String(text).includes(String(pattern)));
}

export function buildPostFragmentHtml(model, rules) {
  const html = ['<div class="dc-post">'];
  html.push(`  <p class="dc-image"><img src="${escapeHtml(model.titleImageUrl)}" alt="title card"></p>`);

  for (const line of model.lines) {
    const displayText = getDisplayText(line.text);
    if (line.type === 'heading') {
      html.push(`  <p class="dc-section">${escapeHtml(displayText)}</p>`);
      continue;
    }
    if (line.type === 'challenge') {
      const link = getChallengeLink(line, rules);
      const content = link
        ? `<a class="challenge-link" href="${escapeHtml(link)}" target="_blank" rel="noreferrer">${escapeHtml(displayText)}</a>`
        : escapeHtml(displayText);
      html.push(`  <p class="dc-line">${content}</p>`);
      if (hasTimetableTrigger(line.text, rules.timetable)) {
        html.push(`  <p class="dc-line"><a class="hint-link" href="${escapeHtml(rules.timetable.url)}" target="_blank" rel="noreferrer">${escapeHtml(rules.timetable.linkText)}</a></p>`);
      }
      continue;
    }
    if (line.type === 'nazar') {
      html.push(`  <p class="dc-line dc-nazar">${escapeHtml(displayText)}</p>`);
      html.push(`  <p class="dc-image"><img src="${escapeHtml(model.nazarImageUrl)}" alt="madam nazar location"></p>`);
    }
  }

  html.push('</div>');
  return html.join('\n');
}

export function buildPlainText(model) {
  const output = [];
  let hasContent = false;
  for (const line of model.lines) {
    if ((line.type === 'heading' || line.type === 'nazar') && hasContent) {
      output.push('');
    }
    output.push(getDisplayText(line.text));
    hasContent = true;
  }
  return output.join('\n');
}
