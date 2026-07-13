// public/js/whitelist.js
(function () {
  const STORAGE_KEY = 'whitelist_symbols';

  function getWhitelist() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function setWhitelist(symbols) {
    const unique = [...new Set(symbols.map(s => s.trim().toUpperCase()).filter(Boolean))];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(unique));
    window.dispatchEvent(new Event('whitelist-changed'));
  }

  function addToWhitelist(symbol) {
    const list = getWhitelist();
    const s = symbol.trim().toUpperCase();
    if (s && !list.includes(s)) {
      list.push(s);
      setWhitelist(list);
    }
  }

  function removeFromWhitelist(symbol) {
    const s = symbol.trim().toUpperCase();
    setWhitelist(getWhitelist().filter(x => x !== s));
  }

  function clearWhitelist() {
    localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new Event('whitelist-changed'));
  }

  function isWhitelistEnabled() {
    return getWhitelist().length > 0;
  }

  /**
   * 过滤数据数组，仅保留白名单内的股票
   * @param {Array} data - 数据数组
   * @param {string} symbolKey - 股票代码字段名，默认 'symbol'
   * @returns {Array} 过滤后的数组（白名单为空则返回原数组）
   */
  function filterByWhitelist(data, symbolKey = 'symbol') {
    const list = getWhitelist();
    if (list.length === 0) return data;
    const set = new Set(list);
    return data.filter(item => set.has((item[symbolKey] || '').toUpperCase()));
  }

  // 暴露全局 API
  window.Whitelist = {
    get: getWhitelist,
    set: setWhitelist,
    add: addToWhitelist,
    remove: removeFromWhitelist,
    clear: clearWhitelist,
    isEnabled: isWhitelistEnabled,
    filter: filterByWhitelist,
  };
})();
