/**
 * 带 503 重试的 fetch 包装器
 * 当服务器返回 503（冷启动未完成）时，显示提示并自动重试
 *
 * 用法：
 *   const data = await apiFetch('/api/ranking?min_volume=1000', {
 *     onWarmingUp: (msg) => { 显示loading提示 },
 *   });
 *
 * @param {string} url - API 地址
 * @param {object} options - 配置项
 * @param {function} options.onWarmingUp - 收到503时的回调，参数为提示消息
 * @param {number} options.maxRetries - 最大重试次数，默认 20（约100秒）
 * @param {object} options.fetchOptions - 传给 fetch 的原始选项
 * @returns {Promise<Response>} - 成功时返回 Response 对象
 */
async function apiFetch(url, options = {}) {
  const { onWarmingUp, maxRetries = 20, fetchOptions = {} } = options;
  let retries = 0;

  while (retries < maxRetries) {
    const res = await fetch(url, fetchOptions);

    if (res.status !== 503) {
      return res;
    }

    // 503: 服务器冷启动中
    retries++;
    const body = await res.json().catch(() => ({}));
    const retryAfter = Number(body.retry_after || 5) * 1000;
    const message = body.message || '服务器正在初始化数据缓存...';

    if (onWarmingUp) {
      onWarmingUp(message, retries);
    }

    await new Promise(resolve => setTimeout(resolve, retryAfter));
  }

  // 超过最大重试次数，返回最后一次的 503 响应让调用方处理
  return fetch(url, fetchOptions);
}

// ══════════════════════════════════════════════════════════════
// Stale-While-Revalidate localStorage 缓存
// ══════════════════════════════════════════════════════════════

/**
 * 缓存配置
 * maxAge: 缓存有效期（毫秒），超过后仍可作为 stale 数据先展示
 * maxStale: stale 数据最大可用时间（毫秒），超过后视为失效不再使用
 */
const API_CACHE_CONFIG = {
  maxAge:   60 * 1000,       // 1分钟内视为新鲜
  maxStale: 30 * 60 * 1000,  // 30分钟内仍可用作 stale 展示
  prefix:   'api_cache_',
};

/**
 * 从 localStorage 读取缓存数据
 * @param {string} cacheKey - 缓存键（不含前缀）
 * @returns {{ data: any, timestamp: number, isStale: boolean } | null}
 */
function getCachedData(cacheKey) {
  try {
    const raw = localStorage.getItem(API_CACHE_CONFIG.prefix + cacheKey);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    const age = Date.now() - ts;
    if (age > API_CACHE_CONFIG.maxStale) {
      // 太旧了，删除
      localStorage.removeItem(API_CACHE_CONFIG.prefix + cacheKey);
      return null;
    }
    return { data, timestamp: ts, isStale: age > API_CACHE_CONFIG.maxAge };
  } catch (e) {
    return null;
  }
}

/**
 * 将数据写入 localStorage 缓存
 * @param {string} cacheKey - 缓存键（不含前缀）
 * @param {any} data - 要缓存的数据
 */
function setCachedData(cacheKey, data) {
  try {
    const payload = JSON.stringify({ data, ts: Date.now() });
    localStorage.setItem(API_CACHE_CONFIG.prefix + cacheKey, payload);
  } catch (e) {
    // localStorage 满或不可用，静默忽略
    // 尝试清理最旧的缓存条目
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(API_CACHE_CONFIG.prefix)) {
          keys.push(key);
        }
      }
      if (keys.length > 5) {
        // 删除前3个（最早写入的）
        keys.slice(0, 3).forEach(k => localStorage.removeItem(k));
        // 重试写入
        localStorage.setItem(API_CACHE_CONFIG.prefix + cacheKey, JSON.stringify({ data, ts: Date.now() }));
      }
    } catch (_) { /* 放弃 */ }
  }
}

/**
 * 生成缓存键：基于 URL 路径（去掉变化频繁的参数）
 * @param {string} url - 完整 API URL
 * @returns {string}
 */
function makeCacheKey(url) {
  // 使用完整 URL 作为 key（包含查询参数），确保不同筛选条件互不干扰
  return url.replace(/[^a-zA-Z0-9_/]/g, '_').slice(0, 100);
}

