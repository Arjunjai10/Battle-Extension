/**
 * injected.js — MAIN world bridge
 *
 * Runs in the page's main world (world: "MAIN") so it can access
 * Showdown's live JavaScript objects (window.Dex, window.BattlePokedex, etc.).
 *
 * Receives postMessage requests from the isolated content script,
 * queries the real game data, and posts the results back.
 *
 * Security: all messages are validated against the expected schema
 * before being acted on. Responses always include a `direction` tag
 * so the content script can distinguish them from other page messages.
 */

const DEFAULT_MOVE_STUB = { basePower: 0, category: 'Status', type: 'Normal', priority: 0, accuracy: 100 };
const DEFAULT_SPECIES_STUB = { baseStats: { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100 } };

/** Normalise a name to a Showdown lookup key (lowercase, alphanumeric only). */
function toShowdownKey(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Fetch a move from whatever Showdown data object is available. */
function getMove(moveName) {
  const dex = window.Dex || window.BattleDex;
  if (dex?.moves) {
    const result = dex.moves.get(moveName);
    // dex.moves.get returns an object with `id` set even for misses; check basePower
    if (result && result.id) return result;
  }
  if (window.BattleMovedex) {
    const result = window.BattleMovedex[toShowdownKey(moveName)];
    if (result) return result;
  }
  return null;
}

/** Fetch a species from whatever Showdown data object is available. */
function getSpecies(name) {
  const dex = window.Dex || window.BattleDex;
  if (dex?.species) {
    const result = dex.species.get(name);
    if (result && result.id) return result;
  }
  if (window.BattlePokedex) {
    const result = window.BattlePokedex[toShowdownKey(name)];
    if (result) return result;
  }
  return null;
}

window.addEventListener('message', (event) => {
  // Only accept messages from this page's own content script
  if (event.source !== window) return;
  if (!event.data || event.data.direction !== 'from-extension') return;

  const { type } = event.data;

  if (type === 'FETCH_MOVES') {
    if (!Array.isArray(event.data.moves)) return;
    const result = {};
    for (const moveName of event.data.moves) {
      if (typeof moveName !== 'string') continue;
      // Structured-clone drops undefined keys — always provide a fallback object
      result[moveName] = getMove(moveName) ?? { ...DEFAULT_MOVE_STUB };
    }
    window.postMessage({ direction: 'from-page', type: 'MOVES_RESULT', result }, '*');
    return;
  }

  if (type === 'FETCH_OPPONENTS') {
    if (!Array.isArray(event.data.opponents)) return;
    const result = {};
    for (const name of event.data.opponents) {
      if (typeof name !== 'string') continue;
      const species = getSpecies(name);
      result[name] = species ?? { ...DEFAULT_SPECIES_STUB };
    }
    window.postMessage({ direction: 'from-page', type: 'OPP_RESULT', result }, '*');
    return;
  }
});
