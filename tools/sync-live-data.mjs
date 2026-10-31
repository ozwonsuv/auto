import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RESET_HOUR_UTC = 6;
const RESET_SETTLE_DELAY_MS = 15 * 1000;
const PRE_RESET_WAIT_WINDOW_MS = 15 * 60 * 1000;
const RETRY_WINDOW_MS = 12 * 60 * 1000;
const RETRY_DELAY_MS = 30 * 1000;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUTS = {
  dailies: resolve(ROOT, 'data/live/dailies.json'),
  nazar: resolve(ROOT, 'data/live/nazar.json')
};
const ENDPOINTS = {
  dailies: 'https://rdo-dailies.com/api/RDO/general/daily_challenges',
  nazar: 'https://rdo-dailies.com/api/RDO/collector/nazar_location'
};

function expectedGameDate(now = new Date()) {
  return new Date(now.getTime() - RESET_HOUR_UTC * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function millisecondsUntilTodayReset(now = new Date()) {
  const reset = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    RESET_HOUR_UTC,
    0,
    0
  ) + RESET_SETTLE_DELAY_MS;
  return reset - now.getTime();
}

async function waitForResetIfClose() {
  if (!process.argv.includes('--wait-for-reset')) {
    return;
  }

  const waitTime = millisecondsUntilTodayReset();
  if (waitTime > 0 && waitTime <= PRE_RESET_WAIT_WINDOW_MS) {
    console.log(`Waiting ${Math.ceil(waitTime / 1000)} seconds for the daily reset`);
    await sleep(waitTime);
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function validateDailies(payload, expectedDate) {
  if (payload?.date !== expectedDate) {
    throw new Error(`Daily data is not current: expected ${expectedDate}, received ${payload?.date ?? 'none'}`);
  }

  const general = payload?.data?.general?.challenges;
  const hardRoles = payload?.data?.hard;
  if (!Array.isArray(general) || general.length !== 7) {
    throw new Error(`Expected 7 general challenges, received ${general?.length ?? 'none'}`);
  }
  if (!Array.isArray(hardRoles) || hardRoles.length !== 5) {
    throw new Error(`Expected 5 hard role sets, received ${hardRoles?.length ?? 'none'}`);
  }

  for (const role of hardRoles) {
    if (!String(role?.role ?? '').startsWith('CHARACTER_RANK_')) {
      throw new Error('A hard role set has an invalid role identifier');
    }
    if (!Array.isArray(role?.challenges) || role.challenges.length !== 3) {
      throw new Error(`${role?.role ?? 'Unknown role'} does not contain 3 challenges`);
    }
    for (const challenge of role.challenges) {
      if (!challenge?.description?.label || !challenge?.description?.localizedFull) {
        throw new Error(`${role.role} contains an incomplete challenge`);
      }
    }
  }

  for (const challenge of general) {
    if (!challenge?.description?.label || !challenge?.description?.localizedFull) {
      throw new Error('General challenges contain an incomplete entry');
    }
  }
}

function validateNazar(payload, expectedDate) {
  if (payload?.date !== expectedDate) {
    throw new Error(`Nazar data is not current: expected ${expectedDate}, received ${payload?.date ?? 'none'}`);
  }
  if (!/^MPSW_LOCATION_(?:0[0-9]|1[01])$/u.test(String(payload?.nazar ?? ''))) {
    throw new Error(`Nazar location is invalid: ${payload?.nazar ?? 'none'}`);
  }
}

async function fetchJson(url, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'static-workspace-data-sync'
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`${label} request failed with HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function writeJsonIfChanged(path, value) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  const current = await readFile(path, 'utf8').catch(() => '');
  if (current === next) {
    return false;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, 'utf8');
  return true;
}

async function main() {
  await waitForResetIfClose();
  const expectedDate = expectedGameDate();
  const force = process.env.FORCE_SYNC === '1';
  const retry = process.argv.includes('--retry');
  const [currentDailies, currentNazar] = await Promise.all([
    readJson(OUTPUTS.dailies),
    readJson(OUTPUTS.nazar)
  ]);

  if (!force) {
    try {
      validateDailies(currentDailies, expectedDate);
      validateNazar(currentNazar, expectedDate);
      console.log(`Live data is already current for ${expectedDate}`);
      return;
    } catch {
      // Fetch only while the checked-in mirror is missing, stale, or incomplete.
    }
  }

  const retryDeadline = Date.now() + RETRY_WINDOW_MS;
  while (true) {
    try {
      const [dailies, nazar] = await Promise.all([
        fetchJson(ENDPOINTS.dailies, 'Daily data'),
        fetchJson(ENDPOINTS.nazar, 'Nazar data')
      ]);
      validateDailies(dailies, expectedDate);
      validateNazar(nazar, expectedDate);

      const changes = await Promise.all([
        writeJsonIfChanged(OUTPUTS.dailies, dailies),
        writeJsonIfChanged(OUTPUTS.nazar, nazar)
      ]);
      console.log(changes.some(Boolean)
        ? `Updated live data for ${expectedDate}`
        : `Live data content is unchanged for ${expectedDate}`);
      return;
    } catch (error) {
      if (!retry || Date.now() + RETRY_DELAY_MS > retryDeadline) {
        throw error;
      }
      console.warn(`${error.message}. Retrying in ${RETRY_DELAY_MS / 1000} seconds`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

await main();
