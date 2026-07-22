window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.direction !== 'from-extension') return;
  
  if (event.data.type === 'FETCH_MOVES') {
    let result = {};
    const dex = window.Dex || window.BattleDex;
    for (const move of event.data.moves) {
      let res = null;
      if (dex && dex.moves) {
        res = dex.moves.get(move);
      } else if (window.BattleMovedex) {
        res = window.BattleMovedex[move.toLowerCase().replace(/[^a-z0-9]/g, '')];
      }
      // Never return undefined because postMessage structured clone drops the key
      result[move] = res || { basePower: 0, category: 'Status', type: 'Normal', priority: 0, accuracy: 100 };
    }
    window.postMessage({ direction: 'from-page', type: 'MOVES_RESULT', result: result }, '*');
  }
  
  if (event.data.type === 'FETCH_OPPONENTS') {
     let result = {};
     const dex = window.Dex || window.BattleDex;
     for (const name of event.data.opponents) {
       let res = null;
       if (dex && dex.species) {
         res = dex.species.get(name);
       } else if (window.BattlePokedex) {
         res = window.BattlePokedex[name.toLowerCase().replace(/[^a-z0-9]/g, '')];
       }
       result[name] = res || { baseStats: { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100 } };
     }
     window.postMessage({ direction: 'from-page', type: 'OPP_RESULT', result: result }, '*');
  }
});
