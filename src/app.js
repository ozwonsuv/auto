import {
  DataSourceError,
  buildPlainText,
  buildPostFragmentHtml,
  buildPostModel,
  getExpectedApiDate
} from './core.js';

const ENDPOINTS = {
  dailies: 'https://pepegapi.jeanropke.net/v3/rdo/dailies',
  nazar: 'https://pepegapi.jeanropke.net/v2/rdo/nazar',
  translations: 'https://jeanropke.github.io/RDOMap/langs/ko.json',
  challenges: './data/challenges.json',
  rules: './data/rules.json'
};

const MAX_LIVE_ATTEMPTS = 7;
const RETRY_DELAY_MS = 10000;

const elements = {
  generate: document.querySelector('#generateButton'),
  copyTitle: document.querySelector('#copyTitleButton'),
  copyBody: document.querySelector('#copyBodyButton'),
  status: document.querySelector('#status'),
  meta: document.querySelector('#postMeta'),
  fallback: document.querySelector('#fallbackNotice'),
  preview: document.querySelector('#preview'),
  post: document.querySelector('#postContent')
};

let currentResult = null;
let staticDataPromise = null;

function setStatus(message, tone = 'neutral') {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
}

function setCopyButtonsEnabled(enabled) {
  elements.copyTitle.disabled = !enabled;
  elements.copyBody.disabled = !enabled;
}

function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function fetchJson(url, label, { fresh = false } = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  const separator = url.includes('?') ? '&' : '?';
  const requestUrl = fresh ? `${url}${separator}ts=${Date.now()}` : url;

  try {
    const response = await fetch(requestUrl, {
      cache: fresh ? 'no-store' : 'no-cache',
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      throw new Error(`${label} 요청 실패 (HTTP ${response.status})`);
    }
    const raw = await response.text();
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`${label} 응답이 올바른 JSON이 아닙니다.`);
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`${label} 응답 시간이 15초를 넘었습니다.`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function loadStaticData() {
  if (!staticDataPromise) {
    staticDataPromise = Promise.all([
      fetchJson(ENDPOINTS.challenges, '내장 도전 문구'),
      fetchJson(ENDPOINTS.rules, '게시물 규칙'),
      fetchJson(ENDPOINTS.translations, '공식 한국어 번역', { fresh: true })
    ])
      .then(([challengeData, rules, translations]) => ({ challengeData, rules, translations }))
      .catch((error) => {
        staticDataPromise = null;
        throw error;
      });
  }
  return staticDataPromise;
}

async function loadCurrentPost() {
  const staticData = await loadStaticData();
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_LIVE_ATTEMPTS; attempt += 1) {
    setStatus(
      attempt === 1
        ? '최신 오늘의 도전과 나자르 위치를 확인하고 있습니다.'
        : `최신 데이터 반영을 기다리는 중입니다. ${attempt}/${MAX_LIVE_ATTEMPTS}`,
      'loading'
    );

    try {
      const [dailyData, nazarData] = await Promise.all([
        fetchJson(ENDPOINTS.dailies, '오늘의 도전 API', { fresh: true }),
        fetchJson(ENDPOINTS.nazar, '마담 나자르 API', { fresh: true })
      ]);
      return {
        model: buildPostModel({
          dailyData,
          nazarData,
          challengeData: staticData.challengeData,
          translations: staticData.translations,
          rules: staticData.rules,
          now: new Date()
        }),
        rules: staticData.rules
      };
    } catch (error) {
      lastError = error;
      const retryableDataError = error instanceof DataSourceError && error.code === 'UPSTREAM_NOT_READY';
      const retryableNetworkError = !(error instanceof DataSourceError);
      if ((!retryableDataError && !retryableNetworkError) || attempt === MAX_LIVE_ATTEMPTS) {
        throw error;
      }
      await sleep(RETRY_DELAY_MS);
    }
  }

  throw lastError ?? new Error('오늘의 도전 생성에 실패했습니다.');
}

function renderResult(result) {
  const { model, rules } = result;
  const fragmentHtml = buildPostFragmentHtml(model, rules);
  const plainText = buildPlainText(model);
  currentResult = { model, rules, fragmentHtml, plainText };

  elements.post.innerHTML = fragmentHtml;
  elements.meta.textContent = `데이터 ${model.date} · 나자르 ${model.nazarLocation} · 생성 ${model.generatedAtKst} KST`;
  if (model.fallbacks.length > 0) {
    const fallbackNames = model.fallbacks.map((entry) => entry.text).join(', ');
    elements.fallback.textContent = `엑셀에 없던 ${model.fallbacks.length}개 도전은 공식 한국어 문구로 표시했습니다: ${fallbackNames}`;
    elements.fallback.hidden = false;
  } else {
    elements.fallback.textContent = '';
    elements.fallback.hidden = true;
  }

  elements.preview.hidden = false;
  setCopyButtonsEnabled(true);
  setStatus(`${model.date} 오늘의 도전 생성 완료`, 'success');
}

async function generatePost() {
  elements.generate.disabled = true;
  elements.generate.textContent = '생성 중...';
  setCopyButtonsEnabled(false);
  elements.preview.hidden = true;
  elements.fallback.hidden = true;
  currentResult = null;

  try {
    const result = await loadCurrentPost();
    renderResult(result);
  } catch (error) {
    console.error(error);
    const message = error instanceof DataSourceError ? error.message : `불러오기 실패: ${error.message}`;
    setStatus(`${message} 잠시 후 다시 눌러 주세요.`, 'error');
  } finally {
    elements.generate.disabled = false;
    elements.generate.textContent = '오늘 생성';
  }
}

function legacyCopyText(value) {
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.className = 'clipboard-helper';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  if (!legacyCopyText(value)) {
    throw new Error('브라우저가 텍스트 복사를 허용하지 않았습니다.');
  }
}

async function copyTitle() {
  if (!currentResult) {
    return;
  }
  try {
    await copyText(currentResult.model.title);
    setStatus('제목 복사 완료', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

function legacyCopyRichHtml(html, plainText) {
  const listener = (event) => {
    event.clipboardData.setData('text/html', html);
    event.clipboardData.setData('text/plain', plainText);
    event.preventDefault();
  };
  document.addEventListener('copy', listener, { once: true });
  const copied = document.execCommand('copy');
  if (!copied) {
    document.removeEventListener('copy', listener);
  }
  return copied;
}

async function copyBody() {
  if (!currentResult) {
    return;
  }

  try {
    if (window.ClipboardItem && navigator.clipboard?.write) {
      const item = new ClipboardItem({
        'text/html': new Blob([currentResult.fragmentHtml], { type: 'text/html' }),
        'text/plain': new Blob([currentResult.plainText], { type: 'text/plain' })
      });
      await navigator.clipboard.write([item]);
    } else if (!legacyCopyRichHtml(currentResult.fragmentHtml, currentResult.plainText)) {
      throw new Error('브라우저가 HTML 복사를 허용하지 않았습니다.');
    }
    setStatus('본문 전체 복사 완료 (웹 이미지와 링크 포함)', 'success');
  } catch (error) {
    setStatus(`본문 복사 실패: ${error.message}`, 'error');
  }
}

elements.generate.addEventListener('click', generatePost);
elements.copyTitle.addEventListener('click', copyTitle);
elements.copyBody.addEventListener('click', copyBody);

setCopyButtonsEnabled(false);
setStatus(`기준 날짜 ${getExpectedApiDate(new Date())}. 오늘 생성을 눌러 주세요.`);
