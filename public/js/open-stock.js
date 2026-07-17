/**
 * open-stock.js — 点击 .symbol 单元格调用本机桥接开 PPro8 StockWindow
 *
 * 用法：在页面 </body> 前加 <script src="/js/open-stock.js" defer></script>
 * 可选覆盖：window.OPEN_STOCK_BRIDGE_PORT = 28081;
 */
(function () {
  'use strict';

  const PORT = (typeof window.OPEN_STOCK_BRIDGE_PORT === 'number')
    ? window.OPEN_STOCK_BRIDGE_PORT : 28080;
  const BRIDGE = `http://127.0.0.1:${PORT}/open-stock`;
  const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,12}$/;
  const IN_FLIGHT = new Set();

  // 注入极简样式
  const style = document.createElement('style');
  style.textContent = `
    .symbol { cursor: pointer; }
    .symbol:hover { text-decoration: underline; }
    .open-stock-toast {
      position: fixed; right: 20px; bottom: 20px;
      padding: 10px 16px; border-radius: 6px;
      color: #fff; font-size: 13px; z-index: 99999;
      box-shadow: 0 2px 10px rgba(0,0,0,.3);
      transition: opacity .3s; opacity: 1;
      max-width: 400px;
    }
    .open-stock-toast + .open-stock-toast { bottom: 70px; }
    .open-stock-toast.ok   { background: #26a69a; }
    .open-stock-toast.warn { background: #ef6c00; }
    .open-stock-toast.err  { background: #ef5350; }
    .open-stock-toast.fade { opacity: 0; }
  `;
  document.head.appendChild(style);

  function toast(msg, kind, sticky) {
    const el = document.createElement('div');
    el.className = `open-stock-toast ${kind || 'ok'}`;
    el.textContent = msg;
    document.body.appendChild(el);
    if (!sticky) {
      setTimeout(() => el.classList.add('fade'), 2200);
      setTimeout(() => el.remove(), 2600);
    }
    return el;
  }

  async function openStock(symbol) {
    if (IN_FLIGHT.has(symbol)) return;
    IN_FLIGHT.add(symbol);
    const pending = toast(`发送中 ${symbol}...`, 'ok', /*sticky*/ true);

    try {
      const res = await fetch(BRIDGE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, exchange: 'b' }),
      });
      const body = await res.json().catch(() => ({}));
      pending.remove();

      if (res.ok && body.ok) {
        toast(`已开 ${symbol}${body.title ? ` — ${body.title}` : ''}`, 'ok');
        return;
      }
      if (res.status === 400) {
        toast(`参数错误：${body.error || 'invalid'}`, 'err');
        return;
      }
      if (res.status === 504) {
        toast(`超时：PPro8 无响应`, 'err');
        return;
      }
      if (res.status === 502) {
        toast(body.hint || `失败 (exit ${body.exit_code || '?'})`, 'err');
        console.warn('[open-stock] ps1 log:', body.log);
        return;
      }
      toast(`失败 (${res.status})`, 'err');
    } catch (e) {
      pending.remove();
      toast('桥接未启动，请以管理员身份运行 start-bridge.bat', 'warn');
    } finally {
      IN_FLIGHT.delete(symbol);
    }
  }

  document.addEventListener('click', function (e) {
    const cell = e.target.closest && e.target.closest('.symbol');
    if (!cell) return;
    const symbol = (cell.dataset.symbol || cell.textContent || '').trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol)) return;
    e.preventDefault();
    openStock(symbol);
  });

  console.log(`[open-stock] enabled, bridge=${BRIDGE}`);
})();