const express = require('express');
const app = express();
app.get('/file-serve/*path', (req, res) => res.json({ params: req.params }));
const srv = app.listen(0, async () => {
  const port = srv.address().port;
  const res = await fetch(`http://localhost:${port}/file-serve/a/b/c`);
  console.log('Result:', await res.text());
  srv.close();
});
