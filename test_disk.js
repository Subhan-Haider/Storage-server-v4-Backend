const fs = require('fs');
try {
  const stat = fs.statfsSync(__dirname);
  const total = stat.blocks * stat.bsize;
  const free = stat.bfree * stat.bsize;
  const used = total - free;
  console.log(JSON.stringify({ total, free, used }));
} catch (e) {
  console.error("fs.statfsSync failed:", e.message);
}
