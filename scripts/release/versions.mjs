const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** @param {string} value @returns {number[]} */
export function versionParts(value) {
  const match = typeof value === 'string' && RELEASE.exec(value);
  if (!match) throw new Error(`Invalid release version: ${value}. Expected X.N.P.`);
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error(`Version exceeds the safe integer range: ${value}`);
  return parts;
}

/** @param {string} value @returns {number} */
export function turnNumber(value) {
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid turn number. Use a non-negative integer.');
  return Number(value);
}

export function versionArguments(args) {
  const [mode, turn, ...extra] = args;
  if (!['turn', 'fix', 'major'].includes(mode) || extra.length || (mode !== 'turn' && turn !== undefined)) {
    throw new Error('Usage: release:version -- turn [N] | fix | major');
  }
  return { mode, turn };
}

/** @returns {string} */
export function nextVersion(current, mode, turn) {
  const [major, minor, patch] = versionParts(current);
  let parts;
  switch (mode) {
    case 'turn': parts = [major, turn, 0]; break;
    case 'fix': parts = [major, minor, patch + 1]; break;
    case 'major': parts = [major + 1, minor, 0]; break;
    default: throw new Error(`Unknown release mode: ${mode}`);
  }
  const version = parts.join('.');
  versionParts(version);
  return version;
}
