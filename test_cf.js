const cf = require('./cloudflare_manager');
try {
  console.log(cf.getRoutes());
} catch(e) {
  console.error("Error:", e.message);
}
