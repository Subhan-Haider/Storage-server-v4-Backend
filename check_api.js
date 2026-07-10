const axios = require('axios');
axios.get('https://storage.lootops.me/admin/files', {
  headers: { 'x-api-key': 'sh202620252009sh' }
}).then(res => {
  const files = res.data.filter(f => f.name.includes('IMG_0180'));
  console.log(JSON.stringify(files, null, 2));
}).catch(err => console.error(err.message));
