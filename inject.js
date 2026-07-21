const fs = require('fs');
const path = require('path');

const files = [
  "index.html", "abnormal-trades.html", "active-trading.html", "alerts.html",
  "boundary-alerts.html", "crossed-market.html", "hill-alerts.html", "hills.html",
  "l2_alert_history.html", "large-orders.html", "rect-alerts.html", "screener.html",
  "screener-breakout.html", "screener-oscillator.html", "screener-range.html",
  "screener-stable.html", "swing-screener.html", "volume-alerts.html",
  "volume-chart.html", "volume-surge.html"
];

for (const f of files) {
  const p = path.join(__dirname, 'public', f);
  if (fs.existsSync(p)) {
    let content = fs.readFileSync(p, 'utf8');
    if (!content.includes('open-stock.js')) {
      content = content.replace('</body>', '    <script src="/js/open-stock.js" defer></script>\n</body>');
      fs.writeFileSync(p, content, 'utf8');
      console.log(`Updated ${f}`);
    }
  }
}
