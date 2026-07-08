const fs = require('fs');

let html = fs.readFileSync('public/index.html', 'utf8');

// 1. Add nav links
const navLinksStr = `        <a href="/screener-breakout" style="color: #007acc; text-decoration: none; padding: 8px 16px; border: 1px solid #007acc; border-radius: 4px; transition: all 0.2s;">突破监控 <span id="nav-breakout-count" style="font-weight:bold;color:#ff6b6b"></span></a>
        <a href="/screener-range" style="color: #007acc; text-decoration: none; padding: 8px 16px; border: 1px solid #007acc; border-radius: 4px; transition: all 0.2s;">震荡监控 <span id="nav-range-count" style="font-weight:bold;color:#ff6b6b"></span></a>
      </div>`;

html = html.replace('      </div>', navLinksStr);

// 2. Add updateScannerCounts
const scriptEndStr = `      // Fetch scanner counts
      async function updateScannerCounts() {
        try {
          const res = await fetch('/api/scanners');
          if (res.ok) {
            const data = await res.json();
            const breakout = data.find(d => d.type === 'BREAKOUT');
            const range = data.find(d => d.type === 'RANGE');
            if (breakout) document.getElementById('nav-breakout-count').textContent = '(' + breakout.count + ')';
            if (range) document.getElementById('nav-range-count').textContent = '(' + range.count + ')';
          }
        } catch (e) {
          console.error('Failed to fetch scanner counts', e);
        }
      }

      // 启动图表初始化
      initChart();
      updateScannerCounts();
      setInterval(updateScannerCounts, 15000);
    </script>
  </body>
</html>`;

html = html.replace(/      \/\/ 启动图表初始化[\s\S]*?<\/html>/, scriptEndStr);

fs.writeFileSync('public/index.html', html, 'utf8');
console.log('Fixed index.html');
