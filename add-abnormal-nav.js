const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, 'public');
const files = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));

let modifiedCount = 0;

for (const file of files) {
  const filePath = path.join(publicDir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  let originalContent = content;

  // Skip if it already contains abnormal-trades link (except for maybe updating index.html specifically)
  if (content.includes('href="/abnormal-trades"')) {
    continue;
  }

  if (file === 'index.html') {
    const searchStr = `<a href="/boundary-alerts" style="color: #007acc; text-decoration: none; padding: 8px 16px; border: 1px solid #007acc; border-radius: 4px; transition: all 0.2s;">边界预警</a>`;
    const replaceStr = `<a href="/boundary-alerts" style="color: #007acc; text-decoration: none; padding: 8px 16px; border: 1px solid #007acc; border-radius: 4px; transition: all 0.2s;">边界预警</a>\n        <a href="/active-trading" style="color: #007acc; text-decoration: none; padding: 8px 16px; border: 1px solid #007acc; border-radius: 4px; transition: all 0.2s;">活跃主买</a>\n        <a href="/abnormal-trades" style="color: #007acc; text-decoration: none; padding: 8px 16px; border: 1px solid #007acc; border-radius: 4px; transition: all 0.2s;">异常成交</a>`;
    content = content.replace(searchStr, replaceStr);
  } else if (file === 'volatility.html') {
    const searchStr = `<a href="/boundary-alerts">边界预警</a>`;
    const replaceStr = `<a href="/boundary-alerts">边界预警</a>\n  <a href="/active-trading">活跃主买</a>\n  <a href="/abnormal-trades">异常成交</a>`;
    content = content.replace(searchStr, replaceStr);
  } else {
    // Other files: Find the last link in the nav (or boundary-alerts/active-trading)
    const regexActive = /(<a href="\/active-trading".*?>.*?<\/a>)/;
    const regexBoundary = /(<a href="\/boundary-alerts".*?>.*?<\/a>)/;
    
    if (regexActive.test(content)) {
      content = content.replace(regexActive, `$1\n    <a href="/abnormal-trades">异常成交</a>`);
    } else if (regexBoundary.test(content)) {
      content = content.replace(regexBoundary, `$1\n    <a href="/active-trading">活跃主买</a>\n    <a href="/abnormal-trades">异常成交</a>`);
    } else {
      console.log(`Could not find a good anchor to inject navigation link in ${file}`);
    }
  }

  if (content !== originalContent) {
    try {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`Updated ${file}`);
      modifiedCount++;
    } catch (e) {
      console.error(`Failed to write ${file}: ${e.message}`);
    }
  }
}

console.log(`Updated ${modifiedCount} files.`);
